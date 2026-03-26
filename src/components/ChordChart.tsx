import { useState, useRef, useCallback, useMemo } from 'react';
import type { Measure, ChordInfo } from '../types/music';
import type { ReactNode } from 'react';

interface ChordChartProps {
  measures: Measure[];
  selectedMeasure: number | null;
  selectedChordIdx: number;
  onMeasureSelect: (index: number, chordIndex?: number) => void;
  songTitle: string;
  composer: string;
  style: string;
  songKey: string;
  bpm: number;
  onKeyChange?: (newKey: string) => void;
  isPlaying?: boolean;
  onPlay?: () => void;
  onStop?: () => void;
  scalesOnPlay?: boolean;
  onScalesOnPlayToggle?: () => void;
  isLooping?: boolean;
  onLoopToggle?: () => void;
  isMetronomeOn?: boolean;
  onMetronomeToggle?: () => void;
  isPianoOn?: boolean;
  onPianoToggle?: () => void;
  isBassOn?: boolean;
  onBassToggle?: () => void;
  swingPercent?: number;
  onSwingChange?: (percent: number) => void;
  onBpmChange?: (delta: number) => void;
  onBpmSet?: (bpm: number) => void;
  onBpmReset?: () => void;
  originalBpm?: number;
  repeatFrom?: { measureIdx: number; chordIdx: number } | null;
  repeatTo?: { measureIdx: number; chordIdx: number } | null;
  repeatPicker?: 'from' | 'to' | null;
  onRepeatFromClick?: () => void;
  onRepeatToClick?: () => void;
}

const ALL_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const SECTION_COLORS: Record<string, string> = {
  A: '#6c63ff',
  B: '#00d4aa',
  C: '#ff6b6b',
  D: '#ffd93d',
  V: '#ff9f43',
  i: '#a29bfe',
};

const MEASURES_PER_ROW = 4;

const NOTE_CHROMA: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3,
  E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8,
  Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

const UPPER = ['I', 'bII', 'II', 'bIII', 'III', 'IV', 'bV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
const LOWER = ['i', 'bii', 'ii', 'biii', 'iii', 'iv', 'bv', 'v', 'bvi', 'vi', 'bvii', 'vii'];

function chordFunction(chord: ChordInfo, songKey: string): string | null {
  const isMinorKey = /[-m]/.test(songKey);
  const keyRoot = songKey.replace(/[-m].*$/, '');
  let keyCh = NOTE_CHROMA[keyRoot];
  const rootCh = NOTE_CHROMA[chord.root];
  if (keyCh == null || rootCh == null) return null;

  if (isMinorKey) {
    // Treat as relative major: 3 semitones up
    keyCh = (keyCh + 3) % 12;
  }

  const interval = (rootCh - keyCh + 12) % 12;
  const s = chord.symbol.slice(chord.root.length);

  const isHalfDim = /^(m7b5|ø|min7b5|-7b5)/i.test(s);
  const isDim = !isHalfDim && /^(dim|o|°)/i.test(s);
  const isMinor = !isHalfDim && !isDim && /^(m(?!aj)|min|-)/i.test(s);
  const isAug = /^(aug|\+|#5)/i.test(s);
  const isSus = /^sus/i.test(s);
  const isDom = !isMinor && !isDim && !isHalfDim && !isSus && /^(7|9|11|13|alt)/i.test(s);

  const lower = isMinor || isDim || isHalfDim;
  let num = (lower ? LOWER : UPPER)[interval];

  if (isHalfDim) num += 'ø';
  else if (isDim) num += '°';
  else if (isAug) num += '+';
  else if (isDom) num += '7';
  else if (isSus) num += 'sus';

  return num;
}

function renderChordCell(
  chord: ChordInfo | null,
  songKey: string,
  showFn: boolean,
): ReactNode {
  if (!chord) return <div className="cell-chords-empty" />;
  const fn = showFn ? chordFunction(chord, songKey) : null;
  return (
    <>
      <span className="cell-chords">{chord.symbol}</span>
      {fn && <span className="cell-function">{fn}</span>}
    </>
  );
}

export function ChordChart({
  measures,
  selectedMeasure,
  selectedChordIdx,
  onMeasureSelect,
  songTitle,
  composer,
  style,
  songKey,
  bpm,
  onKeyChange,
  isPlaying = false,
  onPlay,
  onStop,
  scalesOnPlay = false,
  onScalesOnPlayToggle,
  isLooping = true,
  onLoopToggle,
  isMetronomeOn = true,
  onMetronomeToggle,
  isPianoOn = true,
  onPianoToggle,
  isBassOn = true,
  onBassToggle,
  swingPercent = 50,
  onSwingChange,
  onBpmChange,
  onBpmSet,
  onBpmReset,
  originalBpm,
  repeatFrom = null,
  repeatTo = null,
  repeatPicker = null,
  onRepeatFromClick,
  onRepeatToClick,
}: ChordChartProps) {
  const [showFunctions, setShowFunctions] = useState(true);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdDelayRef = useRef(400);

  // Pre-process measures to resolve repeats (%)
  const resolvedMeasures = useMemo(() => {
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
  }, [measures]);

  const clearHold = useCallback(() => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdDelayRef.current = 400;
  }, []);

  const scheduleHold = useCallback((delta: number) => {
    if (!onBpmChange) return;
    const run = () => {
      onBpmChange(delta);
      holdDelayRef.current = Math.max(60, holdDelayRef.current * 0.92);
      holdTimeoutRef.current = setTimeout(run, holdDelayRef.current);
    };
    holdTimeoutRef.current = setTimeout(run, holdDelayRef.current);
  }, [onBpmChange]);

  const maxCPM = Math.max(1, ...resolvedMeasures.map((m: Measure) => m.chords.length));
  const cols = MEASURES_PER_ROW * maxCPM;

  const measureRows: Measure[][] = [];
  for (let i = 0; i < resolvedMeasures.length; i += MEASURES_PER_ROW) {
    measureRows.push(resolvedMeasures.slice(i, i + MEASURES_PER_ROW));
  }

  return (
    <div className="chord-chart">
      <div className="chart-header">
        <div className="chart-header-top">
          <h2 className="chart-title">{songTitle}</h2>
          <div className="chart-header-actions">
            {onScalesOnPlayToggle && (
              <button
                type="button"
                className={`scales-on-play-btn ${scalesOnPlay ? 'active' : ''}`}
                onClick={onScalesOnPlayToggle}
                title={scalesOnPlay ? 'During play: show scales' : 'During play: show chords'}
              >
                Scales
              </button>
            )}
            {onPlay && (
              <div className="transport-btns">
                <button
                  className={`transport-btn play ${isPlaying ? 'active' : ''}`}
                  onClick={onPlay}
                  disabled={isPlaying}
                  title="Play"
                >▶</button>
                <button
                  className="transport-btn stop"
                  onClick={onStop}
                  disabled={!isPlaying}
                  title="Stop"
                >⏹</button>
                <button
                  className={`transport-btn loop ${isLooping ? 'active' : ''}`}
                  onClick={onLoopToggle}
                  title={isLooping ? 'Loop on' : 'Loop off'}
                >⟳</button>
                {onRepeatFromClick && (
                  <button
                    type="button"
                    className={`transport-btn repeat-from ${repeatPicker === 'from' ? 'active' : ''} ${repeatFrom ? 'set' : ''}`}
                    onClick={onRepeatFromClick}
                    title={repeatPicker === 'from' ? 'Click a chord to set repeat start' : repeatFrom ? 'Repeat from (set) — click again to clear' : 'Set repeat start — click a chord'}
                  >
                    From
                  </button>
                )}
                {onRepeatToClick && (
                  <button
                    type="button"
                    className={`transport-btn repeat-to ${repeatPicker === 'to' ? 'active' : ''} ${repeatTo ? 'set' : ''}`}
                    onClick={onRepeatToClick}
                    title={repeatPicker === 'to' ? 'Click a chord to set repeat end' : repeatTo ? 'Repeat to (set) — click again to clear' : 'Set repeat end — click a chord'}
                  >
                    To
                  </button>
                )}
                {onMetronomeToggle && (
                  <button
                    className={`transport-btn metronome ${isMetronomeOn ? 'active' : ''}`}
                    onClick={onMetronomeToggle}
                    title={isMetronomeOn ? 'Metronome on' : 'Metronome off'}
                  >
                    ♩
                  </button>
                )}
                {onPianoToggle && (
                  <button
                    className={`transport-btn piano ${isPianoOn ? 'active' : ''}`}
                    onClick={onPianoToggle}
                    title={isPianoOn ? 'Piano on' : 'Piano off'}
                  >
                    P
                  </button>
                )}
                {onBassToggle && (
                  <button
                    className={`transport-btn bass ${isBassOn ? 'active' : ''}`}
                    onClick={onBassToggle}
                    title={isBassOn ? 'Bass on' : 'Bass off'}
                  >
                    B
                  </button>
                )}
                {onSwingChange && (
                  <label
                    title={`Swing: ${swingPercent}%`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '6px' }}
                  >
                    <span style={{ fontSize: '11px', opacity: 0.9 }}>Swing</span>
                    <input
                      type="range"
                      min={50}
                      max={75}
                      step={1}
                      value={swingPercent}
                      onChange={(e) => onSwingChange(parseInt(e.target.value, 10))}
                      style={{ width: '84px' }}
                      aria-label="Swing percent"
                    />
                  </label>
                )}
              </div>
            )}
            <button
              className={`fn-toggle ${showFunctions ? 'active' : ''}`}
              onClick={() => setShowFunctions(v => !v)}
              title={showFunctions ? 'Hide chord functions' : 'Show chord functions'}
            >
              RNA
            </button>
          </div>
        </div>
        <div className="chart-meta">
          <span>{composer}</span>
          <span className="meta-dot">&middot;</span>
          <span>{style}</span>
          <span className="meta-dot">&middot;</span>
          <span className="key-select-wrap">
            Key:&nbsp;
            <select
              className="key-select"
              value={songKey.replace(/[-m].*$/, '')}
              onChange={e => onKeyChange?.(e.target.value)}
            >
              {ALL_KEYS.map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </span>
          <span className="meta-dot">&middot;</span>
          <span className="tempo-control">
            <span className="tempo-value">
              &#9833;=
              {onBpmSet ? (
                <input
                  type="number"
                  className="tempo-input"
                  min={30}
                  max={300}
                  key={bpm}
                  defaultValue={bpm}
                  onBlur={(e) => {
                    const v = parseInt((e.target as HTMLInputElement).value, 10);
                    if (!Number.isNaN(v)) onBpmSet(Math.max(30, Math.min(300, v)));
                    else onBpmSet(bpm);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  aria-label="Tempo BPM"
                />
              ) : (
                bpm
              )}
            </span>
            {onBpmChange && (
              <span className="tempo-arrows">
                <button
                  type="button"
                  className="tempo-arrow-btn"
                  title="Faster (hold to repeat)"
                  aria-label="Increase tempo"
                  onPointerDown={(e) => { e.preventDefault(); onBpmChange(5); scheduleHold(5); }}
                  onPointerUp={clearHold}
                  onPointerLeave={clearHold}
                  onPointerCancel={clearHold}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="tempo-arrow-btn"
                  title="Slower (hold to repeat)"
                  aria-label="Decrease tempo"
                  onPointerDown={(e) => { e.preventDefault(); onBpmChange(-5); scheduleHold(-5); }}
                  onPointerUp={clearHold}
                  onPointerLeave={clearHold}
                  onPointerCancel={clearHold}
                >
                  ▼
                </button>
              </span>
            )}
            {onBpmReset && originalBpm != null && bpm !== originalBpm && (
              <button
                type="button"
                className="tempo-reset-btn"
                onClick={onBpmReset}
                title={`Reset to original tempo (${originalBpm})`}
                aria-label="Reset tempo"
              >
                Reset
              </button>
            )}
          </span>
        </div>
      </div>
      {repeatPicker && (
        <div className="repeat-picker-hint" role="status">
          {repeatPicker === 'from' ? 'Click a chord to set repeat start' : 'Click a chord to set repeat end'}
        </div>
      )}
      <div className="chart-grid">
        {measureRows.map((row, ri) => {
          const cells: ReactNode[] = [];
          let i = 0;
          
          while (i < row.length) {
            const measure = row[i];
            const mi = ri * MEASURES_PER_ROW + i;
            const color = measure.section 
              ? SECTION_COLORS[measure.section] || '#6c63ff'
              : undefined;

            if (measure.chords.length > 1) {
              // Complex measure with multiple chords - distribute evenly
              const baseSpan = Math.floor(maxCPM / measure.chords.length);
              const extras = maxCPM % measure.chords.length;

              measure.chords.forEach((chord: ChordInfo, ci2: number) => {
                const isSelected = mi === selectedMeasure && selectedChordIdx === ci2;
                const isRepeatFrom = repeatFrom?.measureIdx === mi && repeatFrom?.chordIdx === ci2;
                const isRepeatTo = repeatTo?.measureIdx === mi && repeatTo?.chordIdx === ci2;
                
                const colSpan = baseSpan + (ci2 < extras ? 1 : 0);

                cells.push(
                  <div
                    key={`${ri}-${i}-${ci2}`}
                    className={`chart-cell ${isSelected ? 'selected' : ''} ${isRepeatFrom ? 'repeat-from' : ''} ${isRepeatTo ? 'repeat-to' : ''}`}
                    style={{ gridColumn: `span ${colSpan}` }}
                    onClick={() => onMeasureSelect(mi, ci2)}
                  >
                    {ci2 === 0 && measure.section && (
                      <span className="section-badge" style={{ backgroundColor: color }}>
                        {measure.section}
                      </span>
                    )}
                    {renderChordCell(chord, songKey, showFunctions)}
                  </div>,
                );
              });
              i++;
            } else {
              // Single chord - attempt to span
              const startChord = measure.chords[0] || null;
              let colSpan = 1;
              let nextI = i + 1;
              const measuresInSpan = [mi];

              while (
                nextI < row.length && 
                row[nextI].chords.length <= 1 && 
                !row[nextI].section &&
                (row[nextI].chords[0]?.symbol === startChord?.symbol)
              ) {
                colSpan++;
                measuresInSpan.push(ri * MEASURES_PER_ROW + nextI);
                nextI++;
              }

              const isSelected = measuresInSpan.includes(selectedMeasure as number) && selectedChordIdx === 0;
              const isRepeatFrom = measuresInSpan.some(m => repeatFrom?.measureIdx === m && repeatFrom?.chordIdx === 0);
              const isRepeatTo = measuresInSpan.some(m => repeatTo?.measureIdx === m && repeatTo?.chordIdx === 0);

              cells.push(
                <div
                  key={`${ri}-${i}-span`}
                  className={`chart-cell ${isSelected ? 'selected' : ''} ${isRepeatFrom ? 'repeat-from' : ''} ${isRepeatTo ? 'repeat-to' : ''}`}
                  style={{ gridColumn: `span ${colSpan * maxCPM}` }}
                  onClick={() => onMeasureSelect(mi, 0)}
                >
                  {measure.section && (
                    <span className="section-badge" style={{ backgroundColor: color }}>
                      {measure.section}
                    </span>
                  )}
                  {renderChordCell(startChord, songKey, showFunctions)}
                </div>,
              );
              i = nextI;
            }
          }

          const padMeasures = MEASURES_PER_ROW - row.length;
          if (padMeasures > 0) {
            cells.push(
              <div 
                key={`${ri}-padrow`} 
                className="chart-cell empty" 
                style={{ gridColumn: `span ${padMeasures * maxCPM}` }}
              >
              </div>
            );
          }

          return (
            <div
              key={ri}
              className="chart-row"
              style={maxCPM > 1 ? { gridTemplateColumns: `repeat(${cols}, 1fr)` } : undefined}
            >
              {cells}
            </div>
          );
        })}
      </div>
    </div>
  );
}
