// Lädt den Worklet-Prozessor in Node (Globals werden nachgebildet)
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadProcessor(fs = 48000) {
  let Cls = null;
  const ctx = {
    sampleRate: fs,
    currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => this.port._out.push(m), _out: [], onmessage: null }; } },
    registerProcessor: (name, c) => { Cls = c; },
    Math, Float32Array, Float64Array, Uint32Array,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../worklet/dynatune-processor.js', import.meta.url), 'utf8'), ctx);
  const proc = new Cls();
  // Signal blockweise einspeisen
  proc.feed = (mic, ref = null) => {
    const out = [[new Float32Array(128)]];
    for (let i = 0; i + 128 <= mic.length; i += 128) {
      proc.process([[mic.subarray(i, i + 128)], ref ? [ref.subarray(i, i + 128)] : []], out);
      ctx.currentTime += 128 / fs;
    }
    const msgs = proc.port._out; proc.port._out = [];
    return msgs;
  };
  proc.send = (m) => proc.port.onmessage({ data: m });
  return proc;
}
