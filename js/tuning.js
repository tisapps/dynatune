// Notenrechnung: Frequenz <-> MIDI-Note, Cent-Abweichung, Notennamen

export const NAMES = {
  de: ['C', 'Cis', 'D', 'Es', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'B', 'H'],
  int: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'],
};

// Transposition: um wie viele Halbtöne die notierte Note über der klingenden liegt
export const TRANSPOSITIONS = {
  C: 0,   // Violine, Flöte, Oboe, Stimme …
  B: 2,   // Klarinette in B, Trompete, Tenorsaxophon (+12)
  A: 3,   // Klarinette in A
  F: 7,   // Horn, Englischhorn
  Es: 9,  // Altsaxophon (+12), Es-Klarinette (-12)
};

export const midiFromFreq = (f, a4) => 69 + 12 * Math.log2(f / a4);
export const freqFromMidi = (m, a4) => a4 * 2 ** ((m - 69) / 12);
export const centsBetween = (f, ref) => 1200 * Math.log2(f / ref);

// Nächste Note und Abweichung in Cent
export function analyzeFreq(f, a4) {
  const m = midiFromFreq(f, a4);
  const note = Math.round(m);
  return { note, cents: (m - note) * 100 };
}

export function noteName(midi, lang = 'de', transpose = 0) {
  const written = midi + transpose;
  const pc = ((written % 12) + 12) % 12;
  const octave = Math.floor(written / 12) - 1;
  return { name: NAMES[lang][pc], octave };
}
