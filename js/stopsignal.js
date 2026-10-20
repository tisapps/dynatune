// Stoppsignal (z. B. Zungenschnalzen): einlernen und wiedererkennen
//
// Merkmale je Ereignis (nur aus dem lauten Teil des Ereignisses, damit
// Raumhall, Grundrauschen und ein leise mitklingender Referenzton wenig stören):
//   - Spektralform: 10 logarithmisch verteilte Bänder (400 Hz – 10 kHz) in dB,
//     gemittelt über kurze Rahmen, mittelwertfrei (lautstärkeunabhängig)
//   - spektraler Schwerpunkt (in Oktaven)
//   - Dauer über -20 dB des Spitzenwerts (logarithmisch)
//
// Vergleich: Abstand zur Vorlage in Einheiten der beim Einlernen gemessenen
// Streuung (mit Mindeststreuung), daraus ein Wert 0…1.
// 1 Streuung daneben ≈ 61 %, 1,5 ≈ 32 %, 2 ≈ 14 %.

import { fft } from './dsp.js';

const BANDS = 10, F_LO = 400, F_HI = 10000;
const N = 512, HOP = 128;
const FLOOR = { band: 4, centroid: 0.3, dur: 0.5 };   // dB · Oktaven · log2(ms)
const WEIGHT = { band: 0.5, centroid: 0.25, dur: 0.25 };

export function features(buf, fs) {
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  // Rahmenenergien
  const frames = [];
  for (let off = 0; off + N <= buf.length; off += HOP) {
    let e = 0;
    for (let i = 0; i < N; i++) e += buf[off + i] * buf[off + i];
    frames.push({ off, e });
  }
  let pk = 0;
  frames.forEach((f, i) => { if (f.e > frames[pk].e) pk = i; });
  const thr = frames[pk].e / 100;                        // -20 dB
  let a = pk, b = pk;
  while (a > 0 && frames[a - 1].e > thr && pk - a < 6) a--;
  while (b < frames.length - 1 && frames[b + 1].e > thr && b - pk < 12) b++;

  // Dauer feiner über 32er-Hüllkurve bestimmen
  const step = 32, env = [];
  for (let i = 0; i + step <= buf.length; i += step) {
    let s = 0;
    for (let j = 0; j < step; j++) s += buf[i + j] * buf[i + j];
    env.push(s / step);
  }
  let ep = 0;
  env.forEach((v, i) => { if (v > env[ep]) ep = i; });
  let ea = ep, eb = ep;
  while (ea > 0 && env[ea - 1] > env[ep] / 100) ea--;
  while (eb < env.length - 1 && env[eb + 1] > env[ep] / 100) eb++;
  const durMs = Math.max(0.5, ((eb - ea + 1) * step / fs) * 1000);

  // gemitteltes Leistungsspektrum der lauten Rahmen
  const pow = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = a; k <= b; k++) {
    re.fill(0); im.fill(0);
    const off = frames[k].off;
    for (let i = 0; i < N; i++) re[i] = buf[off + i] * hann[i];
    fft(re, im);
    for (let i = 0; i < N / 2; i++) pow[i] += re[i] * re[i] + im[i] * im[i];
  }

  let num = 0, den = 0;
  for (let i = 1; i < N / 2; i++) {
    const f = (i * fs) / N;
    if (f < F_LO || f > F_HI) continue;
    num += pow[i] * Math.log2(f); den += pow[i];
  }
  const centroid = den > 0 ? num / den : 0;

  const bands = [];
  for (let k = 0; k < BANDS; k++) {
    const lo = F_LO * (F_HI / F_LO) ** (k / BANDS);
    const hi = F_LO * (F_HI / F_LO) ** ((k + 1) / BANDS);
    const i0 = Math.max(1, Math.round((lo * N) / fs));
    const i1 = Math.max(i0 + 1, Math.round((hi * N) / fs));
    let s = 0;
    for (let i = i0; i < i1 && i < N / 2; i++) s += pow[i];
    bands.push(10 * Math.log10(s / (i1 - i0) + 1e-14));
  }
  const mean = bands.reduce((x, v) => x + v, 0) / BANDS;
  return { bands: bands.map((v) => v - mean), centroid, logDur: Math.log2(durMs), durMs };
}

const avg = (xs) => xs.reduce((a, v) => a + v, 0) / xs.length;
const sd = (xs, m) => Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));

function makeTemplate(list) {
  const bands = [], bandSd = [];
  for (let k = 0; k < BANDS; k++) {
    const xs = list.map((f) => f.bands[k]);
    const m = avg(xs);
    bands.push(m); bandSd.push(sd(xs, m));
  }
  const cs = list.map((f) => f.centroid), ds = list.map((f) => f.logDur);
  const centroid = avg(cs), logDur = avg(ds);
  return {
    v: 2, n: list.length,
    bands, bandSd,
    centroid, centroidSd: sd(cs, centroid),
    logDur, logDurSd: sd(ds, logDur),
    durMs: 2 ** logDur,
  };
}

export function buildTemplate(list) {
  const tpl = makeTemplate(list);
  // Übereinstimmung „jeweils gegen die anderen“ (leave-one-out): ehrlicher als gegen sich selbst
  tpl.selfScores = list.length > 2
    ? list.map((f, i) => score(makeTemplate(list.filter((_, j) => j !== i)), f))
    : list.map((f) => score(tpl, f));
  return tpl;
}

export function isValidTemplate(t) { return !!t && t.v === 2; }

export function score(tpl, f) {
  const s = (x, floor) => Math.sqrt(x * x + floor * floor);
  let zb = 0;
  for (let k = 0; k < BANDS; k++) zb += ((f.bands[k] - tpl.bands[k]) / s(tpl.bandSd[k], FLOOR.band)) ** 2;
  zb /= BANDS;
  const zc = ((f.centroid - tpl.centroid) / s(tpl.centroidSd, FLOOR.centroid)) ** 2;
  const zd = ((f.logDur - tpl.logDur) / s(tpl.logDurSd, FLOOR.dur)) ** 2;
  const d2 = WEIGHT.band * zb + WEIGHT.centroid * zc + WEIGHT.dur * zd;
  return Math.exp(-d2 / 2);
}
