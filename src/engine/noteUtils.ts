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

/**
 * Same compact voicing as the piano roll "chord all" mode (≤6 pitch classes, or explicit MIDIs e.g. from guitar mirror).
 * Root anchors spelling around octave 4+.
 */
export function buildChordMidis(
  notes: string[],
  rootNote: string,
): { midis: Set<number>; names: Map<number, string> } | null {
  const rootCh = Note.chroma(rootNote);
  if (rootCh == null) return null;

  const startMidi = (4 + 1) * 12 + rootCh;
  const midis = new Set<number>();
  const names = new Map<number, string>();

  for (const n of notes) {
    const ch = Note.chroma(n);
    if (ch == null) continue;

    const m = Note.midi(n);
    if (m != null) {
      midis.add(m);
      names.set(m, n.replace(/\d+$/, ''));
      continue;
    }

    let midi = (4 + 1) * 12 + ch;
    if (midi < startMidi) midi += 12;
    midis.add(midi);
    names.set(midi, n);
  }
  return { midis, names };
}

/**
 * Re-spell a note to match the pitch-class spelling used in `chartNotes` (same chroma),
 * keeping the octave from `noteWithOctave`. Keeps staff / marks aligned with piano labels.
 */
export function spellLikeChordChart(noteWithOctave: string, chartNotes: string[]): string {
  const g = Note.get(noteWithOctave);
  if (g.empty) return normalizeNote(noteWithOctave);
  const ch = Note.chroma(noteWithOctave);
  if (ch == null) return normalizeNote(noteWithOctave);
  const model = chartNotes.find(n => Note.chroma(n) === ch);
  if (!model) return normalizeNote(noteWithOctave);
  const pc = model.replace(/\d+$/, '');
  const oct = g.oct;
  if (oct == null) return normalizeNote(pc);
  const candidate = `${pc}${oct}`;
  return Note.midi(candidate) != null ? normalizeNote(candidate) : normalizeNote(noteWithOctave);
}

/** Spelled note strings (with octaves), sorted low→high, matching the piano roll chord-all voicing. */
export function spellChordNotesLikePianoRoll(allNotes: string[], rootNote: string): string[] {
  const built = buildChordMidis(allNotes, rootNote);
  if (!built || built.midis.size === 0) {
    return assignOctaves(allNotes.map(n => n.replace(/\d+$/, '')));
  }
  return [...built.midis]
    .sort((a, b) => a - b)
    .map(m => {
      const withOct = Note.fromMidi(m);
      if (!withOct) return null;
      const pcFromChord = built.names.get(m);
      if (pcFromChord) {
        const o = Note.get(withOct).oct;
        if (o == null) return normalizeNote(withOct);
        const candidate = `${pcFromChord}${o}`;
        return Note.midi(candidate) != null ? normalizeNote(candidate) : normalizeNote(withOct);
      }
      return normalizeNote(withOct);
    })
    .filter((n): n is string => n != null);
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

/**
 * Vex StaveNote key (`c#/4`, `dbb/5`, etc.). Match `bb`/`##` before single `b`/`#`.
 */
export function noteToVexKey(note: string): { key: string; accidental?: string } {
  const n = normalizeNote(note);
  const match = n.match(/^([A-G])(bb|##|b|#)?(\d)$/);
  if (!match) return { key: 'b/4' };

  const [, letter, acc, octave] = match;
  const key = `${letter.toLowerCase()}${acc ?? ''}/${octave}`;
  return { key, accidental: acc || undefined };
}

/** Matches `PianoRoll` / App compact keyboard (octaves 2–5). */
export const COMPACT_PIANO_ROLL_MIDIS: readonly number[] = (() => {
  const OCTAVES = [2, 3, 4, 5];
  const WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const BLACK_AFTER = ['C', 'D', 'F', 'G', 'A'];
  const midis: number[] = [];
  for (const oct of OCTAVES) {
    for (const wn of WHITE_NAMES) {
      const ch = Note.chroma(wn)!;
      const midi = (oct + 1) * 12 + ch;
      midis.push(midi);
      if (BLACK_AFTER.includes(wn)) {
        const bch = (ch + 1) % 12;
        midis.push((oct + 1) * 12 + bch);
      }
    }
  }
  return midis;
})();

/** Same chroma as `midi`, nearest key on the compact piano roll (fixes guitar open-string octaves vs keyboard). */
export function snapMidiToCompactPianoRoll(midi: number): number {
  const ch = ((midi % 12) + 12) % 12;
  let best = COMPACT_PIANO_ROLL_MIDIS[0] ?? midi;
  let bestD = Infinity;
  for (const k of COMPACT_PIANO_ROLL_MIDIS) {
    if (((k % 12) + 12) % 12 !== ch) continue;
    const d = Math.abs(k - midi);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Map guitar / analysis notes (any octave) onto keys that exist on the compact piano. */
export function mapNotesToCompactPianoRollKeyboard(noteStrings: string[]): string[] {
  return noteStrings.map(n => {
    const m = Note.midi(n);
    if (m == null) return n;
    const s = snapMidiToCompactPianoRoll(m);
    return Note.fromMidi(s) ?? n;
  });
}
