import { useState, useEffect } from 'react';
import { Note } from 'tonal';
import type { ScaleSuggestion, KeyAnalysis } from '../types/music';

interface ScalePanelProps {
  songKey: string;
  keyAnalysis: KeyAnalysis | null;
  chordScales: ScaleSuggestion[];
  selectedChordSymbol: string | null;
  selectedScale: ScaleSuggestion | null;
  onScaleSelect: (scale: ScaleSuggestion) => void;
  degreeColorMap?: Map<number, string> | null;
  prevChordSymbol?: string | null;
  nextChordSymbol?: string | null;
}

function formatKey(key: string): string {
  if (!key) return '';
  if (key.endsWith('-')) return `${key.slice(0, -1)} minor`;
  const m = key.match(/^([A-G][b#]?)m$/);
  if (m) return `${m[1]} minor`;
  return `${key} major`;
}

export function ScalePanel({
  songKey,
  keyAnalysis,
  chordScales,
  selectedChordSymbol,
  selectedScale,
  onScaleSelect,
  degreeColorMap,
  prevChordSymbol,
  nextChordSymbol,
}: ScalePanelProps) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    if (mq.matches) setExpanded(false);
    const handler = () => { if (mq.matches) setExpanded(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <aside className={`scale-panel ${expanded ? 'scale-panel--expanded' : 'scale-panel--collapsed'}`}>
      <button
        type="button"
        className="scale-panel-toggle"
        onClick={() => setExpanded((e) => !e)}
        title={expanded ? 'Collapse scale suggestions' : 'Expand scale suggestions'}
        aria-expanded={expanded}
      >
        <span className="scale-panel-toggle-label">Scales</span>
        <span className="scale-panel-toggle-icon" aria-hidden>{expanded ? '›' : '‹'}</span>
      </button>
      <div className="scale-panel-inner">
      <div className="key-analysis">
        <h3 className="panel-heading">Key</h3>
        <div className="key-result">
          <span className="key-name">{formatKey(songKey)}</span>
          {keyAnalysis && (
            <div className="key-analysis-sub">
              <div className="confidence-bar">
                <div
                  className="confidence-fill"
                  style={{ width: `${keyAnalysis.confidence * 100}%` }}
                />
              </div>
              <span className="confidence-label">
                Analysis: {keyAnalysis.key} ({Math.round(keyAnalysis.confidence * 100)}%)
              </span>
            </div>
          )}
          {keyAnalysis && keyAnalysis.alternateKeys.length > 0 && (
            <div className="alternate-keys">
              <span className="alt-label">Also possible:</span>
              {keyAnalysis.alternateKeys.map((alt, i) => (
                <span key={i} className="alt-key">
                  {alt.key} ({Math.round(alt.confidence * 100)}%)
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedChordSymbol ? (
        <div className="chord-scales">
          <h3 className="panel-heading">
            Scales for{' '}
            <span className="chord-highlight">{selectedChordSymbol}</span>
          </h3>
          {chordScales.length === 0 ? (
            <p className="no-scales">No scale suggestions available</p>
          ) : (
            <div className="scale-list">
              {chordScales.map((scale, i) => (
                <button
                  key={i}
                  className={`scale-card ${scale.relevance} ${
                    selectedScale?.name === scale.name ? 'active' : ''
                  }`}
                  onClick={() => onScaleSelect(scale)}
                >
                  <div className="scale-card-header">
                    <span className="scale-name">{scale.name}</span>
                    <span className={`relevance-dot ${scale.relevance}`} />
                  </div>
                  {scale.relationLabel && (
                    <div className="scale-relation-label">{scale.relationLabel}</div>
                  )}
                  {(scale.relatedToPrevious || scale.relatedToNext) && (
                    <div className="scale-relation">
                      {scale.relatedToPrevious && <span className="scale-relation-tag prev">← {prevChordSymbol}</span>}
                      {scale.relatedToNext && <span className="scale-relation-tag next">{nextChordSymbol} →</span>}
                    </div>
                  )}
                  <div className="scale-notes">
                    {scale.notes.map((n, j) => {
                      const ch = Note.chroma(n);
                      const color =
                        degreeColorMap && ch != null
                          ? degreeColorMap.get(ch)
                          : undefined;
                      return (
                        <span
                          key={j}
                          className="note-pill"
                          style={
                            color
                              ? { background: color, color: '#fff', borderColor: color }
                              : undefined
                          }
                        >
                          {n}
                        </span>
                      );
                    })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="panel-empty">
          <p>Select a chord from the chart to see scale suggestions</p>
        </div>
      )}
      </div>
    </aside>
  );
}
