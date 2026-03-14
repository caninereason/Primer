import { Note } from 'tonal';
import { normalizeNote } from './noteUtils';

/** Semitones from parent root to each mode degree (degree 1 = 0, 2 = 2, ...) */
const MAJOR_DEGREE_SEMIS = [0, 2, 4, 5, 7, 9, 11];

/** Interval down from scale root to parent root: 9 = 6M (vi), 11 = 7M (vii) */
const SEMIS_DOWN_TO_INTERVAL: Record<number, string> = {
  0: '1P', 2: '2M', 4: '3M', 5: '4P', 7: '5P', 9: '6M', 11: '7M',
};

/** Prefer flat spelling for key in relation (so "Gb Major" not "F# Major") */
const SHARP_TO_FLAT: Record<string, string> = {
  'F#': 'Gb', 'C#': 'Db', 'G#': 'Ab', 'D#': 'Eb', 'A#': 'Bb', 'E#': 'F', 'B#': 'C',
};

/** Mode degree to roman (lowercase for minor/ diminished) */
const DEGREE_ROMAN = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii'];

/** Scale type -> { parent name, degree 1-7, display name for mode } */
const MODE_INFO: Record<string, { parent: string; degree: number; label: string }> = {
  // Major (Ionian) modes
  'major': { parent: 'Major', degree: 1, label: 'Ionian' },
  'dorian': { parent: 'Major', degree: 2, label: 'Dorian' },
  'phrygian': { parent: 'Major', degree: 3, label: 'Phrygian' },
  'lydian': { parent: 'Major', degree: 4, label: 'Lydian' },
  'mixolydian': { parent: 'Major', degree: 5, label: 'Mixolydian' },
  'aeolian': { parent: 'Major', degree: 6, label: 'Aeolian' },
  'minor': { parent: 'Major', degree: 6, label: 'Aeolian' },
  'locrian': { parent: 'Major', degree: 7, label: 'Locrian' },
  // Melodic minor modes
  'melodic minor': { parent: 'Melodic Minor', degree: 1, label: 'Melodic Minor' },
  'dorian b2': { parent: 'Melodic Minor', degree: 2, label: 'Dorian b2' },
  'lydian augmented': { parent: 'Melodic Minor', degree: 3, label: 'Lydian Augmented' },
  'lydian dominant': { parent: 'Melodic Minor', degree: 4, label: 'Lydian Dominant' },
  'mixolydian b6': { parent: 'Melodic Minor', degree: 5, label: 'Mixolydian b6' },
  'locrian #2': { parent: 'Melodic Minor', degree: 6, label: 'Locrian #2' },
  'altered': { parent: 'Melodic Minor', degree: 7, label: 'Altered' },
  // Harmonic minor modes
  'harmonic minor': { parent: 'Harmonic Minor', degree: 1, label: 'Harmonic Minor' },
  'locrian 6': { parent: 'Harmonic Minor', degree: 2, label: 'Locrian ♮6' },
  'ionian #5': { parent: 'Harmonic Minor', degree: 3, label: 'Ionian #5' },
  'dorian #4': { parent: 'Harmonic Minor', degree: 4, label: 'Dorian #4' },
  'phrygian dominant': { parent: 'Harmonic Minor', degree: 5, label: 'Phrygian Dominant' },
  'lydian #9': { parent: 'Harmonic Minor', degree: 6, label: 'Lydian #2' },
  'ultralocrian': { parent: 'Harmonic Minor', degree: 7, label: 'Ultralocrian' },
};

/**
 * Get relation string e.g. "Dorian ii of C Major", "Phrygian Dominant V of C Harmonic Minor".
 * Returns null if scale type is not a known mode.
 */
function simplifyParentKey(note: string): string {
  const noDouble = normalizeNote(note.replace(/\d+$/, ''));
  return SHARP_TO_FLAT[noDouble] ?? noDouble;
}

export function getScaleRelation(scaleRoot: string, scaleType: string): string | null {
  const info = MODE_INFO[scaleType.toLowerCase()];
  if (!info) return null;

  const degreeSemis = MAJOR_DEGREE_SEMIS[info.degree - 1];
  const intervalDown = SEMIS_DOWN_TO_INTERVAL[degreeSemis];
  if (!intervalDown) return null;
  let parentRoot = Note.transpose(scaleRoot.replace(/\d+$/, ''), `-${intervalDown}`);
  if (!parentRoot) return null;

  parentRoot = simplifyParentKey(parentRoot);

  const roman = DEGREE_ROMAN[info.degree - 1];
  return `${info.label} ${roman} of ${parentRoot} ${info.parent}`;
}

export { MODE_INFO, DEGREE_ROMAN };
