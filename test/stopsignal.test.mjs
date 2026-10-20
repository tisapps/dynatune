// Trennschärfe des Stoppsignals unter realistischen Schwankungen:
// Vorlage aus 5 Aufnahmen, dann Treffer vs. Fehlauslöser – mit und ohne
// mitklingenden Referenzton (wie im Haltezustand).
import { features, buildTemplate, score } from '../js/stopsignal.js';
import assert from 'node:assert';

const fs = 48000;
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const jit = (v, p) => v * (1 + p * rnd());
const LEN = 4352, PRE = 256;

// Raumhall + Grundrauschen + optional Referenzton (Geige 440 Hz)
function scene(gen, { ref = 0 } = {}) {
  const b = new Float32Array(LEN);
  const level = 10 ** (rnd() * 10 / 20);                  // ±10 dB
  const shift = Math.round(rnd() * 40);                    // Auslöse-Zeitpunkt schwankt
  const dry = new Float32Array(LEN);
  for (let i = 0; i < LEN - PRE - shift; i++) dry[PRE + shift + i] = gen(i / fs, i);
  // einfacher Raumhall: Echos mit abklingender Dichte
  for (let i = 0; i < LEN; i++) {
    let v = dry[i];
    for (const [d, g] of [[211, 0.25], [487, 0.15], [911, 0.08], [1530, 0.04]]) if (i >= d) v += g * dry[i - d];
    b[i] = level * v + 0.002 * rnd();
  }
  if (ref) {
    const ph = Math.random() * 6;
    for (let i = 0; i < LEN; i++) {
      let v = 0;
      [1, 0.62, 0.52, 0.42, 0.33, 0.28, 0.3, 0.2].forEach((a, h) => (v += a * Math.sin(2 * Math.PI * 440 * (h + 1) * i / fs + ph + h)));
      b[i] += ref * v / 8;
    }
  }
  return b;
}

const kinds = {
  // Zungenschnalzen: scharfer Einsatz, Resonanzen um 1–3 kHz
  zunge: () => { const f1 = jit(1400, 0.15), f2 = jit(2600, 0.15), d = jit(0.0025, 0.4);
    return (t) => Math.exp(-t / d) * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t) + 0.2 * rnd()) * 0.5; },
  // Fingerschnipsen: heller, Rauschanteil
  schnipsen: () => { const d = jit(0.004, 0.3), f = jit(3500, 0.15);
    return (t) => Math.exp(-t / d) * (0.5 * rnd() + 0.5 * Math.sin(2 * Math.PI * f * t)) * 0.5; },
  klatschen: () => { const d = jit(0.012, 0.3);
    return (t) => Math.exp(-t / d) * (rnd() * 0.5 + 0.5 * Math.sin(2 * Math.PI * jit(900, 0.1) * t)) * 0.5; },
  geige: () => { const f = jit(440, 0.3);
    return (t) => Math.min(1, t / 0.02) * [1, 0.6, 0.5, 0.4].reduce((a, h, k) => a + h * Math.sin(2 * Math.PI * f * (k + 1) * t), 0) / 6; },
  klopfen: () => { const f = jit(180, 0.2);
    return (t) => Math.exp(-t / 0.01) * Math.sin(2 * Math.PI * f * t) * 0.5 + 0.05 * Math.exp(-t / 0.001) * rnd(); },
  ts: () => (t) => Math.exp(-t / 0.04) * rnd() * 0.25,
  husten: () => (t) => Math.min(1, t / 0.01) * Math.exp(-t / 0.08) * (rnd() * 0.3 + 0.3 * Math.sin(2 * Math.PI * 250 * t)),
};

const HIT = 0.5, FALSE = 0.3;   // Standardschwelle 50 %
let failed = 0;
for (const target of ['zunge', 'schnipsen']) {
  const tpl = buildTemplate([0, 1, 2, 3, 4].map(() => features(scene(kinds[target]()), fs)));
  console.log(`Vorlage: ${target}  (Übereinstimmung beim Einlernen ${tpl.selfScores.map((v) => (v * 100).toFixed(0)).join('/')} %)`);
  for (const ref of [0, 0.03]) {
    for (const [k, mk] of Object.entries(kinds)) {
      const s = Array.from({ length: 40 }, () => score(tpl, features(scene(mk(), { ref }), fs))).sort((a, b) => a - b);
      const p10 = s[4], med = s[20], max = s.at(-1);
      const isTarget = k === target;
      const bad = isTarget ? p10 < HIT : max >= FALSE;
      if (bad) failed++;
      console.log(`  ${ref ? 'mit Ref.' : 'ohne    '}  ${k.padEnd(10)} 10%-Quantil ${(p10 * 100).toFixed(0).padStart(3)} %  Median ${(med * 100).toFixed(0).padStart(3)} %  max ${(max * 100).toFixed(0).padStart(3)} %${bad ? '  ✗' : ''}`);
    }
  }
}
assert.strictEqual(failed, 0, `Stoppsignal: Treffer (10%-Quantil) < ${HIT * 100} % oder Fehlauslöser ≥ ${FALSE * 100} %`);
console.log('OK');
