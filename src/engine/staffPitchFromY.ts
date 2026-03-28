/**
 * Map a vertical click on a treble or bass stave to the nearest staff (diatonic) pitch with octave.
 * `y` is relative to the top of the SVG / staff render area; `yLine0` is stave.getYForLine(0) in the same coordinates.
 */

/** Ledger lines above treble top (F5): index 0 = k=-N (highest), last = k=-1 (G5 above top line). */
const TREBLE_LEDGER_ABOVE_TOP: string[] = [
  'A7', 'G7', 'F7', 'E7', 'D7', 'C7', 'B6', 'A6', 'G6', 'F6', 'E6', 'D6', 'C6', 'B5', 'A5', 'G5',
];

const TREBLE_FROM_TOP_LINE = [
  'F5', 'E5', 'D5', 'C5', 'B4', 'A4', 'G4', 'F4', 'E4', 'D4', 'C4', 'B3', 'A3', 'G3', 'F3', 'E3', 'D3', 'C3', 'B2',
  'A2', 'G2', 'F2', 'E2', 'D2', 'C2',
];

const TREBLE_DESC_FROM_TOP_LINE = [...TREBLE_LEDGER_ABOVE_TOP, ...TREBLE_FROM_TOP_LINE];
/** How many staff “half-line” steps exist above treble top line (for hit-testing / padding). */
export const TREBLE_TOP_LEDGER_SLOT_COUNT = TREBLE_LEDGER_ABOVE_TOP.length;

const BASS_DESC_FROM_TOP_LINE = [
  'A3', 'G3', 'F3', 'E3', 'D3', 'C3', 'B2', 'A2', 'G2', 'F2', 'E2', 'D2', 'C2', 'B1', 'A1', 'G1', 'F1', 'E1', 'D1',
  'C1', 'B0', 'A0',
];

export function pitchFromStaffY(
  y: number,
  yLine0: number,
  lineSpacing: number,
  clef: 'treble' | 'bass',
): string {
  const half = lineSpacing * 0.5;
  const k = Math.round((y - yLine0) / half);
  const table = clef === 'treble' ? TREBLE_DESC_FROM_TOP_LINE : BASS_DESC_FROM_TOP_LINE;
  const idx =
    clef === 'treble'
      ? Math.max(0, Math.min(table.length - 1, TREBLE_TOP_LEDGER_SLOT_COUNT + k))
      : Math.max(0, Math.min(table.length - 1, k));
  return table[idx]!;
}

export function clefForGrandStaffClick(
  y: number,
  trebleYLine0: number,
  trebleBottomY: number,
  bassYLine0: number,
  bassBottomY: number,
): 'treble' | 'bass' {
  const trebleMid = (trebleYLine0 + trebleBottomY) * 0.5;
  const bassMid = (bassYLine0 + bassBottomY) * 0.5;
  const boundary = (trebleBottomY + bassYLine0) * 0.5;
  if (y <= boundary) return 'treble';
  if (y >= bassMid) return 'bass';
  return y < (trebleMid + bassMid) * 0.5 ? 'treble' : 'bass';
}
