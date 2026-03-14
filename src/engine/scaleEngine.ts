import { Chord, Scale, Note } from 'tonal';
import { normalizeNotes } from './noteUtils';
import { getScaleRelation } from './scaleRelations';
import { getChordNotes } from './chordDatabase';
import type { ScaleSuggestion } from '../types/music';

const ALL_CHROMATIC = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const COMMON_SCALES = new Set([
  'major', 'minor', 'dorian', 'mixolydian', 'lydian', 'phrygian',
  'aeolian', 'locrian', 'melodic minor', 'harmonic minor',
  'dorian b2', 'lydian augmented', 'lydian dominant', 'mixolydian b6',
  'locrian #2', 'altered', 'locrian 6', 'ionian #5', 'dorian #4',
  'phrygian dominant', 'lydian #9', 'ultralocrian',
  'major pentatonic', 'minor pentatonic', 'blues',
  'whole tone', 'diminished', 'half-whole diminished', 'whole-half diminished',
  'bebop', 'bebop dominant', 'bebop major', 'bebop minor',
]);

const HIGH_RELEVANCE = new Set([
  'major', 'minor', 'dorian', 'mixolydian', 'lydian', 'aeolian',
  'minor pentatonic', 'major pentatonic', 'blues',
  'melodic minor', 'harmonic minor', 'dorian b2', 'lydian augmented',
  'lydian dominant', 'mixolydian b6', 'locrian #2', 'altered',
  'locrian 6', 'ionian #5', 'dorian #4', 'phrygian dominant',
  'lydian #9', 'ultralocrian',
]);

const EXTRA_SCALES = [
  'melodic minor', 'harmonic minor',
  'dorian b2', 'lydian augmented', 'lydian dominant', 'mixolydian b6', 'locrian #2', 'altered',
  'locrian 6', 'ionian #5', 'dorian #4', 'phrygian dominant', 'lydian #9', 'ultralocrian',
];

function chordFitsScale(chordChromas: Set<number>, scaleName: string, root: string): boolean {
  const scale = Scale.get(`${root} ${scaleName}`);
  if (!scale.notes.length) return false;
  const scaleChromas = new Set(scale.notes.map(n => Note.chroma(n)).filter((c): c is number => c != null));
  for (const ch of chordChromas) {
    if (!scaleChromas.has(ch)) return false;
  }
  return true;
}

export function getScalesForChord(chordSymbol: string): ScaleSuggestion[] {
  if (!chordSymbol) return [];

  const m = chordSymbol.match(/^([A-G][b#]?)/);
  const rootStr = m ? m[1] : '';
  if (!rootStr) return [];

  const chord = Chord.get(chordSymbol);
  const tonic = chord.tonic || rootStr;

  const notes = getChordNotes(chordSymbol);
  const chordChromas = new Set(notes.map(n => Note.chroma(n)).filter((c): c is number => c != null));

  const scaleNames = new Set(Chord.chordScales(chordSymbol).filter(name => COMMON_SCALES.has(name)));

  ALL_CHROMATIC.forEach(root => {
    for (const extra of EXTRA_SCALES) {
      if (chordFitsScale(chordChromas, extra, root)) {
        scaleNames.add(`${root}|${extra}`);
      }
    }
  });

  const chordRootChroma = Note.chroma(tonic) ?? -1;
  const results: ScaleSuggestion[] = [];
  const seen = new Set<string>();
  /** For each scale (pitch-class set), keep only the mode whose root matches the chord root. */
  const byChromaSet = new Map<string, { index: number; rootChroma: number }>();

  for (const entry of scaleNames) {
    let scaleName: string;
    let scaleRoot: string;

    if (entry.includes('|')) {
      const [r, n] = entry.split('|');
      scaleRoot = r;
      scaleName = n;
    } else {
      scaleRoot = tonic;
      scaleName = entry;
    }

    const scale = Scale.get(`${scaleRoot} ${scaleName}`);
    if (!scale.notes.length) continue;

    const fullName = `${scaleRoot} ${scaleName}`;
    if (seen.has(fullName)) continue;
    seen.add(fullName);

    const scaleChromas = scale.notes.map(n => Note.chroma(n)).filter((c): c is number => c != null).sort((a, b) => a - b);
    const chromaKey = scaleChromas.join(',');

    const suggestion: ScaleSuggestion = {
      name: fullName,
      type: scaleName,
      notes: normalizeNotes(scale.notes),
      relevance: HIGH_RELEVANCE.has(scaleName) ? 'high' as const
        : COMMON_SCALES.has(scaleName) ? 'medium' as const
        : 'low' as const,
      relationLabel: getScaleRelation(scaleRoot, scaleName) ?? undefined,
    };

    const scaleRootChroma = Note.chroma(scaleRoot) ?? -1;

    if (byChromaSet.has(chromaKey)) {
      const existing = byChromaSet.get(chromaKey)!;
      if (existing.rootChroma === chordRootChroma) continue;
      if (scaleRootChroma === chordRootChroma) {
        results[existing.index] = suggestion;
        byChromaSet.set(chromaKey, { index: existing.index, rootChroma: scaleRootChroma });
      }
      continue;
    }

    const index = results.length;
    results.push(suggestion);
    byChromaSet.set(chromaKey, { index, rootChroma: scaleRootChroma });
  }

  return results.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.relevance] - order[b.relevance];
  });
}
