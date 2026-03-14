import { Key, Chord as TonalChord, Note } from 'tonal';
import type { KeyAnalysis, ChordInfo } from '../types/music';

const ALL_ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function chordFitsKey(chordSymbol: string, keyChords: string[]): number {
  const chord = TonalChord.get(chordSymbol);
  if (!chord.tonic) return 0;

  const chordRoot = Note.enharmonic(chord.tonic);

  for (const kc of keyChords) {
    const keyChord = TonalChord.get(kc);
    if (!keyChord.tonic) continue;

    const keyRoot = Note.enharmonic(keyChord.tonic);

    if (chordRoot === keyRoot) {
      if (chord.quality === keyChord.quality) return 1;
      return 0.4;
    }
  }

  return 0;
}

export function analyzeKey(chords: ChordInfo[]): KeyAnalysis {
  const symbols = chords
    .map(c => c.symbol)
    .filter(s => s && TonalChord.get(s).tonic);

  if (symbols.length === 0) {
    return { key: 'C major', confidence: 0, suggestedScale: 'C major', alternateKeys: [] };
  }

  const results: { key: string; score: number }[] = [];

  for (const root of ALL_ROOTS) {
    try {
      const majorKey = Key.majorKey(root);
      let majorScore = 0;
      for (const s of symbols) majorScore += chordFitsKey(s, [...majorKey.chords]);
      results.push({ key: `${root} major`, score: majorScore / symbols.length });
    } catch { /* skip */ }

    try {
      const minorKey = Key.minorKey(root);
      const minorChords = [
        ...minorKey.natural.chords,
        ...minorKey.harmonic.chords,
        ...minorKey.melodic.chords,
      ];
      let minorScore = 0;
      for (const s of symbols) minorScore += chordFitsKey(s, minorChords);
      results.push({ key: `${root} minor`, score: minorScore / symbols.length });
    } catch { /* skip */ }
  }

  results.sort((a, b) => b.score - a.score);

  const best = results[0] || { key: 'C major', score: 0 };
  const alternates = results.slice(1, 4).filter(r => r.score > 0.25);

  return {
    key: best.key,
    confidence: Math.min(best.score, 1),
    suggestedScale: best.key,
    alternateKeys: alternates.map(r => ({ key: r.key, confidence: Math.min(r.score, 1) })),
  };
}
