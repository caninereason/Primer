import { Note } from 'tonal';

/**
 * Guitar voicing generator with physical playability validation.
 * Barre detection, finger count, span limits, inner-mute avoidance.
 *
 * Strings in physical order: [low E, A, D, G, B, high e]
 * Callers must .slice().reverse() for display order (high e first).
 */

const PHYS_STRINGS = [
  { chroma: 4, midi: 40 },
  { chroma: 9, midi: 45 },
  { chroma: 2, midi: 50 },
  { chroma: 7, midi: 55 },
  { chroma: 11, midi: 59 },
  { chroma: 4, midi: 64 },
];

export type GuitarTab = (number | null)[];

/** Lowest root MIDI used when filtering (C2 = 36). */
const ROOT_MIDI_BASE = 36;

/**
 * Return a copy of the tab with any note lower than the chord root (fundamental) muted.
 * Used so displayed chord shapes do not show notes below the root.
 */
export function filterTabNotesAtOrAboveRoot(tab: GuitarTab, rootChroma: number): GuitarTab {
  const rootMidi = ROOT_MIDI_BASE + ((rootChroma % 12) + 12) % 12;
  const out: GuitarTab = [];
  for (let i = 0; i < 6; i++) {
    const f = tab[i];
    if (f == null) {
      out.push(null);
      continue;
    }
    const noteMidi = PHYS_STRINGS[i].midi + (f === 0 ? 0 : f);
    out.push(noteMidi < rootMidi ? null : f);
  }
  return out;
}

/**
 * Convert a guitar tab to MIDI-aware note strings.
 * @param isDisplayOrder When true, input is [high e, B, G, D, A, low E].
 *                      When false, input is physical [low E, A, D, G, B, high e].
 */
export function tabToMidiNotes(tab: GuitarTab, isDisplayOrder = false): string[] {
  const notes: string[] = [];
  const tabToUse = isDisplayOrder ? [...tab].reverse() : tab;
  for (let i = 0; i < 6; i++) {
    const f = tabToUse[i];
    if (f != null) {
      const midi = PHYS_STRINGS[i].midi + f;
      notes.push(Note.fromMidi(midi));
    }
  }
  return notes;
}

/**
 * Count clusters of adjacent strings at each distinct fret.
 * Adjacent strings at the same fret can share one finger (mini-barre).
 */
function countClusters(notes: [number, number][]): number {
  if (notes.length === 0) return 0;
  const byFret = new Map<number, number[]>();
  for (const [si, f] of notes) {
    if (!byFret.has(f)) byFret.set(f, []);
    byFret.get(f)!.push(si);
  }
  let count = 0;
  for (const strings of byFret.values()) {
    strings.sort((a, b) => a - b);
    count++;
    for (let i = 1; i < strings.length; i++) {
      if (strings[i] !== strings[i - 1] + 1) count++;
    }
  }
  return count;
}

/**
 * Estimate fingers needed. A barre at the lowest fret spans all
 * sounding strings (even if some have higher frets on top), as long
 * as no open string sits inside the sounding range.
 */
function countFingers(tab: GuitarTab): number {
  const fretted: [number, number][] = [];
  for (let i = 0; i < tab.length; i++) {
    if (tab[i] != null && tab[i]! > 0) fretted.push([i, tab[i]!]);
  }
  if (fretted.length === 0) return 0;

  const minFret = Math.min(...fretted.map(([, f]) => f));

  const soundingIndices: number[] = [];
  for (let i = 0; i < tab.length; i++) {
    if (tab[i] != null) soundingIndices.push(i);
  }
  const lowStr = soundingIndices[0];
  const highStr = soundingIndices[soundingIndices.length - 1];

  let hasOpenInRange = false;
  for (let i = lowStr; i <= highStr; i++) {
    if (tab[i] === 0) { hasOpenInRange = true; break; }
  }

  const atMinFret = fretted.filter(([, f]) => f === minFret);
  const canBarre = !hasOpenInRange && atMinFret.length >= 2 && minFret > 0;

  if (canBarre) {
    const above = fretted.filter(([, f]) => f > minFret);
    return 1 + countClusters(above);
  }

  return countClusters(fretted);
}

function isPlayable(
  tab: GuitarTab,
  maxSpan = 4,
  maxFingers = 4,
): boolean {
  const fretted = tab.filter((f): f is number => f != null && f > 0);

  if (fretted.length > 0) {
    if (Math.max(...fretted) - Math.min(...fretted) > maxSpan) return false;
  }

  if (countFingers(tab) > maxFingers) return false;

  const sounding: number[] = [];
  for (let i = 0; i < tab.length; i++) {
    if (tab[i] != null) sounding.push(i);
  }
  if (sounding.length > 0) {
    const low = sounding[0];
    const high = sounding[sounding.length - 1];
    for (let i = low; i <= high; i++) {
      if (tab[i] == null) return false;
    }
  }

  return true;
}

const MAX_VOICINGS = 24;

export function generatePlayableVoicings(
  startFret: number,
  endFret: number,
  chordChromas: Set<number>,
  rootChroma: number,
  databaseShapes?: GuitarTab[],
  preferredShape?: GuitarTab | null,
): GuitarTab[] {
  // Highlight set can be empty (e.g. chord notes not resolved yet) — still show DB / preferred shapes
  // so library + saved custom voicings update on the fretboard.
  if (chordChromas.size === 0) {
    const out: GuitarTab[] = [];
    const seen = new Set<string>();
    const add = (tab: GuitarTab) => {
      const key = tab.map((f) => f ?? 'x').join(',');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(tab);
    };
    if (preferredShape) add(preferredShape);
    if (databaseShapes && databaseShapes.length > 0) {
      for (const s of databaseShapes) {
        if (s && out.length < MAX_VOICINGS) add(s);
      }
    }
    return out;
  }

  const candidates: (number | null)[][] = [];
  for (let si = 0; si < 6; si++) {
    const opts: (number | null)[] = [null];
    for (let fret = startFret; fret <= endFret; fret++) {
      const ch = (PHYS_STRINGS[si].chroma + fret) % 12;
      if (chordChromas.has(ch)) opts.push(fret);
    }
    candidates[si] = opts;
  }

  const results: { tab: GuitarTab; score: number }[] = [];
  const buf: GuitarTab = new Array(6).fill(null);

  function search(si: number) {
    if (si === 6) {
      const sounding = buf.filter(f => f != null).length;
      if (sounding < 3) return;
      if (!isPlayable(buf)) return;

      const chromas = new Set<number>();
      let lowestIdx = -1;
      for (let i = 0; i < 6; i++) {
        if (buf[i] != null) {
          chromas.add((PHYS_STRINGS[i].chroma + buf[i]!) % 12);
          if (lowestIdx < 0) lowestIdx = i;
        }
      }

      let score = 0;

      score += chromas.size * 100;
      if (chromas.size === chordChromas.size) score += 80;

      if (lowestIdx >= 0) {
        const bassCh = (PHYS_STRINGS[lowestIdx].chroma + buf[lowestIdx]!) % 12;
        if (bassCh === rootChroma) score += 200;
        else score -= 30;
      }

      score += sounding * 30;
      if (sounding >= 5) score += 50;
      if (sounding === 6) score += 30;

      const fretted = buf.filter((f): f is number => f != null && f > 0);
      if (fretted.length > 0) {
        score -= (Math.max(...fretted) - Math.min(...fretted)) * 5;
      }

      score -= countFingers(buf) * 3;

      results.push({ tab: [...buf], score });
      return;
    }

    for (const opt of candidates[si]) {
      buf[si] = opt;
      search(si + 1);
    }
  }

  search(0);

  results.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const final: GuitarTab[] = [];

  if (preferredShape) {
    const key = preferredShape.map(f => f ?? 'x').join(',');
    seen.add(key);
    final.push(preferredShape);
     console.debug(`[VoicingGen] Prioritized preferred shape`);
  }

  if (databaseShapes && databaseShapes.length > 0) {
    // Only shapes that fit the current position's fret range (inversions = rearrange notes within this position)
    const fitting = databaseShapes
      .filter(shape => {
        if (!shape) return false;
        // Don't re-add the preferred one
        const key = shape.map(f => f ?? 'x').join(',');
        if (seen.has(key)) return false;

        const fretted = shape.filter((f): f is number => f != null && f > 0);
        if (fretted.length === 0) {
          return shape.some(f => f != null) && startFret === 0;
        }
        return Math.min(...fretted) >= startFret && Math.max(...fretted) <= endFret;
      })
      .sort((a, b) => {
        const sa = (a ?? []).filter(f => f != null).length;
        const sb = (b ?? []).filter(f => f != null).length;
        return sb - sa;
      });

    for (const shape of fitting) {
      if (!shape) continue;
      if (final.length >= MAX_VOICINGS) break;
      const key = shape.map(f => f ?? 'x').join(',');
      if (!seen.has(key)) {
        seen.add(key);
        final.push(shape);
      }
    }
  }

  for (const v of results) {
    if (final.length >= MAX_VOICINGS) break;
    const key = v.tab.map(f => f ?? 'x').join(',');
    if (!seen.has(key)) {
      seen.add(key);
      final.push(v.tab);
    }
  }

  return final;
}
