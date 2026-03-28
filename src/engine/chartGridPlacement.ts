import type { ChordInfo, Measure } from '../types/music';

/** Must match ChordChart layout. */
export const CHART_MEASURES_PER_ROW = 4;

/** Same repeat (%) resolution as ChordChart. */
export function resolveChartMeasures(measures: Measure[]): Measure[] {
  const result: Measure[] = [];
  let lastChords: ChordInfo[] = [];
  for (const m of measures) {
    if (m.chords.length === 0) {
      result.push({ ...m, chords: lastChords });
    } else {
      lastChords = m.chords;
      result.push(m);
    }
  }
  return result;
}
