// Geschlossene Simulation: Spieler → Mikrofon ← Lautsprecher-Echo der Referenz
//
// Pro 128er-Block: Referenz synthetisieren (wie die App), über einen simulierten
// Handy-Lautsprecher (Verzögerung, Hochpass, leichte Verzerrung) zum Mikrofon
// zurückführen, mit dem Spielersignal mischen, Worklet + Tracker laufen lassen.

import { loadProcessor } from './load-worklet.mjs';
import { Tracker, gateFor } from '../js/tracker.js';
import { TIMBRES } from '../js/reference.js';
import { freqFromMidi } from '../js/tuning.js';
import { trainNlms } from '../js/calibrate.js';
import { features, score } from '../js/stopsignal.js';

const FS = 48000, B = 128;

function biquadHP(fc) {
  const w0 = (2 * Math.PI * fc) / FS, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const c = { b0: (1 + cs) / 2 / a0, b1: -(1 + cs) / a0, b2: (1 + cs) / 2 / a0, a1: (-2 * cs) / a0, a2: (1 - al) / a0 };
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

// Lautsprecher + Raum: Verzögerung, kaum Bässe, leichte Sättigung, etwas Nachhall
export function makeSpeaker({ gain = 0.5, delayMs = 30, hp = 450 } = {}) {
  const d = Math.round((delayMs / 1000) * FS);
  const buf = new Float32Array(1 << 16);
  let w = 0;
  const h1 = biquadHP(hp), h2 = biquadHP(hp);
  const taps = [[0, 1], [37, 0.35], [151, -0.2], [433, 0.12], [977, 0.06]];
  return (x) => {
    buf[w & 0xffff] = x;
    let v = 0;
    for (const [t, g] of taps) v += g * buf[(w - d - t) & 0xffff];
    w++;
    v = h2(h1(v)) * gain * 3;
    return Math.tanh(v * 1.5) / 1.5;             // leichte Lautsprecher-Verzerrung
  };
}

// Kalibrierung wie in der App: Rauschen über den Lautsprecher, NLMS vortrainieren
// (nur wenn ein Echo messbar ist), dann Referenzton → Echo-Pegel (leakGain)
export function calibrate(proc, speaker, timbre = 'violine') {
  let nl = null;
  if (speaker) nl = calibrateNlms(proc, speaker);
  // Tonprobe: 0,5 s Referenz A4, Pegelverhältnis Mikrofon(Rest) / Referenz
  const synth = new RefSynth(timbre);
  synth.play(440);
  proc.send({ type: 'ref', f: 440 });
  const mic = new Float32Array(B), ref = new Float32Array(B), out = [[new Float32Array(B)]];
  const ratios = [], ks = [];
  let s = 5;
  for (let i = 0; i < 0.5 * FS; i += B) {
    for (let j = 0; j < B; j++) { const r = synth.sample(); ref[j] = r; mic[j] = (speaker ? speaker(r) : 0) + 0.002 * (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1); }
    proc.process([[mic], [ref]], out);
    for (const m of proc.port._out.splice(0)) {
      if (m.type !== 'pitch' || i < 0.2 * FS) continue;
      if (m.refRms > 1e-3) ratios.push(m.rms / m.refRms);
      if (m.echo > 1e-4) ks.push(m.rms / m.echo);
    }
  }
  // Ausklingen lassen
  synth.stop();
  proc.send({ type: 'ref', f: 0 });
  for (let i = 0; i < 0.4 * FS; i += B) { for (let j = 0; j < B; j++) { ref[j] = synth.sample(); mic[j] = speaker ? speaker(ref[j]) : 0; } proc.process([[mic], [ref]], out); proc.port._out.length = 0; }
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null);
  return { ...nl, leakGain: med(ratios), echoK: med(ks) };
}

function calibrateNlms(proc, speaker) {
  const n = Math.round(1.2 * FS);
  const ref = new Float32Array(n), mic = new Float32Array(n);
  let s = 7;
  for (let i = Math.round(0.15 * FS); i < Math.round(0.65 * FS); i++) ref[i] = 0.25 * (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
  for (let i = 0; i < n; i++) mic[i] = speaker(ref[i]);
  // Laufzeit per Kreuzkorrelation (grob, direkt)
  let best = 0, lag = 0;
  for (let L = 0; L < 0.2 * FS; L += 1) {
    let c = 0;
    for (let i = Math.round(0.15 * FS); i < Math.round(0.45 * FS); i += 4) c += mic[i + L] * ref[i];
    if (Math.abs(c) > best) { best = Math.abs(c); lag = L; }
  }
  const delay = Math.max(0, lag - 32);
  const { weights, erleDb } = trainNlms(mic, ref, delay, 256);
  proc.send({ type: 'nlms', enabled: true, delay, weights });
  return { delay, erleDb };
}

// Referenz-Synthese wie ReferenceEngine (Teiltöne, Einschwingen, Überblendung)
class RefSynth {
  constructor(timbre = 'violine') {
    this.h = TIMBRES[timbre].harm;
    const norm = this.h.reduce((a, v) => a + Math.abs(v), 0);
    this.h = this.h.map((v) => v / norm);
    this.voices = [];
    this.freq = 0;
  }
  play(f) {
    for (const v of this.voices) v.target = 0;
    this.voices.push({ f, ph: 0, amp: 0, target: 1, rate: 1 / (0.02 * FS) });
    this.freq = f;
  }
  stop() { for (const v of this.voices) { v.target = 0; v.rate = 1 / (0.3 * FS); } this.freq = 0; }
  sample() {
    let out = 0;
    for (const v of this.voices) {
      v.amp += Math.sign(v.target - v.amp) * Math.min(v.rate, Math.abs(v.target - v.amp));
      let s = 0;
      for (let k = 0; k < this.h.length; k++) s += this.h[k] * Math.sin((k + 1) * v.ph);
      v.ph += (2 * Math.PI * v.f) / FS;
      out += v.amp * s;
    }
    this.voices = this.voices.filter((v) => v.amp > 0 || v.target > 0);
    return 0.6 * out;
  }
}

export function simulate(player, {
  a4 = 440, octave = 0, sensitivity = 6, holdSec = 20, timbre = 'violine',
  leak = null, nlms = false, calib = true, noise = 0.002, onBlock = null,
  stopTemplate = null, stopThreshold = 0.5,
} = {}) {
  const proc = loadProcessor(FS);
  const speaker = leak ? makeSpeaker(leak) : null;
  // Einmessung beim Start (wie die App); nlms=false simuliert Kalibrierung ohne NLMS-Filter
  let cal = null;
  if (calib) {
    cal = calibrate(proc, leak ? makeSpeaker(leak) : null, timbre);
    if (!nlms) proc.send({ type: 'nlms', enabled: false });
  }
  const synth = new RefSynth(timbre);
  const log = [];
  let t = 0, refNote = null;
  const io = {
    startReference(note) { refNote = note; synth.play(freqFromMidi(note + octave, a4)); proc.send({ type: 'ref', f: synth.freq }); log.push({ t, ev: 'note', note }); },
    stopReference(reason) { refNote = null; synth.stop(); proc.send({ type: 'ref', f: 0 }); log.push({ t, ev: 'stop', reason }); },
    setState(s) {
      log.push({ t, ev: 'state', s });
      proc.send({ type: 'transient', value: s === 'hold', gate: gateFor(sensitivity) ** 2 });
    },
    refFreq: () => synth.freq,
    show() {}, readout() {},
  };
  const tracker = new Tracker(io, { a4, sensitivity, holdSec, leakGain: cal?.leakGain, echoK: nlms ? cal?.echoK : null });
  const mic = new Float32Array(B), ref = new Float32Array(B), out = [[new Float32Array(B)]];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const timeline = [];
  let eL = 0, eP = 0;      // Energie Echo / Spieler, solange die Referenz klingt
  for (let i = 0; i + B <= player.length; i += B) {
    for (let j = 0; j < B; j++) {
      const r = synth.sample();
      ref[j] = r;
      const l = speaker ? speaker(r) : 0;
      mic[j] = player[i + j] + l + noise * rnd();
      if (r !== 0) { eL += l * l; eP += player[i + j] * player[i + j]; }
    }
    proc.process([[mic], [ref]], out);
    for (const m of proc.port._out.splice(0)) {
      if (m.type === 'pitch') tracker.pitch(m, t * 1000);
      if (m.type === 'transient' && stopTemplate && tracker.stopSignalAllowed(t * 1000)) {
        const sc = score(stopTemplate, features(m.buf, FS));
        log.push({ t, ev: 'transient', score: sc });
        if (sc >= stopThreshold) tracker.stopReference('signal', t * 1000);
      }
    }
    t = (i + B) / FS;
    timeline.push({ t, note: refNote, state: tracker.state, cents: tracker.lastPitch?.cents ?? null });
    if (onBlock) onBlock(t, tracker, proc);
  }
  return { log, timeline, tracker, cal, echoDb: eL > 0 ? 10 * Math.log10(eL / eP) : -Infinity };
}

// Auswertung gegen erwartete Notenfolge [{ t0, t1, note }]
export function evaluate(timeline, expected, { settle = 0.15 } = {}) {
  const res = [];
  for (const e of expected) {
    const seg = timeline.filter((p) => p.t >= e.t0 && p.t < e.t1);
    const first = seg.find((p) => p.note === e.note);
    const after = seg.filter((p) => p.t >= e.t0 + settle);
    const wrong = after.filter((p) => p.note !== null && p.note !== e.note);
    const oct = wrong.filter((p) => Math.abs(p.note - e.note) % 12 === 0);
    const held = after.filter((p) => p.state !== 'tracking');
    res.push({
      note: e.note,
      latencyMs: first ? Math.round((first.t - e.t0) * 1000) : null,
      wrongPct: after.length ? (100 * wrong.length) / after.length : 0,
      octPct: after.length ? (100 * oct.length) / after.length : 0,
      wrongNotes: [...new Set(wrong.map((p) => p.note))],
      holdPct: after.length ? (100 * held.length) / after.length : 0,
    });
  }
  return res;
}
