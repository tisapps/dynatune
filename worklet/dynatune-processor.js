// Dynatune – AudioWorklet-Prozessor
//
// Eingang 0: Mikrofon
// Eingang 1: Referenzton, so wie er an den Lautsprecher geht (für NLMS)
//
// Aufgaben (alles im Audio-Thread, damit die Reaktionszeit kurz bleibt):
//   1. Gleichanteil entfernen
//   2. NLMS-Echounterdrückung: geschätztes Lautsprecher-Echo vom Mikrofon abziehen
//   3. Tonhöhenerkennung (McLeod Pitch Method, NSDF per FFT) alle HOP Samples
//   4. Transienten-Erkennung für das Stoppsignal (Zungenschnalzen o. ä.)
//   5. Aufnahme für die Echo-Kalibrierung
//
// Die Datei ist bewusst eigenständig (keine Imports), damit sie in allen
// Browsern als Worklet-Modul lädt und in Node getestet werden kann.

const HOP = 256;            // Analyse alle 256 Samples (~5 ms bei 48 kHz)
const W_FAST = 1024;        // kurzes Fenster für schnelle Erkennung
const W_PRECISE = 2048;     // langes Fenster für Präzision bei gehaltenem Ton
const RING = 8192;          // Ringpuffer für das (echobereinigte) Signal
const F_MIN = 60;
const F_MAX = 2200;
const MPM_K = 0.9;          // MPM-Schwelle relativ zum höchsten Maximum
const SINC_HALF = 16;       // Kammfilter-Interpolation: 2 × 16 Stützstellen

class FFT {
  constructor(n) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  // In-place, vorwärts (inverse = false) oder rückwärts (ohne 1/n-Skalierung)
  transform(re, im, inverse = false) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = sgn * this.sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

// Normalisierte Quadratdifferenzfunktion (NSDF) eines Fensters per FFT-Autokorrelation
class Nsdf {
  constructor(w) {
    this.w = w;
    this.fft = new FFT(2 * w);
    this.re = new Float64Array(2 * w);
    this.im = new Float64Array(2 * w);
    this.out = new Float64Array(w);
  }

  compute(x) {
    const w = this.w, re = this.re, im = this.im, out = this.out;
    re.fill(0); im.fill(0);
    for (let i = 0; i < w; i++) re[i] = x[i];
    this.fft.transform(re, im);
    for (let i = 0; i < 2 * w; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, true);
    const scale = 1 / (2 * w);
    let m = 0;
    for (let i = 0; i < w; i++) m += x[i] * x[i];
    m *= 2;
    for (let tau = 0; tau < w; tau++) {
      const r = re[tau] * scale;
      out[tau] = m > 1e-12 ? (2 * r) / m : 0;
      m -= x[tau] * x[tau] + x[w - 1 - tau] * x[w - 1 - tau];
    }
    return out;
  }
}

function parabolic(arr, i) {
  const a = arr[i - 1], b = arr[i], c = arr[i + 1];
  const d = a - 2 * b + c;
  if (d === 0) return { x: i, y: b };
  const p = (0.5 * (a - c)) / d;
  return { x: i + p, y: b - 0.25 * (a - c) * p };
}

// McLeod Pitch Method: liefert Periode (in Samples) und Klarheit
function mpm(nsdf, minTau, maxTau) {
  let tau = 1;
  while (tau < maxTau && nsdf[tau] > 0) tau++;          // erst ins Negative
  const peaks = [];
  let best = -1, bestIdx = -1, positive = false;
  for (; tau < maxTau; tau++) {
    const v = nsdf[tau];
    if (v > 0 && !positive) { positive = true; best = -1; bestIdx = -1; }
    if (positive) {
      if (v > best) { best = v; bestIdx = tau; }
      if (v <= 0) {
        if (bestIdx > 0) peaks.push(bestIdx);
        positive = false;
      }
    }
  }
  if (positive && bestIdx > 0 && bestIdx < maxTau - 1) peaks.push(bestIdx);
  if (!peaks.length) return null;
  let maxVal = 0;
  for (const p of peaks) if (nsdf[p] > maxVal) maxVal = nsdf[p];
  const thr = MPM_K * maxVal;
  for (const p of peaks) {
    if (p < minTau) continue;
    if (nsdf[p] >= thr) {
      const { x, y } = parabolic(nsdf, p);
      return { tau: x, clarity: y };
    }
  }
  return null;
}

// Präzisionsverbesserung: Maximum beim k-fachen der Periode suchen,
// der Interpolationsfehler wird dann durch k geteilt.
function refineTau(nsdf, tau0, limit) {
  const k = Math.floor(limit / tau0);
  if (k < 2) return tau0;
  const center = Math.round(k * tau0);
  let bi = center, bv = -Infinity;
  for (let i = center - 3; i <= center + 3; i++) {
    if (i > 0 && i < nsdf.length - 1 && nsdf[i] > bv) { bv = nsdf[i]; bi = i; }
  }
  if (bv < 0.8) return tau0;
  return parabolic(nsdf, bi).x / k;
}

class DynatuneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fs = sampleRate;
    this.ring = new Float32Array(RING);
    // Kammfilter für die Stoppsignal-Erkennung: zieht das Signal von k Perioden
    // des Referenztons vorher ab → der gleichbleibende Referenzton (mit allen
    // Obertönen) löscht sich aus, kurze Geräusche bleiben erhalten.
    this.ringC = new Float32Array(RING);
    this.combDelay = 0;
    this.ringPos = 0;
    this.sinceHop = 0;
    this.win = new Float64Array(W_PRECISE);
    this.nsdfFast = new Nsdf(W_FAST);
    this.nsdfPrecise = new Nsdf(W_PRECISE);
    this.stRaw = { stable: 0, lastF: 0 };
    this.stComb = { stable: 0, lastF: 0 };
    // Kammfilter über genau eine Periode des Referenztons (fein interpoliert):
    // Das Lautsprecher-Echo der Referenz ist mit dieser Periode streng periodisch
    // (auch mit Verzerrung und Nachhall) und löscht sich vollständig aus.
    // Tonerkennung läuft zusätzlich auf diesem Signal.
    this.ringP = new Float32Array(RING);
    this.refPeriod = 0;
    this.refEnergy = 0;

    // Hochpass (Gleichanteil)
    this.dcX = 0; this.dcY = 0;

    // NLMS
    this.nlmsOn = false;
    this.adapt = false;
    this.mu = 0.3;
    this.L = 256;
    this.delay = 0;
    this.w = new Float32Array(this.L);
    this.refBufSize = 16384;
    this.refBuf = new Float32Array(this.refBufSize * 2); // doppelt, vermeidet Modulo
    this.refPos = 0;
    this.refPow = 0;              // laufende Leistung im Filterfenster
    this.eShort = 0; this.eFloor = 1; this.yShort = 0;
    this.leak = 1 - 2e-6;         // Leaky-NLMS: verhindert Gewichtsdrift bei schmalbandiger Referenz

    // Transienten
    this.transientOn = false;
    this.slowEnergy = 1e-6;
    this.capture = null;
    // Hochpass 1,5 kHz (Biquad) nur für die Auslösung: Schnalzer haben dort viel
    // Energie, der Referenzton und gespielte Töne vergleichsweise wenig.
    {
      const w0 = (2 * Math.PI * 1500) / this.fs, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
      const a0 = 1 + al;
      this.hp = { b0: (1 + cs) / 2 / a0, b1: -(1 + cs) / a0, b2: (1 + cs) / 2 / a0, a1: (-2 * cs) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
    }
    this.cooldown = 0;
    this.clickGate = 1e-5;

    // Kalibrier-Aufnahme
    this.rec = null;

    this.port.onmessage = (ev) => this.onMessage(ev.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'nlms':
        if (m.enabled !== undefined) this.nlmsOn = m.enabled;
        if (m.delay !== undefined) this.delay = Math.max(0, Math.min(this.refBufSize - this.L - 1, m.delay | 0));
        if (m.weights) this.w.set(m.weights.subarray(0, this.L));
        if (m.reset) this.w.fill(0);
        this.eFloor = 1;
        break;
      case 'adapt':
        this.adapt = !!m.value;
        break;
      case 'transient':
        this.transientOn = !!m.value;
        if (m.gate !== undefined) this.clickGate = m.gate;
        break;
      case 'ref':
        this.combDelay = this.pickCombDelay(m.f);
        this.refPeriod = m.f > 0 ? this.fs / m.f : 0;
        if (this.refPeriod > 0) this.makeCombCoef(this.refPeriod);
        this.stComb.stable = 0;
        break;
      case 'record':
        this.rec = { mic: new Float32Array(m.samples), ref: new Float32Array(m.samples), pos: 0 };
        break;
    }
  }

  process(inputs, outputs) {
    const mic = inputs[0] && inputs[0][0];
    const ref = inputs[1] && inputs[1][0];
    const n = mic ? mic.length : 128;
    const L = this.L, w = this.w, size = this.refBufSize, rb = this.refBuf;
    let blockEnergy = 0;
    if (this.nlmsOn) {
      // Fensterleistung je Block neu berechnen (verhindert Rundungsdrift)
      const base0 = this.refPos - 1 - this.delay + size;
      let pw = 0;
      for (let k = 0; k < L; k++) { const v = rb[base0 - k]; pw += v * v; }
      this.refPow = pw;
    }

    for (let i = 0; i < n; i++) {
      // DC-Sperre
      const xin = mic ? mic[i] : 0;
      const x = xin - this.dcX + 0.995 * this.dcY;
      this.dcX = xin; this.dcY = x;

      const r = ref ? ref[i] : 0;
      this.refEnergy = 0.999 * this.refEnergy + 0.001 * r * r;
      // Referenz im doppelten Ringpuffer ablegen
      const p = this.refPos;
      rb[p] = r; rb[p + size] = r;

      if (this.rec) {
        const rc = this.rec;
        rc.mic[rc.pos] = x; rc.ref[rc.pos] = r; rc.pos++;
        if (rc.pos >= rc.mic.length) {
          this.port.postMessage({ type: 'recorded', mic: rc.mic, ref: rc.ref, fs: this.fs });
          this.rec = null;
        }
      }

      let e = x;
      if (this.nlmsOn) {
        // Filtereingang: ref[n - delay - k], k = 0..L-1
        // Index (p - delay - k) im doppelten Puffer: base = p - delay + size
        const base = p - this.delay + size; // base - k bleibt >= 0, da delay + L < size
        // Leistung im Fenster laufend aktualisieren
        const newest = rb[base], oldest = rb[base - L];
        this.refPow += newest * newest - oldest * oldest;
        if (this.refPow < 0) this.refPow = 0;
        let y = 0;
        for (let k = 0; k < L; k++) y += w[k] * rb[base - k];
        e = x - y;
        this.eShort = 0.995 * this.eShort + 0.005 * e * e;
        this.yShort = 0.995 * this.yShort + 0.005 * y * y;
        // Doppelsprech-Schutz: nur adaptieren, wenn kein plötzlicher Anstieg
        // des Restsignals (= Musiker spielt) vorliegt.
        const doubleTalk = this.eShort > 4 * this.eFloor + 1e-8;
        if (this.adapt && this.refPow > 1e-4 && !doubleTalk) {
          const g = (this.mu * e) / (this.refPow + 1e-3);
          const leak = this.leak;
          for (let k = 0; k < L; k++) w[k] = leak * w[k] + g * rb[base - k];
          this.eFloor = 0.999 * this.eFloor + 0.001 * this.eShort;
        } else {
          // langsam lösen, falls sich der Echopfad ändert
          this.eFloor = Math.min(1, this.eFloor * 1.0002);
        }
      }
      this.refPos = (p + 1) % size;

      this.ring[this.ringPos] = e;
      let cv = e;
      if (this.combDelay > 0) {
        const pos = this.ringPos - this.combDelay + RING;
        const i0 = Math.floor(pos), fr = pos - i0;
        cv = e - ((1 - fr) * this.ring[i0 % RING] + fr * this.ring[(i0 + 1) % RING]);
      }
      this.ringC[this.ringPos] = cv;
      if (this.refPeriod > 0) {
        // Wert an Position n - P per gefensterter Sinc-Interpolation (32 Stützstellen,
        // Koeffizienten je Referenzton vorberechnet) – Auslöschung > 70 dB auch bei
        // hohen Tönen mit verzerrten Obertönen
        const c = this.combCoef, base = this.ringPos - this.combBase + RING, R = this.ring;
        let d = 0;
        for (let k = 0; k < c.length; k++) d += c[k] * R[(base + k) % RING];
        this.ringP[this.ringPos] = e - d;
      }
      this.ringPos = (this.ringPos + 1) % RING;
      const h = this.hp;
      const hy = h.b0 * cv + h.b1 * h.x1 + h.b2 * h.x2 - h.a1 * h.y1 - h.a2 * h.y2;
      h.x2 = h.x1; h.x1 = cv; h.y2 = h.y1; h.y1 = hy;
      blockEnergy += hy * hy;

      if (this.capture) {
        const c = this.capture;
        c.buf[c.pos++] = cv;
        if (c.pos >= c.buf.length) {
          this.port.postMessage({ type: 'transient', buf: c.buf, fs: this.fs });
          this.capture = null;
        }
      }
    }

    blockEnergy /= n;
    this.detectTransient(blockEnergy, n);

    this.sinceHop += n;
    if (this.sinceHop >= HOP) {
      this.sinceHop = 0;
      this.analyze();
    }

    const out = outputs[0] && outputs[0][0];
    if (out) out.fill(0);
    return true;
  }

  // Interpolationskoeffizienten für den Wert x(n - P), P = i0 + u (gebrochen).
  // Stützstellen n - i0 + k, k = -half … half-1; Abstand zum Zielpunkt t = k + u.
  // Gewicht: sinc(t) · Hann-Fenster. Nur vergangene Werte (half ≤ i0).
  makeCombCoef(P) {
    const i0 = Math.floor(P), u = P - i0;
    const half = Math.max(2, Math.min(SINC_HALF, i0));
    const coef = new Float64Array(2 * half);
    let sum = 0;
    for (let k = -half; k < half; k++) {
      const t = k + u;
      const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (half + 1));
      coef[k + half] = sinc * w;
      sum += coef[k + half];
    }
    for (let j = 0; j < coef.length; j++) coef[j] /= sum;   // Gleichanteil exakt
    this.combCoef = coef;
    this.combBase = i0 + half;      // ältester Wert: n - i0 - half
  }

  // Verzögerung = k Perioden, mindestens 20 ms (Spektrum des Geräuschs bleibt
  // unverfälscht), k so gewählt, dass sie möglichst genau ganzzahlig ist.
  pickCombDelay(f) {
    if (!(f > 0)) return 0;
    const P = this.fs / f, minD = 0.02 * this.fs, maxD = RING / 2;
    let best = 0, bestErr = Infinity;
    for (let k = Math.ceil(minD / P); k * P <= maxD; k++) {
      const D = k * P, err = Math.abs(D - Math.round(D));
      if (err < bestErr) { bestErr = err; best = D; }
      if (err < 0.01) break;
    }
    return best;
  }

  detectTransient(energy, n) {
    if (this.cooldown > 0) this.cooldown -= n;
    if (this.transientOn && !this.capture && this.cooldown <= 0 &&
        energy > this.clickGate && energy > 6 * this.slowEnergy) {
      // 256 Samples Vorlauf aus dem Ring + 4096 Samples Nachlauf
      const pre = 256, post = 4096;
      const buf = new Float32Array(pre + post);
      for (let i = 0; i < pre + n; i++) {
        buf[i] = this.ringC[(this.ringPos - pre - n + i + RING) % RING];
      }
      this.capture = { buf, pos: pre + n };
      this.cooldown = Math.round(0.35 * this.fs);
    }
    this.slowEnergy = 0.97 * this.slowEnergy + 0.03 * energy;
    if (this.slowEnergy < 1e-9) this.slowEnergy = 1e-9;
  }

  // Tonhöhe eines Ringpuffers bestimmen; st = Stabilitätszustand (Präzisionsfenster)
  detect(ring, st) {
    const fs = this.fs;
    const usePrecise = st.stable >= W_PRECISE / HOP;
    const W = usePrecise ? W_PRECISE : W_FAST;
    const x = this.win;
    let sum = 0;
    for (let i = 0; i < W; i++) {
      const v = ring[(this.ringPos - W + i + RING) % RING];
      x[i] = v; sum += v * v;
    }
    const rms = Math.sqrt(sum / W);

    let res = null;
    if (rms > 1e-4) {
      const nsdf = (usePrecise ? this.nsdfPrecise : this.nsdfFast).compute(x);
      const minTau = Math.floor(fs / F_MAX);
      const maxTau = Math.min(Math.floor(W / 2), Math.ceil(fs / F_MIN));
      res = mpm(nsdf, minTau, maxTau);
      if (res) res.tau = refineTau(nsdf, res.tau, W / 2);
      // tiefer Ton im kurzen Fenster: mit langem Fenster nachrechnen
      if (!usePrecise && (!res || fs / res.tau < 130)) {
        const W2 = W_PRECISE;
        for (let i = 0; i < W2; i++) x[i] = ring[(this.ringPos - W2 + i + RING) % RING];
        const n2 = this.nsdfPrecise.compute(x);
        const r2 = mpm(n2, minTau, Math.min(W2 / 2, Math.ceil(fs / F_MIN)));
        if (r2) { r2.tau = refineTau(n2, r2.tau, W2 / 2); res = r2; }
      }
    }

    let f = 0, clarity = 0;
    if (res && res.tau > 0) {
      f = fs / res.tau;
      clarity = res.clarity;
      if (f < F_MIN || f > F_MAX) { f = 0; clarity = 0; }
    }

    // Stabilität für das Präzisionsfenster
    if (f > 0 && clarity > 0.85 && st.lastF > 0 && Math.abs(1200 * Math.log2(f / st.lastF)) < 30) st.stable++;
    else st.stable = 0;
    st.lastF = f;
    return { f, clarity, rms, precise: usePrecise };
  }

  analyze() {
    const raw = this.detect(this.ring, this.stRaw);
    const msg = {
      type: 'pitch', f: raw.f, clarity: raw.clarity, rms: raw.rms, precise: raw.precise,
      refRms: Math.sqrt(this.refEnergy),
      echo: this.nlmsOn ? Math.sqrt(this.yShort) : 0,   // NLMS-Schätzung des Echos für den aktuellen Ton
      t: currentTime,
    };
    // Zusätzlich auf dem Signal ohne Referenz-Echo (Kammfilter über eine Referenzperiode)
    if (this.refPeriod > 0) {
      const c = this.detect(this.ringP, this.stComb);
      msg.fc = c.f; msg.cc = c.clarity; msg.rmsC = c.rms;
    }
    this.port.postMessage(msg);
  }

}

registerProcessor('dynatune-processor', DynatuneProcessor);
