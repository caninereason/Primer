import { Chord, Note } from 'tonal';
import { normalizeNote } from './noteUtils';

export type VoicingType =
  | 'all'
  | 'shell'
  | 'rootless-a'
  | 'rootless-b'
  | 'iivi'
  | 'quartal'
  | 'spread'
  | 'upper-structure'
  | 'guitar';

export const VOICING_OPTIONS: { value: VoicingType; label: string }[] = [
  { value: 'all', label: 'All Notes' },
  { value: 'shell', label: '1. Shell' },
  { value: 'rootless-a', label: '2a. Rootless A' },
  { value: 'rootless-b', label: '2b. Rootless B' },
  { value: 'iivi', label: '3. ii-V-I Auto' },
  { value: 'quartal', label: '4. Quartal' },
  { value: 'spread', label: '5. Spread (Evans)' },
  { value: 'upper-structure', label: '6. Upper Structure' },
  { value: 'guitar', label: '7. Guitar (Mirror)' },
];

export interface VoicingResult {
  leftHand: string[];
  rightHand: string[];
}

function tr(root: string, interval: string): string {
  const r = Note.transpose(root, interval);
  if (!r) return '';
  return normalizeNote(Note.simplify(r) || r);
}

function voiceUp(notes: string[], startOctave: number): string[] {
  let oct = startOctave;
  let prevMidi = -1;
  return notes.filter(Boolean).map((n, i) => {
    const nn = normalizeNote(n);
    const full = `${nn}${oct}`;
    const midi = Note.midi(full);
    if (midi == null) return full;
    if (i > 0 && midi <= prevMidi) {
      oct++;
      const raised = `${nn}${oct}`;
      prevMidi = Note.midi(raised) ?? midi + 12;
      return raised;
    }
    prevMidi = midi;
    return full;
  });
}

/** Pitch class after the last "/" in a chord symbol (e.g. `C7/G` → `G`). */
export function slashBassPitchClass(symbol: string): string | null {
  const i = symbol.lastIndexOf('/');
  if (i < 0 || i >= symbol.length - 1) return null;
  const tail = symbol.slice(i + 1).trim();
  const m = tail.match(/^([A-G][b#]?)/);
  return m ? m[1] : null;
}

function lowestMidiForPitchClass(notes: string[], chroma: number): number | null {
  let best: number | null = null;
  for (const n of notes) {
    if (Note.chroma(n) !== chroma) continue;
    const mid = Note.midi(n);
    if (mid == null) continue;
    if (best == null || mid < best) best = mid;
  }
  return best;
}

/** Place slash bass in the lowest register that is still below the chord root. */
function slashBassNoteBelowTonic(
  bassPc: string,
  chordTonic: string,
  allVoicedNotes: string[],
): string | null {
  const bc = Note.chroma(bassPc);
  const tc = Note.chroma(chordTonic);
  if (bc == null || tc == null || bc === tc) return null;

  let rootFloor = lowestMidiForPitchClass(allVoicedNotes, tc);
  if (rootFloor == null) {
    const approx = Note.midi(`${normalizeNote(chordTonic)}3`);
    rootFloor = approx ?? 55;
  }

  let o = Math.floor((rootFloor - 1) / 12);
  const bn = normalizeNote(bassPc);
  let low = `${bn}${o}`;
  let bm = Note.midi(low);
  while (bm != null && bm >= rootFloor) {
    o--;
    low = `${bn}${o}`;
    bm = Note.midi(low);
  }
  if (bm == null) return null;
  return normalizeNote(low);
}

function applySlashBassToStructuredVoicing(
  result: VoicingResult,
  chordSymbol: string,
  chordTonic: string,
): VoicingResult {
  const bassPc = slashBassPitchClass(chordSymbol);
  if (!bassPc) return result;
  const bc = Note.chroma(bassPc);
  const tc = Note.chroma(chordTonic);
  if (bc == null || tc == null || bc === tc) return result;

  const allNotes = [...result.leftHand, ...result.rightHand];
  const lowBass = slashBassNoteBelowTonic(bassPc, chordTonic, allNotes);
  if (!lowBass) return result;

  const filteredLh = result.leftHand.filter((n) => Note.chroma(n) !== bc);
  return {
    leftHand: [lowBass, ...filteredLh],
    rightHand: result.rightHand,
  };
}

/** Caption for guitar panel, e.g. `G in bass` for `Cmaj7/G`. */
export function slashBassDisplayLabel(symbol: string, bassField?: string): string | null {
  const raw = (bassField && bassField.trim()) || slashBassPitchClass(symbol);
  if (!raw) return null;
  const m = symbol.match(/^([A-G][b#]?)/);
  const symRoot = m?.[1];
  if (symRoot && Note.chroma(raw) === Note.chroma(symRoot)) return null;
  return `${normalizeNote(raw)} in bass`;
}

/** "All notes" piano mode: LH = slash bass under root, RH = remaining chord tones. */
export function splitSlashChordForPiano(
  symbol: string,
  chordTonic: string,
  chordNotes: string[],
): { leftHand: string[]; rightHand: string[] } | null {
  const bassPc = slashBassPitchClass(symbol);
  if (!bassPc) return null;
  const bc = Note.chroma(bassPc);
  const tc = Note.chroma(chordTonic);
  if (bc == null || tc == null || bc === tc) return null;

  const tonicRef = `${normalizeNote(chordTonic)}4`;
  const lowBass = slashBassNoteBelowTonic(bassPc, chordTonic, [tonicRef]);
  if (!lowBass) return null;

  const rhsPcs: string[] = [];
  const seen = new Set<number>();
  for (const n of chordNotes) {
    const ch = Note.chroma(n);
    if (ch == null || ch === bc || seen.has(ch)) continue;
    seen.add(ch);
    rhsPcs.push((Note.pitchClass(n) || n.replace(/\d+$/, '')) as string);
  }
  const rh =
    rhsPcs.length > 0 ? voiceUp(rhsPcs, 4) : voiceUp([normalizeNote(chordTonic)], 4);
  return { leftHand: [lowBass], rightHand: rh };
}

export function computeVoicing(
  chordSymbol: string,
  type: VoicingType,
): VoicingResult | null {
  if (type === 'all') return null;

  const chord = Chord.get(chordSymbol);
  if (!chord.tonic) return null;

  const root = chord.tonic;
  const ints = chord.intervals;
  const is3m = ints.includes('3m');
  const is3M = ints.includes('3M');
  const is5d = ints.includes('5d');
  const is7M = ints.includes('7M');
  const is7m = ints.includes('7m');
  const hasSeventh = is7M || is7m;
  const isDom = is3M && is7m;

  const third = tr(root, is3m ? '3m' : '3M');
  const fifth = tr(root, is5d ? '5d' : '5P');
  const seventh = hasSeventh ? tr(root, is7M ? '7M' : '7m') : null;
  const ninth = tr(root, '2M');
  const thirteenth = tr(root, is5d ? '6m' : '6M');

  let out: VoicingResult | null = null;
  switch (type) {
    case 'shell':
      out = {
        leftHand: voiceUp(seventh ? [root, seventh] : [root, fifth], 3),
        rightHand: voiceUp([third, ninth], 4),
      };
      break;

    case 'rootless-a':
      out = {
        leftHand: voiceUp(seventh ? [third, seventh] : [third, fifth], 3),
        rightHand: voiceUp([ninth, fifth], 4),
      };
      break;

    case 'rootless-b':
      out = {
        leftHand: voiceUp(seventh ? [seventh, third] : [fifth, third], 3),
        rightHand: voiceUp([fifth, ninth], 4),
      };
      break;

    case 'iivi':
      if (isDom && seventh)
        out = {
          leftHand: voiceUp([seventh, third], 3),
          rightHand: voiceUp([fifth, ninth], 4),
        };
      else
        out = {
          leftHand: voiceUp(seventh ? [third, seventh] : [third, fifth], 3),
          rightHand: voiceUp([ninth, fifth], 4),
        };
      break;

    case 'quartal': {
      const p1 = tr(root, '4P');
      const p2 = tr(p1, '4P');
      const p3 = tr(p2, '4P');
      const m3 = tr(p3, '3M');
      out = {
        leftHand: voiceUp([root, p1, p2], 3),
        rightHand: voiceUp([p3, m3], 4),
      };
      break;
    }

    case 'spread':
      out = {
        leftHand: [`${root}3`, `${third}4`].filter(Boolean),
        rightHand: voiceUp(seventh ? [seventh, ninth, thirteenth] : [fifth, ninth, thirteenth], 4),
      };
      break;

    case 'upper-structure': {
      const triadRoot = isDom ? tr(root, '5P') : ninth;
      const triadThird = tr(triadRoot, '3M');
      const triadFifth = tr(triadRoot, '5P');
      out = {
        leftHand: voiceUp(seventh ? [third, seventh] : [third, fifth], 3),
        rightHand: voiceUp([triadRoot, triadThird, triadFifth], 4),
      };
      break;
    }

    default:
      out = null;
  }

  if (!out) return null;
  return applySlashBassToStructuredVoicing(out, chordSymbol, root);
}

export interface GuitarPosition {
  label: string;
  startFret: number;
  endFret: number;
}

export function computeGuitarPositions(rootChroma: number): GuitarPosition[] {
  // Use the same CAGED root-finding logic as chordDatabase.ts to ensure synchronization
  // Standard tuning: E=4, A=9, D=2, G=7, B=11, e=4
  const rootOnA = (rootChroma - 9 + 12) % 12; // root on A string
  const rootOnE = (rootChroma - 4 + 12) % 12; // root on E string
  const rootOnD = (rootChroma - 2 + 12) % 12; // root on D string

  // LEFT shapes (C, G) need room below root; RIGHT shapes (A, E, D) cluster above
  const leftA = rootOnA < 3 ? rootOnA + 12 : rootOnA;
  const leftE = rootOnE < 3 ? rootOnE + 12 : rootOnE;
  const dFret = rootOnD === 0 ? 12 : rootOnD;

  const defs = [
    { start: Math.max(0, leftA - 4), center: leftA - 2 },   // C shape (root on A, left)
    { start: rootOnA,                center: rootOnA + 2 }, // A shape (root on A, right)
    { start: Math.max(0, leftE - 4), center: leftE - 2 },   // G shape (root on E, left)
    { start: rootOnE,                center: rootOnE + 2 }, // E shape (root on E, right)
    { start: rootOnD,                center: rootOnD + 2 }, // D shape (root on D, right)
  ];

  // Sort by center fret so positions ascend the neck identically to chords
  defs.sort((a, b) => a.center - b.center);

  const maxFret = 24;
  return defs.map((d, i) => ({
    label: `Pos ${i + 1}`,
    startFret: Math.max(0, d.start - 1),
    endFret: Math.min(d.start + 4, maxFret),
  }));
}
