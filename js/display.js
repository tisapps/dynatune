// Grafische Anzeige: senkrecht bewegliches, farbiges Objekt + Verlaufsspur

export const RANGE = 20;         // Erkennungsbreite ±20 Cent
const VIEW = 25;                 // sichtbarer Bereich (Graubereich außerhalb ±20)
const TRAIL_SEC = 3;

const VIOLET = [147, 51, 234];
const BLUE = [37, 99, 235];
const GREEN = [34, 197, 94];
const YELLOW = [250, 204, 21];
const ORANGE = [249, 115, 22];
const GRAY = [140, 140, 150];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// Violett (zu tief) – Blau – Grün (±Toleranz) – Gelb – Orange (zu hoch)
export function colorFor(cents, tol) {
  if (cents == null || Math.abs(cents) > RANGE) return GRAY;
  const a = Math.abs(cents);
  if (a <= tol) return GREEN;
  const t = Math.min(1, (a - tol) / (RANGE - tol));
  return cents < 0 ? mix(BLUE, VIOLET, t) : mix(YELLOW, ORANGE, t);
}

export class TunerDisplay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tol = 3;
    this.trail = [];
    this.cents = null;    // geglätteter Anzeigewert
    this.active = false;  // Musiker spielt gerade
    this.dimmed = false;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // cents: Rohwert der aktuellen Messung (null = kein Ton); jump: neuer Ton
  push(cents, t, jump = false) {
    if (cents == null) {
      this.active = false;
    } else {
      this.active = true;
      // leichte Glättung, bei Tonwechsel sofort springen
      this.cents = jump || this.cents == null ? cents : this.cents + 0.35 * (cents - this.cents);
    }
    this.trail.push({ t, c: cents == null ? null : this.cents });
    while (this.trail.length && this.trail[0].t < t - TRAIL_SEC) this.trail.shift();
  }

  reset() { this.trail = []; this.cents = null; this.active = false; }

  y(c) {
    const pad = 28;
    const cl = Math.max(-VIEW, Math.min(VIEW, c));
    return this.h / 2 - (cl / VIEW) * (this.h / 2 - pad);
  }

  draw(now) {
    const { ctx, w, h } = this;
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg-muted').trim() || '#888';
    const line = css.getPropertyValue('--line').trim() || '#ccc';
    ctx.clearRect(0, 0, w, h);

    const ballX = w * 0.68;
    const stripX = w - 22;

    // Graubereiche außerhalb ±20 Cent
    ctx.fillStyle = rgb(GRAY, 0.12);
    ctx.fillRect(0, 0, w, this.y(RANGE));
    ctx.fillRect(0, this.y(-RANGE), w, h - this.y(-RANGE));

    // Toleranzband (grün)
    ctx.fillStyle = rgb(GREEN, 0.14);
    ctx.fillRect(0, this.y(this.tol), w, this.y(-this.tol) - this.y(this.tol));

    // Farbleiste rechts
    for (let c = -RANGE; c < RANGE; c += 0.5) {
      ctx.fillStyle = rgb(colorFor(c + 0.25, this.tol));
      ctx.fillRect(stripX, this.y(c + 0.5), 8, this.y(c) - this.y(c + 0.5) + 0.5);
    }

    // Skala
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let c = -RANGE; c <= RANGE; c += 5) {
      const y = this.y(c);
      ctx.strokeStyle = line;
      ctx.lineWidth = c === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(c === 0 ? 0 : w * 0.06, y);
      ctx.lineTo(stripX - 6, y);
      ctx.stroke();
      if (c % 10 === 0) {
        ctx.fillStyle = fg;
        ctx.fillText(c > 0 ? `+${c}` : `${c}`, stripX - 10, y - 9);
      }
    }

    // Verlaufsspur
    const tr = this.trail;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1], b = tr[i];
      if (a.c == null || b.c == null) continue;
      const xa = ballX - ((now - a.t) / TRAIL_SEC) * ballX;
      const xb = ballX - ((now - b.t) / TRAIL_SEC) * ballX;
      const age = (now - b.t) / TRAIL_SEC;
      ctx.strokeStyle = rgb(colorFor(b.c, this.tol), 0.85 * (1 - age));
      ctx.beginPath();
      ctx.moveTo(xa, this.y(a.c));
      ctx.lineTo(xb, this.y(b.c));
      ctx.stroke();
    }

    // Objekt
    if (this.cents != null) {
      const col = this.active ? colorFor(this.cents, this.tol) : GRAY;
      const alpha = this.active ? 1 : 0.35;
      const y = this.y(this.cents);
      const r = Math.min(26, w * 0.07);
      ctx.save();
      ctx.shadowColor = rgb(col, 0.8 * alpha);
      ctx.shadowBlur = this.active ? 24 : 0;
      ctx.fillStyle = rgb(col, alpha);
      ctx.beginPath();
      ctx.arc(ballX, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
