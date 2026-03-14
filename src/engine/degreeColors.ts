import { Note } from 'tonal';

const DEGREE_COLORS: Record<number, [string, string, string]> = {
  // [flat, natural, sharp]
  1: ['#cc2222', '#ff3333', '#ff7777'],
  2: ['#cc6600', '#ff8800', '#ffaa44'],
  3: ['#ccaa00', '#ffdd00', '#ffee66'],
  4: ['#228833', '#33bb44', '#66dd77'],
  5: ['#2255cc', '#3377ff', '#66aaff'],
  6: ['#5c00b8', '#7f00ff', '#a64dff'],
  7: ['#cc3377', '#ff69b4', '#ff99cc'],
};

const SEMITONE_DEGREE: { degree: number; alt: number }[] = [
  { degree: 1, alt: 1 }, // 0  root
  { degree: 2, alt: 0 }, // 1  b2
  { degree: 2, alt: 1 }, // 2  2
  { degree: 3, alt: 0 }, // 3  b3
  { degree: 3, alt: 1 }, // 4  3
  { degree: 4, alt: 1 }, // 5  4
  { degree: 4, alt: 2 }, // 6  #4 / b5
  { degree: 5, alt: 1 }, // 7  5
  { degree: 6, alt: 0 }, // 8  b6
  { degree: 6, alt: 1 }, // 9  6
  { degree: 7, alt: 0 }, // 10 b7
  { degree: 7, alt: 1 }, // 11 7
];

export function buildDegreeColorMap(
  rootNote: string,
  activeDegrees: Set<number>,
): Map<number, string> | null {
  if (activeDegrees.size === 0) return null;
  const rootCh = Note.chroma(rootNote);
  if (rootCh == null) return null;

  const map = new Map<number, string>();
  for (let ch = 0; ch < 12; ch++) {
    const semi = (ch - rootCh + 12) % 12;
    const info = SEMITONE_DEGREE[semi];
    if (activeDegrees.has(info.degree)) {
      map.set(ch, DEGREE_COLORS[info.degree][info.alt]);
    }
  }
  return map.size > 0 ? map : null;
}
