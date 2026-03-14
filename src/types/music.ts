export interface ChordInfo {
  symbol: string;
  root: string;
  quality: string;
  bass?: string;
  notes: string[];
}

export interface Measure {
  chords: ChordInfo[];
  timeSignature?: string;
  section?: string;
}

export interface Song {
  title: string;
  composer: string;
  style: string;
  key: string;
  bpm: number;
  timeSignature: string;
  measures: Measure[];
}

export interface ScaleSuggestion {
  name: string;
  type: string;
  notes: string[];
  relevance: 'high' | 'medium' | 'low';
  /** e.g. "Dorian ii of C Major" */
  relationLabel?: string | null;
  /** True if this scale also fits the chord before the selected one. */
  relatedToPrevious?: boolean;
  /** True if this scale also fits the chord after the selected one. */
  relatedToNext?: boolean;
}

export interface KeyAnalysis {
  key: string;
  confidence: number;
  suggestedScale: string;
  alternateKeys: { key: string; confidence: number }[];
}
