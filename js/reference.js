// Referenzton-Erzeugung
//
// Prototyp: Klangfarben per additiver Synthese (PeriodicWave). Vorteile:
// exakt gestimmt, beliebig lange haltbar, offline, keine Lizenzfragen.
// Stufe 2 ersetzt/ergänzt das durch geloopte Samples (siehe docs/KONZEPT.md).

// Teiltonamplituden (1. = Grundton), grob an die Instrumente angelehnt
export const TIMBRES = {
  violine:    { label: 'Violine',     harm: [1, 0.62, 0.52, 0.42, 0.33, 0.28, 0.3, 0.2, 0.16, 0.12, 0.1, 0.08, 0.06, 0.05, 0.04, 0.03] },
  floete:     { label: 'Querflöte',   harm: [1, 0.42, 0.14, 0.07, 0.035, 0.015] },
  klarinette: { label: 'Klarinette',  harm: [1, 0.04, 0.62, 0.03, 0.36, 0.03, 0.2, 0.02, 0.12, 0.01, 0.07] },
  oboe:       { label: 'Oboe',        harm: [0.55, 1, 0.82, 0.52, 0.46, 0.3, 0.2, 0.15, 0.1, 0.06] },
  cello:      { label: 'Cello',       harm: [1, 0.8, 0.55, 0.5, 0.35, 0.3, 0.2, 0.18, 0.12, 0.08, 0.05] },
  orgel:      { label: 'Orgel',       harm: [1, 0.5, 0, 0.25, 0, 0, 0, 0.12] },
  sinus:      { label: 'Sinus',       harm: [1] },
};

const ATTACK = 0.025;     // Einschwingen
const XFADE = 0.02;       // Überblendung beim Tonwechsel

export class ReferenceEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 0.6;
    this.waves = {};
    this.timbre = 'violine';
    this.voice = null;
    this.freq = 0;
  }

  wave(name) {
    if (!this.waves[name]) {
      const h = TIMBRES[name].harm;
      const real = new Float32Array(h.length + 1);
      const imag = new Float32Array(h.length + 1);
      for (let i = 0; i < h.length; i++) imag[i + 1] = h[i];
      this.waves[name] = this.ctx.createPeriodicWave(real, imag);
    }
    return this.waves[name];
  }

  setTimbre(name) {
    this.timbre = name;
    if (this.voice) this.voice.osc.setPeriodicWave(this.wave(name));
  }

  setVolume(v) {
    this.output.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  get playing() { return !!this.voice; }

  // Startet den Ton oder wechselt mit kurzer Überblendung auf eine neue Frequenz
  play(freq) {
    const ctx = this.ctx, now = ctx.currentTime;
    if (this.voice && Math.abs(this.voice.osc.frequency.value - freq) < 1e-6) return;
    const old = this.voice;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave(this.timbre));
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + (old ? XFADE : ATTACK));
    osc.connect(env).connect(this.output);
    osc.start(now);
    this.voice = { osc, env };
    this.freq = freq;
    if (old) this.release(old, XFADE);
  }

  stop(fade = 0.3) {
    if (!this.voice) return;
    this.release(this.voice, fade);
    this.voice = null;
    this.freq = 0;
  }

  release(v, fade) {
    const now = this.ctx.currentTime;
    v.env.gain.cancelScheduledValues(now);
    v.env.gain.setValueAtTime(v.env.gain.value, now);
    v.env.gain.linearRampToValueAtTime(0, now + fade);
    v.osc.stop(now + fade + 0.05);
  }
}
