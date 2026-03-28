import { useRef, useEffect, useState, useCallback, useReducer } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import {
  Renderer,
  Stave,
  StaveNote,
  Voice,
  Formatter,
  Accidental,
  StaveConnector,
  GhostNote,
} from 'vexflow';
import { Note } from 'tonal';
import {
  pitchFromStaffY,
  clefForGrandStaffClick,
  TREBLE_TOP_LEDGER_SLOT_COUNT,
} from '../engine/staffPitchFromY';
import { vexKeySignatureSpec, vexNoteRenderSpec, spellPitchOnStaffInKey } from '../engine/staffKey';
import { spellLikeChordChart } from '../engine/noteUtils';
import { staffNeswAccidentalHighlight } from '../engine/staffScratchAccidentals';

/** Host-relative X + width so Draw mode can mirror piano string-column hinting. */
export type StaffMirrorHint = { x: number; width: number };

export interface StaffProps {
  notes: string[];
  mode: 'chord' | 'scale' | 'empty';
  keySignature?: string;
  label?: string;
  showNoteNames?: boolean;
  noteColors?: (string | undefined)[];
  showBassClef?: boolean;
  /** Parallel to `notes`: non-null = user scratch note at that index (editable). */
  scratchIdPerIndex?: (string | null)[] | null;
  /** Enable click-to-add and scratch controls (e.g. off in scale mode). */
  staffInteractive?: boolean;
  selectedScratchId?: string | null;
  /** Current spelling of selected scratch (for NESW visibility). */
  selectedScratchNote?: string | null;
  /** Must support functional updates so NESW dismiss only clears the note that timed out. */
  onStaffSelectScratch?: Dispatch<SetStateAction<string | null>>;
  /** Raw staff-slot pitch from click (`pitchFromStaffY`); host spells / toggles in key. */
  onStaffPitchClick?: (rawStaffPitch: string, mirrorHint?: StaffMirrorHint) => void;
  /** Raw pitch under pointer while over the stave (null when leaving or outside lines); host maps to piano key. */
  onStaffHoverPitch?: (rawStaffPitch: string | null, mirrorHint?: StaffMirrorHint | null) => void;
  /** Chart notes (e.g. `baseForStaff`) so left-rail / piano spelling matches chord voicing. */
  chartSpellNotes?: string[];
  onStaffScratchRemove?: (id: string) => void;
  onStaffScratchSharp?: (id: string) => void;
  onStaffScratchFlat?: (id: string) => void;
  onStaffScratchNatural?: (id: string) => void;
  /**
   * Guitar Draw: treble-only — written +8ve, clicks report sounding pitch; wider vertical hit band
   * for ledger lines; scratch dots / NESW unchanged.
   */
  staffDrawMode?: boolean;
}

const BASS_CLEF_SPLIT_MIDI = 60;

const TIGHT_STAVE_OPTS = {
  spaceAboveStaffLn: 2,
  spaceBelowStaffLn: 2,
};

/** Treble staff bottom line ≈ E4; notes below need ledger space when bass clef is off. */
function extraBelowTrebleStavePx(noteStrings: string[], lineSpacing: number): number {
  const e4 = Note.midi('E4');
  if (e4 == null || lineSpacing <= 0) return 0;
  let minM = 127;
  for (const n of noteStrings) {
    const m = Note.midi(n);
    if (m != null) minM = Math.min(minM, m);
  }
  if (minM >= e4) return 0;
  const semisDown = e4 - minM;
  const halfLine = lineSpacing * 0.5;
  const steps = Math.min(28, Math.ceil(semisDown / 2));
  return steps * halfLine + lineSpacing * 1.25;
}

/** Treble staff top line ≈ F5; notes above need ledger space above the stave. */
function extraAboveTrebleStavePx(noteStrings: string[], lineSpacing: number): number {
  const f5 = Note.midi('F5');
  if (f5 == null || lineSpacing <= 0) return 0;
  let maxM = 0;
  for (const n of noteStrings) {
    const m = Note.midi(n);
    if (m != null) maxM = Math.max(maxM, m);
  }
  if (maxM <= f5) return 0;
  const semisUp = maxM - f5;
  const halfLine = lineSpacing * 0.5;
  const steps = Math.min(28, Math.ceil(semisUp / 2));
  return steps * halfLine + lineSpacing * 1.25;
}

function transposeNoteOctaveUp(note: string): string {
  const m = Note.midi(note);
  if (m == null) return note;
  return Note.fromMidi(m + 12) ?? note;
}

function isOnBassStaff(note: string): boolean {
  const m = Note.midi(note);
  if (m == null) return false;
  return m < BASS_CLEF_SPLIT_MIDI;
}

/**
 * Center of one chord key’s notehead in Vex/SVG logical coords.
 * After `voice.draw`, `getBoundingBox()` reflects each head’s displaced X and glyph metrics (staggered chords).
 */
function scratchHeadCenterForKey(
  sn: InstanceType<typeof StaveNote>,
  keyIndex: number,
): { x: number; y: number } {
  const ys = sn.getYs();
  const yLine = ys[keyIndex] ?? ys[0]!;
  const heads = sn.noteHeads;
  const h = heads[keyIndex];
  if (!h) {
    return { x: sn.getNoteHeadBeginX() + sn.getGlyphWidth() / 2, y: yLine };
  }
  try {
    const bb = h.getBoundingBox();
    const bw = bb.getW();
    const bh = bb.getH();
    if (bw > 0.5 && bh > 0.5) {
      return {
        x: bb.getX() + bw / 2,
        y: bb.getY() + bh / 2,
      };
    }
  } catch {
    /* bbox not ready in edge cases */
  }
  return {
    x: h.getAbsoluteX() + h.getWidth() / 2,
    y: yLine,
  };
}

type ScratchDot = { id: string; x: number; y: number };

type StaffLayoutMetrics = {
  staveStartLogicalX: number;
};

/** Map Vex logical (SVG user) coords to positions inside `host`, matching `clientX/Y - host.getBoundingClientRect()`. */
function mapLogicalDotsRelativeToHost(
  dots: ScratchDot[],
  host: HTMLElement,
  svg: SVGSVGElement,
  nominalW: number,
  nominalH: number,
): ScratchDot[] {
  const hr = host.getBoundingClientRect();
  const sr = svg.getBoundingClientRect();
  const nw = svg.width.baseVal.value || nominalW;
  const nh = svg.height.baseVal.value || nominalH;
  const rw = sr.width > 0 ? sr.width : 1;
  const rh = sr.height > 0 ? sr.height : 1;
  const ox = sr.left - hr.left;
  const oy = sr.top - hr.top;
  return dots.map(d => ({
    id: d.id,
    x: ox + (d.x / nw) * rw,
    y: oy + (d.y / nh) * rh,
  }));
}

type ClickMetricsSingle = { yLine0: number; lineSpacing: number; bottomY: number };
type ClickMetricsGrand = {
  treble: ClickMetricsSingle;
  bass: ClickMetricsSingle;
};

type StaffPointerResult =
  | { kind: 'ignore' }
  | { kind: 'scratch'; id: string }
  | { kind: 'pitch'; rawPitch: string }
  | { kind: 'deselect' };

const HIT_R = 22;

/** NESW buttons are 24px with ~8px gap from notehead; stay box = note + tool cluster only. */
const NESW_BTN = 24;
const NESW_BTN_GAP = 8;
/** Half-width/height (px) from scratch center: inside = timer cleared; outside starts dismiss. */
const NESW_STAY_BOX_HALF = NESW_BTN_GAP + NESW_BTN + 6;
const NESW_DISMISS_AFTER_MS = 2000;

function leftRailPitchClass(raw: string, songKey: string, chart: string[] | undefined): string {
  const spelled = spellPitchOnStaffInKey(raw, songKey);
  const aligned =
    chart != null && chart.length > 0 ? spellLikeChordChart(spelled, chart) : spelled;
  return aligned.replace(/\d+$/, '');
}

export function Staff({
  notes,
  mode,
  keySignature = 'C',
  label,
  showNoteNames = false,
  noteColors,
  showBassClef = false,
  scratchIdPerIndex = null,
  staffInteractive = false,
  selectedScratchId = null,
  selectedScratchNote = null,
  onStaffSelectScratch,
  onStaffPitchClick,
  onStaffHoverPitch,
  chartSpellNotes,
  onStaffScratchRemove,
  onStaffScratchSharp,
  onStaffScratchFlat,
  onStaffScratchNatural,
  staffDrawMode = false,
}: StaffProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const neswDismissTimerRef = useRef<number | null>(null);
  const onStaffSelectScratchRef = useRef(onStaffSelectScratch);
  onStaffSelectScratchRef.current = onStaffSelectScratch;
  const layoutMetricsRef = useRef<StaffLayoutMetrics>({
    staveStartLogicalX: 52,
  });
  const [scratchDots, setScratchDots] = useState<ScratchDot[]>([]);
  const [clickSingle, setClickSingle] = useState<ClickMetricsSingle | null>(null);
  const [clickGrand, setClickGrand] = useState<ClickMetricsGrand | null>(null);
  const [hoverRail, setHoverRail] = useState<{ y: number; pc: string } | null>(null);
  const [layoutVersion, bumpLayout] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bumpLayout());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (!staffInteractive) {
      setClickSingle(null);
      setClickGrand(null);
    }

    el.innerHTML = '';

    const width = el.clientWidth || 700;
    const GRAND_STAFF_GAP_IN_SPACES = 2;
    const staveYTop = 0;
    const nameColW = showNoteNames
      ? mode === 'scale'
        ? 40
        : mode === 'chord'
          ? 42
          : 26
      : 0;
    const staveX = nameColW + 4;
    const staveWidth = width - staveX - 8;
    const formatWidth = staveWidth - 100;

    const drawTransposeSingle = staffDrawMode && !showBassClef;
    const notesForStaff = drawTransposeSingle
      ? notes.map(n => transposeNoteOctaveUp(n))
      : notes;

    const commitDots = (logicalDots: ScratchDot[]) => {
      const host = hostRef.current;
      const svg = el.querySelector('svg');
      layoutMetricsRef.current = { staveStartLogicalX: staveX };
      if (
        host &&
        svg instanceof SVGSVGElement &&
        width > 0 &&
        height > 0
      ) {
        setScratchDots(mapLogicalDotsRelativeToHost(logicalDots, host, svg, width, height));
      } else {
        const ox = el.offsetLeft;
        const oy = el.offsetTop;
        setScratchDots(
          logicalDots.map(d => ({
            id: d.id,
            x: ox + d.x,
            y: oy + d.y,
          })),
        );
      }
    };

    let height = 120;
    let staveYBottom = 0;
    let trebleOnlyStaveYTop = staveYTop;
    if (showBassClef) {
      const trebleProbe = new Stave(staveX, staveYTop, staveWidth, TIGHT_STAVE_OPTS);
      trebleProbe.addClef('treble');
      const spacing = trebleProbe.getSpacingBetweenLines();
      const spaceAbove = trebleProbe.getYForLine(0) - staveYTop;
      const trebleBottomLineY = trebleProbe.getYForLine(trebleProbe.getNumLines() - 1);
      staveYBottom =
        trebleBottomLineY + GRAND_STAFF_GAP_IN_SPACES * spacing - spaceAbove;
      const bassProbe = new Stave(staveX, staveYBottom, staveWidth, TIGHT_STAVE_OPTS);
      bassProbe.addClef('bass');
      height = Math.ceil(Math.max(168, bassProbe.getBottomY() + 12));
    } else {
      const tmpForSpacing = new Stave(staveX, 0, staveWidth, TIGHT_STAVE_OPTS);
      tmpForSpacing.addClef('treble');
      if (!staffDrawMode) tmpForSpacing.addKeySignature(vexKeySignatureSpec(keySignature));
      const lineSpacing = tmpForSpacing.getSpacingBetweenLines();
      let singleStaveYTop = staveYTop;
      if (
        drawTransposeSingle &&
        notesForStaff.length > 0 &&
        (mode === 'chord' || mode === 'scale')
      ) {
        singleStaveYTop =
          Math.ceil(extraAboveTrebleStavePx(notesForStaff, lineSpacing) + lineSpacing * 0.5);
      }
      const singleProbe = new Stave(staveX, singleStaveYTop, staveWidth, TIGHT_STAVE_OPTS);
      singleProbe.addClef('treble');
      if (!staffDrawMode) singleProbe.addKeySignature(vexKeySignatureSpec(keySignature));
      height = Math.ceil(singleProbe.getBottomY() + 8);
      if (notesForStaff.length > 0 && (mode === 'chord' || mode === 'scale')) {
        height = Math.ceil(height + extraBelowTrebleStavePx(notesForStaff, lineSpacing));
      }
      trebleOnlyStaveYTop = singleStaveYTop;
    }

    const renderer = new Renderer(el, Renderer.Backends.SVG);
    renderer.resize(width, height);
    const context = renderer.getContext();

    context.setFillStyle('#c8c8d8');
    context.setStrokeStyle('#c8c8d8');

    const noteLabel = (note: string) => note.replace(/\d+$/, '') || note;

    const dots: ScratchDot[] = [];

    const collectChordDots = (
      sn: InstanceType<typeof StaveNote>,
      globalIndices: number[],
    ) => {
      if (!scratchIdPerIndex || !staffInteractive) return;
      const ys = sn.getYs();
      for (let j = 0; j < ys.length; j++) {
        const g = globalIndices[j];
        if (g == null) continue;
        const sid = scratchIdPerIndex[g];
        if (sid) {
          const { x, y } = scratchHeadCenterForKey(sn, j);
          dots.push({ id: sid, x, y });
        }
      }
    };

    /** Name column left of stave/clef (`nameColW` reserves horizontal space in layout). */
    const NAME_COL_L = 2;
    const NAME_COL_R = 22;

    const drawChordNoteNamesSingle = (sn: InstanceType<typeof StaveNote>) => {
      if (!showNoteNames) return;
      const ys = sn.getYs();
      for (let i = 0; i < ys.length; i++) {
        const labelText = noteLabel(notes[i]);
        const y = ys[i]! + 4;
        const color = noteColors?.[i] || '#c8c8d8';
        const x = i % 2 === 0 ? NAME_COL_L : NAME_COL_R;
        context.setFillStyle(color);
        context.setFont('Inter, sans-serif', 10, 'bold');
        context.fillText(labelText, x, y);
      }
    };

    const drawChordNoteNamesByIndex = (sn: InstanceType<typeof StaveNote>, indices: number[]) => {
      if (!showNoteNames) return;
      const ys = sn.getYs();
      for (let i = 0; i < ys.length; i++) {
        const origIdx = indices[i];
        const labelText = noteLabel(notes[origIdx] ?? '');
        const y = ys[i]! + 4;
        const color = noteColors?.[origIdx] || '#c8c8d8';
        const x = i % 2 === 0 ? NAME_COL_L : NAME_COL_R;
        context.setFillStyle(color);
        context.setFont('Inter, sans-serif', 10, 'bold');
        context.fillText(labelText, x, y);
      }
    };

    const drawScaleNoteNames = (staveNotes: InstanceType<typeof StaveNote>[]) => {
      if (!showNoteNames) return;
      staveNotes.forEach((sn, idx) => {
        const y = sn.getYs()[0]! + 4;
        const labelText = noteLabel(notes[idx]);
        const color = noteColors?.[idx] || '#c8c8d8';
        const x = idx % 2 === 0 ? NAME_COL_L : NAME_COL_R;
        context.setFillStyle(color);
        context.setFont('Inter, sans-serif', 10, 'bold');
        context.fillText(labelText, x, y);
      });
    };

    const drawGrandScaleNoteNames = (
      trebleTicks: (InstanceType<typeof StaveNote> | InstanceType<typeof GhostNote>)[],
      bassTicks: (InstanceType<typeof StaveNote> | InstanceType<typeof GhostNote>)[],
    ) => {
      if (!showNoteNames) return;
      notes.forEach((n, idx) => {
        const onBass = isOnBassStaff(n);
        const tick = onBass ? bassTicks[idx] : trebleTicks[idx];
        if (tick instanceof GhostNote) return;
        const sn = tick as InstanceType<typeof StaveNote>;
        const y = sn.getYs()[0]! + 4;
        const labelText = noteLabel(n);
        const color = noteColors?.[idx] || '#c8c8d8';
        const x = idx % 2 === 0 ? NAME_COL_L : NAME_COL_R;
        context.setFillStyle(color);
        context.setFont('Inter, sans-serif', 10, 'bold');
        context.fillText(labelText, x, y);
      });
    };

    if (!showBassClef) {
      const stave = new Stave(staveX, trebleOnlyStaveYTop, staveWidth, TIGHT_STAVE_OPTS);
      stave.addClef('treble');
      if (!staffDrawMode) stave.addKeySignature(vexKeySignatureSpec(keySignature));
      stave.setContext(context).draw();

      if (staffInteractive) {
        setClickSingle({
          yLine0: stave.getYForLine(0),
          lineSpacing: stave.getSpacingBetweenLines(),
          bottomY: stave.getYForLine(stave.getNumLines() - 1),
        });
        setClickGrand(null);
      }

      if (mode === 'empty' || notesForStaff.length === 0) {
        commitDots([]);
        return;
      }

      try {
        if (mode === 'chord') {
          const specs = notesForStaff.map(n => vexNoteRenderSpec(n, keySignature));
          const sn = new StaveNote({
            keys: specs.map(s => s.key),
            duration: 'w',
            autoStem: true,
          });

          specs.forEach((spec, i) => {
            if (spec.addAccidentalModifier && spec.accidental) {
              sn.addModifier(new Accidental(spec.accidental), i);
            }
            if (noteColors?.[i]) sn.setKeyStyle(i, { fillStyle: noteColors[i]! });
          });

          const voice = new Voice({ numBeats: 4, beatValue: 4 });
          voice.setStrict(false);
          voice.addTickables([sn]);

          new Formatter().joinVoices([voice]).format([voice], formatWidth);
          voice.draw(context, stave);
          drawChordNoteNamesSingle(sn);
          const globalIdx = notes.map((_, i) => i);
          collectChordDots(sn, globalIdx);
        } else if (mode === 'scale') {
          const staveNotes = notesForStaff.map((n, idx) => {
            const vex = vexNoteRenderSpec(n, keySignature);
            const note = new StaveNote({
              keys: [vex.key],
              duration: 'q',
              autoStem: true,
            });
            if (vex.addAccidentalModifier && vex.accidental) {
              note.addModifier(new Accidental(vex.accidental));
            }
            if (noteColors?.[idx]) note.setKeyStyle(0, { fillStyle: noteColors[idx]! });
            return note;
          });

          const voice = new Voice({ numBeats: notes.length, beatValue: 4 });
          voice.setStrict(false);
          voice.addTickables(staveNotes);

          new Formatter().joinVoices([voice]).format([voice], formatWidth);
          voice.draw(context, stave);
          drawScaleNoteNames(staveNotes);
          if (scratchIdPerIndex && staffInteractive) {
            staveNotes.forEach((sn, idx) => {
              const sid = scratchIdPerIndex[idx];
              if (!sid) return;
              const { x, y } = scratchHeadCenterForKey(sn, 0);
              dots.push({ id: sid, x, y });
            });
          }
        }
      } catch (e) {
        console.error('VexFlow render error:', e);
      }
      commitDots(dots);
      return;
    }

    const trebleStave = new Stave(staveX, staveYTop, staveWidth, TIGHT_STAVE_OPTS);
    trebleStave.addClef('treble');
    if (!staffDrawMode) trebleStave.addKeySignature(vexKeySignatureSpec(keySignature));
    trebleStave.setContext(context).draw();

    const bassStave = new Stave(staveX, staveYBottom, staveWidth, TIGHT_STAVE_OPTS);
    bassStave.addClef('bass');
    if (!staffDrawMode) bassStave.addKeySignature(vexKeySignatureSpec(keySignature));
    bassStave.setContext(context).draw();

    const noteStartX = Math.max(trebleStave.getNoteStartX(), bassStave.getNoteStartX());
    trebleStave.setNoteStartX(noteStartX);
    bassStave.setNoteStartX(noteStartX);

    const brace = new StaveConnector(trebleStave, bassStave);
    brace.setType(StaveConnector.type.BRACE);
    brace.setContext(context);
    brace.draw();

    if (staffInteractive) {
      setClickSingle(null);
      setClickGrand({
        treble: {
          yLine0: trebleStave.getYForLine(0),
          lineSpacing: trebleStave.getSpacingBetweenLines(),
          bottomY: trebleStave.getYForLine(trebleStave.getNumLines() - 1),
        },
        bass: {
          yLine0: bassStave.getYForLine(0),
          lineSpacing: bassStave.getSpacingBetweenLines(),
          bottomY: bassStave.getYForLine(bassStave.getNumLines() - 1),
        },
      });
    }

    if (mode === 'empty' || !notes || notes.length === 0) {
      commitDots([]);
      return;
    }

    try {
      if (mode === 'chord') {
        const makeChordTick = (indices: number[]) => {
          if (indices.length === 0) return new GhostNote('w');
          const specs = indices.map(i => vexNoteRenderSpec(notes[i]!, keySignature));
          const sn = new StaveNote({
            keys: specs.map(s => s.key),
            duration: 'w',
            autoStem: true,
          });
          specs.forEach((spec, j) => {
            if (spec.addAccidentalModifier && spec.accidental) {
              sn.addModifier(new Accidental(spec.accidental), j);
            }
            const orig = indices[j];
            if (orig != null && noteColors?.[orig]) sn.setKeyStyle(j, { fillStyle: noteColors[orig]! });
          });
          return sn;
        };

        // Grand staff: keep the full chord on treble (same layout as treble-only) so toggling bass
        // clef doesn’t drop low notes onto the F staff. Scale mode still splits by range.
        const trebleIdx = notes.map((_, i) => i);
        const bassIdx: number[] = [];
        const trebleTick = makeChordTick(trebleIdx);
        const bassTick = new GhostNote('w');

        const trebleVoice = new Voice({ numBeats: 4, beatValue: 4 });
        trebleVoice.setStrict(false);
        trebleVoice.addTickables([trebleTick]);

        const bassVoice = new Voice({ numBeats: 4, beatValue: 4 });
        bassVoice.setStrict(false);
        bassVoice.addTickables([bassTick]);

        new Formatter().joinVoices([trebleVoice, bassVoice]).format([trebleVoice, bassVoice], formatWidth);
        // Keep bass and treble chord columns aligned (formatter can offset voices differently).
        if (trebleTick instanceof StaveNote && bassTick instanceof StaveNote) {
          const tx = trebleTick.getNoteHeadBeginX();
          const bx = bassTick.getNoteHeadBeginX();
          const delta = tx - bx;
          if (Math.abs(delta) > 0.5) {
            bassTick.setXShift(bassTick.getXShift() + delta);
          }
        }
        trebleVoice.draw(context, trebleStave);
        bassVoice.draw(context, bassStave);

        if (trebleTick instanceof StaveNote) {
          drawChordNoteNamesByIndex(trebleTick, trebleIdx);
          collectChordDots(trebleTick, trebleIdx);
        }
        if (bassTick instanceof StaveNote) {
          drawChordNoteNamesByIndex(bassTick, bassIdx);
          collectChordDots(bassTick, bassIdx);
        }
      } else if (mode === 'scale') {
        const trebleTicks: (InstanceType<typeof StaveNote> | InstanceType<typeof GhostNote>)[] = [];
        const bassTicks: (InstanceType<typeof StaveNote> | InstanceType<typeof GhostNote>)[] = [];

        notes.forEach((n, idx) => {
          const onBass = isOnBassStaff(n);
          const vex = vexNoteRenderSpec(n, keySignature);
          if (onBass) {
            trebleTicks.push(new GhostNote('q'));
            const bn = new StaveNote({
              keys: [vex.key],
              duration: 'q',
              autoStem: true,
            });
            if (vex.addAccidentalModifier && vex.accidental) {
              bn.addModifier(new Accidental(vex.accidental));
            }
            if (noteColors?.[idx]) bn.setKeyStyle(0, { fillStyle: noteColors[idx]! });
            bassTicks.push(bn);
          } else {
            const tn = new StaveNote({
              keys: [vex.key],
              duration: 'q',
              autoStem: true,
            });
            if (vex.addAccidentalModifier && vex.accidental) {
              tn.addModifier(new Accidental(vex.accidental));
            }
            if (noteColors?.[idx]) tn.setKeyStyle(0, { fillStyle: noteColors[idx]! });
            trebleTicks.push(tn);
            bassTicks.push(new GhostNote('q'));
          }
        });

        const trebleVoice = new Voice({ numBeats: notes.length, beatValue: 4 });
        trebleVoice.setStrict(false);
        trebleVoice.addTickables(trebleTicks);

        const bassVoice = new Voice({ numBeats: notes.length, beatValue: 4 });
        bassVoice.setStrict(false);
        bassVoice.addTickables(bassTicks);

        new Formatter().joinVoices([trebleVoice, bassVoice]).format([trebleVoice, bassVoice], formatWidth);
        for (let i = 0; i < notes.length; i++) {
          const tt = trebleTicks[i];
          const bt = bassTicks[i];
          if (tt instanceof StaveNote && bt instanceof StaveNote) {
            const delta = tt.getNoteHeadBeginX() - bt.getNoteHeadBeginX();
            if (Math.abs(delta) > 0.5) bt.setXShift(bt.getXShift() + delta);
          }
        }
        trebleVoice.draw(context, trebleStave);
        bassVoice.draw(context, bassStave);
        drawGrandScaleNoteNames(trebleTicks, bassTicks);

        if (scratchIdPerIndex && staffInteractive) {
          notes.forEach((n, idx) => {
            const sid = scratchIdPerIndex[idx];
            if (!sid) return;
            const onBass = isOnBassStaff(n);
            const tick = onBass ? bassTicks[idx] : trebleTicks[idx];
            if (tick instanceof GhostNote) return;
            const sn = tick as InstanceType<typeof StaveNote>;
            const st = onBass ? bassStave : trebleStave;
            const { x, y } = scratchHeadCenterForKey(sn, 0);
            dots.push({ id: sid, x, y });
          });
        }
      }
    } catch (e) {
      console.error('VexFlow render error:', e);
    }
    commitDots(dots);
  }, [
    notes,
    mode,
    keySignature,
    showNoteNames,
    noteColors,
    showBassClef,
    staffDrawMode,
    scratchIdPerIndex,
    staffInteractive,
    layoutVersion,
  ]);

  useEffect(() => {
    if (neswDismissTimerRef.current) {
      clearTimeout(neswDismissTimerRef.current);
      neswDismissTimerRef.current = null;
    }
    return () => {
      if (neswDismissTimerRef.current) {
        clearTimeout(neswDismissTimerRef.current);
        neswDismissTimerRef.current = null;
      }
    };
  }, [selectedScratchId]);

  const clearNeswDismissTimer = useCallback(() => {
    if (neswDismissTimerRef.current) {
      clearTimeout(neswDismissTimerRef.current);
      neswDismissTimerRef.current = null;
    }
  }, []);

  const scheduleNeswDismissTimer = useCallback(() => {
    if (!staffInteractive || !selectedScratchId || !onStaffSelectScratchRef.current) return;
    if (neswDismissTimerRef.current) return;
    const idWhenScheduled = selectedScratchId;
    neswDismissTimerRef.current = window.setTimeout(() => {
      neswDismissTimerRef.current = null;
      onStaffSelectScratchRef.current?.(prev =>
        prev === idWhenScheduled ? null : prev,
      );
    }, NESW_DISMISS_AFTER_MS);
  }, [staffInteractive, selectedScratchId]);

  const handleHostMouseMoveForNesw = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!staffInteractive || !selectedScratchId) return;
      const dot = scratchDots.find(d => d.id === selectedScratchId);
      if (!dot) return;
      const host = hostRef.current;
      if (!host) return;
      const br = host.getBoundingClientRect();
      const x = e.clientX - br.left;
      const y = e.clientY - br.top;
      const onNeswButton = (e.target as HTMLElement).closest?.('.staff-nesw-btn');
      const inStayBox =
        Math.abs(x - dot.x) <= NESW_STAY_BOX_HALF && Math.abs(y - dot.y) <= NESW_STAY_BOX_HALF;

      if (onNeswButton || inStayBox) {
        clearNeswDismissTimer();
      } else {
        scheduleNeswDismissTimer();
      }
    },
    [staffInteractive, selectedScratchId, scratchDots, clearNeswDismissTimer, scheduleNeswDismissTimer],
  );

  const handleHostLeaveForNesw = useCallback(() => {
    if (!staffInteractive || !selectedScratchId) return;
    scheduleNeswDismissTimer();
  }, [staffInteractive, selectedScratchId, scheduleNeswDismissTimer]);

  const handleHostEnterForNesw = useCallback(() => {
    clearNeswDismissTimer();
  }, [clearNeswDismissTimer]);

  const resolveStaffPointer = useCallback(
    (
      e: ReactMouseEvent<HTMLDivElement>,
      options: { scratchHitsSelectable: boolean },
    ): StaffPointerResult => {
      if ((e.target as HTMLElement).closest('.staff-nesw-btn')) return { kind: 'ignore' };
      const host = hostRef.current;
      if (!host) return { kind: 'ignore' };
      const br = host.getBoundingClientRect();
      const x = e.clientX - br.left;
      const y = e.clientY - br.top;

      if (options.scratchHitsSelectable) {
        for (const d of scratchDots) {
          const dx = x - d.x;
          const dy = y - d.y;
          if (dx * dx + dy * dy <= HIT_R * HIT_R) {
            return { kind: 'scratch', id: d.id };
          }
        }
      }

      const lm = layoutMetricsRef.current;
      const svg = containerRef.current?.querySelector('svg');
      if (!(svg instanceof SVGSVGElement)) return { kind: 'ignore' };
      const sr = svg.getBoundingClientRect();
      const nw = svg.width.baseVal.value || 1;
      const nh = svg.height.baseVal.value || 1;
      const rw = sr.width > 0 ? sr.width : 1;
      const rh = sr.height > 0 ? sr.height : 1;
      const logicalX = ((e.clientX - sr.left) / rw) * nw;
      const logicalY = ((e.clientY - sr.top) / rh) * nh;

      /** Name labels sit left of `staveStartLogicalX`; same Y as the note row → treat as that pitch. */
      const nameColumnPitch =
        showNoteNames &&
        mode === 'chord' &&
        !showBassClef &&
        notes.length > 0 &&
        logicalX >= 0 &&
        logicalX < lm.staveStartLogicalX;
      if (logicalX < lm.staveStartLogicalX && !nameColumnPitch) return { kind: 'deselect' };

      const notesForClickExtent =
        staffDrawMode && !showBassClef && notes.length > 0
          ? notes.map(n => transposeNoteOctaveUp(n))
          : notes;

      let pitch: string | null = null;
      if (clickSingle) {
        const sp = clickSingle.lineSpacing;
        let pad = sp * 3;
        let yMin = clickSingle.yLine0 - pad;
        let yMax = clickSingle.bottomY + pad;
        if (staffDrawMode && !showBassClef) {
          yMin -= (TREBLE_TOP_LEDGER_SLOT_COUNT * sp) / 2;
          if (notesForClickExtent.length > 0) {
            yMax += extraBelowTrebleStavePx(notesForClickExtent, sp) + sp * 2;
            yMin -= extraAboveTrebleStavePx(notesForClickExtent, sp) + sp * 2;
          }
        }
        if (logicalY < yMin || logicalY > yMax) return { kind: 'deselect' };
        pitch = pitchFromStaffY(logicalY, clickSingle.yLine0, clickSingle.lineSpacing, 'treble');
        if (staffDrawMode && !showBassClef) {
          const t = Note.transpose(pitch, '-8P');
          if (t) pitch = t;
        }
      } else if (clickGrand) {
        const pt = clickGrand.treble.lineSpacing * 3;
        const pb = clickGrand.bass.lineSpacing * 3;
        const yMin = clickGrand.treble.yLine0 - pt;
        const yMax = clickGrand.bass.bottomY + pb;
        if (logicalY < yMin || logicalY > yMax) return { kind: 'deselect' };
        const clef = clefForGrandStaffClick(
          logicalY,
          clickGrand.treble.yLine0,
          clickGrand.treble.bottomY,
          clickGrand.bass.yLine0,
          clickGrand.bass.bottomY,
        );
        const m = clef === 'treble' ? clickGrand.treble : clickGrand.bass;
        pitch = pitchFromStaffY(logicalY, m.yLine0, m.lineSpacing, clef);
        if (staffDrawMode && clef === 'treble') {
          const t = Note.transpose(pitch, '-8P');
          if (t) pitch = t;
        }
      }
      if (pitch) return { kind: 'pitch', rawPitch: pitch };
      return { kind: 'deselect' };
    },
    [
      scratchDots,
      clickSingle,
      clickGrand,
      staffDrawMode,
      showBassClef,
      notes,
      mode,
      showNoteNames,
    ],
  );

  const handleHostClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!staffInteractive || !onStaffPitchClick || !onStaffSelectScratch) return;
      const r = resolveStaffPointer(e, { scratchHitsSelectable: true });
      if (r.kind === 'ignore') return;
      if (r.kind === 'scratch') {
        clearNeswDismissTimer();
        onStaffSelectScratch(selectedScratchId === r.id ? null : r.id);
        return;
      }
      if (r.kind === 'deselect') {
        clearNeswDismissTimer();
        onStaffSelectScratch(null);
        return;
      }
      clearNeswDismissTimer();
      const br = hostRef.current?.getBoundingClientRect();
      const mirrorHint =
        br && br.width > 0
          ? { x: e.clientX - br.left, width: br.width }
          : undefined;
      onStaffPitchClick(r.rawPitch, mirrorHint);
    },
    [
      staffInteractive,
      onStaffPitchClick,
      onStaffSelectScratch,
      resolveStaffPointer,
      selectedScratchId,
      clearNeswDismissTimer,
    ],
  );

  const handleHostMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      handleHostMouseMoveForNesw(e);
      if (!staffInteractive) return;
      const host = hostRef.current;
      if (!host) return;
      const br = host.getBoundingClientRect();
      const y = e.clientY - br.top;
      const r = resolveStaffPointer(e, { scratchHitsSelectable: false });
      if (r.kind === 'pitch') {
        setHoverRail({
          y,
          pc: leftRailPitchClass(r.rawPitch, keySignature, chartSpellNotes),
        });
      } else {
        setHoverRail(null);
      }

      if (!onStaffHoverPitch || selectedScratchId) return;
      const mirrorHint =
        br.width > 0 ? { x: e.clientX - br.left, width: br.width } : undefined;
      if (r.kind === 'pitch') onStaffHoverPitch(r.rawPitch, mirrorHint);
      else onStaffHoverPitch(null, null);
    },
    [
      staffInteractive,
      onStaffHoverPitch,
      selectedScratchId,
      handleHostMouseMoveForNesw,
      resolveStaffPointer,
      keySignature,
      chartSpellNotes,
    ],
  );

  const handleHostLeave = useCallback(() => {
    handleHostLeaveForNesw();
    setHoverRail(null);
    onStaffHoverPitch?.(null, null);
  }, [handleHostLeaveForNesw, onStaffHoverPitch]);

  const n = selectedScratchNote || '';
  const neswAcc = n ? staffNeswAccidentalHighlight(n) : null;

  const selectedDot = scratchDots.find(d => d.id === selectedScratchId);
  const selectedPc =
    selectedScratchNote != null ? selectedScratchNote.replace(/\d+$/, '') : '';
  const showStickyRail =
    staffInteractive && Boolean(selectedScratchId && selectedDot && selectedPc);
  const showHoverRail = staffInteractive && !selectedScratchId && hoverRail != null;
  const railTop = showStickyRail ? selectedDot!.y : hoverRail?.y ?? 0;
  const railPc = showStickyRail ? selectedPc : hoverRail?.pc ?? '';

  return (
    <div className="staff-container">
      {label && <div className="staff-label">{label}</div>}
      <div
        ref={hostRef}
        className={`staff-host${staffInteractive ? ' staff-host--interactive' : ''}`}
        onClick={handleHostClick}
        onMouseMove={handleHostMouseMove}
        onMouseLeave={handleHostLeave}
        onMouseEnter={handleHostEnterForNesw}
      >
        {(showStickyRail || showHoverRail) && (
          <div className="staff-name-rail" aria-hidden>
            <div
              className={`staff-name-rail-label${showStickyRail ? ' staff-name-rail-label--sticky' : ''}`}
              style={{ top: railTop }}
            >
              {railPc}
            </div>
          </div>
        )}
        <div ref={containerRef} className="staff-render" />
        {staffInteractive && selectedScratchId && selectedDot && onStaffScratchRemove && (
          <div
            className="staff-nesw-wrap"
            style={{
              left: selectedDot.x,
              top: selectedDot.y,
              transform: 'translate(-50%, -50%)',
            }}
            onClick={ev => ev.stopPropagation()}
          >
            <button
              type="button"
              className="staff-nesw-btn staff-nesw-n"
              title="Remove note"
              onClick={() => {
                onStaffScratchRemove(selectedScratchId);
                onStaffSelectScratch?.(null);
              }}
            >
              ×
            </button>
            {onStaffScratchSharp && (
              <button
                type="button"
                className={`staff-nesw-btn staff-nesw-e${neswAcc === 'sharp' ? ' staff-nesw-btn--active' : ''}`}
                title="Sharp"
                onClick={() => {
                  if (neswAcc !== 'sharp') onStaffScratchSharp(selectedScratchId);
                  onStaffSelectScratch?.(null);
                }}
              >
                ♯
              </button>
            )}
            {onStaffScratchNatural && (
              <button
                type="button"
                className={`staff-nesw-btn staff-nesw-s${neswAcc === 'natural' ? ' staff-nesw-btn--active' : ''}`}
                title="Natural"
                onClick={() => {
                  if (neswAcc !== 'natural') onStaffScratchNatural(selectedScratchId);
                  onStaffSelectScratch?.(null);
                }}
              >
                ♮
              </button>
            )}
            {onStaffScratchFlat && (
              <button
                type="button"
                className={`staff-nesw-btn staff-nesw-w${neswAcc === 'flat' ? ' staff-nesw-btn--active' : ''}`}
                title="Flat"
                onClick={() => {
                  if (neswAcc !== 'flat') onStaffScratchFlat(selectedScratchId);
                  onStaffSelectScratch?.(null);
                }}
              >
                ♭
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
