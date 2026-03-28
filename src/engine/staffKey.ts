import { Key, Note, Scale } from 'tonal';
import { normalizeNote, noteToVexKey } from './noteUtils';

/**
 * One conventional major tonic per chroma for VexFlow `addKeySignature`.
 * Tonal may return `Fb`, `Cb`, `Bbb` as relative majors (e.g. Dbm → Fb); those crash or break Vex.
 */
const VEX_MAJOR_KEY_SIG_BY_CHROMA = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
] as const;

function vexSafeMajorTonic(tonic: string): string {
  const ch = Note.chroma(tonic);
  if (ch == null) return tonic;
  return VEX_MAJOR_KEY_SIG_BY_CHROMA[ch];
}

/** Tonal scale name for diatonic spelling (e.g. `G major`, `A minor`). */
export function scaleNameFromSongKey(songKey: string): string {
  const s = songKey.trim();
  const m = s.match(/^([A-G][b#]?)m(inor)?$/i);
  if (m) return `${m[1]} minor`;
  const root = s.match(/^([A-G][b#]?)/)?.[1];
  return root ? `${root} major` : 'C major';
}

/** VexFlow `addKeySignature` tonic: minor keys use relative major (same key sig). */
export function vexKeySignatureSpec(songKey: string): string {
  const s = songKey.trim();
  const m = s.match(/^([A-G][b#]?)m(inor)?$/i);
  if (m) return vexSafeMajorTonic(Key.minorKey(m[1]).relativeMajor);
  const root = s.match(/^([A-G][b#]?)/)?.[1] ?? 'C';
  return vexSafeMajorTonic(root);
}

/**
 * Map a staff-slot name from `pitchFromStaffY` (C-major-style letter+octave) to the note
 * in the song key with the same letter name and octave on the staff.
 */
export function spellPitchOnStaffInKey(staffNaturalName: string, songKey: string): string {
  const g = Note.get(staffNaturalName);
  if (g.empty) return staffNaturalName;
  const letter = g.letter;
  const oct = g.oct ?? 4;
  const scaleName = scaleNameFromSongKey(songKey);
  const scaleData = Scale.get(scaleName);
  if (!scaleData.notes.length) return normalizeNote(staffNaturalName);
  const scaleChroma = new Set(
    scaleData.notes.map(n => Note.chroma(n)).filter((c): c is number => c != null),
  );
  const center = Note.midi(staffNaturalName) ?? 69;
  for (let d = 0; d <= 6; d++) {
    for (const sign of [0, 1, -1] as const) {
      const midi = center + sign * d;
      if (midi < 0 || midi > 127) continue;
      const ch = midi % 12;
      if (!scaleChroma.has(ch)) continue;
      const name = Note.fromMidi(midi);
      if (!name) continue;
      const ng = Note.get(name);
      if (ng.letter === letter && ng.oct === oct) return normalizeNote(name);
    }
  }
  return normalizeNote(staffNaturalName);
}

/** Vex StaveNote key string + whether to add an explicit accidental (not in key). */
export function vexNoteRenderSpec(
  note: string,
  songKey: string,
): { key: string; accidental?: string; addAccidentalModifier: boolean } {
  const nSpell = normalizeNote(note);
  const { key, accidental: accRaw } = noteToVexKey(nSpell);
  const scaleName = scaleNameFromSongKey(songKey);
  const chromas = new Set(
    Scale.get(scaleName).notes.map(n => Note.chroma(n)).filter((c): c is number => c != null),
  );
  const ch = Note.chroma(nSpell);
  const inKey = ch != null && chromas.has(ch);

  const isDblSharp = accRaw === '##';
  const isDblFlat = accRaw === 'bb';
  const isSharp = accRaw === '#';
  const isFlat = accRaw === 'b';

  if (isDblSharp || isDblFlat) {
    return { key, accidental: isDblSharp ? '##' : 'bb', addAccidentalModifier: true };
  }

  if (inKey) {
    return {
      key,
      accidental: isSharp || isFlat ? accRaw : undefined,
      addAccidentalModifier: false,
    };
  }

  if (isSharp || isFlat) {
    return { key, accidental: accRaw!, addAccidentalModifier: true };
  }

  // Natural spelling but pitch class is not diatonic (e.g. F♮ in G, B♮ in F) — cancel key sig.
  return { key, accidental: 'n', addAccidentalModifier: true };
}
