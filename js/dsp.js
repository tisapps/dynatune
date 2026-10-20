// Signalverarbeitung im Hauptthread (Kalibrierung, Stoppsignal-Merkmale)

export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / size;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

export const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(n));

// Kreuzkorrelation c[lag] = sum mic[i + lag] * ref[i], lag = 0..maxLag
export function crossCorrelate(mic, ref, maxLag) {
  const n = nextPow2(mic.length + ref.length);
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(mic); br.set(ref);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  const out = new Float64Array(maxLag + 1);
  for (let i = 0; i <= maxLag; i++) out[i] = ar[i] / n;
  return out;
}
