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

  switch (type) {
    case 'shell':
      return {
        leftHand: voiceUp(seventh ? [root, seventh] : [root, fifth], 3),
        rightHand: voiceUp([third, ninth], 4),
      };

    case 'rootless-a':
      return {
        leftHand: voiceUp(seventh ? [third, seventh] : [third, fifth], 3),
        rightHand: voiceUp([ninth, fifth], 4),
      };

    case 'rootless-b':
      return {
        leftHand: voiceUp(seventh ? [seventh, third] : [fifth, third], 3),
        rightHand: voiceUp([fifth, ninth], 4),
      };

    case 'iivi':
      if (isDom && seventh)
        return {
          leftHand: voiceUp([seventh, third], 3),
          rightHand: voiceUp([fifth, ninth], 4),
        };
      return {
        leftHand: voiceUp(seventh ? [third, seventh] : [third, fifth], 3),
        rightHand: voiceUp([ninth, fifth], 4),
      };

    case 'quartal': {
      const p1 = tr(root, '4P');
      const p2 = tr(p1, '4P');
      const p3 = tr(p2, '4P');
      const m3 = tr(p3, '3M');
      return {
        leftHand: voiceUp([root, p1, p2], 3),
        rightHand: voiceUp([p3, m3], 4),
      };
    }

    case 'spread':
      return {
        leftHand: [`${root}3`, `${third}4`].filter(Boolean),
        rightHand: voiceUp(seventh ? [seventh, ninth, thirteenth] : [fifth, ninth, thirteenth], 4),
      };

    case 'upper-structure': {
      const triadRoot = isDom ? tr(root, '5P') : ninth;
      const triadThird = tr(triadRoot, '3M');
      const triadFifth = tr(triadRoot, '5P');
      return {
        leftHand: voiceUp(seventh ? [third, seventh] : [third, fifth], 3),
        rightHand: voiceUp([triadRoot, triadThird, triadFifth], 4),
      };
    }

    default:
      return null;
  }
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

  const maxFret = 12;
  return defs.map((d, i) => ({
    label: `Pos ${i + 1}`,
    startFret: Math.max(0, d.start - 1),
    endFret: Math.min(d.start + 4, maxFret),
  }));
}
