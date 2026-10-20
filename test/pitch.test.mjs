import { loadProcessor } from './load-worklet.mjs';
import assert from 'node:assert';

const fs = 48000;
function tone(f, sec, harm = [1, 0.6, 0.5, 0.45, 0.3, 0.25, 0.3, 0.2], amp = 0.3, noise = 0.003) {
  const n = Math.round(sec * fs), x = new Float32Array(n);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * f * (h + 1) * i / fs + h);
    x[i] = amp * v / harm.length + noise * rnd();
  }
  return x;
}
const cents = (a, b) => 1200 * Math.log2(a / b);

let worst = 0, rows = [];
for (const [name, f0] of [['G3', 196], ['A4', 440], ['D4', 293.66], ['E6', 1318.5], ['C3', 130.81], ['E2', 82.41]]) {
  for (const off of [-17, -3, 0, 2.5, 11]) {
    const f = f0 * 2 ** (off / 1200);
    const p = loadProcessor(fs);
    const msgs = p.feed(tone(f, 0.5)).filter(m => m.type === 'pitch');
    const firstOk = msgs.findIndex(m => m.f > 0 && Math.abs(cents(m.f, f)) < 20 && m.clarity > 0.8);
    const tail = msgs.slice(-20);
    const err = Math.max(...tail.map(m => Math.abs(cents(m.f, f))));
    worst = Math.max(worst, err);
    rows.push(`${name}${off >= 0 ? '+' : ''}${off}c  erkannt nach ${((firstOk + 1) * 256 / fs * 1000).toFixed(1)} ms  max. Fehler (gehalten) ${err.toFixed(3)} c  präzise=${tail.at(-1).precise}`);
    assert.ok(firstOk >= 0, `kein Ton erkannt: ${name}`);
  }
}
console.log(rows.join('\n'));
console.log('schlechtester Fehler:', worst.toFixed(3), 'Cent');
assert.ok(worst < 0.5, 'Genauigkeit unter 0.5 Cent erwartet');

// Flöte (fast Sinus) und Klarinette (ungerade Harmonische)
for (const harm of [[1, 0.3, 0.1], [1, 0.05, 0.6, 0.04, 0.35, 0.03, 0.2]]) {
  const p = loadProcessor(fs);
  const f = 523.25 * 2 ** (4 / 1200);
  const m = p.feed(tone(f, 0.4, harm)).filter(m => m.type === 'pitch').slice(-5);
  const e = Math.max(...m.map(m => Math.abs(cents(m.f, f))));
  console.log('Spektrum', JSON.stringify(harm), 'Fehler', e.toFixed(3));
  assert.ok(e < 0.5);
}

// NLMS: Echo = verzögerter, gefilterter Referenzton; Musiker schweigt
{
  const p = loadProcessor(fs);
  const n = fs * 6;
  const ref = tone(440, 6, [1, 0.5, 0.3], 0.5, 0);
  const D = 900;
  const mic = new Float32Array(n);
  for (let i = D + 40; i < n; i++) mic[i] = 0.4 * ref[i - D] + 0.2 * ref[i - D - 3] - 0.1 * ref[i - D - 40];
  p.send({ type: 'nlms', enabled: true, delay: D - 32 });
  p.send({ type: 'adapt', value: true });
  const msgs = p.feed(mic, ref).filter(m => m.type === 'pitch');
  const micRms = Math.sqrt(mic.slice(-4800).reduce((a, v) => a + v * v, 0) / 4800);
  const resRms = msgs.at(-1).rms;
  const erle = 20 * Math.log10(micRms / resRms);
  console.log('NLMS Echodämpfung nach 6 s:', erle.toFixed(1), 'dB');
  assert.ok(erle > 20);
}
console.log('OK');

// Doppelsprechen: Filter auf Referenz eingelernt, dann spielt der Musiker 4 Cent daneben.
// Die Unterdrückung darf den Musiker nicht wegfiltern.
{
  const p = loadProcessor(fs);
  const D = 600, sec = 2.5, n = Math.round(sec * fs);
  const ref = tone(440, sec, [1, 0.5, 0.3], 0.5, 0);
  const player = tone(440 * 2 ** (4 / 1200), sec, [1, 0.6, 0.5, 0.4], 0.3, 0.002);
  const mic = new Float32Array(n);
  for (let i = D; i < n; i++) mic[i] = 0.4 * ref[i - D] + (i > 1.5 * fs ? player[i] : 0);
  p.send({ type: 'nlms', enabled: true, delay: D - 32 });
  p.send({ type: 'adapt', value: true });           // ungünstigster Fall: Adaption bleibt an
  const msgs = p.feed(mic, ref).filter(m => m.type === 'pitch');
  const tail = msgs.slice(-40);
  const c = tail.map(m => cents(m.f, 440));
  const mean = c.reduce((a, v) => a + v, 0) / c.length;
  console.log(`Doppelsprechen: erkannt ${mean.toFixed(2)} ct (Musiker +4 ct), Restpegel ${tail.at(-1).rms.toFixed(3)}`);
  assert.ok(Math.abs(mean - 4) < 0.5, 'Musiker muss trotz Echounterdrückung erkannt werden');
}
console.log('OK (Doppelsprechen)');

// Stoppsignal-Auslöser im Haltezustand: Referenz klingt laut übers Mikrofon mit
// (ohne Echounterdrückung), Schnalzer ist nicht lauter als die Referenz.
{
  const sec = 2, n = sec * fs;
  for (const [label, clickAmp, expect] of [['Schnalzer gleich laut wie Referenz', 0.25, true], ['Schnalzer 6 dB leiser', 0.125, true], ['Schnalzer 12 dB leiser', 0.0625, true], ['ohne Schnalzer', 0, false]]) {
    const p = loadProcessor(fs);
    p.send({ type: 'transient', value: true, gate: 0.004 ** 2 });
    p.send({ type: 'ref', f: 440 });
    const mic = tone(440, sec, [1, 0.62, 0.52, 0.42, 0.33, 0.28, 0.3, 0.2], 0.6, 0.001);
    let s2 = 1;
    const r = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const at = Math.round(1.2 * fs);
    for (let i = 0; i < 0.03 * fs; i++) {
      const t = i / fs;
      mic[at + i] += clickAmp * Math.exp(-t / 0.0025) * (0.6 * Math.sin(2 * Math.PI * 1400 * t) + 0.4 * Math.sin(2 * Math.PI * 2600 * t) + 0.2 * r()) / 0.6;
    }
    p.feed(mic.subarray(0, fs));                       // Einschwingen (Toneinsatz zählt nicht)
    const tr = p.feed(mic.subarray(fs)).filter(m => m.type === 'transient');
    const refPeak = Math.max(...mic.slice(0, at).map(Math.abs));
    console.log(`Auslöser: ${label} (Ref.-Spitze ${refPeak.toFixed(2)}): ${tr.length} Ereignis(se)`);
    assert.ok(expect ? tr.length >= 1 : tr.length === 0);
  }
}
console.log('OK (Auslöser)');
