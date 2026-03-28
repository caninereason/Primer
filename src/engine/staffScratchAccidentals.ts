import { Note } from 'tonal';
import { normalizeNote } from './noteUtils';

/** Merge tap-derived note names with staff scratch (same MIDI → scratch spelling wins). */
export function mergeHarmonyNoteStrings(
  tapNotes: string[],
  scratch: { note: string }[],
): string[] {
  const byMidi = new Map<number, string>();
  for (const n of tapNotes) {
    const m = Note.midi(n);
    if (m != null) byMidi.set(m, n);
  }
  for (const s of scratch) {
    const m = Note.midi(s.note);
    if (m != null) byMidi.set(m, s.note);
  }
  return [...byMidi.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, n]) => n);
}

/** User staff scratch: `replacesChartMidi` = base pitch (MIDI) hidden when this row exists so accidentals can move without leaving the old head. */
export type StaffScratchEntry = { id: string; note: string; replacesChartMidi?: number };

/** Merge chart staff notes with user scratch notes (same MIDI → scratch spelling wins). */
export function mergeStaffWithScratch(
  base: string[],
  scratch: StaffScratchEntry[],
): { notes: string[]; scratchIdPerIndex: (string | null)[] } {
  const omitMidis = new Set<number>();
  for (const s of scratch) {
    if (s.replacesChartMidi != null) omitMidis.add(s.replacesChartMidi);
  }
  const filteredBase = base.filter(n => {
    const m = Note.midi(n);
    return m == null || !omitMidis.has(m);
  });

  const byMidi = new Map<number, { note: string; scratchId: string | null }>();
  for (const n of filteredBase) {
    const m = Note.midi(n);
    if (m == null) continue;
    if (!byMidi.has(m)) byMidi.set(m, { note: n, scratchId: null });
  }
  for (const s of scratch) {
    const m = Note.midi(s.note);
    if (m == null) continue;
    byMidi.set(m, { note: s.note, scratchId: s.id });
  }
  const sorted = [...byMidi.entries()].sort((a, b) => a[0] - b[0]);
  return {
    notes: sorted.map(([, v]) => v.note),
    scratchIdPerIndex: sorted.map(([, v]) => v.scratchId),
  };
}

/** Spelling helpers for staff scratch-note NESW controls (not key-aware). */

export function staffNoteHasSharp(note: string): boolean {
  return /#/.test(note.replace(/\d+$/, ''));
}

export function staffNoteHasFlat(note: string): boolean {
  return /b/.test(note.replace(/\d+$/, ''));
}

export function staffNoteIsNaturalSpelling(note: string): boolean {
  return !staffNoteHasSharp(note) && !staffNoteHasFlat(note);
}

/** Which NESW accidental side reflects the current spelling (E ♯ / S ♮ / W ♭). */
export type StaffNeswAccidental = 'sharp' | 'flat' | 'natural';

export function staffNeswAccidentalHighlight(note: string): StaffNeswAccidental {
  const pc = note.replace(/\d+$/, '');
  if (/##/.test(pc)) return 'sharp';
  if (/bb/.test(pc)) return 'flat';
  if (/#/.test(pc)) return 'sharp';
  if (/b/.test(pc)) return 'flat';
  return 'natural';
}

/** B#→C, E#→F, Cb→B, Fb→E, etc.; same MIDI (see `normalizeNote`). */
export function normalizeStaffScratchSpelling(note: string): string {
  return normalizeNote(note);
}

/**
 * NESW ♯ / ♭ / ♮: change spelling on the same staff letter (augmented / diminished unison),
 * replacing the previous accidental instead of jumping to `fromMidi(m±1)`.
 */
export function scratchApplyAccidental(note: string, dir: 'sharp' | 'flat' | 'natural'): string {
  if (Note.midi(note) == null) return note;

  if (dir === 'sharp') {
    const t = Note.transpose(note, '1A') || note;
    return normalizeStaffScratchSpelling(t);
  }
  if (dir === 'flat') {
    const t = Note.transpose(note, '-1A') || note;
    return normalizeStaffScratchSpelling(t);
  }

  let n = note;
  let p = Note.get(n);
  if (p.empty) return note;
  while (p.alt > 0) {
    const next = Note.transpose(n, '-1A');
    if (!next) break;
    n = next;
    p = Note.get(n);
  }
  while (p.alt < 0) {
    const next = Note.transpose(n, '1A');
    if (!next) break;
    n = next;
    p = Note.get(n);
  }
  return normalizeStaffScratchSpelling(n);
}
