// Diagnose-Aufnahme: 20 s Mikrofon + gesendete Referenz (WAV, 32 bit float,
// links Mikrofon, rechts Referenz) und ein Protokoll (JSON) mit Einstellungen,
// Einmess-Ergebnis und allen Zustands- und Notenwechseln. Mit
// test/replay.mjs lässt sich die Aufnahme exakt durch den Code schicken.

export class DiagRecorder {
  constructor() { this.log = null; this.t0 = 0; }

  get active() { return this.log != null; }

  event(ev, data = {}) {
    if (this.log) this.log.push({ t: +((performance.now() - this.t0) / 1000).toFixed(4), ev, ...data });
  }

  start(node, ctx, seconds, meta) {
    this.log = [];
    this.t0 = performance.now();
    this.meta = meta;
    this.ctxT0 = ctx.currentTime;
    return new Promise((resolve) => {
      const prev = node.port.onmessage;
      node.port.onmessage = (ev) => {
        if (ev.data.type === 'diagDone') {
          node.port.onmessage = prev;
          const log = this.log;
          this.log = null;
          resolve({ ...ev.data, log, meta: this.meta });
        } else if (prev) prev(ev);
      };
      node.port.postMessage({ type: 'diag', samples: Math.round(seconds * ctx.sampleRate) });
    });
  }
}

export function wavFloat32Stereo(left, right, fs) {
  const n = left.length, bytes = 44 + n * 8;
  const buf = new ArrayBuffer(bytes), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true);
  v.setUint32(24, fs, true); v.setUint32(28, fs * 8, true); v.setUint16(32, 8, true); v.setUint16(34, 32, true);
  str(36, 'data'); v.setUint32(40, n * 8, true);
  for (let i = 0, o = 44; i < n; i++, o += 8) { v.setFloat32(o, left[i], true); v.setFloat32(o + 4, right[i], true); }
  return new Blob([buf], { type: 'audio/wav' });
}

// Teilen (Smartphone: Mail, Messenger, Drive …) oder herunterladen
export async function shareOrDownload(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: 'Dynatune-Diagnose' }); return 'geteilt'; }
    catch (e) { if (e.name === 'AbortError') return 'abgebrochen'; }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  return 'heruntergeladen';
}
