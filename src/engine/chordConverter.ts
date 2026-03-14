const QUALITY_MAP: [string, string][] = [
  ['-^9', 'mMaj9'],
  ['-^7', 'mMaj7'],
  ['^7#11', 'maj7#11'],
  ['^7#5', 'maj7#5'],
  ['^7', 'maj7'],
  ['^9', 'maj9'],
  ['^13', 'maj13'],
  ['^', 'maj7'],
  ['-7b5', 'm7b5'],
  ['-9', 'm9'],
  ['-11', 'm11'],
  ['-6', 'm6'],
  ['-7', 'm7'],
  ['-', 'm'],
  ['h7', 'm7b5'],
  ['h', 'm7b5'],
  ['o7', 'dim7'],
  ['o', 'dim'],
  ['7sus', '7sus4'],
  ['sus', 'sus4'],
  ['7alt', '7alt'],
];

export function iRealToStandard(iRealChord: string): string {
  if (!iRealChord) return '';

  const chord = iRealChord.trim();
  if (['n', 'x', 'W', 'p', ''].includes(chord)) return '';

  const rootMatch = chord.match(/^([A-G][b#]?)/);
  if (!rootMatch) return chord;

  const root = rootMatch[1];
  let rest = chord.substring(root.length);

  let bass = '';
  const slashIdx = rest.lastIndexOf('/');
  if (slashIdx >= 0) {
    const possibleBass = rest.substring(slashIdx + 1);
    if (/^[A-G][b#]?$/.test(possibleBass)) {
      bass = '/' + possibleBass;
      rest = rest.substring(0, slashIdx);
    }
  }

  for (const [from, to] of QUALITY_MAP) {
    if (rest.startsWith(from)) {
      rest = to + rest.substring(from.length);
      break;
    }
  }

  return root + rest + bass;
}
