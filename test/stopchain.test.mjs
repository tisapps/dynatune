// Ganze Kette Stoppsignal: Worklet-Auslöser + Merkmale + Vergleich.
// Einlernen ohne Referenz, Erkennen im Haltezustand mit laut mitklingender Referenz
// (ohne Echounterdrückung = ungünstigster Fall).
import { loadProcessor } from './load-worklet.mjs';
import { features, buildTemplate, score } from '../js/stopsignal.js';
import assert from 'node:assert';

const fs = 48000;
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const jit = (v, p) => v * (1 + p * rnd());

function addClick(x, at, amp) {
  const f1 = jit(1400, 0.15), f2 = jit(2600, 0.15), d = jit(0.0025, 0.4);
  for (let i = 0; i < 0.04 * fs; i++) {
    const t = i / fs;
    x[at + i] += amp * Math.exp(-t / d) * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t) + 0.2 * rnd()) / 0.6;
  }
}
function addClap(x, at, amp) {
  for (let i = 0; i < 0.06 * fs; i++) { const t = i / fs; x[at + i] += amp * Math.exp(-t / 0.012) * (rnd() * 0.5 + 0.5 * Math.sin(2 * Math.PI * 900 * t)); }
}
function refTone(n, f, amp) {
  const x = new Float32Array(n);
  const h = [1, 0.62, 0.52, 0.42, 0.33, 0.28, 0.3, 0.2, 0.16, 0.12];
  for (let i = 0; i < n; i++) { let v = 0; h.forEach((a, k) => (v += a * Math.sin(2 * Math.PI * f * (k + 1) * i / fs + k))); x[i] = amp * v / h.length; }
  return x;
}

// Einlernen: 5 Schnalzer, leises Grundrauschen, keine Referenz
const p = loadProcessor(fs);
p.send({ type: 'transient', value: true, gate: 0.002 ** 2 });
const train = new Float32Array(6 * fs);
for (let i = 0; i < train.length; i++) train[i] = 0.002 * rnd();
for (let k = 0; k < 5; k++) addClick(train, Math.round((0.5 + k) * fs), 0.2 * 10 ** (rnd() * 6 / 20));
const caps = p.feed(train).filter((m) => m.type === 'transient');
assert.strictEqual(caps.length, 5, `5 Lernaufnahmen erwartet, erhalten ${caps.length}`);
const tpl = buildTemplate(caps.map((m) => features(m.buf, fs)));
console.log('Übereinstimmung beim Einlernen:', tpl.selfScores.map((v) => Math.round(v * 100)).join('/'), '%');

// Halten: Referenz 440 Hz laut übers Mikrofon, Schnalzer unterschiedlich laut, dazu Klatschen
let fails = 0;
for (const [label, add, amp, want] of [
  ['Schnalzer 0 dB', addClick, 0.25, true], ['Schnalzer −6 dB', addClick, 0.125, true], ['Schnalzer −12 dB', addClick, 0.0625, true],
  ['Klatschen', addClap, 0.25, false],
]) {
  const res = [];
  for (let r = 0; r < 5; r++) {
    const q = loadProcessor(fs);
    q.send({ type: 'transient', value: true, gate: 0.002 ** 2 });
    q.send({ type: 'ref', f: 440 });
    const x = refTone(2 * fs, 440, 0.6);
    for (let i = 0; i < x.length; i++) x[i] += 0.002 * rnd();
    q.feed(x.subarray(0, fs));
    add(x, Math.round(1.2 * fs), amp);
    const ev = q.feed(x.subarray(fs)).filter((m) => m.type === 'transient');
    res.push(ev.length ? Math.max(...ev.map((m) => score(tpl, features(m.buf, fs)))) : 0);
  }
  const stops = res.filter((v) => v >= 0.5).length;
  const ok = want ? stops >= 4 : stops === 0;
  if (!ok) fails++;
  console.log(`${label.padEnd(17)} Werte ${res.map((v) => String(Math.round(v * 100)).padStart(3)).join(' ')} %  → ${stops}/5 stoppt ${ok ? '' : '✗'}`);
}
assert.strictEqual(fails, 0);
console.log('OK');
