import { useState, useMemo } from 'react';
import { Chord, Scale } from 'tonal';
import { normalizeNotes } from '../engine/noteUtils';
import { getScaleRelation } from '../engine/scaleRelations';
import type { ChordInfo, ScaleSuggestion } from '../types/music';

const ALL_ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

interface ScaleCategory {
  name: string;
  scales: string[];
}

const SCALE_CATEGORIES: ScaleCategory[] = [
  { name: 'Major & Modes', scales: ['major', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian'] },
  { name: 'Minor', scales: ['minor', 'melodic minor', 'harmonic minor'] },
  { name: 'Melodic Minor Modes', scales: ['melodic minor', 'dorian b2', 'lydian augmented', 'lydian dominant', 'mixolydian b6', 'locrian #2', 'altered'] },
  { name: 'Harmonic Minor Modes', scales: ['harmonic minor', 'locrian 6', 'ionian #5', 'dorian #4', 'phrygian dominant', 'lydian #9', 'ultralocrian'] },
  { name: 'Pentatonic & Blues', scales: ['major pentatonic', 'minor pentatonic', 'blues'] },
  { name: 'Other', scales: ['whole tone', 'diminished', 'bebop', 'bebop dominant'] },
];

interface ChordEntry {
  label: string;
  suffix: string;
}

interface ChordCategory {
  name: string;
  chords: ChordEntry[];
}

const CHORD_CATEGORIES: ChordCategory[] = [
  {
    name: 'Triads',
    chords: [
      { label: 'Major', suffix: '' },
      { label: 'Minor', suffix: 'm' },
      { label: 'Diminished', suffix: 'dim' },
      { label: 'Augmented', suffix: 'aug' },
      { label: 'Suspended 2', suffix: 'sus2' },
      { label: 'Suspended 4', suffix: 'sus4' },
    ],
  },
  {
    name: 'Seventh Chords',
    chords: [
      { label: 'Major 7', suffix: 'maj7' },
      { label: 'Dominant 7', suffix: '7' },
      { label: 'Minor 7', suffix: 'm7' },
      { label: 'Minor Major 7', suffix: 'mM7' },
      { label: 'Half Diminished', suffix: 'm7b5' },
      { label: 'Diminished 7', suffix: 'dim7' },
      { label: 'Augmented Major 7', suffix: 'maj7#5' },
      { label: 'Augmented Dominant 7', suffix: '7#5' },
      { label: 'Dominant 7sus4', suffix: '7sus4' },
    ],
  },
  {
    name: 'Ninth Chords',
    chords: [
      { label: 'Major 9', suffix: 'maj9' },
      { label: 'Dominant 9', suffix: '9' },
      { label: 'Minor 9', suffix: 'm9' },
      { label: 'Minor Major 9', suffix: 'mM9' },
      { label: 'Dominant 7b9', suffix: '7b9' },
      { label: 'Dominant 7#9', suffix: '7#9' },
      { label: 'Add9', suffix: 'add9' },
      { label: 'Minor Add9', suffix: 'madd9' },
      { label: 'Dominant 9sus4', suffix: '9sus4' },
    ],
  },
  {
    name: 'Eleventh Chords',
    chords: [
      { label: 'Major 11', suffix: 'maj11' },
      { label: 'Major 7#11', suffix: 'maj7#11' },
      { label: 'Dominant 11', suffix: '11' },
      { label: 'Dominant 7#11', suffix: '7#11' },
      { label: 'Minor 11', suffix: 'm11' },
      { label: 'Minor Major 11', suffix: 'mM11' },
    ],
  },
  {
    name: 'Thirteenth Chords',
    chords: [
      { label: 'Major 13', suffix: 'maj13' },
      { label: 'Major 13#11', suffix: 'maj13#11' },
      { label: 'Dominant 13', suffix: '13' },
      { label: 'Dominant 13b9', suffix: '13b9' },
      { label: 'Minor 13', suffix: 'm13' },
    ],
  },
  {
    name: 'Altered Dominant',
    chords: [
      { label: '7alt', suffix: '7alt' },
      { label: '7b5', suffix: '7b5' },
      { label: '7#5', suffix: '7#5' },
      { label: '7b5b9', suffix: '7b5b9' },
      { label: '7#5b9', suffix: '7#5b9' },
    ],
  },
  {
    name: 'Sixth Chords',
    chords: [
      { label: 'Major 6', suffix: '6' },
      { label: 'Minor 6', suffix: 'm6' },
      { label: '6/9', suffix: '6/9' },
      { label: 'Minor 6/9', suffix: 'm6/9' },
      { label: 'Minor b6', suffix: 'mb6' },
    ],
  },
];

interface LibraryProps {
  selectedRoot: string;
  selectedSuffix: string;
  selectedScale: ScaleSuggestion | null;
  onChordSelect: (chord: ChordInfo, suffix: string) => void;
  onScaleSelect: (scale: ScaleSuggestion | null) => void;
  onRootChange: (root: string) => void;
  onBack: () => void;
}

export function Library({
  selectedRoot,
  selectedSuffix,
  selectedScale,
  onChordSelect,
  onScaleSelect,
  onRootChange,
  onBack,
}: LibraryProps) {
  const [tab, setTab] = useState<'chords' | 'scales'>('chords');
  const [search, setSearch] = useState('');

  const filteredCategories = useMemo(() => {
    if (!search.trim()) return CHORD_CATEGORIES;
    const q = search.toLowerCase();
    return CHORD_CATEGORIES
      .map(cat => ({
        ...cat,
        chords: cat.chords.filter(
          c => c.label.toLowerCase().includes(q) || c.suffix.toLowerCase().includes(q),
        ),
      }))
      .filter(cat => cat.chords.length > 0);
  }, [search]);

  const filteredScaleCategories = useMemo(() => {
    if (!search.trim()) return SCALE_CATEGORIES;
    const q = search.toLowerCase();
    return SCALE_CATEGORIES
      .map(cat => ({
        ...cat,
        scales: cat.scales.filter(s => s.toLowerCase().includes(q)),
      }))
      .filter(cat => cat.scales.length > 0);
  }, [search]);

  const handleChordSelect = (entry: ChordEntry) => {
    const symbol = `${selectedRoot}${entry.suffix}`;
    const c = Chord.get(symbol);
    const root = c.tonic || selectedRoot;
    const notes = c.notes.length > 0 ? normalizeNotes(c.notes) : [];
    onChordSelect(
      { symbol, root, quality: c.type || entry.suffix, notes },
      entry.suffix,
    );
    onScaleSelect(null);
  };

  const handleScaleSelect = (scaleType: string) => {
    const scale = Scale.get(`${selectedRoot} ${scaleType}`);
    if (!scale.notes.length) return;
    const name = `${selectedRoot} ${scaleType}`;
    onScaleSelect({
      name,
      type: scaleType,
      notes: normalizeNotes(scale.notes),
      relevance: 'high',
      relationLabel: getScaleRelation(selectedRoot, scaleType) ?? undefined,
    });
  };

  return (
    <div className="library-panel">
      <div className="library-header">
        <button className="btn btn-ghost library-back-btn" onClick={onBack}>
          ← Back to Chart
        </button>
        <h3 className="library-title">Chord / Scale Library</h3>
      </div>

      <div className="library-tabs">
        <button
          className={`library-tab ${tab === 'chords' ? 'active' : ''}`}
          onClick={() => setTab('chords')}
        >
          Chords
        </button>
        <button
          className={`library-tab ${tab === 'scales' ? 'active' : ''}`}
          onClick={() => setTab('scales')}
        >
          Scales
        </button>
      </div>

      <div className="library-controls">
        <div className="library-root-row">
          {ALL_ROOTS.map(r => (
            <button
              key={r}
              className={`library-root-btn ${r === selectedRoot ? 'active' : ''}`}
              onClick={() => onRootChange(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          className="library-search"
          placeholder={tab === 'chords' ? 'Filter chords…' : 'Filter scales…'}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {tab === 'chords' ? (
        <div className="library-chord-grid">
          {filteredCategories.map(cat => (
            <div key={cat.name} className="library-category">
              <h4 className="library-category-name">{cat.name}</h4>
              <div className="library-category-chords">
                {cat.chords.map(entry => {
                  const symbol = `${selectedRoot}${entry.suffix}`;
                  const isActive = entry.suffix === selectedSuffix;
                  return (
                    <button
                      key={entry.suffix}
                      className={`library-chord-btn ${isActive ? 'active' : ''}`}
                      onClick={() => handleChordSelect(entry)}
                      title={entry.label}
                    >
                      <span className="library-chord-symbol">{symbol}</span>
                      <span className="library-chord-label">{entry.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="library-scale-grid">
          {filteredScaleCategories.map(cat => (
            <div key={cat.name} className="library-category">
              <h4 className="library-category-name">{cat.name}</h4>
              <div className="library-category-scales">
                {cat.scales.map(scaleType => {
                  const fullName = `${selectedRoot} ${scaleType}`;
                  const isActive = selectedScale?.name === fullName;
                  const relation = getScaleRelation(selectedRoot, scaleType);
                  return (
                    <button
                      key={scaleType}
                      className={`library-scale-btn ${isActive ? 'active' : ''}`}
                      onClick={() => handleScaleSelect(scaleType)}
                      title={relation || fullName}
                    >
                      <span className="library-scale-name">{fullName}</span>
                      {relation && <span className="library-scale-relation">{relation}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
