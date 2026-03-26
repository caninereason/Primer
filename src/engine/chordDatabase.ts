import guitarData from '../../guitar.json';
import customChordsRaw from '../customChords.json';
import { Note, Chord, Scale } from 'tonal';
import { normalizeNotes } from './noteUtils';
import type { GuitarTab } from './guitarVoicings';

interface DbPosition {
  frets: number[];
  fingers: number[];
  baseFret: number;
  barres: number[];
  capo?: boolean;
  midi: number[];
}

interface DbChordEntry {
  key: string;
  suffix: string;
  positions: DbPosition[];
}

export interface ChordShapesResult {
  tabs: GuitarTab[];
  shapeLabels: string[] | null;
}

const systemChords = customChordsRaw as Record<string, GuitarTab[]>;

const KEY_MAP: Record<string, string> = {
  'C': 'C', 'C#': 'Csharp', 'Db': 'Csharp',
  'D': 'D', 'D#': 'Eb', 'Eb': 'Eb',
  'E': 'E', 'Fb': 'E',
  'F': 'F', 'E#': 'F', 'F#': 'Fsharp', 'Gb': 'Fsharp',
  'G': 'G', 'G#': 'Ab', 'Ab': 'Ab',
  'A': 'A', 'A#': 'Bb', 'Bb': 'Bb',
  'B': 'B', 'Cb': 'B',
};

const SUFFIX_MAP: Record<string, string> = {
  '': 'major', 'M': 'major', 'maj': 'major', 'Maj': 'major',
  'm': 'minor', 'min': 'minor', '-': 'minor',
  '-7': 'm7', 'min7': 'm7',
  '-9': 'm9', 'min9': 'm9',
  '-11': 'm11', 'min11': 'm11',
  '-6': 'm6', 'min6': 'm6',
  'o': 'dim', 'o7': 'dim7',
  'ø': 'm7b5', 'ø7': 'm7b5',
  '+': 'aug', '+7': 'aug7',
  'Δ': 'maj7', 'Δ7': 'maj7', 'M7': 'maj7', 'Maj7': 'maj7',
  'M9': 'maj9', 'Maj9': 'maj9',
  'M13': 'maj13', 'Maj13': 'maj13',
  'maj11': 'maj11', 'Maj11': 'maj11', 'M11': 'maj11',
  'mMaj7': 'mmaj7', 'mM7': 'mmaj7', '-Δ7': 'mmaj7',
  'mM11': 'mM11', 'mMaj11': 'mM11',
  'm6/9': 'm69', '-6/9': 'm69',
  'sus': 'sus4',
  'mb6': 'mb6', 'm(b6)': 'mb6',
};

/** Maps common chord abbreviations to the canonical suffixes used in customChords.json for exact lookup. */
export const CANONICAL_SUFFIX_MAP: Record<string, string> = {
  '-': 'm',
  'min': 'm',
  'minor': 'm',
  'major': '',
  'M': '',
  'maj': '',
  'Maj': '',
  '-7': 'm7',
  'min7': 'm7',
  'maj7': 'maj7',
  'Maj7': 'maj7',
  'M7': 'maj7',
  'Δ7': 'maj7',
  'Δ': 'maj7',
  'mMaj7': 'mM7',
  'mmaj7': 'mM7',
  '-Δ7': 'mM7',
  'ø': 'm7b5',
  'ø7': 'm7b5',
  'o7': 'dim7',
  'o': 'dim',
  'dim': 'dim',
  'dim7': 'dim7',
  '+': 'aug',
  'aug': 'aug',
  '7sus4': '7sus4',
  'sus': 'sus4',
  'mb6': 'mb6',
};

function positionToTab(pos: DbPosition): GuitarTab {
  return pos.frets.map(f => {
    if (f === -1) return null;
    if (f === 0) return 0;
    return pos.baseFret - 1 + f;
  });
}

function rootChromaFromKey(root: string): number | null {
  const chroma: Record<string, number> = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4,
    F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
  };
  return chroma[root] ?? null;
}

/* ── Helpers ───────────────────────────────────────────────────── */

const TUNING = [4, 9, 2, 7, 11, 4]; // E A D G B e (low E → high e)

/** Pressed frets stay at or below this when building / transposing shapes. */
const MAX_CHORD_FRET = 12;

function intervalToSemitones(iv: string): number | null {
  const map: Record<string, number> = {
    '1P': 0, '2m': 1, '2M': 2, '2A': 3, '3m': 3, '3M': 4,
    '4d': 4, '4P': 5, '4A': 6, '5d': 6, '5P': 7, '5A': 8,
    '6m': 8, '6M': 9, '7d': 9, '7m': 10, '7M': 11,
    '8P': 12, '9m': 13, '9M': 14, '9A': 15,
    '10m': 15, '10M': 16, '11P': 17, '11A': 18,
    '13m': 20, '13M': 21,
  };
  return map[iv] ?? null;
}

function getChordIntervals(root: string, suffix: string): number[] | null {
  const info = Chord.get(root + suffix);
  let intervals = info.intervals;

  // Fallback for chords tonal doesn't natively support
  if (!intervals || intervals.length === 0) {
    if (suffix === 'maj11') intervals = ['1P', '3M', '5P', '7M', '9M', '11P'];
    else if (suffix === 'mM11') intervals = ['1P', '3m', '5P', '7M', '9M', '11P'];
    else if (suffix === 'mb6') intervals = ['1P', '3m', '5P', '6m'];
    else return null;
  }

  const out: number[] = [];
  for (const iv of intervals) {
    const st = intervalToSemitones(iv);
    if (st != null) out.push(st % 12);
  }
  return out.length > 0 ? out : null;
}

/**
 * Returns the notes for a chord symbol, handling fallbacks for non-standard qualities (like mb6).
 */
export function getChordNotes(symbol: string): string[] {
  const m = symbol.match(/^([A-G][b#]?)(.*)/);
  if (!m) return [];
  const root = m[1];
  const rawSuffix = m[2];

  // Try tonal first
  const info = Chord.get(symbol);
  if (info.notes.length > 0) return normalizeNotes(info.notes);

  // Fallback logic
  const suffix = SUFFIX_MAP[rawSuffix] ?? rawSuffix;
  const tonalSuffix = suffix === 'major' ? '' : suffix;
  
  let intervals: string[] = [];
  if (tonalSuffix === 'maj11') intervals = ['1P', '3M', '5P', '7M', '9M', '11P'];
  else if (tonalSuffix === 'mM11') intervals = ['1P', '3m', '5P', '7M', '9M', '11P'];
  else if (tonalSuffix === 'mb6') intervals = ['1P', '3m', '5P', '6m'];
  else {
    const info2 = Chord.get(root + tonalSuffix);
    if (info2.intervals.length > 0) intervals = info2.intervals;
  }

  if (intervals.length === 0) return [];
  return normalizeNotes(intervals.map(iv => Note.transpose(root, iv)));
}

function tabsEqual(a: GuitarTab, b: GuitarTab): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/** Transpose a tab by delta frets; any resulting negative fret becomes mute (null). */
function transposeTab(tab: GuitarTab, delta: number): GuitarTab {
  if (delta === 0) return tab;
  return tab.map(f => {
    if (f == null) return null;
    const v = f + delta;
    return v < 0 ? null : v;
  });
}

/**
 * Transpose a C-root template toward `targetChordChromas` (same shape class as C, new root).
 * Keeps a string open only if that open pitch class is still a chord tone.
 * Rejects shapes that would need a pressed fret above MAX_CHORD_FRET or fewer than 3 strings.
 */
function transposeTemplateTab(
  tab: GuitarTab,
  delta: number,
  targetChordChromas: Set<number>,
): GuitarTab | null {
  const next: GuitarTab = tab.map((f, s) => {
    if (f == null) return null;
    if (f === 0) {
      return targetChordChromas.has(TUNING[s] % 12) ? 0 : null;
    }
    const v = f + delta;
    if (v < 0) return null;
    if (v > MAX_CHORD_FRET) return null;
    return v;
  });
  return validateShape(next);
}

function validateShape(tab: GuitarTab): GuitarTab | null {
  const sounding = tab.filter(f => f != null);
  if (sounding.length < 3) return null;
  const pressed = tab.filter((f): f is number => f != null && f > 0);
  if (pressed.length > 0 && Math.max(...pressed) > MAX_CHORD_FRET) return null;
  return tab;
}

/** For ordering: Pos 1 = closest to nut (lowest min pressed fret), then more open strings, then lower stretch. */
function shapeNeckSortKey(tab: GuitarTab): { minP: number; maxP: number; opens: number; sumP: number } {
  const pressed = tab.filter((f): f is number => f != null && f > 0);
  const opens = tab.filter(f => f === 0).length;
  if (pressed.length === 0) return { minP: 999, maxP: 0, opens, sumP: 0 };
  const minP = Math.min(...pressed);
  const maxP = Math.max(...pressed);
  const sumP = pressed.reduce((a, b) => a + b, 0);
  return { minP, maxP, opens, sumP };
}

function sortChordPositionsNearestNutFirst(tabs: GuitarTab[]): void {
  tabs.sort((a, b) => {
    const sa = shapeNeckSortKey(a);
    const sb = shapeNeckSortKey(b);
    if (sa.minP !== sb.minP) return sa.minP - sb.minP;
    if (sa.opens !== sb.opens) return sb.opens - sa.opens;
    if (sa.maxP !== sb.maxP) return sa.maxP - sb.maxP;
    return sa.sumP - sb.sumP;
  });
}

/* ── CAGED shape builder ──────────────────────────────────────── */

/**
 * Build one CAGED shape.
 *
 * direction = 'left':  notes cluster BELOW rootFret (C shape, G shape)
 * direction = 'right': notes cluster ABOVE rootFret (A/E/D shapes)
 *
 * Open strings preferred only when rootFret ≤ 5 (near nut).
 * High-e in LEFT: prefer open if near nut, else barre at rootFret if chord tone.
 * Max fret span among pressed (non-open) notes: 4.
 */
function buildOneShape(
  rootChroma: number,
  chordChromas: Set<number>,
  bassStr: number,
  rootFret: number,
  direction: 'left' | 'right',
): GuitarTab | null {
  if (rootFret > MAX_CHORD_FRET) return null;

  const tab: GuitarTab = new Array(6).fill(null);
  tab[bassStr] = rootFret;

  const nearNut = rootFret <= 5;

  for (let s = bassStr + 1; s < 6; s++) {
    const open = TUNING[s];

    if (direction === 'left') {
      // High-e special handling
      if (s === 5) {
        const openChr = open % 12;
        const rootChr = (open + rootFret) % 12;
        if (nearNut && chordChromas.has(openChr)) {
          tab[5] = 0;
        } else if (chordChromas.has(rootChr)) {
          tab[5] = rootFret;
        } else {
          tab[5] = findClosest(
            s,
            chordChromas,
            Math.max(0, rootFret - 5),
            Math.min(rootFret - 1, MAX_CHORD_FRET),
            rootFret,
          );
        }
        continue;
      }

      // Open string preference near nut
      if (nearNut && chordChromas.has(open % 12)) {
        tab[s] = 0;
        continue;
      }

      tab[s] = findClosest(
        s,
        chordChromas,
        Math.max(0, rootFret - 5),
        Math.min(rootFret - 1, MAX_CHORD_FRET),
        rootFret,
      );

    } else {
      // RIGHT: search at or above rootFret
      tab[s] = findClosest(
        s,
        chordChromas,
        rootFret,
        Math.min(rootFret + 5, MAX_CHORD_FRET),
        rootFret,
      );
    }
  }

  // Validate: at least 3 sounding strings
  const sounding = tab.filter(f => f != null);
  if (sounding.length < 3) return null;

  // Max 3-fret span among pressed (non-open) notes
  const pressed = tab.filter((f): f is number => f != null && f > 0);
  if (pressed.length > 0) {
    const span = Math.max(...pressed) - Math.min(...pressed);
    if (span > 3) return null;
  }

  // Try to include all chord tones by swapping duplicates or dropping 5th
  ensureAllTones(tab, bassStr, chordChromas, rootChroma);

  return tab;
}

/**
 * Post-processing: if any chord chroma is missing from the shape,
 * try to swap a string that has a duplicate chroma for the missing one.
 * If still missing, try dropping the 5th.
 * Only swaps if the result keeps pressed-fret span ≤ 3.
 */
function ensureAllTones(tab: GuitarTab, bassStr: number, chordChromas: Set<number>, rootChroma: number): void {
  // Collect which chromas are present and on which strings
  const present = new Map<number, number[]>(); // chroma → string indices
  for (let s = 0; s < 6; s++) {
    if (tab[s] == null) continue;
    const chr = (TUNING[s] + tab[s]!) % 12;
    if (!present.has(chr)) present.set(chr, []);
    present.get(chr)!.push(s);
  }

  // Find missing chromas
  const missing: number[] = [];
  for (const chr of chordChromas) {
    if (!present.has(chr)) missing.push(chr);
  }
  if (missing.length === 0) return;

  // For each missing chroma, try to swap a duplicate
  for (const missChr of missing) {
    // Find strings with duplicate chromas (chroma appears on 2+ strings)
    let swapped = false;
    for (const [dupChr, strings] of present.entries()) {
      if (strings.length < 2) continue;
      // Try swapping the last occurrence (highest string) for the missing chroma
      for (let si = strings.length - 1; si >= 0; si--) {
        const s = strings[si];
        if (s <= bassStr) continue; // don't touch bass
        // Find the missing chroma on this string within ±3 frets of current
        const curFret = tab[s]!;
        const targetFret = findClosestForChroma(s, missChr, curFret - 3, curFret + 3);
        if (targetFret == null) continue;

        // Check span wouldn't exceed 3
        const testTab = [...tab];
        testTab[s] = targetFret;
        const pressed = testTab.filter((f): f is number => f != null && f > 0);
        if (pressed.length > 0 && Math.max(...pressed) - Math.min(...pressed) > 3) continue;

        tab[s] = targetFret;
        // Update tracking
        strings.splice(si, 1);
        if (!present.has(missChr)) present.set(missChr, []);
        present.get(missChr)!.push(s);
        swapped = true;
        break;
      }
      if (swapped) break;
    }
  }

  // Find still missing chromas
  const stillMissing: number[] = [];
  for (const chr of chordChromas) {
    if (!present.has(chr)) stillMissing.push(chr);
  }
  if (stillMissing.length === 0) return;

  // Try to sacrifice the 5th (rootChroma + 7) for a missing note
  const fifthChr = (rootChroma + 7) % 12;
  // Make sure it's actually in the chord and we have it
  if (chordChromas.has(fifthChr) && present.has(fifthChr)) {
    for (const missChr of stillMissing) {
      let swapped = false;
      const strings = present.get(fifthChr)!;
      for (let si = strings.length - 1; si >= 0; si--) {
        const s = strings[si];
        if (s <= bassStr) continue;

        const curFret = tab[s]!;
        const targetFret = findClosestForChroma(s, missChr, curFret - 3, curFret + 3);
        if (targetFret == null) continue;

        const testTab = [...tab];
        testTab[s] = targetFret;
        const pressed = testTab.filter((f): f is number => f != null && f > 0);
        if (pressed.length > 0 && Math.max(...pressed) - Math.min(...pressed) > 3) continue;

        tab[s] = targetFret;
        strings.splice(si, 1);
        if (!present.has(missChr)) present.set(missChr, []);
        present.get(missChr)!.push(s);
        swapped = true;
        break;
      }
      if (swapped) break;
    }
  }
}

/** Find fret on string `s` that gives chroma `targetChr` within [lo, hi]. */
function findClosestForChroma(s: number, targetChr: number, lo: number, hi: number): number | null {
  const open = TUNING[s];
  const hiC = Math.min(hi, MAX_CHORD_FRET);
  for (let f = Math.max(0, lo); f <= hiC; f++) {
    if ((open + f) % 12 === targetChr) return f;
  }
  return null;
}

/** Find closest chord tone on string `s` within [lo, hi], closest to `anchor`. */
function findClosest(
  s: number,
  chordChromas: Set<number>,
  lo: number,
  hi: number,
  anchor: number,
): number | null {
  const open = TUNING[s];
  let best = -1;
  let bestDist = Infinity;

  const hiC = Math.min(hi, MAX_CHORD_FRET);
  for (let f = Math.max(0, lo); f <= hiC; f++) {
    const chr = (open + f) % 12;
    if (chordChromas.has(chr)) {
      const d = Math.abs(f - anchor);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
  }

  return best >= 0 ? best : null;
}

/* ── Generate all 5 CAGED shapes ─────────────────────────────── */

function generateCAGEDShapes(rootChroma: number, intervals: number[]): GuitarTab[] {
  const chordChromas = new Set(intervals.map(i => (rootChroma + i) % 12));

  const rootOnA = (rootChroma - TUNING[1] + 12) % 12; // root fret on A string
  const rootOnE = (rootChroma - TUNING[0] + 12) % 12; // root fret on low E
  const rootOnD = (rootChroma - TUNING[2] + 12) % 12; // root fret on D

  // LEFT shapes need room below root; if too close to nut, go up an octave
  const leftA = rootOnA < 3 ? rootOnA + 12 : rootOnA;
  const leftE = rootOnE < 3 ? rootOnE + 12 : rootOnE;
  const dFret = rootOnD === 0 ? 12 : rootOnD;

  // Define shapes with center-fret for sorting (incremental up the neck)
  // D shape uses RIGHT direction (like open D barred up) so it's distinct from E shape
  const defs = [
    { bass: 1, fret: leftA, dir: 'left' as const, center: leftA - 2 },   // C shape
    { bass: 1, fret: rootOnA, dir: 'right' as const, center: rootOnA + 2 },  // A shape
    { bass: 0, fret: leftE, dir: 'left' as const, center: leftE - 2 },    // G shape
    { bass: 0, fret: rootOnE, dir: 'right' as const, center: rootOnE + 2 },  // E shape
    { bass: 2, fret: dFret, dir: 'right' as const, center: dFret + 2 },    // D shape
  ];

  // Sort by center fret → shapes go incrementally up the fretboard
  defs.sort((a, b) => a.center - b.center);

  const shapes: GuitarTab[] = [];
  for (const def of defs) {
    const shape = buildOneShape(rootChroma, chordChromas, def.bass, def.fret, def.dir);
    if (shape && !shapes.some(s => tabsEqual(s, shape))) {
      shapes.push(shape);
    }
  }

  return shapes;
}

/* ── Main lookup ─────────────────────────────────────────────── */

/** Optional runtime overlay (e.g. after save) so shapes update without reload. */
export function lookupChordShapes(
  chordSymbol: string,
  customChordsOverride?: Record<string, (GuitarTab | null)[]> | null
): ChordShapesResult {
  const m = chordSymbol.match(/^([A-G][b#]?)(.*)/);
  if (!m) return { tabs: [], shapeLabels: null };

  const root = m[1];
  const rawSuffix = m[2];
  const rootChroma = rootChromaFromKey(root);
  if (rootChroma == null) return { tabs: [], shapeLabels: null };

  const suffix = SUFFIX_MAP[rawSuffix] ?? rawSuffix;
  const tonalSuffix = suffix === 'major' ? '' : suffix;
  const intervals = getChordIntervals(root, tonalSuffix);

  const effectiveCustom = customChordsOverride != null ? customChordsOverride : {};
  const system = systemChords;

  let baseTabs: (GuitarTab | null)[] = [];

  // 1) Algorithmic CAGED shapes
  if (intervals && intervals.length >= 3) {
    baseTabs = generateCAGEDShapes(rootChroma, intervals);
  }

  // 2) Fallback: guitar.json positions
  if (baseTabs.length === 0) {
    const dbKey = KEY_MAP[root];
    const chords = (guitarData.chords as Record<string, DbChordEntry[]>)[dbKey];
    const entry = chords?.find(c => c.suffix === suffix) ?? null;
    if (entry && entry.positions.length > 0) {
      baseTabs = entry.positions.map(positionToTab);
    }
  }

  // 3) Global templates: if there are saved shapes for the C-root version of this chord
  // (e.g. "Cm7"), use them as templates for all roots by transposing frets.
  const baseRoot = 'C';
  if (root !== baseRoot) {
    const templateSymbol = `${baseRoot}${rawSuffix}`;
    const templateSystem = system[templateSymbol];
    const templateUser = effectiveCustom[templateSymbol];

    const combinedTemplate: (GuitarTab | null)[] = [];
    if ((templateSystem && templateSystem.length > 0) || (templateUser && templateUser.length > 0)) {
      const len = Math.max(templateSystem?.length ?? 0, templateUser?.length ?? 0);
      for (let i = 0; i < len; i++) {
        combinedTemplate[i] = templateUser?.[i] || templateSystem?.[i] || null;
      }
    }

    if (combinedTemplate.length > 0) {
      const baseChroma = rootChromaFromKey(baseRoot);
      if (baseChroma != null) {
        const delta = (rootChroma - baseChroma + 12) % 12;
        const targetChromas = new Set<number>();
        if (intervals && intervals.length > 0) {
          for (const i of intervals) targetChromas.add((rootChroma + i) % 12);
        } else {
          for (const n of getChordNotes(`${root}${rawSuffix}`)) {
            const c = Note.chroma(n);
            if (c != null) targetChromas.add(c);
          }
        }
        const transposedTemplate =
          targetChromas.size > 0
            ? combinedTemplate.map(tab =>
                tab ? transposeTemplateTab(tab, delta, targetChromas) : null,
              )
            : combinedTemplate.map(tab => (tab ? transposeTab(tab, delta) : null));

        // Merge by index so Pos N matches the C template slot N (same CAGED family).
        const mergeLen = Math.max(baseTabs.length, transposedTemplate.length);
        const merged: (GuitarTab | null)[] = [];
        for (let i = 0; i < mergeLen; i++) {
          merged[i] = transposedTemplate[i] ?? baseTabs[i] ?? null;
        }
        baseTabs = merged;
      }
    }
  }

  // 4) Merge collections: system + user overrides for this exact symbol
  // Normalize symbol for lookup to catch "F-7" as "Fm7"
  const canonicalSuffix = CANONICAL_SUFFIX_MAP[rawSuffix] ?? rawSuffix;
  const canonicalSymbol = `${root}${canonicalSuffix}`;

  const sysExact = system[chordSymbol] || system[canonicalSymbol];
  const userExact = effectiveCustom[chordSymbol] || effectiveCustom[canonicalSymbol];

  if (userExact) {
    console.info(`[ChordLookup] Found user overrides for "${chordSymbol}" (canonical: "${canonicalSymbol}"):`, userExact);
  }

  if ((sysExact && sysExact.length > 0) || (userExact && userExact.length > 0)) {
    const len = Math.max(baseTabs.length, sysExact?.length ?? 0, userExact?.length ?? 0, 5);
    const finalTabs: (GuitarTab | null)[] = new Array(len).fill(null);
    for (let i = 0; i < len; i++) {
      // Priority: 1. User Exact, 2. System Exact, 3. Base/Template
      if (userExact && userExact[i] && userExact[i]!.length === 6) {
        finalTabs[i] = userExact[i] as GuitarTab;
        console.debug(`[ChordLookup] Using user shape for "${chordSymbol}" Pos ${i + 1}`);
      } else if (sysExact && sysExact[i] && sysExact[i].length === 6) {
        finalTabs[i] = sysExact[i] as GuitarTab;
      } else {
        finalTabs[i] = (baseTabs[i] ?? null);
      }
    }
    baseTabs = finalTabs;
  }

  // 5) Ensure we have exactly 5 positions: pad length, then fill any null slots so position indices stay correct
  while (baseTabs.length < 5) baseTabs.push(null);

  const firstValid = baseTabs.find((t): t is GuitarTab => t !== null);
  const caged = (intervals && intervals.length >= 3) ? generateCAGEDShapes(rootChroma, intervals) : [];

  const finalBaseTabs: GuitarTab[] = [];
  const ultimateFallback: GuitarTab = [null, null, null, null, null, null];

  for (let i = 0; i < 5; i++) {
    const tabToUse = (baseTabs as any)[i] ||
      fallbackBarreShape(rootChroma, intervals ?? [], i) ||
      caged[i] || caged[0] || firstValid || ultimateFallback;
    finalBaseTabs[i] = tabToUse as GuitarTab;
  }

  // 6) Pos 1 = lowest on neck (nearest open position); remaining slots ascend by min fret / openness / span.
  sortChordPositionsNearestNutFirst(finalBaseTabs);

  return { tabs: finalBaseTabs, shapeLabels: null };
}

/** Minimal barre shape for a given root and chord tones, used to pad to 5 positions. */
function fallbackBarreShape(rootChroma: number, intervals: number[], index: number): GuitarTab | null {
  const chordChromas = new Set(intervals.map(i => (rootChroma + i) % 12));
  const bassStrings = [0, 1, 0, 1, 2]; // E, A, E(+12), A(+12), D for 5 distinct positions
  const bassStr = bassStrings[index % 5];
  let rootFret = (rootChroma - TUNING[bassStr] + 12) % 12;
  if (index >= 2 && rootFret + 12 <= MAX_CHORD_FRET) rootFret += 12;
  if (rootFret > MAX_CHORD_FRET) return null;
  const tab: GuitarTab = new Array(6).fill(null);
  tab[bassStr] = rootFret;
  for (let s = bassStr + 1; s < 6; s++) {
    const open = TUNING[s];
    const hi = Math.min(rootFret + 4, MAX_CHORD_FRET);
    for (let f = rootFret; f <= hi; f++) {
      if (chordChromas.has((open + f) % 12)) {
        tab[s] = f;
        break;
      }
    }
  }
  const sounding = tab.filter(f => f != null);
  return sounding.length >= 3 ? tab : null;
}

/** 
 * Pre-computed map of Chroma String -> Array of Chord Symbols 
 * e.g. "100010010000" -> ["C", "Cmaj"]
 */
let LIBRARY_CHROMA_CACHE: Map<string, string[]> | null = null;

function getChromaString(notes: string[]): string {
  const chromas = new Array(12).fill('0');
  notes.forEach(n => {
    const c = Note.chroma(n);
    if (c != null) chromas[c] = '1';
  });
  return chromas.join('');
}

function ensureChromaCache() {
  if (LIBRARY_CHROMA_CACHE) return;
  LIBRARY_CHROMA_CACHE = new Map();
  
  const roots = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const suffixes = new Set([
    ...Object.values(SUFFIX_MAP),
    ...Object.values(CANONICAL_SUFFIX_MAP),
    '', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus4', 'sus2', '6', 'm6', '9', 'maj9', 'm9', 'mb6', '6/9', 'maj6/9', 'm6/9'
  ]);

  for (const r of roots) {
    for (const s of suffixes) {
      const notes = getChordNotes(`${r}${s}`);
      if (notes.length === 0) continue;
      
      const key = getChromaString(notes);
      const symbol = `${r}${s === 'major' ? '' : s}`;
      
      const existing = LIBRARY_CHROMA_CACHE.get(key) || [];
      if (!existing.includes(symbol)) {
        existing.push(symbol);
        LIBRARY_CHROMA_CACHE.set(key, existing);
      }
    }
  }
}

/**
 * Detect chords by searching our library definitions (roots + canonical suffixes).
 * 
 * Features:
 * 1. Exact Chroma Match: Instant library lookup.
 * 2. Fragment Detection: Returns chords where input notes are a subset of the library chord.
 * 3. Bass-Note Priority: Sorts results by whether the lowest note matches the potential root.
 */
export function detectLibraryChords(notes: string[]): string[] {
  if (notes.length === 0) return [];
  ensureChromaCache();
  
  const inputChroma = getChromaString(notes);
  
  // 1. Exact matches
  const exactMatches = LIBRARY_CHROMA_CACHE?.get(inputChroma) || [];
  
  // 2. Fragment matches: find all LIBRARY_CHROMA_CACHE keys where inputChroma bits are a subset
  const fragmentMatches: string[] = [];
  const inputBits = parseInt(inputChroma, 2);
  
  LIBRARY_CHROMA_CACHE?.forEach((symbols, chromaStr) => {
    const targetBits = parseInt(chromaStr, 2);
    // If (input & target) == input, then input is a subset
    if ((inputBits & targetBits) === inputBits) {
      for (const s of symbols) {
        if (!exactMatches.includes(s)) fragmentMatches.push(s);
      }
    }
  });

  // 3. Scoring and Sorting
  // We prioritize:
  // - Exact matches
  // - Chords where the lowest note (bass) matches the root
  // - Chords with fewer total notes (closer fit)
  const lowestNote = notes.reduce((min, n) => {
    const m = Note.midi(n);
    const minM = Note.midi(min);
    return (m != null && minM != null && m < minM) ? n : min;
  }, notes[0]);
  const bassRoot = Note.get(lowestNote).pc;

  const allLibraryCandidates = [...exactMatches, ...fragmentMatches];
  
  const scored = allLibraryCandidates.map(symbol => {
    const m = symbol.match(/^([A-G][b#]?)/);
    const root = m ? m[1] : '';
    const isBassRoot = Note.chroma(root) === Note.chroma(bassRoot);
    const chordNotes = getChordNotes(symbol);
    
    let score = 0;
    if (exactMatches.includes(symbol)) score += 1000; // Exact match is king
    if (isBassRoot) score += 500; // Bass root is crucial
    score -= chordNotes.length; // Prefer tighter fit
    
    return { symbol, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.symbol).slice(0, 8); // Return top 8
}
