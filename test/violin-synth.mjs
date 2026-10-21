// Synthetische Geige für Tests: Teiltonspektrum, Vibrato, Bogenrauschen,
// Einschwingen, Handy-Mikrofon (Hochpass 300 Hz)
const FS = 48000;

export function violinNote(midi, dur, { cents = 0, a4 = 440, vibrato = 15, seed = 1 } = {}) {
  const f0 = a4 * 2 ** ((midi - 69 + cents / 100) / 12);
  const n = Math.round(dur * FS), y = new Float32Array(n);
  const h = [1, 0.7, 0.55, 0.5, 0.35, 0.3, 0.32, 0.2, 0.15, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04, 0.03];
  let s = seed * 9973 + 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const phs = h.map(() => (rnd() + 1) * 3.14);   // zufällig, aber reproduzierbar
  let ph = 0, nz = 0;
  const vibStart = 0.25 * FS;
  for (let i = 0; i < n; i++) {
    const vibAmt = i < vibStart ? 0 : Math.min(1, (i - vibStart) / (0.2 * FS)) * vibrato;
    const f = f0 * 2 ** ((vibAmt * Math.sin(2 * Math.PI * 5.5 * i / FS)) / 1200);
    ph += (2 * Math.PI * f) / FS;
    let v = 0;
    for (let k = 0; k < h.length && f * (k + 1) < 16000; k++) v += h[k] * Math.sin((k + 1) * ph + phs[k]);
    nz = 0.9 * nz + 0.1 * rnd();
    const env = Math.min(1, i / (0.04 * FS)) * Math.min(1, (n - i) / (0.02 * FS));
    y[i] = env * (0.3 * v / 3 + 0.02 * nz);
  }
  return y;
}

// Handy-Mikrofon: Hochpass 300 Hz (2× Biquad)
export function phoneMic(x) {
  let y = x;
  for (let o = 0; o < 2; o++) {
    const w0 = 2 * Math.PI * 300 / FS, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al;
    const b0 = (1 + cs) / 2 / a0, b1 = -(1 + cs) / a0, a1 = -2 * cs / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const z = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) { const v = b0 * y[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = y[i]; y2 = y1; y1 = v; z[i] = v; }
    y = z;
  }
  return y;
}

// Zungenschnalzen
export function tongueClick(amp = 0.15, seed = 1) {
  let s = seed * 7919 + 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const f1 = 1400 * (1 + 0.1 * rnd()), f2 = 2600 * (1 + 0.1 * rnd()), d = 0.0025 * (1 + 0.3 * rnd());
  const y = new Float32Array(Math.round(0.04 * FS));
  for (let i = 0; i < y.length; i++) {
    const t = i / FS;
    y[i] = amp * Math.exp(-t / d) * (0.6 * Math.sin(2 * Math.PI * f1 * t) + 0.4 * Math.sin(2 * Math.PI * f2 * t) + 0.2 * rnd()) / 0.6;
  }
  return y;
}

// Melodie zusammensetzen: [[midi, Dauer, Pause, Cent], …] → { signal, expected, end }
export function melody(notes, { lead = 0.3, tail = 2.5, a4 = 440 } = {}) {
  const parts = [new Float32Array(Math.round(lead * FS))], expected = [];
  let t = lead, k = 0;
  for (const [m, d, gap, c] of notes) {
    parts.push(violinNote(m, d, { cents: c, a4, seed: ++k }));
    expected.push({ t0: t, t1: t + d, note: m });
    t += d;
    if (gap) { parts.push(new Float32Array(Math.round(gap * FS))); t += gap; }
  }
  parts.push(new Float32Array(Math.round(tail * FS)));
  const x = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { x.set(p, o); o += p.length; }
  return { signal: phoneMic(x), expected, end: t };
}
