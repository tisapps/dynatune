// Dynatune – Hauptprogramm: Audio-Aufbau, Einmessen, Bedienung
// (Notenlogik/Zustandsautomat: js/tracker.js)

import { freqFromMidi, noteName, TRANSPOSITIONS } from './tuning.js';
import { ReferenceEngine, TIMBRES } from './reference.js';
import { TunerDisplay } from './display.js';
import { calibrateEcho, probeEcho } from './calibrate.js';
import { features, buildTemplate, score, isValidTemplate } from './stopsignal.js';
import { Tracker, gateFor } from './tracker.js';

// ---------- Einstellungen ----------
const DEFAULTS = {
  a4: 440,
  timbre: 'violine',
  octave: 0,          // 0 = gleiche Oktave, -12 = eine Oktave tiefer
  volume: 0.6,
  sensitivity: 6,     // 1..10
  holdSec: 20,        // automatische Abschaltung im Haltezustand
  tolerance: 3,       // Mitte des Übergangs grün → Farbe (voll grün bis ±(tol-1), Farbe ab ±(tol+1))
  smoothing: 6,       // Glättung der Anzeige 1..10
  lang: 'de',
  transpose: 'C',
  autoCalib: true,    // beim Start einmessen (Echo des Lautsprechers)
  stopThreshold: 0.5,
  stopTemplate: null,
};
const STORE_KEY = 'dynatune.settings.v1';

const SETTINGS_REV = 3;
function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  // Rev. 2: neues Stoppsignal-Verfahren – alte Vorlage passt nicht mehr, Schwelle neu
  if ((s.rev || 1) < 2) { s.stopTemplate = null; s.stopThreshold = DEFAULTS.stopThreshold; }
  // Rev. 3: Einmessen beim Start statt gespeicherter Echo-Laufzeit
  if ((s.rev || 1) < 3) { delete s.echo; delete s.nlms; s.autoCalib = true; }
  if (s.stopTemplate && !isValidTemplate(s.stopTemplate)) s.stopTemplate = null;
  s.rev = SETTINGS_REV;
  return s;
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* privat/blockiert */ }
}
const S = loadSettings();

// ---------- Zustand ----------
let ctx = null, node = null, ref = null, refBus = null, micStream = null;
let mode = 'off';            // off | run | calib | train
let tracker = null;
let calib = null;            // Ergebnis des Einmessens (nur für diese Sitzung)
let training = null;
let wakeLock = null;
let starting = false;

const $ = (id) => document.getElementById(id);
const display = new TunerDisplay($('meter'));
display.tol = S.tolerance;
const tauFor = (s) => 0.04 * 1.35 ** (s - 1);   // Glättung 1..10 → 0,04 … 0,6 s
display.tau = tauFor(S.smoothing);
const currentNote = () => tracker?.currentNote ?? null;

// ---------- Audio-Aufbau ----------
async function start() {
  if (starting || ctx) return;
  starting = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (e) {
    starting = false;
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
  refBus.connect(node, 0, 1);           // gesendete Referenz: für NLMS und Kammfilter

  // Testhilfe: ?echotest=<Pegel> mischt ein simuliertes Handy-Lautsprecher-Echo
  // (Laufzeit, kaum Bässe, Verzerrung) ins Mikrofonsignal
  const echoTest = Number(new URLSearchParams(location.search).get('echotest'));
  if (echoTest > 0) {
    const delay = ctx.createDelay(1); delay.delayTime.value = 0.04;
    const hp1 = ctx.createBiquadFilter(), hp2 = ctx.createBiquadFilter();
    hp1.type = hp2.type = 'highpass'; hp1.frequency.value = hp2.frequency.value = 450;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 511.5 - 1) * 2; curve[i] = Math.tanh(1.5 * x) / 1.5; }
    shaper.curve = curve;
    shaper.oversample = '4x';        // ohne Überabtastung entstünde Aliasing, das ein echter Lautsprecher nicht hat
    const g = ctx.createGain(); g.gain.value = echoTest * 3;
    refBus.connect(delay).connect(hp1).connect(hp2).connect(g).connect(shaper).connect(node, 0, 0);
  }

  const sink = ctx.createGain();        // hält den Worklet-Knoten aktiv
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);

  node.port.onmessage = onWorkletMessage;
  if (ctx.state !== 'running') await ctx.resume();
  tracker = new Tracker(trackerIO, S);
  $('start').textContent = 'Stopp';
  $('start').classList.add('running');
  requestWakeLock();
  showLatency();
  starting = false;
  if (S.autoCalib) await runCalibration(true);
  else setMode('run');
}

function stop() {
  ref?.stop(0.05);
  micStream?.getTracks().forEach((t) => t.stop());
  ctx?.close();
  ctx = node = ref = refBus = micStream = null;
  tracker = null;
  calib = null;
  setMode('off');
  wakeLock?.release?.(); wakeLock = null;
  $('start').textContent = 'Start';
  $('start').classList.remove('running');
  display.reset();
  renderNote(null);
  renderReference();
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}

// App im Hintergrund: Audio vollständig freigeben. Ein offen gehaltenes Mikrofon
// hält Android im Kommunikationsmodus; nach Bluetooth-Nutzung bleibt dann der
// Lautsprecher stumm.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ctx) { stop(); toast('Pausiert – zum Weitermachen Start drücken.'); }
});
window.addEventListener('pagehide', () => { if (ctx) stop(); });

// Audiogerät gewechselt (Kopfhörer/Bluetooth ein- oder ausgesteckt):
// Audio neu aufbauen, damit die Ausgabe wieder richtig geroutet wird, und neu einmessen.
let deviceTimer;
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(async () => {
    if (!ctx || mode === 'train') return;
    stop();
    toast('Audiogerät gewechselt – Audio neu gestartet.');
    await start();
  }, 1000);
});

// ---------- Zustände ----------
const LABELS = { off: 'Aus', idle: 'Hört zu', tracking: 'Verfolgt', hold: 'Hält', train: 'Lernt Stoppsignal', calib: 'Misst ein …' };

function setMode(m) {
  mode = m;
  if (m === 'run' && tracker) tracker.reset();
  showState(m === 'run' ? tracker?.state ?? 'idle' : m);
}

function showState(s) {
  if (node) {
    // Stoppsignal-Erkennung nur im Halten (beim Spielen würde z. B. Zungenstoß auslösen) und beim Einlernen
    const g = gateFor(S.sensitivity);
    node.port.postMessage({ type: 'transient', value: s === 'hold' || s === 'train', gate: g * g });
  }
  document.body.dataset.state = s;
  $('status').textContent = LABELS[s];
}

const trackerIO = {
  startReference(note) {
    ref.play(freqFromMidi(note + S.octave, S.a4));
    node.port.postMessage({ type: 'ref', f: ref.freq });
    renderReference(note);
  },
  stopReference(reason) {
    ref?.stop(reason === 'signal' ? 0.08 : 0.4);
    node?.port.postMessage({ type: 'ref', f: 0 });
    renderReference(null);
    renderNote(null);
    display.reset();
  },
  setState(s) {
    if (mode === 'run') showState(s);
    // im Halten ist der Cent-Wert nicht mehr aktuell
    if (s === 'hold') { display.push(null, performance.now() / 1000); $('cents').classList.add('gray'); }
  },
  refFreq: () => ref?.freq ?? 0,
  show(cents, jump) { display.push(cents, performance.now() / 1000, jump); },
  readout(note, cents, gray, jump) { setReadout(note, cents, gray, jump); },
};

function stopReferenceNow(reason) {
  if (tracker && tracker.currentNote != null) tracker.stopReference(reason, performance.now());
}

function onTransient(m) {
  const f = features(m.buf, m.fs);
  if (mode === 'train' && training) {
    if (training.phase === 'record') recordSample(f);
    else showTestResult(score(S.stopTemplate, f));
    return;
  }
  if (mode === 'run' && S.stopTemplate && tracker?.stopSignalAllowed(performance.now())) {
    const sc = score(S.stopTemplate, f);
    const pct = `${(sc * 100).toFixed(0)} %`;
    $('stop-last').textContent = `letzte Erkennung: ${pct}`;
    if (sc >= S.stopThreshold) {
      stopReferenceNow('signal');
      flashHint(`Stoppsignal erkannt (${pct})`);
    } else {
      flashHint(`Geräusch: ${pct} – Stoppsignal braucht ${Math.round(S.stopThreshold * 100)} %`);
    }
  }
}

let hintTimer;
function flashHint(msg) {
  const h = $('hint');
  h.textContent = msg;
  h.classList.add('flash');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { h.textContent = HINT; h.classList.remove('flash'); }, 2500);
}
const HINT = 'Antippen der Anzeige beendet den Referenzton.';

function onWorkletMessage(ev) {
  const m = ev.data;
  if (m.type === 'pitch') { if (mode === 'run' && tracker) tracker.pitch(m, performance.now()); }
  else if (m.type === 'transient') onTransient(m);
}

// ---------- Anzeige ----------
// Notenname sofort, Cent-Zahl geglättet und höchstens 10× pro Sekunde (ruhiger lesbar)
let readout = null, readoutShown = 0;
function setReadout(note, cents, gray, immediate = false) {
  const prevNote = readout?.note;
  readout = { note, cents, gray };
  if (immediate || note !== prevNote) renderReadout();
}
function renderReadout() {
  readoutShown = performance.now();
  if (!readout) return;
  const cents = readout.gray || display.cents == null ? readout.cents : display.cents;
  renderNote(readout.note, cents, readout.gray);
}

function renderNote(note, cents, gray = false) {
  const el = $('note');
  if (note == null) {
    readout = null;
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

function renderReference(note = currentNote()) {
  const el = $('refinfo');
  if (note == null) { el.textContent = 'Referenz: –'; return; }
  const n = note + S.octave;
  const { name, octave } = noteName(n, S.lang, TRANSPOSITIONS[S.transpose]);
  el.textContent = `Referenz: ${name}${octave} · ${freqFromMidi(n, S.a4).toFixed(2).replace('.', ',')} Hz`;
}

function frame() {
  display.draw(performance.now() / 1000);
  if (readout && performance.now() - readoutShown > 100 && tracker?.state !== 'hold') renderReadout();
  const bar = $('holdbar');
  if (mode === 'run' && tracker?.state === 'hold') {
    const left = Math.max(0, S.holdSec - (performance.now() - tracker.holdStart) / 1000);
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
  // Popover liegt in der obersten Ebene, also auch über geöffneten Dialogen
  const t = $('toast');
  t.textContent = msg;
  try { t.showPopover(); } catch { t.style.display = 'block'; }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    try { t.hidePopover(); } catch { t.style.display = 'none'; }
  }, 4000);
}

// ---------- Stoppsignal einlernen ----------
async function startTraining() {
  if (!ctx) await start();          // Audio bei Bedarf automatisch starten
  if (!ctx) return;
  stopReferenceNow('train');
  training = { list: [], needed: 5, phase: 'record' };
  setMode('train');
  $('train-title').textContent = 'Stoppsignal einlernen';
  $('train-text').innerHTML = `Mach dein Signal (z. B. Zungenschnalzen) <strong>${training.needed}×</strong>, jeweils mit etwa einer Sekunde Pause. Möglichst so, wie du es später beim Spielen machst.`;
  $('train-progress').textContent = `0 / ${training.needed} aufgenommen`;
  $('train-log').textContent = '';
  $('train-cancel').textContent = 'Abbrechen';
  $('train-dialog').showModal();
}
function recordSample(f) {
  training.list.push(f);
  $('train-progress').textContent = `${training.list.length} / ${training.needed} aufgenommen`;
  $('train-log').textContent = '●'.repeat(training.list.length) + '○'.repeat(training.needed - training.list.length);
  if (training.list.length >= training.needed) finishTraining();
}
function finishTraining() {
  const tpl = buildTemplate(training.list);
  S.stopTemplate = tpl;
  saveSettings();
  renderStopInfo();
  const vals = tpl.selfScores.map((v) => Math.round(v * 100));
  const worst = Math.min(...vals);
  const verdict = worst >= 60 ? 'gut' : worst >= 40 ? 'brauchbar – Signal möglichst gleichmäßig machen' : 'schwankend – bitte neu einlernen';
  training.phase = 'test';
  $('train-title').textContent = 'Stoppsignal testen';
  $('train-progress').textContent = `Übereinstimmung: ${vals.join(' · ')} % (${verdict})`;
  $('train-text').textContent = `Jetzt testen: Mach dein Signal oder andere Geräusche. Ab ${Math.round(S.stopThreshold * 100)} % gilt es als Stoppsignal.`;
  $('train-log').textContent = '';
  $('train-cancel').textContent = 'Fertig';
}
function showTestResult(sc) {
  const pct = Math.round(sc * 100);
  const ok = sc >= S.stopThreshold;
  const line = document.createElement('div');
  line.textContent = `${ok ? '✓ Stoppsignal' : '✗ kein Stoppsignal'} · ${pct} %`;
  line.className = ok ? 'ok' : 'no';
  const log = $('train-log');
  log.prepend(line);
  while (log.children.length > 5) log.lastChild.remove();
}
function cancelTraining() {
  training = null;
  if (mode === 'train') setMode('run');
}
function renderStopInfo() {
  const t = S.stopTemplate;
  $('stop-info').textContent = t
    ? `Eingelernt (${t.n} Aufnahmen, Übereinstimmung ${t.selfScores.map((v) => Math.round(v * 100)).join('/')} %)`
    : 'Noch nicht eingelernt – Abschaltung per Zeit oder Antippen.';
  $('train-main-state').textContent = t ? '✓ eingelernt' : 'einlernen';
  $('train-main').classList.toggle('trained', !!t);
}

// ---------- Einmessen ----------
// Rauschen → Echo-Laufzeit + NLMS-Filter; Tonprobe → erwartetes Rest-Echo
async function runCalibration(auto = false) {
  if (!ctx) { await start(); return; }     // start() misst selbst ein
  if (mode === 'calib') return;
  const btn = $('calibrate');
  btn.disabled = true;
  stopReferenceNow('calib');
  setMode('calib');
  if (auto) toast('Einmessen – bitte kurz still sein …');
  $('echo-info').textContent = 'Misst ein … bitte kurz still sein.';
  try {
    const r = await calibrateEcho(ctx, node, refBus);
    const p = await probeEcho(ctx, node, ref);
    calib = { ...r, ...p };
    tracker.leakGain = p.leakGain;
    tracker.echoK = r.ok ? p.echoK : null;
    $('echo-info').textContent = r.ok
      ? `Echo-Laufzeit ${r.latencyMs.toFixed(0)} ms · Unterdrückung ${r.erleDb.toFixed(0)} dB`
      : 'Kein Echo messbar (Kopfhörer) – keine Unterdrückung nötig.';
  } catch (e) {
    $('echo-info').textContent = 'Einmessen fehlgeschlagen: ' + e.message;
  }
  btn.disabled = false;
  if (ctx) setMode('run');
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
    tolerance: (v) => `±${Math.max(0, v - 1)}…${v + 1} ct`,
    smoothing: (v) => `${Math.round(tauFor(v) * 1000)} ms`,
    stopThreshold: (v) => `${Math.round(v * 100)} %`,
  };
  bind('a4', 'a4', Number, renderReference);
  bind('timbre', 'timbre', String, () => ref?.setTimbre(S.timbre));
  bind('octave', 'octave', Number, () => currentNote() != null && ref && trackerIO.startReference(currentNote()));
  bind('volume', 'volume', Number, () => ref?.setVolume(S.volume));
  bind('sensitivity', 'sensitivity', Number);
  bind('holdSec', 'holdSec', Number);
  bind('tolerance', 'tolerance', Number, () => (display.tol = S.tolerance));
  bind('smoothing', 'smoothing', Number, () => (display.tau = tauFor(S.smoothing)));
  bind('lang', 'lang', String, renderReference);
  bind('transpose', 'transpose', String, renderReference);
  bind('autoCalib', 'autoCalib', Boolean);
  bind('stopThreshold', 'stopThreshold', Number);
  renderStopInfo();
  $('echo-info').textContent = 'Wird beim Start eingemessen.';
}

$('start').addEventListener('click', () => (mode === 'off' ? start() : stop()));
$('meter').addEventListener('click', () => stopReferenceNow('tap'));
$('open-settings').addEventListener('click', () => $('settings').showModal());
$('close-settings').addEventListener('click', () => $('settings').close());
$('calibrate').addEventListener('click', () => runCalibration(false));
$('train').addEventListener('click', startTraining);
$('train-main').addEventListener('click', startTraining);
$('train-cancel').addEventListener('click', () => { cancelTraining(); $('train-dialog').close(); });
$('train-dialog').addEventListener('close', cancelTraining);
$('stop-reset').addEventListener('click', () => { S.stopTemplate = null; saveSettings(); renderStopInfo(); });
bindSettings();
setMode('off');
renderNote(null);
renderReference();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// für Tests und Fehlersuche
window.dynatune = {
  get state() { return mode === 'run' ? tracker?.state ?? 'idle' : mode; },
  get currentNote() { return currentNote(); },
  get refFreq() { return ref?.freq ?? 0; },
  get lastPitch() { return tracker?.lastPitch ?? null; },
  get calib() { return calib; },
  get lastMsg() { return tracker?.lastMsg ?? null; },
  settings: S,
};
