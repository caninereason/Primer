import { Chord, Note } from 'tonal';
import type { ChordInfo } from '../types/music';

function toBassRegister(chroma: number): number {
  let midi = 36 + chroma;
  while (midi > 47) midi -= 12;
  return midi;
}

function slashBassFromSymbol(symbol: string): string | null {
  const i = symbol.lastIndexOf('/');
  if (i < 0 || i === symbol.length - 1) return null;
  const bass = symbol.slice(i + 1).trim();
  return bass.length > 0 ? bass : null;
}

function chordRootMidi(chord: ChordInfo): number {
  const bassOrRoot = chord.bass || slashBassFromSymbol(chord.symbol) || chord.root;
  const ch = Note.chroma(bassOrRoot);
  if (ch == null) return 36;
  return toBassRegister(ch);
}

function chordToneBassMidis(chord: ChordInfo): number[] {
  const parsed = Chord.get(chord.symbol);
  const source = parsed.notes.length > 0 ? parsed.notes : chord.notes;
  const rootCh = Note.chroma(chord.root);
  if (rootCh == null) return [chordRootMidi(chord)];

  const tones = source
    .map((n) => Note.chroma(n))
    .filter((c): c is number => c != null && c !== rootCh)
    .map(toBassRegister);

  const uniq = [...new Set(tones)];
  return uniq.length > 0 ? uniq : [chordRootMidi(chord)];
}

function approachToNext(nextRootMidi: number, currentMidi: number): number {
  const candidates = [nextRootMidi - 1, nextRootMidi + 1];
  let best = candidates[0];
  let bestDist = Math.abs(best - currentMidi);
  for (const c of candidates.slice(1)) {
    const dist = Math.abs(c - currentMidi);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

export function generateWalkingBassBar(
  chord: ChordInfo,
  nextChord: ChordInfo | null,
  beats: number,
  phase = 0,
): number[] {
  if (beats <= 0) return [];
  const root = chordRootMidi(chord);
  if (beats === 1) return [root];

  const tones = chordToneBassMidis(chord);
  const out: number[] = [root];

  for (let i = 1; i < beats; i++) {
    const isLast = i === beats - 1;
    if (isLast && nextChord) {
      const nextRoot = chordRootMidi(nextChord);
      // chromatic approach tone
      out.push(approachToNext(nextRoot, out[out.length - 1]));
    } else {
      out.push(tones[(phase + i - 1) % tones.length]);
    }
  }

  return out;
}
