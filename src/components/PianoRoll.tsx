import { Note } from 'tonal';
import { buildChordMidis } from '../engine/noteUtils';
import { resolveGuitarMirrorPick, type GuitarMirrorPick } from '../engine/guitarVoicings';

const MIRROR_STRING_COUNT = 6;

interface PianoRollProps {
  allNotes: string[];
  leftHand: string[];
  rightHand: string[];
  root?: string;
  /** When set (e.g. scale mode), only keys at or above this root are highlighted. */
  scaleRoot?: string;
  degreeColorMap?: Map<number, string> | null;
  onToggleNote?: (midi: number, mirrorPick?: GuitarMirrorPick) => void;
  /**
   * Mirror guitar voicing: keyboard width = 6 columns (low E … high e). Fret = match clicked MIDI
   * to actual sounding MIDI on that string (not compact snap), so octaves stay correct piano→guitar.
   */
  guitarMirrorSlotMode?: boolean;
  guitarMirrorChordTab?: (number | null)[] | null;
  guitarMirrorFretWindow?: { startFret: number; endFret: number };
  activeMidis?: Set<number>;
  /** Default chord/voicing keys turned off by click (see App handleTogglePianoNote). */
  omittedMidis?: Set<number>;
  omittedChromas?: Set<number>;
  hideVoicings?: boolean;
  /** When false, active keys show color only (no letter names on keys). Default true. */
  showKeyNoteNames?: boolean;
  /** When true (e.g. scale mode), keys ignore clicks. */
  readOnlyKeys?: boolean;
  /** Emphasize this MIDI (e.g. pitch under cursor on the staff). */
  staffHoverMidi?: number | null;
  /** Pitch-class text for that hover (matches chart spelling when provided). */
  staffHoverPitchClass?: string | null;
  /** Override key labels by MIDI (staff scratch ##/bb, merged staff spelling). */
  pitchClassByMidi?: Map<number, string>;
}

const OCTAVES = [2, 3, 4, 5];
const WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const BLACK_AFTER = ['C', 'D', 'F', 'G', 'A'];

export function PianoRoll({
  allNotes,
  leftHand,
  rightHand,
  root,
  scaleRoot,
  degreeColorMap,
  onToggleNote,
  guitarMirrorSlotMode = false,
  guitarMirrorChordTab = null,
  guitarMirrorFretWindow,
  activeMidis,
  omittedMidis,
  omittedChromas,
  hideVoicings = false,
  showKeyNoteNames = true,
  readOnlyKeys = false,
  staffHoverMidi = null,
  staffHoverPitchClass = null,
  pitchClassByMidi,
}: PianoRollProps) {
  const canClickKey = Boolean(onToggleNote) && !readOnlyKeys;
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

  const mirrorFretWin = guitarMirrorFretWindow ?? { startFret: 0, endFret: 24 };

  function pickMirrorFromPianoKey(centerX: number, clickedMidi: number): GuitarMirrorPick | null {
    if (!guitarMirrorSlotMode || totalW <= 0) return null;
    return resolveGuitarMirrorPick({
      centerX,
      totalWidth: totalW,
      clickedMidi,
      chordTab: guitarMirrorChordTab,
      fretWindow: mirrorFretWin,
    });
  }

  function isActive(k: K): boolean {
    if (activeMidis?.has(k.midi)) return true;
    if (omittedMidis?.has(k.midi)) return false;
    if (omittedChromas?.has(k.chroma)) return false;
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
    const ovr = pitchClassByMidi?.get(k.midi);
    if (ovr) return ovr;
    if (voicingMode) return midiNames.get(k.midi) || '';
    if (chordAll) return chordAll.names.get(k.midi) || '';
    return allNames.get(k.chroma) || '';
  }

  function staffHoverLabel(k: K): string {
    if (staffHoverMidi == null || staffHoverMidi !== k.midi) return '';
    if (staffHoverPitchClass) return staffHoverPitchClass;
    const pc = Note.pitchClass(Note.fromMidi(staffHoverMidi) ?? '');
    return pc || '';
  }

  /** Tapped / extra keys may not appear in chord voicing maps — still show a name. */
  function labelForTappedMidi(midi: number): string {
    const ovr = pitchClassByMidi?.get(midi);
    if (ovr) return ovr;
    const n = Note.fromMidi(midi);
    if (!n) return '';
    return Note.pitchClass(n) || '';
  }

  return (
    <div className={`piano-container${readOnlyKeys ? ' piano-container--read-only-keys' : ''}`}>
      <svg
        viewBox={`0 0 ${totalW} ${wh}`}
        preserveAspectRatio="xMidYMid meet"
        style={readOnlyKeys ? { pointerEvents: 'none' } : undefined}
      >
        {guitarMirrorSlotMode &&
          Array.from({ length: MIRROR_STRING_COUNT - 1 }, (_, i) => {
            const x = ((i + 1) * totalW) / MIRROR_STRING_COUNT;
            return (
              <line
                key={`mirror-zone-${i}`}
                x1={x}
                y1={0}
                x2={x}
                y2={wh}
                stroke="rgba(241, 196, 15, 0.35)"
                strokeWidth={0.75}
                strokeDasharray="3 3"
                pointerEvents="none"
              />
            );
          })}
        {whites.map((k, i) => {
          const on = isActive(k);
          const staffHover = staffHoverMidi != null && staffHoverMidi === k.midi;
          const isTapped = activeMidis?.has(k.midi) ?? false;
          const label =
            getName(k) ||
            staffHoverLabel(k) ||
            (isTapped ? labelForTappedMidi(k.midi) : '');
          return (
            <g
              key={`w${i}`}
              onClick={() => {
                if (!onToggleNote || readOnlyKeys) return;
                const cx = k.x + ww / 2;
                const pick = pickMirrorFromPianoKey(cx, k.midi);
                if (pick) onToggleNote(k.midi, pick);
                else onToggleNote(k.midi);
              }}
              style={{ cursor: canClickKey ? 'pointer' : 'default' }}
            >
              <rect x={k.x + 0.5} y={0} width={ww - 1} height={wh} rx={1.5}
                fill={fill(k, false)}
                stroke={staffHover ? '#f1c40f' : '#161625'}
                strokeWidth={staffHover ? 2.25 : 0.5} />
              {(on || staffHover) &&
                label &&
                (showKeyNoteNames || isTapped || staffHover) && (
                <text x={k.x + ww / 2} y={wh - 5} textAnchor="middle"
                  fill={staffHover ? '#f1c40f' : textFill(k, false)} fontSize={7} fontWeight={600}
                  fontFamily="Inter,sans-serif">{label}</text>
              )}
            </g>
          );
        })}
        {blacks.map((k, i) => {
          const on = isActive(k);
          const staffHover = staffHoverMidi != null && staffHoverMidi === k.midi;
          const isTapped = activeMidis?.has(k.midi) ?? false;
          const label =
            getName(k) ||
            staffHoverLabel(k) ||
            (isTapped ? labelForTappedMidi(k.midi) : '');
          return (
            <g
              key={`b${i}`}
              onClick={() => {
                if (!onToggleNote || readOnlyKeys) return;
                const cx = k.x + bw / 2;
                const pick = pickMirrorFromPianoKey(cx, k.midi);
                if (pick) onToggleNote(k.midi, pick);
                else onToggleNote(k.midi);
              }}
              style={{ cursor: canClickKey ? 'pointer' : 'default' }}
            >
              <rect x={k.x} y={0} width={bw} height={bh} rx={1.5}
                fill={fill(k, true)}
                stroke={staffHover ? '#f1c40f' : '#161625'}
                strokeWidth={staffHover ? 2.25 : 0.5} />
              {(on || staffHover) &&
                label &&
                (showKeyNoteNames || isTapped || staffHover) && (
                <text x={k.x + bw / 2} y={bh - 4} textAnchor="middle"
                  fill={staffHover ? '#f1c40f' : '#fff'} fontSize={6} fontWeight={600}
                  fontFamily="Inter,sans-serif">{label}</text>
              )}
            </g>
          );
        })}
      </svg>
      {voicingMode && showKeyNoteNames && (
        <div className="voicing-legend">
          <span className="legend-lh">LH: {leftHand.join(' · ')}</span>
          <span className="legend-rh">RH: {rightHand.join(' · ')}</span>
        </div>
      )}
    </div>
  );
}
