import type { Measure, ChordInfo } from '../types/music';

/** Pick one (string, fret) for an exact MIDI in the visible range; prefers lower fret, then higher string index (thicker string). */
export function pickBassCellForExactMidi(
  midi: number,
  startFret: number,
  endFret: number,
  stringOpenMidis: readonly number[],
  numStrings: number,
): { si: number; fret: number } | null {
  type Cand = { si: number; fret: number };
  const candidates: Cand[] = [];
  for (let si = 0; si < numStrings; si++) {
    const open = stringOpenMidis[si];
    if (open == null) continue;
    const fret = midi - open;
    if (fret < startFret || fret > endFret || fret < 0) continue;
    candidates.push({ si, fret });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.fret - b.fret || b.si - a.si);
  return candidates[0]!;
}

/** Beats allocated to one chord slot in a measure (matches `ChordPlayer` timeline). */
export function chordBeatsForSlot(
  measure: Measure,
  chordIdx: number,
  beatsPerMeasure: number,
): number {
  const hasChords = measure.chords.length > 0;
  const numSlots = hasChords ? measure.chords.length : 1;
  if (!hasChords) return beatsPerMeasure;
  let beatInMeasure = 0;
  for (let ci = 0; ci < numSlots; ci++) {
    const chordBeats =
      ci < numSlots - 1
        ? Math.round(beatsPerMeasure / numSlots)
        : beatsPerMeasure - beatInMeasure;
    if (ci === chordIdx) return Math.max(1, chordBeats);
    beatInMeasure += chordBeats;
  }
  return beatsPerMeasure;
}

/** Next chord after `(fromMi, fromCi)` in song order (same as walking-bass “next” in player). */
export function findNextChordInfo(
  measures: Measure[],
  fromMi: number,
  fromCi: number,
): ChordInfo | null {
  for (let mi = fromMi; mi < measures.length; mi++) {
    const m = measures[mi];
    if (!m.chords.length) continue;
    const startCi = mi === fromMi ? fromCi + 1 : 0;
    for (let ci = startCi; ci < m.chords.length; ci++) {
      return m.chords[ci]!;
    }
  }
  return null;
}
