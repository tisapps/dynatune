// Dynatune – Hauptprogramm: Audio-Aufbau, Zustandsautomat, Bedienung

import { analyzeFreq, freqFromMidi, centsBetween, noteName, TRANSPOSITIONS } from './tuning.js';
import { ReferenceEngine, TIMBRES } from './reference.js';
import { TunerDisplay, RANGE } from './display.js';
import { calibrateEcho } from './calibrate.js';
import { features, buildTemplate, score } from './stopsignal.js';

// ---------- Einstellungen ----------
const DEFAULTS = {
  a4: 440,
  timbre: 'violine',
  octave: 0,          // 0 = gleiche Oktave, -12 = eine Oktave tiefer
  volume: 0.6,
  sensitivity: 6,     // 1..10
  holdSec: 20,        // automatische Abschaltung im Haltezustand
  tolerance: 3,       // grüner Bereich ±Cent
  lang: 'de',
  transpose: 'C',
  nlms: true,
  stopThreshold: 0.6,
  stopTemplate: null,
};
const STORE_KEY = 'dynatune.settings.v1';

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* privat/blockiert */ }
}
const S = loadSettings();

// ---------- Erkennungsparameter ----------
const STABLE_FRAMES = 3;      // gleiche Note in 3 Messungen (~16 ms) bis Ton gilt
const SILENCE_MS = 120;       // so lange kein Ton → Haltezustand
const CLARITY_MIN = 0.8;
const LEAK_CENTS = 1.2;       // so nah an der Referenz (oder Vielfachen) = Verdacht auf Übersprechen

const gateFor = (s) => 0.05 * 10 ** (-(s - 1) / 4.5);

// ---------- Zustand ----------
let ctx = null, node = null, ref = null, refBus = null, micStream = null;
let state = 'off';           // off | idle | tracking | hold | train
let currentNote = null;      // MIDI-Note der Referenz
let candidate = { note: null, count: 0 };
let grayCount = 0;           // Graubereich erst nach 2 Messungen anzeigen (Tonwechsel-Übergang)
let silenceSince = null;
let holdStart = 0;
let peakRms = 0;
let leak = { samples: [], base: null };
let training = null;
let wakeLock = null;
let lastPitch = null;

const $ = (id) => document.getElementById(id);
const display = new TunerDisplay($('meter'));
display.tol = S.tolerance;

// ---------- Audio-Aufbau ----------
async function start() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (e) {
    toast('Kein Mikrofonzugriff: ' + e.message);
    return;
  }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('worklet/dynatune-processor.js');
  node = new AudioWorkletNode(ctx, 'dynatune-processor', {
    numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit',
  });
  const mic = ctx.createMediaStreamSource(micStream);
  mic.connect(node, 0, 0);

  ref = new ReferenceEngine(ctx);
  ref.setTimbre(S.timbre);
  ref.setVolume(S.volume);
  refBus = ctx.createGain();
  ref.output.connect(refBus);
  refBus.connect(ctx.destination);
  refBus.connect(node, 0, 1);           // Referenz als NLMS-Eingang

  const sink = ctx.createGain();        // hält den Worklet-Knoten aktiv
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);

  node.port.onmessage = onWorkletMessage;
  if (ctx.state !== 'running') await ctx.resume();
  applyNlmsSetting();
  setState('idle');
  requestWakeLock();
  $('start').textContent = 'Stopp';
  $('start').classList.add('running');
  showLatency();
}

function stop() {
  ref?.stop(0.05);
  micStream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  ctx = node = ref = refBus = micStream = null;
  setState('off');
  wakeLock?.release?.(); wakeLock = null;
  $('start').textContent = 'Start';
  $('start').classList.remove('running');
  display.reset();
  renderNote(null);
}

function applyNlmsSetting() {
  if (!node) return;
  node.port.postMessage({ type: 'nlms', enabled: S.nlms && !!S.echo });
  if (S.nlms && S.echo) node.port.postMessage({ type: 'nlms', delay: S.echo.delay });
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state !== 'off') requestWakeLock();
});

// ---------- Zustandsautomat ----------
function setState(s) {
  state = s;
  if (node) {
    // NLMS nur adaptieren, wenn ausschließlich die Referenz klingt
    node.port.postMessage({ type: 'adapt', value: s === 'hold' });
    const g = gateFor(S.sensitivity);
    node.port.postMessage({ type: 'transient', value: s === 'hold' || s === 'train', gate: (g * 2) ** 2 });
  }
  if (s === 'hold') { holdStart = performance.now(); leak = { samples: [], base: null }; }
  if (s === 'tracking') peakRms = 0;
  document.body.dataset.state = s;
  const labels = { off: 'Aus', idle: 'Hört zu', tracking: 'Verfolgt', hold: 'Hält', train: 'Lernt Stoppsignal' };
  $('status').textContent = labels[s];
}

function startReference(note) {
  currentNote = note;
  ref.play(freqFromMidi(note + S.octave, S.a4));
  renderReference();
}

function stopReference(reason) {
  ref?.stop(reason === 'signal' ? 0.08 : 0.4);
  currentNote = null;
  renderReference();
  renderNote(null);
  display.reset();
  if (state === 'hold' || state === 'tracking') setState('idle');
}

// Ist der gemessene Ton vermutlich nur der eigene Referenzton aus dem Lautsprecher?
function isLeak(f, rms) {
  if (!ref?.playing) return false;
  let match = false;
  for (let k = 1; k <= 4 && !match; k++) {
    if (Math.abs(centsBetween(f, ref.freq * k)) < LEAK_CENTS) match = true;
    if (Math.abs(centsBetween(f, ref.freq / k)) < LEAK_CENTS) match = true;
  }
  if (!match) return false;
  if (state === 'hold') {
    if (leak.base == null) return true;
    return rms < Math.max(gateFor(S.sensitivity) * 1.5, leak.base * 2.5);
  }
  if (state === 'tracking') return peakRms > 0 && rms < peakRms * 0.25;
  return false;
}

function onPitch(m) {
  const now = performance.now();
  const gate = gateFor(S.sensitivity);
  let valid = m.f > 0 && m.clarity >= CLARITY_MIN && m.rms >= gate;
  if (valid && isLeak(m.f, m.rms)) valid = false;

  // Grundpegel des Übersprechens zu Beginn des Haltens messen
  if (state === 'hold' && leak.base == null) {
    const dt = now - holdStart;
    if (dt > 60 && !valid) leak.samples.push(m.rms);
    if (dt > 250) {
      const s = leak.samples.sort((a, b) => a - b);
      leak.base = s.length ? s[Math.floor(s.length / 2)] : 0;
    }
  }

  if (valid) {
    silenceSince = null;
    const { note, cents } = analyzeFreq(m.f, S.a4);
    const inZone = Math.abs(cents) <= RANGE;
    lastPitch = { f: m.f, note, cents, inZone };
    grayCount = inZone ? 0 : grayCount + 1;
    if (inZone) {
      candidate = candidate.note === note ? { note, count: candidate.count + 1 } : { note, count: 1 };
      if (candidate.count >= STABLE_FRAMES) {
        const changed = note !== currentNote;
        if (changed) startReference(note);
        if (state !== 'tracking') setState('tracking');
        peakRms = Math.max(peakRms, m.rms);
        display.push(cents, now / 1000, changed);
        renderNote(note, cents);
      }
    } else if (grayCount >= 2) {
      // Graubereich: Referenz spielt weiter, Anzeige grau
      candidate = { note: null, count: 0 };
      if (state === 'hold' && currentNote != null) setState('tracking');
      if (state === 'tracking') peakRms = Math.max(peakRms, m.rms);
      display.push(Math.sign(cents) * (RANGE + 2), now / 1000);
      renderNote(note, cents, true);
    }
  } else {
    candidate = { note: null, count: 0 };
    grayCount = 0;
    display.push(null, now / 1000);
    if (state === 'tracking') {
      if (silenceSince == null) silenceSince = now;
      if (now - silenceSince > SILENCE_MS) {
        if (currentNote != null) setState('hold'); else setState('idle');
      }
    }
  }

  if (state === 'hold' && now - holdStart > S.holdSec * 1000) stopReference('timeout');
}

function onTransient(m) {
  const f = features(m.buf, m.fs);
  if (state === 'train' && training) {
    training.list.push(f);
    $('train-progress').textContent = `${training.list.length} / ${training.needed} aufgenommen`;
    if (training.list.length >= training.needed) finishTraining();
    return;
  }
  if (state === 'hold' && S.stopTemplate) {
    const sc = score(S.stopTemplate, f);
    $('stop-last').textContent = `letzte Erkennung: ${(sc * 100).toFixed(0)} %`;
    if (sc >= S.stopThreshold) stopReference('signal');
  }
}

function onWorkletMessage(ev) {
  const m = ev.data;
  if (m.type === 'pitch') { if (state !== 'off' && state !== 'train') onPitch(m); }
  else if (m.type === 'transient') onTransient(m);
}

// ---------- Anzeige ----------
function renderNote(note, cents, gray = false) {
  const el = $('note');
  if (note == null) {
    el.innerHTML = '–';
    $('cents').textContent = '';
    return;
  }
  const { name, octave } = noteName(note, S.lang, TRANSPOSITIONS[S.transpose]);
  el.innerHTML = `${name}<sub>${octave}</sub>`;
  const c = cents.toFixed(1).replace('.', ',');
  $('cents').textContent = gray ? `${cents > 0 ? '+' : ''}${c} ct · außerhalb` : `${cents > 0 ? '+' : ''}${c} ct`;
  $('cents').classList.toggle('gray', gray);
}

function renderReference() {
  const el = $('refinfo');
  if (currentNote == null) { el.textContent = 'Referenz: –'; return; }
  const n = currentNote + S.octave;
  const { name, octave } = noteName(n, S.lang, TRANSPOSITIONS[S.transpose]);
  el.textContent = `Referenz: ${name}${octave} · ${freqFromMidi(n, S.a4).toFixed(2).replace('.', ',')} Hz`;
}

function frame() {
  display.draw(performance.now() / 1000);
  const bar = $('holdbar');
  if (state === 'hold') {
    const left = Math.max(0, S.holdSec - (performance.now() - holdStart) / 1000);
    bar.style.transform = `scaleX(${left / S.holdSec})`;
    $('status').textContent = `Hält · ${Math.ceil(left)} s`;
  } else {
    bar.style.transform = 'scaleX(0)';
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function showLatency() {
  if (!ctx) return;
  const outMs = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
  $('latency').textContent = `Audio-Ausgabelatenz ca. ${outMs.toFixed(0)} ms · ${ctx.sampleRate} Hz`;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------- Stoppsignal einlernen ----------
function startTraining() {
  if (!ctx) { toast('Bitte zuerst Start drücken.'); return; }
  ref.stop(0.05); currentNote = null; renderReference();
  training = { list: [], needed: 4 };
  setState('train');
  $('train-progress').textContent = `0 / ${training.needed} aufgenommen`;
  $('train-dialog').showModal();
}
function finishTraining() {
  const tpl = buildTemplate(training.list);
  S.stopTemplate = tpl;
  saveSettings();
  const self = Math.min(...tpl.selfScores);
  $('train-progress').textContent = `Fertig. Übereinstimmung der Aufnahmen: ${(self * 100).toFixed(0)} %`;
  training = null;
  setState('idle');
  renderStopInfo();
  setTimeout(() => $('train-dialog').close(), 1500);
}
function cancelTraining() {
  training = null;
  if (state === 'train') setState('idle');
}
function renderStopInfo() {
  const t = S.stopTemplate;
  $('stop-info').textContent = t
    ? `Eingelernt (${t.n} Aufnahmen, Dauer ca. ${t.durMs.toFixed(0)} ms)`
    : 'Noch nicht eingelernt – Abschaltung per Zeit oder Antippen.';
}

// ---------- Echo kalibrieren ----------
async function runCalibration() {
  if (!ctx) { toast('Bitte zuerst Start drücken.'); return; }
  const btn = $('calibrate');
  btn.disabled = true;
  $('echo-info').textContent = 'Kalibriere … bitte ruhig sein.';
  ref.stop(0.05); currentNote = null;
  const prev = state;
  setState('train');                  // Tonerkennung pausieren
  try {
    const r = await calibrateEcho(ctx, node, refBus);
    if (r.ok) {
      S.echo = { delay: r.delay };
      $('echo-info').textContent = `Echo-Laufzeit ${r.latencyMs.toFixed(0)} ms · Dämpfung ${r.erleDb.toFixed(0)} dB`;
    } else {
      S.echo = null;
      $('echo-info').textContent = r.reason;
    }
    saveSettings();
    applyNlmsSetting();
  } catch (e) {
    $('echo-info').textContent = 'Kalibrierung fehlgeschlagen: ' + e.message;
  }
  setState(prev === 'off' ? 'off' : 'idle');
  btn.disabled = false;
}

// ---------- Bedienelemente ----------
function bindSettings() {
  const sel = $('timbre');
  for (const [k, v] of Object.entries(TIMBRES)) sel.add(new Option(v.label, k));
  const tr = $('transpose');
  for (const k of Object.keys(TRANSPOSITIONS)) tr.add(new Option(k === 'C' ? 'C (klingend)' : `in ${k}`, k));

  const bind = (id, key, parse = (v) => v, after = () => {}) => {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = S[key]; else el.value = S[key];
    const out = $(id + '-val');
    const show = () => out && (out.textContent = fmt[id] ? fmt[id](S[key]) : S[key]);
    show();
    el.addEventListener('input', () => {
      S[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
      show(); saveSettings(); after();
    });
  };
  const fmt = {
    a4: (v) => `${v} Hz`,
    volume: (v) => `${Math.round(v * 100)} %`,
    holdSec: (v) => `${v} s`,
    tolerance: (v) => `±${v} ct`,
    stopThreshold: (v) => `${Math.round(v * 100)} %`,
  };
  bind('a4', 'a4', Number, renderReference);
  bind('timbre', 'timbre', String, () => ref?.setTimbre(S.timbre));
  bind('octave', 'octave', Number, () => currentNote != null && ref && startReference(currentNote));
  bind('volume', 'volume', Number, () => ref?.setVolume(S.volume));
  bind('sensitivity', 'sensitivity', Number);
  bind('holdSec', 'holdSec', Number);
  bind('tolerance', 'tolerance', Number, () => (display.tol = S.tolerance));
  bind('lang', 'lang', String, renderReference);
  bind('transpose', 'transpose', String, renderReference);
  bind('nlms', 'nlms', Boolean, applyNlmsSetting);
  bind('stopThreshold', 'stopThreshold', Number);
  renderStopInfo();
  $('echo-info').textContent = S.echo ? `Kalibriert (Laufzeit ${S.echo.delay} Samples)` : 'Noch nicht kalibriert.';
}

$('start').addEventListener('click', () => (state === 'off' ? start() : stop()));
$('meter').addEventListener('click', () => { if (currentNote != null) stopReference('tap'); });
$('open-settings').addEventListener('click', () => $('settings').showModal());
$('close-settings').addEventListener('click', () => $('settings').close());
$('calibrate').addEventListener('click', runCalibration);
$('train').addEventListener('click', startTraining);
$('train-cancel').addEventListener('click', () => { cancelTraining(); $('train-dialog').close(); });
$('train-dialog').addEventListener('close', cancelTraining);
$('stop-reset').addEventListener('click', () => { S.stopTemplate = null; saveSettings(); renderStopInfo(); });
bindSettings();
setState('off');
renderNote(null);
renderReference();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// für Tests und Fehlersuche
window.dynatune = {
  get state() { return state; },
  get currentNote() { return currentNote; },
  get refFreq() { return ref?.freq ?? 0; },
  get lastPitch() { return lastPitch; },
  settings: S,
};
