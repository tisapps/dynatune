// Notenlogik / Zustandsautomat (ohne DOM, damit in Node simulierbar)
//
// Zustände: idle | tracking | hold
// Eingabe: Messungen des Worklets mit Zeitstempel in ms:
//   f, clarity, rms   – Tonhöhe des (echobereinigten) Mikrofonsignals
//   fc, cc, rmsC      – Tonhöhe nach Kammfilter über eine Referenzperiode
//                       (Echo des Referenztons vollständig entfernt), nur wenn Referenz klingt
//   refRms            – Pegel des gesendeten Referenztons
// Ausgabe über io-Rückrufe:
//   io.startReference(note)   io.stopReference(reason)   io.setState(s)
//   io.refFreq()              → aktuell klingende Referenzfrequenz (0 = aus)
//   io.show(cents|null, jump) io.readout(note, cents, gray, jump)
//
// Grundgedanke: Das Mikrofon hört ohne Kopfhörer den eigenen Referenzton mit.
// Die Mischung aus Spieler und Referenz hat oft eine gemeinsame Unterperiode
// (z. B. G4 + A4 → C3), daher werden Tonwechsel auf dem Kammfilter-Signal
// erkannt, in dem die Referenz fehlt. Spielt der Musiker genau den
// Referenzton (oder dessen Oktave), verschwindet er dort mit – dieser Fall wird
// über den Pegel entschieden: Mikrofon deutlich lauter als das erwartete Echo.

import { analyzeFreq, centsBetween } from './tuning.js';

export const RANGE = 20;            // Erkennungsbreite ±20 Cent
const STABLE_FRAMES = 3;            // gleiche Note in 3 Messungen (~16 ms) bis Ton gilt
const OCTAVE_FRAMES = 8;            // Oktavwechsel brauchen länger (~40 ms)
const SILENCE_MS = 120;             // so lange kein Ton → Haltezustand
const CLARITY_MIN = 0.8;
const FAMILY_CENTS = 1.2;           // so nah an Referenz (oder Vielfachen) = Echo der Referenz
const PREV_REF_MS = 300;            // nach Tonwechsel: Echo des alten Referenztons ignorieren
const TAIL_MAX_MS = 700;            // erweiterter Schutz höchstens so lange (Raumhall)
const STOP_ECHO_MS = 600;           // nach Stopp: Echo des ausklingenden Tons ignorieren
const PREV_SUB_MS = 150;            // … und dessen Unterharmonische (Mischklänge mit dem Spieler)
const LEAK_FACTOR = 1.8;            // Mikrofon > 1,8 × erwartetes Echo → Musiker spielt
const TONELESS_FRAMES = 6;          // ~30 ms tonloser Aktivität beenden das Halten
const MIX_ECHO_MAX = 0.25;          // Mischsignal-Tonhöhe nur, wenn Echo < 25 % des Spielers
const COMB_SHARE = 0.2;             // Kammfilter-Signal muss ≥ 20 % des Spielerpegels haben

export const gateFor = (s) => 0.05 * 10 ** (-(s - 1) / 4.5);

function inFamily(f, rf, tol = FAMILY_CENTS) {
  if (!rf || !f) return false;
  for (let k = 1; k <= 4; k++) {
    if (Math.abs(centsBetween(f, rf * k)) < tol) return true;
    if (Math.abs(centsBetween(f, rf / k)) < tol) return true;
  }
  return false;
}

// f ≈ rf / k für eine ganze Zahl k ≥ 2 (±50 Cent)?
function isSubharmonic(f, rf) {
  if (!f || !rf || f >= rf * 0.75) return false;
  const k = Math.round(rf / f);
  return k >= 2 && Math.abs(centsBetween(f * k, rf)) < 50;
}

export class Tracker {
  constructor(io, settings) {
    this.io = io;
    this.S = settings;              // { a4, sensitivity, holdSec, leakGain? }
    this.state = 'idle';
    this.currentNote = null;
    this.candidate = { note: null, count: 0 };
    this.grayCount = 0;
    this.silenceSince = null;
    this.holdStart = 0;
    // erwartetes Rest-Echo: bevorzugt echoK × NLMS-Echoschätzung (frequenzabhängig,
    // weil das Filter den Lautsprecher-Frequenzgang kennt), sonst leakGain × Referenzpegel
    this.echoK = settings.echoK ?? null;
    this.leakGain = settings.leakGain ?? null;
    this.prevRef = { f: 0, from: 0, until: 0 };
    this.toneless = 0;              // Messungen „Musiker aktiv, aber Tonhöhe unklar“ in Folge
    this.holdEndedAt = -Infinity;
    this.tailMs = settings.tailMs ?? 0;  // gemessener Nachhall des Echos (Raumhall)
    this.arrivalKnown = false;      // meldet das Worklet den ankommenden Referenzton?
    this.lastArr = 0;
    this.lastPitch = null;
  }

  setState(s, now) {
    if (s === this.state) return;
    if (this.state === 'hold') this.holdEndedAt = now;
    this.state = s;
    if (s === 'hold') this.holdStart = now;
    this.io.setState(s);
  }

  startReference(note, now) {
    if (!this.arrivalKnown) {
      const old = this.io.refFreq();
      if (old) this.prevRef = { f: old, from: now, until: now + PREV_REF_MS };
    }
    this.currentNote = note;
    this.io.startReference(note);
  }

  stopReference(reason, now) {
    // ausklingendes Echo des gestoppten Tons darf nicht als neuer Ton gelten
    const old = this.io.refFreq();
    if (old && !this.arrivalKnown) this.prevRef = { f: old, from: now, until: now + STOP_ECHO_MS };
    this.currentNote = null;
    this.io.stopReference(reason);
    if (this.state === 'hold' || this.state === 'tracking') this.setState('idle', now);
  }

  reset() {
    this.currentNote = null;
    this.candidate = { note: null, count: 0 };
    this.grayCount = 0;
    this.silenceSince = null;
    this.state = 'idle';
  }

  // Echo-Pegel im Halten lernen (nur Referenz klingt): schnell nach unten, langsam nach oben
  learnLeak(m) {
    const upd = (v, x) => (v == null ? x : x < v ? v + 0.3 * (x - v) : v + 0.01 * (x - v));
    if (m.refRms > 1e-3) this.leakGain = upd(this.leakGain, m.rms / m.refRms);
    if (m.echo > 1e-4) this.echoK = upd(this.echoK, m.rms / m.echo);
  }

  expectedEcho(m) {
    if (m.echo > 1e-4 && this.echoK != null) return this.echoK * m.echo;
    if (this.leakGain != null) return this.leakGain * m.refRms;
    return null;
  }

  // Spielt der Musiker nahe der Referenz (z. B. mit Vibrato), bleiben im
  // Kammfilter-Signal nur obere Teiltöne übrig – die Erkennung greift dort
  // gern eine Unterharmonische der Referenz (A5 → D4 = A5/3). Erkennbar daran,
  // dass das Gesamtsignal weiter auf der Referenz liegt. Ein echter Sprung nach
  // unten (A5 → A4) zeigt sich dagegen auch im Gesamtsignal.
  subharmonicArtifact(m, rf) {
    if (!isSubharmonic(m.fc, rf)) return false;
    if (!(m.f > 0 && m.clarity >= CLARITY_MIN)) return true;
    const nearRef = Math.abs(centsBetween(m.f, rf)) < 50 ||
      (this.currentNote != null && Math.abs(analyzeFreq(m.f, this.S.a4).note - this.currentNote) === 0);
    return nearRef;
  }

  // Liefert die Wahrnehmung des Spielers: { note, cents, f, kind } oder null (Stille)
  //   kind: 'free'   – Ton eindeutig erkannt (ohne Referenz oder im Kammfilter-Signal)
  //         'unison' – Musiker spielt den Referenzton/dessen Oktave (nur über Pegel erkannt)
  perceive(m, now) {
    const gate = gateFor(this.S.sensitivity);
    // maßgeblich ist der Ton, dessen Echo gerade am Mikrofon ankommt (bei langer
    // Laufzeit noch der vorige) – das meldet das Worklet; sonst der gesendete
    const rf = m.rfArr !== undefined ? m.rfArr : this.io.refFreq();
    const a4 = this.S.a4;

    // Echo des alten Referenztons kurz nach einem Wechsel/Stopp – auch als Mischklang
    // mit dem Spieler (gemeinsame Unterperiode, z. B. A5-Echo + E6 → A4)
    const oldEcho = (f) => {
      if (now >= this.prevRef.until) return false;
      if (inFamily(f, this.prevRef.f)) return true;
      // in den ersten 150 ms ist das abklingende Echo durch den Spieler leicht verfälscht
      if (now < this.prevRef.from + (this.prevRef.wide ?? PREV_SUB_MS)) {
        if (inFamily(f, this.prevRef.f, 20)) return true;
        if (isSubharmonic(f, this.prevRef.f)) return true;
      }
      return false;
    };

    if (!rf || m.fc === undefined) {
      if (m.f > 0 && m.clarity >= CLARITY_MIN && m.rms >= gate && !oldEcho(m.f)) return { ...analyzeFreq(m.f, a4), f: m.f, kind: 'free' };
      return null;
    }

    // geschätzter Spielerpegel (Mikrofon minus erwartetes Echo)
    const echo = this.expectedEcho(m) ?? 0;
    const playerRms = Math.sqrt(Math.max(m.rms * m.rms - echo * echo, 0));

    // 1. Kammfilter-Signal: Spieler ohne Referenz-Echo. Nur wenn dort ein
    //    nennenswerter Teil des Spielers ankommt – liegt der Spieler fast auf
    //    der Referenz, bleibt nur ein schwacher Rest (unsichere Oktave).
    if (m.fc > 0 && m.cc >= CLARITY_MIN && m.rmsC >= gate * 0.5 && m.rmsC >= COMB_SHARE * playerRms &&
        !inFamily(m.fc, rf, 0.6) && !oldEcho(m.fc) && !this.subharmonicArtifact(m, rf)) {
      const c = analyzeFreq(m.fc, a4);
      // widerspricht das Gesamtsignal (eindeutiger anderer Ton, kein Echo)? Dann
      // braucht der Wechsel länger – fängt Ausrutscher der Erkennung im
      // Kammfilter-Signal ab (z. B. 5/4 der Frequenz, wenn untere Teiltöne fehlen)
      const rawOk = m.f > 0 && m.clarity >= CLARITY_MIN && !inFamily(m.f, rf) && !oldEcho(m.f);
      const disputed = rawOk && analyzeFreq(m.f, a4).note !== c.note;
      return { ...c, f: m.fc, kind: 'free', src: 'comb', disputed };
    }

    // 2. Spielt der Musiker zusätzlich zum Echo (im Zusammenklang mit der Referenz)?
    //    a) Pegel deutlich über dem erwarteten Echo, oder
    //    b) Tonhöhe des Gesamtsignals weicht von der Referenz ab: Das reine Echo
    //       hat exakt die Referenzfrequenz; mit Spieler verschieben Schwebung und
    //       Vibrato die gemessene Tonhöhe. (Wichtig, weil sich Spieler und Echo bei
    //       Schwebung zeitweise auslöschen – der Pegel allein wäre unzuverlässig.)
    const rawValid = m.f > 0 && m.clarity >= CLARITY_MIN;
    const exp = this.expectedEcho(m);
    const levelActive = exp != null && m.rms > LEAK_FACTOR * exp + 0.5 * gate;
    const pitchActive = rawValid && !inFamily(m.f, rf) && !oldEcho(m.f);
    //    c) schwache, aber plausible Tonhöhe im Kammfilter-Signal nahe der Referenz
    //       (obere Teiltöne eines Spielers mit Vibrato; reines Echo ist dort restlos weg)
    let combHint = false;
    if (m.fc > 0 && m.cc >= 0.6 && m.rmsC >= gate * 0.2 && !oldEcho(m.fc)) {
      const d = Math.abs(centsBetween(m.fc, rf));
      combHint = d > FAMILY_CENTS && d < 60;
    }
    const active = m.rms >= gate && (levelActive || pitchActive || combHint);
    if (!active) return null;

    // Musiker klingt mit der Referenz zusammen (gleiche Tonklasse). Die Tonhöhe
    // der Mischung ist nur für die Cent-Abweichung brauchbar; als Notenwechsel
    // zählt allein ein Oktavsprung nach OBEN (der ist im Kammfilter-Signal
    // unsichtbar, weil alle Teiltöne auf Referenz-Teiltöne fallen).
    const cur = this.currentNote;
    if (cur != null && m.f > 0 && m.clarity >= CLARITY_MIN && !oldEcho(m.f)) {
      const raw = analyzeFreq(m.f, a4);
      if ((raw.note - cur) % 12 === 0) {
        // Das Gesamtsignal ist eine Mischung aus Spieler und Echo – seine Tonhöhe ist
        // zur Referenz hin verfälscht. Nur verwenden, wenn das Echo deutlich leiser ist.
        let cents = echo < MIX_ECHO_MAX * playerRms ? raw.cents : null, f = m.f;
        // genauere Cent-Werte aus dem Kammfilter-Signal (obere Teiltöne), falls vorhanden
        if (m.fc > 0 && m.cc >= 0.5 && m.rmsC >= gate * 0.2 && !inFamily(m.fc, rf, 0.5)) {
          const c = analyzeFreq(m.fc, a4);
          if ((c.note - cur) % 12 === 0) { cents = c.cents; f = m.fc; }
        }
        return { note: raw.note > cur ? raw.note : cur, cents, f, kind: 'unison', src: f === m.f ? 'mix' : 'comb' };
      }
    }
    return { note: cur, cents: null, f: 0, kind: 'unison' };
  }

  // Darf ein Stoppsignal jetzt wirken? Im Halten – oder kurz danach, falls das
  // Geräusch selbst das Halten beendet hat.
  stopSignalAllowed(now) {
    return this.currentNote != null && (this.state === 'hold' || now - this.holdEndedAt < 250);
  }

  pitch(m, now) {
    this.lastMsg = m;            // für Fehlersuche
    // Wechsel des ankommenden Echos: ab jetzt klingt das alte Echo aus
    if (m.rfArr !== undefined) {
      this.arrivalKnown = true;
      if (m.rfArr !== this.lastArr) {
        const base = m.rfArr ? PREV_REF_MS : STOP_ECHO_MS;
        const tail = Math.min(TAIL_MAX_MS, this.tailMs);
        if (this.lastArr) this.prevRef = { f: this.lastArr, from: now, until: now + Math.max(base, tail + 150), wide: Math.max(PREV_SUB_MS, tail) };
        this.lastArr = m.rfArr;
      }
    }
    if (this.state === 'hold' && now - this.holdStart > 150) {
      // nur lernen, solange kein Spieler im Kammfilter-Signal auftaucht
      if (!(m.fc > 0 && m.cc >= CLARITY_MIN && m.rmsC >= gateFor(this.S.sensitivity) * 0.5)) this.learnLeak(m);
    }

    const p = this.perceive(m, now);
    if (!p || p.cents != null) this.toneless = 0;

    if (p && p.cents != null) {
      this.silenceSince = null;
      const inZone = Math.abs(p.cents) <= RANGE;
      this.lastPitch = { f: p.f, note: p.note, cents: p.cents, inZone, kind: p.kind, src: p.src };
      this.grayCount = inZone ? 0 : this.grayCount + 1;
      if (inZone) {
        const c = this.candidate;
        this.candidate = c.note === p.note ? { note: p.note, count: c.count + 1 } : { note: p.note, count: 1 };
        const octaveOnly = this.currentNote != null && p.note !== this.currentNote && (p.note - this.currentNote) % 12 === 0;
        const need = octaveOnly || p.disputed ? OCTAVE_FRAMES : STABLE_FRAMES;
        // Im Zusammenklang mit der Referenz nur Oktavwechsel zulassen (gleiche Tonklasse)
        const allowed = p.kind === 'free' || octaveOnly || p.note === this.currentNote;
        if (allowed && this.candidate.count >= need) {
          const changed = p.note !== this.currentNote;
          if (changed) this.startReference(p.note, now);
          this.setState('tracking', now);
          this.io.show(p.cents, changed);
          this.io.readout(p.note, p.cents, false, changed);
        } else if (p.kind === 'unison' && p.note !== this.currentNote && this.currentNote != null && !octaveOnly) {
          // unplausibel (Mischklang) – Musiker spielt aber: Zustand halten
          this.setState('tracking', now);
        }
      } else if (this.grayCount >= 2) {
        // Graubereich: Referenz spielt weiter, Anzeige grau
        this.candidate = { note: null, count: 0 };
        if (this.state === 'hold' && this.currentNote != null) this.setState('tracking', now);
        this.io.show(Math.sign(p.cents) * (RANGE + 2), false);
        this.io.readout(p.note, p.cents, true);
      }
    } else if (p) {
      // Musiker spielt im Zusammenklang, Cent-Wert nicht verlässlich bestimmbar
      // (Anzeige grau statt eines zur Referenz hin verfälschten Werts). Aus dem Halten
      // erst nach 30 ms – ein kurzes Geräusch (z. B. das Stoppsignal) soll es nicht beenden.
      this.silenceSince = null;
      this.io.show(null, false);
      this.toneless++;
      if (this.currentNote != null && (this.state !== 'hold' || this.toneless >= TONELESS_FRAMES)) this.setState('tracking', now);
    } else {
      this.candidate = { note: null, count: 0 };
      this.grayCount = 0;
      this.io.show(null, false);
      if (this.state === 'tracking') {
        if (this.silenceSince == null) this.silenceSince = now;
        if (now - this.silenceSince > SILENCE_MS) {
          this.setState(this.currentNote != null ? 'hold' : 'idle', now);
        }
      }
    }

    if (this.state === 'hold' && now - this.holdStart > this.S.holdSec * 1000) this.stopReference('timeout', now);
  }
}
