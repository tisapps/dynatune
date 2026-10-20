// Trennschärfe des Stoppsignals: Vorlage aus 4 Aufnahmen, dann Treffer vs. Fehlauslöser
import { features, buildTemplate, score } from '../js/stopsignal.js';
import assert from 'node:assert';

const fs = 48000;
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const jit = (v, p) => v * (1 + p * rnd());

function event(gen, len = 4352, pre = 256) {
  const b = new Float32Array(len);
  for (let i = 0; i < len - pre; i++) b[pre + i] = gen(i / fs, i);
  return b;
}
const kinds = {
  // Zungenschnalzen: scharfer Einsatz, Resonanzen um 1–3 kHz, Abklingen ~8 ms
  zunge: () => { const f1 = jit(1400, 0.08), f2 = jit(2600, 0.08), d = jit(0.0025, 0.2);
    return event((t) => Math.exp(-t / d) * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t) + 0.15 * rnd())); },
  // Breitbandiger Knack (weißes Rauschen, ~5 ms)
  knack: () => { const d = jit(0.002, 0.2); return event((t) => Math.exp(-t / d) * rnd()); },
  // Händeklatschen: länger, tiefer
  klatschen: () => { const d = jit(0.012, 0.2); return event((t, i) => Math.exp(-t / d) * (rnd() * 0.5 + 0.5 * Math.sin(2 * Math.PI * 900 * t)) * (t < 0.0005 ? t / 0.0005 : 1)); },
  // Tonbeginn Geige (harmonisch, gehalten)
  geige: () => { const f = jit(440, 0.3); return event((t) => Math.min(1, t / 0.02) * [1, 0.6, 0.5, 0.4].reduce((a, h, k) => a + h * Math.sin(2 * Math.PI * f * (k + 1) * t), 0) / 3); },
  // Klopfen auf Holz (tiefer Rumms)
  klopfen: () => { const f = jit(180, 0.2); return event((t) => Math.exp(-t / 0.01) * Math.sin(2 * Math.PI * f * t) + 0.1 * Math.exp(-t / 0.001) * rnd()); },
  // Zischlaut "ts" (Rauschen hochfrequent, lang)
  ts: () => event((t, i) => Math.exp(-t / 0.04) * (rnd() - 0.8 * (i > 0 ? 0 : 0)) * 0.5),
};

let failed = 0;
for (const target of ['zunge', 'knack']) {
  const tpl = buildTemplate([0, 1, 2, 3].map(() => features(kinds[target](), fs)));
  const rows = [];
  for (const [k, gen] of Object.entries(kinds)) {
    const s = Array.from({ length: 20 }, () => score(tpl, features(gen(), fs)));
    const min = Math.min(...s), max = Math.max(...s);
    rows.push(`${k.padEnd(10)} min ${(min * 100).toFixed(0).padStart(3)} %  max ${(max * 100).toFixed(0).padStart(3)} %`);
    if (k === target && min < 0.6) failed++;
    if (k !== target && k !== 'zunge' && k !== 'knack' && max >= 0.3) failed++;
  }
  console.log(`Vorlage: ${target}  (Selbstwerte ${tpl.selfScores.map((v) => (v * 100).toFixed(0)).join('/')} %)\n  ` + rows.join('\n  '));
}
assert.strictEqual(failed, 0, 'Stoppsignal: Treffer < 60 % oder Fehlauslöser ≥ 30 %');
console.log('OK');
