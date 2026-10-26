// Stimmen: Spieler hält einen Ton und zieht ihn langsam an die Referenz heran
// (−25 → +12 → 0 ct, mit natürlicher Mikroschwankung ±1 ct), dann Stille.
// Prüft, dass die Anzeige nahe der Referenz durchgehend einen genauen Wert hat
// (auch mit Lautsprecher-Echo, Laufzeit und Raumhall) und danach das Halten folgt.
import { simulate } from './sim.mjs';
import { phoneMic } from './violin-synth.mjs';
import assert from 'node:assert';

const FS = 48000, DUR = 6.5, TAIL = 1.5;
const centsAt = (t) => (t < 0.5 ? -25 : t < 2.5 ? -25 + 37 * (t - 0.5) / 2 : t < 4.5 ? 12 - 12 * (t - 2.5) / 2 : 0)
  + 0.7 * Math.sin(2 * Math.PI * 1.3 * t) + 0.3 * Math.sin(2 * Math.PI * 3.1 * t + 1);

const x = new Float32Array(Math.round((DUR + TAIL) * FS));
{
  const h = [1, 0.7, 0.55, 0.5, 0.35, 0.3, 0.32, 0.2, 0.15, 0.12, 0.1, 0.08];
  let ph = 0;
  for (let i = 0; i < DUR * FS; i++) {
    const t = i / FS;
    ph += 2 * Math.PI * 440 * 2 ** (centsAt(t) / 1200) / FS;
    let v = 0; for (let k = 0; k < h.length; k++) v += h[k] * Math.sin((k + 1) * ph + k);
    x[i] = 0.1 * v * Math.min(1, t / 0.05, (DUR - t) / 0.02);
  }
}
const signal = phoneMic(x);

let fails = 0;
for (const [name, opt] of [
  ['Kopfhörer', {}],
  ['Lautsprecher leise', { leak: { gain: 0.25 }, nlms: true }],
  ['Lautsprecher mittel', { leak: { gain: 0.5 }, nlms: true }],
  ['mittel, 300 ms, Hall 0,4 s', { leak: { gain: 0.5, delayMs: 300, rt60: 0.4 }, nlms: true }],
]) {
  const near = [];
  let holdAfter = null;
  const { echoDb } = simulate(signal, { ...opt, onBlock: (t, tr) => {
    if (t > 0.6 && t < DUR - 0.2 && Math.abs(centsAt(t)) <= 8) near.push({ shown: tr.state === 'tracking' ? tr._shown : null, truth: centsAt(t) });
    if (holdAfter == null && t > DUR && tr.state === 'hold') holdAfter = t - DUR;
  } });
  const ok = near.filter((r) => r.shown != null);
  const err = ok.map((r) => Math.abs(r.shown - r.truth)).sort((a, b) => a - b);
  const cover = ok.length / near.length, med = err[err.length >> 1], p90 = err[Math.floor(err.length * 0.9)];
  const pass = cover >= 0.9 && med <= 1 && p90 <= 3 && holdAfter != null && holdAfter <= 1.2;
  if (!pass) fails++;
  console.log(`${name.padEnd(28)} Echo ${isFinite(echoDb) ? echoDb.toFixed(0).padStart(2) + ' dB' : '  – '}  nahe Referenz angezeigt ${(100 * cover).toFixed(0)} %  ` +
    `Fehler Median ${med.toFixed(1)} ct / 90 % ${p90.toFixed(1)} ct  Halten ${holdAfter != null ? Math.round(holdAfter * 1000) + ' ms' : 'NIE'} nach Spielende${pass ? '' : '  ✗'}`);
}
assert.strictEqual(fails, 0);
console.log('OK');
