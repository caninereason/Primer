import { useRef, useEffect } from 'react';
import { Renderer, Stave, StaveNote, Voice, Formatter, Accidental } from 'vexflow';
import { noteToVexKey } from '../engine/noteUtils';

interface StaffProps {
  notes: string[];
  mode: 'chord' | 'scale' | 'empty';
  keySignature?: string;
  label?: string;
  /** Show note names to the right of notes when true */
  showNoteNames?: boolean;
  /** Optional color per note (by index) for note heads; when showNoteNames, annotation uses same color */
  noteColors?: (string | undefined)[];
}

const VEX_KEY_MAP: Record<string, string> = {
  'C': 'C', 'Cm': 'Cm',
  'Db': 'Db', 'D': 'D', 'Dm': 'Dm',
  'Eb': 'Eb', 'E': 'E', 'Em': 'Em',
  'F': 'F', 'Fm': 'Fm',
  'F#': 'F#', 'F#m': 'F#m', 'Gb': 'Gb',
  'G': 'G', 'Gm': 'Gm',
  'Ab': 'Ab', 'A': 'A', 'Am': 'Am',
  'Bb': 'Bb', 'B': 'B', 'Bm': 'Bm',
};

function noteLabel(note: string): string {
  return note.replace(/\d+$/, '') || note;
}

export function Staff({
  notes,
  mode,
  keySignature = 'C',
  label,
  showNoteNames = false,
  noteColors,
}: StaffProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.innerHTML = '';

    const width = el.clientWidth || 700;
    const height = 130;
    const staveY = 0;
    const nameColW = showNoteNames ? (mode === 'scale' ? 40 : 26) : 0;
    const staveX = nameColW + 4;

    const renderer = new Renderer(el, Renderer.Backends.SVG);
    renderer.resize(width, height);
    const context = renderer.getContext();

    context.setFillStyle('#c8c8d8');
    context.setStrokeStyle('#c8c8d8');

    const staveWidth = width - staveX - 8;
    const formatWidth = staveWidth - 100;
    const stave = new Stave(staveX, staveY, staveWidth);
    stave.addClef('treble');
    stave.setContext(context).draw();

    if (mode === 'empty' || !notes || notes.length === 0) return;

    const drawChordNoteNames = (sn: InstanceType<typeof StaveNote>) => {
      if (!showNoteNames) return;
      const ys = sn.getYs();
      for (let i = 0; i < ys.length; i++) {
        const label = noteLabel(notes[i]);
        const y = ys[i] + 4;
        const color = noteColors?.[i] || '#c8c8d8';
        context.setFillStyle(color);
        context.setFont('Inter, sans-serif', 10, 'bold');
        context.fillText(label, 2, y);
      }
    };

    const drawScaleNoteNames = (staveNotes: InstanceType<typeof StaveNote>[]) => {
      if (!showNoteNames) return;
      const COL0_X = 2;
      const COL1_X = 22;
      staveNotes.forEach((sn, idx) => {
        const y = sn.getYs()[0] + 4;
        const label = noteLabel(notes[idx]);
        const color = noteColors?.[idx] || '#c8c8d8';
        const x = idx % 2 === 0 ? COL0_X : COL1_X;
        context.setFillStyle(color);
        context.setFont('Inter, sans-serif', 10, 'bold');
        context.fillText(label, x, y);
      });
    };

    try {
      if (mode === 'chord') {
        const vexNotes = notes.map(n => noteToVexKey(n));
        const sn = new StaveNote({
          keys: vexNotes.map(n => n.key),
          duration: 'w',
          auto_stem: true,
        });

        vexNotes.forEach((n, i) => {
          if (n.accidental) sn.addModifier(new Accidental(n.accidental), i);
          if (noteColors?.[i]) sn.setKeyStyle(i, { fillStyle: noteColors[i]! });
        });

        const voice = new Voice({ num_beats: 4, beat_value: 4 });
        voice.setStrict(false);
        voice.addTickables([sn]);

        new Formatter().joinVoices([voice]).format([voice], formatWidth);
        voice.draw(context, stave);
        drawChordNoteNames(sn);
      } else if (mode === 'scale') {
        const staveNotes = notes.map((n, idx) => {
          const vex = noteToVexKey(n);
          const note = new StaveNote({
            keys: [vex.key],
            duration: 'q',
            auto_stem: true,
          });
          if (vex.accidental) note.addModifier(new Accidental(vex.accidental));
          if (noteColors?.[idx]) note.setKeyStyle(0, { fillStyle: noteColors[idx]! });
          return note;
        });

        const voice = new Voice({ num_beats: notes.length, beat_value: 4 });
        voice.setStrict(false);
        voice.addTickables(staveNotes);

        new Formatter().joinVoices([voice]).format([voice], formatWidth);
        voice.draw(context, stave);
        drawScaleNoteNames(staveNotes);
      }
    } catch (e) {
      console.error('VexFlow render error:', e);
    }
  }, [notes, mode, keySignature, showNoteNames, noteColors]);

  return (
    <div className="staff-container">
      {label && <div className="staff-label">{label}</div>}
      <div ref={containerRef} className="staff-render" />
    </div>
  );
}
