import { Note } from 'tonal';

export const SHARP_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const FLAT_KEYS = new Set([1, 3, 5, 8, 10]); // Db, Eb, F, Ab, Bb prefer flats
export const ALL_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function transposeNote(note: string, semi: number, useFlats: boolean): string {
  const ch = Note.chroma(note);
  if (ch == null) return note;
  return (useFlats ? FLAT_NOTES : SHARP_NOTES)[(ch + semi + 12) % 12];
}

const ENHARMONIC_MAP: Record<string, string> = {
  'Cb': 'B', 'B#': 'C', 'E#': 'F', 'Fb': 'E',
  'Cbb': 'Bb', 'Dbb': 'C', 'Ebb': 'D', 'Fbb': 'Eb',
  'Gbb': 'F', 'Abb': 'G', 'Bbb': 'A',
  'C##': 'D', 'D##': 'E', 'E##': 'F#', 'F##': 'G',
  'G##': 'A', 'A##': 'B', 'B##': 'C#',
};

/**
 * Normalize note names so double-flats/sharps and Cb/B#/E#/Fb are
 * replaced with their standard enharmonic equivalents.
 * Works with or without octave numbers (e.g. "Cb4" → "B4", "Bbb" → "A").
 */
export function normalizeNote(note: string): string {
  const m = note.match(/^([A-G][b#]*)(\d*)$/);
  if (!m) return note;
  const [, pc, oct] = m;
  const replacement = ENHARMONIC_MAP[pc];
  if (replacement) {
    if (oct && (pc === 'B#' || pc === 'B##')) {
      return `${replacement}${Number(oct) + 1}`;
    }
    if (oct && (pc === 'Cb' || pc === 'Cbb')) {
      return `${replacement}${Number(oct) - 1}`;
    }
    return `${replacement}${oct}`;
  }
  return note;
}

/** Normalize an array of note names. */
export function normalizeNotes(notes: string[]): string[] {
  return notes.map(normalizeNote);
}

export function assignOctaves(notes: string[], startOctave = 4): string[] {
  if (notes.length === 0) return [];

  let octave = startOctave;
  let prevMidi = -1;

  return notes.map((note, i) => {
    const clean = normalizeNote(note.replace(/\d+$/, ''));
    let withOctave = `${clean}${octave}`;
    const midi = Note.midi(withOctave);

    if (midi === null) return withOctave;

    if (i > 0 && midi <= prevMidi) {
      octave++;
      withOctave = `${clean}${octave}`;
    }

    prevMidi = Note.midi(withOctave) ?? midi;
    return withOctave;
  });
}

export function noteToVexKey(note: string): { key: string; accidental?: string } {
  const match = note.match(/^([A-G])(b|#)?(\d)$/);
  if (!match) return { key: 'b/4' };

  const [, letter, acc, octave] = match;
  const key = `${letter.toLowerCase()}${acc || ''}/${octave}`;
  return { key, accidental: acc };
}
