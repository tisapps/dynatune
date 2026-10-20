// Stoppsignal (z. B. Zungenschnalzen): einlernen und wiedererkennen
//
// Merkmale je Ereignis:
//   - Spektralform: 12 logarithmisch verteilte Bänder (250 Hz – 12 kHz),
//     in dB, mittelwertfrei (also lautstärkeunabhängig). Wenige breite Bänder,
//     weil das Spektrum sehr kurzer Geräusche sonst zufällig stark schwankt.
//   - spektraler Schwerpunkt (in Oktaven)
//   - Dauer: Zeit über -20 dB des Spitzenwerts
// Vergleich: gewichtete Summe aus Formabstand und Schwerpunktabstand, × Dauerfaktor

import { fft } from './dsp.js';

const BANDS = 12, F_LO = 250, F_HI = 12000, N = 2048;

export function features(buf, fs) {
  // Hüllkurve in 64er-Rahmen
  const frame = 64, env = [];
  for (let i = 0; i + frame <= buf.length; i += frame) {
    let s = 0;
    for (let j = 0; j < frame; j++) s += buf[i + j] * buf[i + j];
    env.push(Math.sqrt(s / frame));
  }
  let pk = 0, pki = 0;
  env.forEach((v, i) => { if (v > pk) { pk = v; pki = i; } });
  let end = pki;
  while (end < env.length - 1 && env[end + 1] > pk * 0.1) end++;
  let start = pki;
  while (start > 0 && env[start - 1] > pk * 0.1) start--;
  const durMs = ((end - start + 1) * frame / fs) * 1000;

  // Spektrum ab kurz vor dem Spitzenwert
  const re = new Float64Array(N), im = new Float64Array(N);
  const off = Math.max(0, pki * frame - 128);
  for (let i = 0; i < N && off + i < buf.length; i++) {
    re[i] = buf[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  fft(re, im);
  const bands = new Float64Array(BANDS);
  let num = 0, den = 0;
  for (let i = 1; i < N / 2; i++) {
    const f = (i * fs) / N;
    if (f < F_LO || f > F_HI) continue;
    const p = re[i] * re[i] + im[i] * im[i];
    num += p * Math.log2(f); den += p;
  }
  const centroid = den > 0 ? num / den : 0;
  for (let b = 0; b < BANDS; b++) {
    const lo = F_LO * (F_HI / F_LO) ** (b / BANDS);
    const hi = F_LO * (F_HI / F_LO) ** ((b + 1) / BANDS);
    const i0 = Math.max(1, Math.floor((lo * N) / fs));
    const i1 = Math.max(i0 + 1, Math.ceil((hi * N) / fs));
    let s = 0;
    for (let i = i0; i < i1 && i < N / 2; i++) s += re[i] * re[i] + im[i] * im[i];
    bands[b] = 10 * Math.log10(s / (i1 - i0) + 1e-12);
  }
  const mean = bands.reduce((a, v) => a + v, 0) / BANDS;
  for (let b = 0; b < BANDS; b++) bands[b] -= mean;
  return { bands: Array.from(bands), centroid, durMs };
}

// mittlerer Abstand der Spektralformen in dB
function bandDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

export function buildTemplate(list) {
  const bands = new Array(BANDS).fill(0);
  for (const f of list) f.bands.forEach((v, i) => (bands[i] += v / list.length));
  const durs = list.map((f) => f.durMs);
  const dur = durs.reduce((a, v) => a + v, 0) / durs.length;
  const sd = Math.sqrt(durs.reduce((a, v) => a + (v - dur) ** 2, 0) / durs.length);
  const cents = list.map((f) => f.centroid);
  const centroid = cents.reduce((a, v) => a + v, 0) / cents.length;
  const tpl = { bands, centroid, durMs: dur, durSd: sd, n: list.length };
  // Selbstkonsistenz: wie ähnlich sind die Aufnahmen der Vorlage?
  tpl.selfScores = list.map((f) => score(tpl, f));
  return tpl;
}

export function score(tpl, f) {
  const shape = Math.exp(-((bandDistance(tpl.bands, f.bands) / 6) ** 2)); // ~6 dB Toleranz
  const cen = Math.exp(-(((f.centroid - tpl.centroid) / 0.6) ** 2));   // ±0,6 Oktaven
  const tol = Math.max(2 * tpl.durSd, 0.5 * tpl.durMs, 8);
  const dur = Math.exp(-(((f.durMs - tpl.durMs) / tol) ** 2));
  return (0.4 * shape + 0.6 * cen) * dur;
}
