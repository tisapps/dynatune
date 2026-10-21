// Diagnose-Aufnahme vom Gerät nachspielen:
//   node test/replay.mjs dynatune-diagnose-XXXX.wav [dynatune-diagnose-XXXX.json] [--frames]
// Schickt Mikrofon und gesendete Referenz exakt so durch Worklet und Notenlogik,
// wie sie auf dem Gerät ankamen, und vergleicht die Entscheidungen mit dem
// Protokoll des Geräts.
import { readFileSync } from 'node:fs';
import { loadProcessor } from './load-worklet.mjs';
import { Tracker } from '../js/tracker.js';
import { noteName } from '../js/tuning.js';

const args = process.argv.slice(2);
const wavPath = args.find((a) => a.endsWith('.wav'));
const jsonPath = args.find((a) => a.endsWith('.json')) ?? wavPath.replace(/\.wav$/, '.json');
const showFrames = args.includes('--frames');

function readWav(path) {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12, fmt = null, data = null;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4), size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), fs: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') data = { off: o + 8, size };
    o += 8 + size + (size & 1);
  }
  if (!fmt || fmt.format !== 3 || fmt.bits !== 32 || fmt.ch !== 2) throw new Error('erwartet: WAV 32 bit float, stereo');
  const n = data.size / 8, mic = new Float32Array(n), ref = new Float32Array(n);
  for (let i = 0; i < n; i++) { mic[i] = v.getFloat32(data.off + i * 8, true); ref[i] = v.getFloat32(data.off + i * 8 + 4, true); }
  return { fs: fmt.fs, mic, ref };
}

const { fs, mic, ref } = readWav(wavPath);
const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
const S = meta.settings, cal = meta.calib || {};
const name = (n) => { if (n == null) return '–'; const x = noteName(n, 'de'); return x.name + x.octave; };

console.log(`Gerät: ${meta.userAgent}`);
console.log(`Abtastrate ${fs} Hz · Ausgabelatenz ${meta.outputLatency != null ? (meta.outputLatency * 1000).toFixed(0) + ' ms' : '–'} · Dauer ${(mic.length / fs).toFixed(1)} s`);
console.log(`Einmessen: ${cal.ok ? `Echo-Laufzeit ${cal.latencyMs?.toFixed(0)} ms, Nachhall ${cal.tailMs?.toFixed(0)} ms, NLMS ${cal.erleDb?.toFixed(0)} dB` : 'kein Echo / nicht eingemessen'} · leakGain ${cal.leakGain?.toFixed(3)} · echoK ${cal.echoK?.toFixed(3)}`);
let pk = 0, sq = 0; for (const x of mic) { pk = Math.max(pk, Math.abs(x)); sq += x * x; }
console.log(`Mikrofon: Spitze ${pk.toFixed(3)}, Mittel ${Math.sqrt(sq / mic.length).toFixed(4)}${pk > 0.99 ? '  ⚠ ÜBERSTEUERT' : ''}`);

const proc = loadProcessor(fs);
if (cal.ok) {
  proc.send({ type: 'nlms', enabled: true, delay: cal.delay, weights: Float32Array.from(cal.weights) });
  proc.send({ type: 'echoDelay', samples: cal.lag, tailSamples: Math.round(((cal.tailMs || 0) / 1000) * fs) });
}
// Referenzwechsel aus dem Protokoll (Zeitpunkt → Sample)
const refEvents = [];
if (meta.initial?.refFreq) refEvents.push({ i: 0, f: meta.initial.refFreq });
for (const e of meta.log) {
  if (e.ev === 'note') refEvents.push({ i: Math.round(e.t * fs), f: e.f });
  if (e.ev === 'stop') refEvents.push({ i: Math.round(e.t * fs), f: 0 });
}
let curRef = 0;
const replayLog = [];
let t = 0;
const io = {
  startReference(note) { replayLog.push({ t, ev: 'note', note }); },
  stopReference(reason) { replayLog.push({ t, ev: 'stop', reason }); },
  setState(s) { replayLog.push({ t, ev: 'state', s }); },
  refFreq: () => curRef,
  show() {}, readout() {},
};
const tracker = new Tracker(io, { a4: S.a4, sensitivity: S.sensitivity, holdSec: S.holdSec, leakGain: cal.leakGain, echoK: cal.ok ? cal.echoK : null, tailMs: cal.ok ? cal.tailMs : 0 });
if (meta.initial?.note != null) { tracker.currentNote = meta.initial.note; tracker.state = meta.initial.state === 'hold' ? 'hold' : 'tracking'; }

const B = 128, out = [[new Float32Array(B)]];
let k = 0;
for (let i = 0; i + B <= mic.length; i += B) {
  while (k < refEvents.length && refEvents[k].i <= i) { curRef = refEvents[k].f; proc.send({ type: 'ref', f: curRef }); k++; }
  proc.process([[mic.subarray(i, i + B)], [ref.subarray(i, i + B)]], out);
  t = (i + B) / fs;
  for (const m of proc.port._out.splice(0)) {
    if (m.type !== 'pitch') continue;
    tracker.pitch(m, t * 1000);
    if (showFrames && Math.round(t * 1000) % 20 < 3) {
      const p = tracker.lastPitch;
      console.log(`${t.toFixed(3)} ${tracker.state.padEnd(8)} ref ${name(tracker.currentNote).padEnd(4)} f=${m.f.toFixed(1)} c=${m.clarity.toFixed(2)} rms=${m.rms.toFixed(4)} fc=${(m.fc ?? 0).toFixed(1)} cc=${(m.cc ?? 0).toFixed(2)} rmsC=${(m.rmsC ?? 0).toFixed(4)} refRms=${m.refRms.toFixed(3)} echo=${m.echo.toFixed(3)} → ${p ? name(p.note) + ' ' + (p.cents?.toFixed(1) ?? '?') + ' ' + p.kind : '–'}`);
    }
  }
}

const fmt = (l) => l.filter((e) => e.ev !== 'transient').map((e) => `${e.t.toFixed(2)} ${e.ev === 'note' ? name(e.note) : e.ev === 'state' ? e.s : 'stop(' + e.reason + ')'}`).join(' · ');
console.log('\nGerät:        ' + fmt(meta.log));
console.log('\nNachgespielt: ' + fmt(replayLog));
