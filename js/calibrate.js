// Einmessen: Echo des Lautsprechers bestimmen
//
// 1. Rauschen (0,5 s) über den Lautsprecher, gleichzeitig Mikrofon und
//    gesendetes Signal aufnehmen. Die Kreuzkorrelation liefert die Laufzeit
//    (Ausgabe-Latenz + Schallweg + Eingabe-Latenz); darauf wird das NLMS-Filter
//    trainiert (= Frequenzgang Lautsprecher → Mikrofon).
// 2. Tonprobe (Referenzklang A4, 0,5 s): wie stark ist das Rest-Echo nach der
//    Unterdrückung? Daraus erwartet die Notenlogik später das Echo jedes Tons –
//    nötig, um „Musiker spielt genau den Referenzton“ von „nur Echo“ zu trennen.

import { crossCorrelate } from './dsp.js';

export const NLMS_TAPS = 256;   // muss zum Worklet passen
const PRE_TAPS = 32;            // Filter beginnt etwas vor dem Hauptechopfad

function waitFor(port, type) {
  return new Promise((resolve) => {
    const prev = port.onmessage;
    port.onmessage = (ev) => {
      if (ev.data.type === type) { port.onmessage = prev; resolve(ev.data); }
      else if (prev) prev(ev);
    };
  });
}

export async function calibrateEcho(ctx, node, refBus, level = 0.25) {
  const fs = ctx.sampleRate;
  const total = Math.round(1.2 * fs);
  node.port.postMessage({ type: 'nlms', enabled: false });
  const recorded = waitFor(node.port, 'recorded');
  node.port.postMessage({ type: 'record', samples: total });

  // 0,5 s weißes Rauschen mit kurzen Rampen
  const len = Math.round(0.5 * fs);
  const buf = ctx.createBuffer(1, len, fs);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const ramp = Math.min(1, i / 480, (len - i) / 480);
    d[i] = (Math.random() * 2 - 1) * ramp;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = level;
  src.connect(g).connect(refBus);
  src.start(ctx.currentTime + 0.15);

  const { mic, ref } = await recorded;
  src.disconnect(); g.disconnect();

  const maxLag = Math.round(0.3 * fs);
  const c = crossCorrelate(mic, ref, maxLag);
  let peak = 0, lag = 0;
  for (let i = 0; i <= maxLag; i++) if (Math.abs(c[i]) > peak) { peak = Math.abs(c[i]); lag = i; }
  let em = 0, er = 0;
  for (let i = 0; i < mic.length; i++) { em += mic[i] * mic[i]; er += ref[i] * ref[i]; }
  const strength = peak / Math.sqrt(em * er + 1e-20);
  const echoDb = 10 * Math.log10(em / (er + 1e-20) + 1e-12);

  if (strength < 0.04 || em < 1e-6) {
    return { ok: false, reason: 'Kein Echo messbar – vermutlich Kopfhörer. Unterdrückung nicht nötig.', strength, latencyMs: null };
  }

  const delay = Math.max(0, lag - PRE_TAPS);
  const { weights, erleDb } = trainNlms(mic, ref, delay, NLMS_TAPS);
  node.port.postMessage({ type: 'nlms', enabled: true, delay, weights, reset: false });
  return { ok: true, delay, latencyMs: (lag / fs) * 1000, strength, erleDb, echoDb };
}

export function trainNlms(mic, ref, delay, L, passes = 4, mu = 0.5) {
  const w = new Float32Array(L);
  const n = mic.length;
  let errEnd = 0, micEnd = 0;
  for (let pass = 0; pass < passes; pass++) {
    let pw = 0;
    for (let i = 0; i < n; i++) {
      const j0 = i - delay;
      const xin = j0 >= 0 && j0 < n ? ref[j0] : 0;
      const jo = j0 - L;
      const xout = jo >= 0 && jo < n ? ref[jo] : 0;
      pw += xin * xin - xout * xout;
      if (pw < 0) pw = 0;
      let y = 0;
      for (let k = 0; k < L; k++) { const j = j0 - k; if (j < 0) break; y += w[k] * ref[j]; }
      const e = mic[i] - y;
      if (pw > 1e-4) {
        const g = (mu * e) / (pw + 1e-3);
        for (let k = 0; k < L; k++) { const j = j0 - k; if (j < 0) break; w[k] += g * ref[j]; }
      }
      if (pass === passes - 1 && pw > 1e-4) { errEnd += e * e; micEnd += mic[i] * mic[i]; }
    }
  }
  return { weights: w, erleDb: 10 * Math.log10((micEnd + 1e-20) / (errEnd + 1e-20)) };
}

// Tonprobe: Referenzklang spielen, Verhältnis Rest-Echo / Referenzpegel bzw.
// Rest-Echo / NLMS-Echoschätzung messen (Median über 0,25 … 0,55 s)
export async function probeEcho(ctx, node, ref) {
  const ratios = [], ks = [];
  const prev = node.port.onmessage;
  const t0 = ctx.currentTime;
  node.port.onmessage = (ev) => {
    const m = ev.data;
    if (m.type !== 'pitch') { if (prev) prev(ev); return; }
    const dt = ctx.currentTime - t0;
    if (dt < 0.25 || dt > 0.55) return;
    if (m.refRms > 1e-3) ratios.push(m.rms / m.refRms);
    if (m.echo > 1e-4) ks.push(m.rms / m.echo);
  };
  ref.play(440);
  node.port.postMessage({ type: 'ref', f: 440 });
  await new Promise((r) => setTimeout(r, 600));
  ref.stop(0.05);
  node.port.postMessage({ type: 'ref', f: 0 });
  await new Promise((r) => setTimeout(r, 350));     // Echo ausklingen lassen
  node.port.onmessage = prev;
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : null);
  return { leakGain: med(ratios), echoK: med(ks) };
}
