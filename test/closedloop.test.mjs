// Geschlossener Kreis: Geige (synthetisch) + Lautsprecher-Echo der eigenen Referenz.
// Prüft Tonwechsel, Oktavfehler, fälschliches Halten, Halten am Ende und
// Stoppsignal – mit und ohne Echo, mit und ohne Kalibrierung.
import { simulate, evaluate } from './sim.mjs';
import { melody, tongueClick } from './violin-synth.mjs';
import { features, buildTemplate } from '../js/stopsignal.js';
import assert from 'node:assert';

const FS = 48000;
const MEL = [[67, 0.9, 0, 0], [69, 0.6, 0, 6], [71, 0.6, 0, -8], [72, 0.9, 0.25, 3], [74, 0.6, 0, 0], [76, 0.6, 0, -5],
  [79, 0.9, 0.25, 0], [76, 0.5, 0, 4], [72, 0.5, 0, 0], [67, 0.9, 0.3, -3], [55, 0.9, 0, 5], [57, 0.7, 0, 0], [62, 0.9, 0.25, 0],
  [81, 0.6, 0, 0], [88, 0.6, 0, 0], [69, 1.0, 0, 0]];
const { signal, expected, end } = melody(MEL, { tail: 3 });

// Stoppsignal: Vorlage aus 5 Schnalzern (wie beim Einlernen, ohne Referenz)
const tpl = buildTemplate([1, 2, 3, 4, 5].map((k) => {
  const b = new Float32Array(4352);
  const c = tongueClick(0.15, k);
  b.set(c, 256);
  return features(b, FS);
}));
// Schnalzer 1,2 s nach dem letzten Ton (im Halten)
const clickAt = Math.round((end + 1.2) * FS);
const click = tongueClick(0.1, 9);
for (let i = 0; i < click.length; i++) signal[clickAt + i] += click[i];

const scenarios = [
  // Standard: Einmessung beim Start (Rauschen + Tonprobe), NLMS wenn Echo messbar
  ['Kopfhörer', {}, { maxHold: 1, maxWrong: 1 }],
  ['Lautsprecher leise', { leak: { gain: 0.25 }, nlms: true }, { maxHold: 2, maxWrong: 1 }],
  ['Lautsprecher mittel', { leak: { gain: 0.5 }, nlms: true }, { maxHold: 3, maxWrong: 1 }],
  ['Lautsprecher laut', { leak: { gain: 1.0 }, nlms: true }, { maxHold: 25, maxWrong: 6, info: true }],
  // Android: lange Laufzeit Lautsprecher → Mikrofon (vorher: Referenz „schlingert“)
  ['mittel, Laufzeit 300 ms', { leak: { gain: 0.5, delayMs: 300 }, nlms: true }, { maxHold: 3, maxWrong: 2, maxSwitch: 0 }],
  ['mittel, Laufzeit 500 ms', { leak: { gain: 0.5, delayMs: 500 }, nlms: true }, { maxHold: 3, maxWrong: 4, maxSwitch: 0 }],   // Sprünge 3:1 kommen ~300 ms verzögert
  ['mittel, Pegelregelung ±3 dB', { leak: { gain: 0.5 }, nlms: true, agc: 3 }, { maxHold: 3, maxWrong: 1, maxSwitch: 0 }],
  ['mittel, Raumhall 0,4 s', { leak: { gain: 0.5, rt60: 0.4 }, nlms: true }, { maxHold: 35, maxWrong: 1, maxSwitch: 1, info: true }],
  ['mittel, ohne Einmessung', { leak: { gain: 0.5 }, calib: false }, { maxHold: 10, maxWrong: 2, info: true }],
];
let fails = 0;
for (const [name, opt, lim] of scenarios) {
  const { timeline, log, echoDb } = simulate(signal, { ...opt, stopTemplate: tpl });
  const r = evaluate(timeline, expected);
  const missed = r.filter((x) => x.latencyMs == null).length;
  const wrong = r.reduce((a, x) => a + x.wrongPct, 0) / r.length;
  const oct = r.reduce((a, x) => a + x.octPct, 0) / r.length;
  const held = r.reduce((a, x) => a + x.holdPct, 0) / r.length;
  const lat = r.map((x) => x.latencyMs).filter((v) => v != null).sort((a, b) => a - b);
  const holdAtEnd = timeline.some((p) => p.t > end + 0.3 && p.t < end + 1.1 && p.state === 'hold');
  const stopped = log.find((e) => e.ev === 'stop' && e.reason === 'signal' && e.t > end + 1.1);
  // nach dem Stopp darf das ausklingende Echo die Referenz nicht neu starten
  const restarted = stopped && log.some((e) => e.ev === 'note' && e.t > stopped.t && e.t < stopped.t + 1.5);
  const extra = log.filter((e) => e.ev === 'note').length - MEL.length;
  const ok = (lim.maxSwitch == null || extra <= lim.maxSwitch) && missed === 0 && wrong <= lim.maxWrong && held <= lim.maxHold && holdAtEnd && !!stopped && !restarted;
  if (!ok && !lim.info) fails++;
  console.log(`${name.padEnd(29)} Wechsel +${String(extra).padEnd(2)} Echo/Geige ${isFinite(echoDb) ? (echoDb >= 0 ? '+' : '') + echoDb.toFixed(0).padStart(2) + ' dB' : '   –  '}  verpasst ${missed}/${r.length}  falsch ${wrong.toFixed(1)} % (Oktave ${oct.toFixed(1)} %)  ` +
    `Latenz Median ${lat[lat.length >> 1]} ms  fälschlich Halten ${held.toFixed(1)} %  Halten am Ende ${holdAtEnd ? 'ja' : 'NEIN'}  ` +
    `Stoppsignal ${stopped ? 'ja' : 'NEIN'}${restarted ? ' (Neustart durch Echo!)' : ''}${ok ? '' : lim.info ? '  (nur Info)' : '  ✗'}`);
}
assert.strictEqual(fails, 0);
console.log('OK');
