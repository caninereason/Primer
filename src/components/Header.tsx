import type { Song } from '../types/music';

interface HeaderProps {
  songs: Song[];
  selectedSongIndex: number;
  onSongSelect: (index: number) => void;
  onImportClick: () => void;
  onDemoLoad: () => void;
  onLibraryClick: () => void;
  activeDegrees: Set<number>;
  onToggleDegree: (degree: number) => void;
  onToggleAllDegrees: () => void;
}

const DEG_COLORS = [
  '#ff3333', '#ff8800', '#ffdd00', '#33bb44',
  '#3377ff', '#7f00ff', '#ff69b4',
];

const DEGREE_LABELS: Record<number, string> = {
  1: 'Root',
  2: '2nd',
  3: '3rd',
  4: '4th',
  5: '5th',
  6: '6th',
  7: '7th',
};

export function Header({
  songs,
  selectedSongIndex,
  onSongSelect,
  onImportClick,
  onDemoLoad,
  onLibraryClick,
  activeDegrees,
  onToggleDegree,
  onToggleAllDegrees,
}: HeaderProps) {
  const allOn = activeDegrees.size === 7;

  return (
    <header className="app-header">
      <div className="header-left">
        <h1 className="app-title">Primer</h1>
        <span className="app-subtitle">Music Theory Workstation</span>
      </div>
      <div className="header-center">
        {songs.length > 0 && (
          <select
            className="song-selector"
            value={selectedSongIndex}
            onChange={e => onSongSelect(Number(e.target.value))}
          >
            {songs.map((song, i) => (
              <option key={i} value={i}>
                {song.title} — {song.composer}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="header-right">
        <div className="degree-toggles">
          <button
            className={`degree-all-btn ${allOn ? 'all-on' : activeDegrees.size > 0 ? 'some-on' : ''}`}
            onClick={onToggleAllDegrees}
            title={activeDegrees.size > 0 ? 'Clear all degrees' : 'Enable all degrees'}
          >
            Note Colours
          </button>
          {[1, 2, 3, 4, 5, 6, 7].map(d => (
            <button
              key={d}
              className={`degree-btn ${activeDegrees.has(d) ? 'active' : ''}`}
              style={{
                background: activeDegrees.has(d) ? DEG_COLORS[d - 1] : 'transparent',
                borderColor: DEG_COLORS[d - 1],
                color: activeDegrees.has(d) ? '#fff' : DEG_COLORS[d - 1],
              }}
              onClick={() => onToggleDegree(d)}
              title={DEGREE_LABELS[d]}
            >
              {DEGREE_LABELS[d]}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" onClick={onLibraryClick}>
          Scale/Chord Library
        </button>
        <button className="btn btn-ghost" onClick={onDemoLoad}>
          Demo Songs
        </button>
        <button className="btn btn-primary" onClick={onImportClick}>
          Import
        </button>
      </div>
    </header>
  );
}
