import { useRef, useCallback } from 'react';
import { Note } from 'tonal';

interface FretboardProps {
  highlightNotes: string[];
  root?: string;
  startFret: number;
  endFret: number;
  mode: 'chord' | 'scale';
  degreeColorMap?: Map<number, string> | null;
  /** Precomputed voicing in display order [high e … low E], null = muted */
  chordTab?: (number | null)[] | null;
  /** When true, clicking a fret sets that string; nut = open, nut again = mute */
  editable?: boolean;
  onFretClick?: (stringIndex: number, fret: number | null) => void;
}

const STRINGS = [
  { name: 'e', chroma: 4 },
  { name: 'B', chroma: 11 },
  { name: 'G', chroma: 7 },
  { name: 'D', chroma: 2 },
  { name: 'A', chroma: 9 },
  { name: 'E', chroma: 4 },
];
const MARKERS = new Set([3, 5, 7, 9, 12, 15]);
const DOUBLE_DOT = new Set([12]);
const STR_W = [0.8, 0.8, 1, 1.2, 1.5, 1.8];

function chromaInfo(notes: string[]) {
  const set = new Set<number>();
  const map = new Map<number, string>();
  for (const n of notes) {
    const c = Note.chroma(n);
    if (c != null) { set.add(c); map.set(c, n); }
  }
  return { set, map };
}

export function Fretboard({
  highlightNotes, root, startFret, endFret, mode, degreeColorMap,
  chordTab = null,
  editable = false,
  onFretClick,
}: FretboardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { set: hlSet, map: nameMap } = chromaInfo(highlightNotes);
  const rootChroma = root ? Note.chroma(root) : undefined;

  const totalFrets = endFret - startFret + 1;
  const compact = totalFrets <= 6;

  const hasOpen = startFret === 0;
  const firstFretSlot = hasOpen ? 1 : startFret;
  const numFretSlots = endFret - firstFretSlot + 1;

  const ss = compact ? 18 : 16;
  const fs = compact ? 52 : 34;
  const nutW = hasOpen ? 4 : 2;
  const pl = 26;
  const pt = 22;
  const pb = compact ? 14 : 12;
  const fNumSize = compact ? 9 : 8;

  const fretAreaStart = pl + nutW;
  const W = fretAreaStart + numFretSlots * fs + 8;
  const H = pt + (STRINGS.length - 1) * ss + pb;

  const nutCX = pl + nutW / 2;

  const slotLeft = (fret: number) => fretAreaStart + (fret - firstFretSlot) * fs;
  const slotCX = (fret: number) => slotLeft(fret) + fs / 2;
  const strY = (s: number) => pt + s * ss;

  const fretCX = (fret: number) => fret === 0 ? nutCX : slotCX(fret);

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!editable || !onFretClick || !svgRef.current) return;
      const svg = svgRef.current;
      
      // Robust screen-to-SVG coordinate mapping
      const pt_svg = svg.createSVGPoint();
      pt_svg.x = e.clientX;
      pt_svg.y = e.clientY;
      const cursorPT = pt_svg.matrixTransform(svg.getScreenCTM()?.inverse());
      
      const x = cursorPT.x;
      const y = cursorPT.y;

      const si = Math.max(0, Math.min(5, Math.round((y - pt) / ss)));
      if (x < fretAreaStart) {
        const current = chordTab?.[si];
        if (current === 0) onFretClick(si, null);
        else onFretClick(si, 0);
        return;
      }
      const fretIndex = Math.floor((x - fretAreaStart) / fs);
      const fret = firstFretSlot + fretIndex;
      if (fret >= startFret && fret <= endFret) {
        const current = chordTab?.[si];
        if (current === fret) onFretClick(si, null);
        else onFretClick(si, fret);
      }
    },
    [editable, onFretClick, chordTab, pt, ss, fretAreaStart, fs, firstFretSlot, startFret, endFret]
  );

  const barreFret =
    chordTab && compact
      ? (() => {
          const byFret = new Map<number, number>();
          for (let si = 0; si < chordTab.length; si++) {
            const f = chordTab[si];
            if (f != null && f > 0) {
              byFret.set(f, (byFret.get(f) ?? 0) + 1);
            }
          }
          let minBarre: number | null = null;
          byFret.forEach((count, fret) => {
            if (count >= 2 && (minBarre == null || fret < minBarre))
              minBarre = fret;
          });
          return minBarre;
        })()
      : null;

  return (
    <div className={`fretboard-container${editable ? ' fretboard-editable' : ''}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onClick={handleSvgClick}
        style={editable ? { cursor: 'pointer' } : undefined}
      >
        {editable && <title>Click fret to set note, click nut for open, click nut again to mute</title>}
        {/* Nut markers (X for muted strings) */}
        {chordTab && STRINGS.map((_, si) => {
          const fret = chordTab[si];
          if (fret !== null) return null;
          return (
            <text
              key={`nx${si}`}
              x={pl - 12}
              y={strY(si) + 4}
              textAnchor="middle"
              fill="#ff4444"
              fontSize={9}
              fontWeight={700}
              fontFamily="Inter,sans-serif"
            >
              X
            </text>
          );
        })}
        {Array.from({ length: numFretSlots }, (_, i) => {
          const fn = firstFretSlot + i;
          const isBarre = barreFret !== null && fn === barreFret;
          return (
            <text
              key={`fn${fn}`}
              x={slotCX(fn)}
              y={12}
              textAnchor="middle"
              fill={isBarre ? 'var(--accent-secondary)' : '#505068'}
              fontSize={fNumSize}
              fontFamily="Inter,sans-serif"
              fontWeight={isBarre ? 700 : 400}
            >
              {fn}
            </text>
          );
        })}

        {/* Nut */}
        <rect x={pl} y={pt - 3} width={nutW}
          height={(STRINGS.length - 1) * ss + 6}
          rx={1} fill={hasOpen ? '#8585a0' : '#2a2a42'} />

        {/* Fret wires */}
        {Array.from({ length: numFretSlots }, (_, i) => (
          <line key={`fw${i}`}
            x1={slotLeft(firstFretSlot + i) + fs} y1={pt - 2}
            x2={slotLeft(firstFretSlot + i) + fs} y2={strY(5) + 2}
            stroke="#2a2a42" strokeWidth={1} />
        ))}

        {/* Inlay markers */}
        {Array.from({ length: numFretSlots }, (_, i) => {
          const fn = firstFretSlot + i;
          if (!MARKERS.has(fn)) return null;
          const cx = slotCX(fn);
          const r = compact ? 3 : 2.5;
          if (DOUBLE_DOT.has(fn))
            return (
              <g key={`m${fn}`}>
                <circle cx={cx} cy={strY(1)} r={r} fill="#1e1e30" />
                <circle cx={cx} cy={strY(4)} r={r} fill="#1e1e30" />
              </g>
            );
          return <circle key={`m${fn}`} cx={cx} cy={H / 2} r={r} fill="#1e1e30" />;
        })}

        {/* Strings */}
        {STRINGS.map((_, si) => (
          <line key={`s${si}`} x1={pl} x2={W - 8}
            y1={strY(si)} y2={strY(si)}
            stroke="#505068" strokeWidth={STR_W[si]} />
        ))}

        {/* String labels */}
        {STRINGS.map((s, si) => (
          <text key={`sl${si}`} x={pl - 6} y={strY(si) + 4}
            textAnchor="end" fill="#505068" fontSize={9}
            fontFamily="Inter,sans-serif">{s.name}</text>
        ))}


        {/* Note dots */}
        {STRINGS.map((s, si) => {
          if (chordTab) {
            const fret = chordTab[si];
            if (fret == null) return null;
            const ch = (s.chroma + fret) % 12;
            const isR = ch === rootChroma;
            const dotR = compact ? (isR ? 7 : 6) : (isR ? 6 : 5.5);
            const cx = fretCX(fret);
            const dotFill = degreeColorMap
              ? (degreeColorMap.get(ch) || '#00d4aa')
              : (isR ? '#6c63ff' : '#00d4aa');
            return (
              <g key={`d${si}`}>
                <circle cx={cx} cy={strY(si)} r={dotR}
                  fill={dotFill} opacity={0.92} />
                <text x={cx} y={strY(si) + (compact ? 4 : 3.5)}
                  textAnchor="middle" fill="#fff"
                  fontSize={compact ? 9 : 7.5} fontWeight={600}
                  fontFamily="Inter,sans-serif">{nameMap.get(ch)}</text>
              </g>
            );
          }

          const frets: number[] = [];
          for (let f = startFret; f <= endFret; f++) frets.push(f);

          return frets.map(fret => {
            const ch = (s.chroma + fret) % 12;
            if (!hlSet.has(ch)) return null;

            const isR = ch === rootChroma;
            const dotR = compact ? (isR ? 7 : 6) : (isR ? 6 : 5.5);
            const cx = fretCX(fret);
            const dotFill = degreeColorMap
              ? (degreeColorMap.get(ch) || '#00d4aa')
              : (isR ? '#6c63ff' : '#00d4aa');
            return (
              <g key={`d${si}-${fret}`}>
                <circle cx={cx} cy={strY(si)} r={dotR}
                  fill={dotFill} opacity={0.92} />
                <text x={cx} y={strY(si) + (compact ? 4 : 3.5)}
                  textAnchor="middle" fill="#fff"
                  fontSize={compact ? 9 : 7.5} fontWeight={600}
                  fontFamily="Inter,sans-serif">{nameMap.get(ch)}</text>
              </g>
            );
          });
        })}
      </svg>
    </div>
  );
}
