import { Note } from 'tonal';

interface PianoRollProps {
  allNotes: string[];
  leftHand: string[];
  rightHand: string[];
  root?: string;
  /** When set (e.g. scale mode), only keys at or above this root are highlighted. */
  scaleRoot?: string;
  degreeColorMap?: Map<number, string> | null;
  onToggleNote?: (midi: number) => void;
  activeMidis?: Set<number>;
  hideVoicings?: boolean;
}

const OCTAVES = [2, 3, 4, 5];
const WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BLACK_AFTER = ['C', 'D', 'F', 'G', 'A'];

function buildChordMidis(notes: string[], rootNote: string) {
  const rootCh = Note.chroma(rootNote);
  if (rootCh == null) return null;

  const startMidi = (4 + 1) * 12 + rootCh;
  const midis = new Set<number>();
  const names = new Map<number, string>();

  for (const n of notes) {
    const ch = Note.chroma(n);
    if (ch == null) continue;
    
    // If note already has an octave (e.g. from guitar mirroring), use it directly
    const m = Note.midi(n);
    if (m != null) {
      midis.add(m);
      names.set(m, n.replace(/\d+$/, ''));
      continue;
    }

    let midi = (4 + 1) * 12 + ch;
    if (midi < startMidi) midi += 12;
    midis.add(midi);
    names.set(midi, n);
  }
  return { midis, names };
}

export function PianoRoll({ allNotes, leftHand, rightHand, root, scaleRoot, degreeColorMap, onToggleNote, activeMidis, hideVoicings = false }: PianoRollProps) {
  const rootChroma = root ? Note.chroma(root) : undefined;
  const fundamentalMidi = scaleRoot != null ? (() => {
    const ch = Note.chroma(scaleRoot);
    return ch != null ? 48 + ch : null;
  })() : null;

  const lhMidis = new Set<number>();
  const rhMidis = new Set<number>();
  const midiNames = new Map<number, string>();

  for (const n of leftHand) {
    const m = Note.midi(n);
    if (m != null) { lhMidis.add(m); midiNames.set(m, n.replace(/\d+$/, '')); }
  }
  for (const n of rightHand) {
    const m = Note.midi(n);
    if (m != null) { rhMidis.add(m); midiNames.set(m, n.replace(/\d+$/, '')); }
  }

  const voicingMode = lhMidis.size > 0 || rhMidis.size > 0;

  // Mirroring also passes 6 notes with octaves in allNotes
  const isChordAll = !voicingMode && allNotes.length > 0 && allNotes.length <= 6 && !!root;
  const chordAll = isChordAll ? buildChordMidis(allNotes, root!) : null;

  const allSet = new Set<number>();
  const allNames = new Map<number, string>();
  if (!isChordAll) {
    for (const n of allNotes) {
      const c = Note.chroma(n);
      if (c != null) { allSet.add(c); allNames.set(c, n); }
    }
  }

  const ww = 18, wh = 64;
  const bw = 12, bh = 38;

  type K = { chroma: number; octave: number; midi: number; x: number };
  const whites: K[] = [];
  const blacks: K[] = [];

  let x = 0;
  for (let oi = 0; oi < OCTAVES.length; oi++) {
    const oct = OCTAVES[oi];
    for (const wn of WHITE_NAMES) {
      const ch = Note.chroma(wn)!;
      const midi = (oct + 1) * 12 + ch;
      whites.push({ chroma: ch, octave: oct, midi, x });
      if (BLACK_AFTER.includes(wn)) {
        const bch = (ch + 1) % 12;
        blacks.push({ chroma: bch, octave: oct, midi: (oct + 1) * 12 + bch, x: x + ww - bw / 2 });
      }
      x += ww;
    }
  }
  const totalW = whites.length * ww;

  function isActive(k: K): boolean {
    if (activeMidis?.has(k.midi)) return true;
    if (hideVoicings) return false;
    if (voicingMode) return lhMidis.has(k.midi) || rhMidis.has(k.midi);
    if (chordAll) return chordAll.midis.has(k.midi);
    if (fundamentalMidi != null) return allSet.has(k.chroma) && k.midi >= fundamentalMidi;
    return allSet.has(k.chroma);
  }

  function fill(k: K, blk: boolean): string {
    if (activeMidis?.has(k.midi)) return blk ? '#e17055' : '#fab1a0'; // Distinct color for tapped notes
    if (!isActive(k)) return blk ? '#08080f' : '#2a2a3e';
    if (degreeColorMap) return degreeColorMap.get(k.chroma) || (blk ? '#08080f' : '#2a2a3e');
    if (chordAll && chordAll.midis.has(k.midi)) {
       if (k.chroma === rootChroma) return blk ? '#5b52ee' : '#6c63ff';
       return blk ? '#00b894' : '#00d4aa';
    }
    if (k.chroma === rootChroma) return blk ? '#5b52ee' : '#6c63ff';
    if (lhMidis.has(k.midi)) return blk ? '#cc5555' : '#ff6b6b';
    if (rhMidis.has(k.midi)) return blk ? '#00b894' : '#00d4aa';
    return blk ? '#00b894' : '#00d4aa';
  }

  function textFill(k: K, blk: boolean): string {
    if (degreeColorMap) return '#fff';
    if (k.chroma === rootChroma || blk || lhMidis.has(k.midi)) return '#fff';
    // If it's a chord note (mirroring), making it white
    if (chordAll && chordAll.midis.has(k.midi)) return '#fff';
    return '#08080f';
  }

  function getName(k: K): string {
    if (voicingMode) return midiNames.get(k.midi) || '';
    if (chordAll) return chordAll.names.get(k.midi) || '';
    return allNames.get(k.chroma) || '';
  }

  return (
    <div className="piano-container">
      <svg viewBox={`0 0 ${totalW} ${wh}`} preserveAspectRatio="xMidYMid meet">
        {whites.map((k, i) => {
          const on = isActive(k);
          return (
            <g key={`w${i}`} onClick={() => onToggleNote?.(k.midi)} style={{ cursor: onToggleNote ? 'pointer' : 'default' }}>
              <rect x={k.x + 0.5} y={0} width={ww - 1} height={wh} rx={1.5}
                fill={fill(k, false)} stroke="#161625" strokeWidth={0.5} />
              {on && (
                <text x={k.x + ww / 2} y={wh - 5} textAnchor="middle"
                  fill={textFill(k, false)} fontSize={7} fontWeight={600}
                  fontFamily="Inter,sans-serif">{getName(k)}</text>
              )}
            </g>
          );
        })}
        {blacks.map((k, i) => {
          const on = isActive(k);
          return (
            <g key={`b${i}`} onClick={() => onToggleNote?.(k.midi)} style={{ cursor: onToggleNote ? 'pointer' : 'default' }}>
              <rect x={k.x} y={0} width={bw} height={bh} rx={1.5}
                fill={fill(k, true)} stroke="#161625" strokeWidth={0.5} />
              {on && (
                <text x={k.x + bw / 2} y={bh - 4} textAnchor="middle"
                  fill="#fff" fontSize={6} fontWeight={600}
                  fontFamily="Inter,sans-serif">{getName(k)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {voicingMode && (
        <div className="voicing-legend">
          <span className="legend-lh">LH: {leftHand.join(' · ')}</span>
          <span className="legend-rh">RH: {rightHand.join(' · ')}</span>
        </div>
      )}
    </div>
  );
}
