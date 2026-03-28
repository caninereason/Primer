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

/** Display-order tab: index 0 = high e … 5 = low E. Piano mirror columns map bass-left → low E … treble-right → high e. */
export function displayStringNoteMidi(tab: GuitarTab, displayStringIndex: number): number | null {
  const f = tab[displayStringIndex];
  if (f == null) return null;
  const physicalIndex = 5 - displayStringIndex;
  if (physicalIndex < 0 || physicalIndex > 5) return null;
  return PHYS_STRINGS[physicalIndex].midi + f;
}

/** If `midi` is playable on that display string, return fret 0–24; else null. */
export function midiToFretOnDisplayString(midi: number, displayStringIndex: number): number | null {
  if (displayStringIndex < 0 || displayStringIndex > 5) return null;
  const physicalIndex = 5 - displayStringIndex;
  const open = PHYS_STRINGS[physicalIndex].midi;
  const fret = midi - open;
  if (fret < 0 || fret > 24) return null;
  return fret;
}

/** Sounding MIDI for `fret` on a display-order string (0 = high e … 5 = low E). */
export function midiForDisplayStringFret(displayStringIndex: number, fret: number): number | null {
  if (displayStringIndex < 0 || displayStringIndex > 5 || fret < 0 || fret > 24) return null;
  const physicalIndex = 5 - displayStringIndex;
  return PHYS_STRINGS[physicalIndex].midi + fret;
}

export type GuitarMirrorPick = { stringIndex: number; fret: number };

/**
 * Frets beside the current one on a string (±2), for piano mirror “areas”.
 * Open (0) is included only when that string is open in the tab (`currentFret === 0`).
 * Muted string: center on the visible fret window; still no open unless you’re on fret 0.
 */
export function neighborFretsForMirrorString(
  currentFret: number | null,
  fretWindow: { startFret: number; endFret: number },
  neighborSpan = 2,
): number[] {
  const lo = Math.min(fretWindow.startFret, fretWindow.endFret);
  const hi = Math.max(fretWindow.startFret, fretWindow.endFret);
  const openInPos = currentFret === 0;

  let center: number;
  if (currentFret != null) {
    center = currentFret;
  } else {
    center = Math.round((lo + hi) / 2);
    center = Math.max(lo, Math.min(hi, center));
  }

  const out: number[] = [];
  for (let d = -neighborSpan; d <= neighborSpan; d++) {
    const f = center + d;
    if (f < 0 || f > 24) continue;
    if (f === 0 && !openInPos) continue;
    out.push(f);
  }

  if (out.length === 0) {
    const fb = Math.max(0, Math.min(24, currentFret ?? center));
    if (fb === 0 && !openInPos) {
      const alt = Math.max(1, Math.min(24, lo > 0 ? lo : 1));
      return [alt];
    }
    return [fb];
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

const MIRROR_STRING_COUNT = 6;
const MIRROR_MAX_COMFORTABLE_STRETCH = 4;
const MIRROR_PITCH_WEIGHT = 100;
const MIRROR_MAX_STRETCH_COST = 40;

function referenceFretForMirrorString(
  d: number,
  tab: (number | null)[],
  win: { startFret: number; endFret: number },
): number {
  const f = tab[d];
  if (f != null) return f;
  const lo = Math.min(win.startFret, win.endFret);
  const hi = Math.max(win.startFret, win.endFret);
  return Math.max(0, Math.min(24, Math.round((lo + hi) / 2)));
}

export type ResolveGuitarMirrorPickArgs = {
  /** Horizontal position for string-column hint (e.g. click X in host coords). */
  centerX: number;
  totalWidth: number;
  clickedMidi: number;
  chordTab: (number | null)[] | null | undefined;
  fretWindow: { startFret: number; endFret: number };
};

/**
 * Map a clicked MIDI + horizontal hint to (display string, fret), same rules as the compact piano
 * in Draw mode: pitch match dominates; stretch from current tab is capped; column biases string.
 */
export function resolveGuitarMirrorPick(args: ResolveGuitarMirrorPickArgs): GuitarMirrorPick | null {
  const { centerX, totalWidth, clickedMidi, chordTab, fretWindow } = args;
  if (totalWidth <= 0) return null;
  const tab: (number | null)[] =
    chordTab && chordTab.length === 6
      ? chordTab
      : [null, null, null, null, null, null];
  const win = fretWindow;

  const refFret = Array.from({ length: MIRROR_STRING_COUNT }, (_, d) =>
    referenceFretForMirrorString(d, tab, win),
  );

  const colW = totalWidth / MIRROR_STRING_COUNT;
  const col = Math.min(MIRROR_STRING_COUNT - 1, Math.floor(centerX / colW));
  const hintString = (MIRROR_STRING_COUNT - 1) - col;

  const clickCh = ((clickedMidi % 12) + 12) % 12;

  function stretchPenalty(gap: number): number {
    if (gap < MIRROR_MAX_COMFORTABLE_STRETCH) return 0;
    if (gap === MIRROR_MAX_COMFORTABLE_STRETCH) return 20;
    return 85 + (gap - MIRROR_MAX_COMFORTABLE_STRETCH) * 14;
  }

  let bestD = hintString;
  let bestF = 0;
  let bestScore = Infinity;
  let bestDist = Infinity;

  for (let d = 0; d < MIRROR_STRING_COUNT; d++) {
    for (let f = 0; f <= 24; f++) {
      const m = midiForDisplayStringFret(d, f);
      if (m == null) continue;
      if (((m % 12) + 12) % 12 !== clickCh) continue;
      const distRaw = Math.abs(m - clickedMidi);
      const gap = Math.abs(f - refFret[d]!);
      const stretch = Math.min(MIRROR_MAX_STRETCH_COST, stretchPenalty(gap));
      const columnHint = d === hintString ? -15 : 0;
      const score = distRaw * MIRROR_PITCH_WEIGHT + stretch + columnHint;
      if (
        score < bestScore ||
        (score === bestScore && distRaw < bestDist) ||
        (score === bestScore && distRaw === bestDist && d === hintString && bestD !== hintString) ||
        (score === bestScore &&
          distRaw === bestDist &&
          (d === hintString) === (bestD === hintString) &&
          f < bestF)
      ) {
        bestScore = score;
        bestDist = distRaw;
        bestD = d;
        bestF = f;
      }
    }
  }

  if (bestScore < Infinity) return { stringIndex: bestD, fret: bestF };

  const neigh = neighborFretsForMirrorString(tab[hintString] ?? null, win);
  if (neigh.length === 0) return null;
  let bf = neigh[0]!;
  let br = Infinity;
  for (const f of neigh) {
    const m = midiForDisplayStringFret(hintString, f);
    if (m == null) continue;
    const r = Math.abs(m - clickedMidi);
    if (r < br) {
      br = r;
      bf = f;
    }
  }
  return { stringIndex: hintString, fret: bf };
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
