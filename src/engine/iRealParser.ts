import iRealReader from 'ireal-reader';
import { Chord } from 'tonal';
import { iRealToStandard } from './chordConverter';
import { normalizeNote, normalizeNotes } from './noteUtils';
import { getChordNotes } from './chordDatabase';
import type { Song, Measure, ChordInfo } from '../types/music';

function parseChordSymbol(raw: string): ChordInfo | null {
  if (!raw || raw === 'n' || raw === 'x' || raw === 'W' || raw === 'p') return null;

  const symbol = iRealToStandard(raw);
  if (!symbol) return null;

  const c = Chord.get(symbol);
  const notes = getChordNotes(symbol);
  return {
    symbol,
    root: normalizeNote(c.tonic || symbol.match(/^[A-G][b#]?/)?.[0] || ''),
    quality: c.type || '',
    notes,
  };
}

export function parseIRealData(input: string): { name: string; songs: Song[] } {
  let data = input.trim();

  if (data.startsWith('irealb://') || data.startsWith('irealbook://')) {
    data = `<a href="${data}">playlist</a>`;
  }

  const playlist = iRealReader(data);

  const songs: Song[] = (playlist.songs || []).map((song: any) => {
    const measures: Measure[] = [];

    const rawMeasures = song.music?.measures || [];
    for (const m of rawMeasures) {
      const chords: ChordInfo[] = [];
      const rawChords = Array.isArray(m) ? m : (m.chords || []);

      for (const c of rawChords) {
        if (typeof c === 'string') {
          const parsed = parseChordSymbol(c);
          if (parsed) chords.push(parsed);
        }
      }

      const annots = Array.isArray(m) ? [] : (m.annots || []);
      const section = annots.find(
        (a: string) => typeof a === 'string' && a.startsWith('*')
      )?.replace('*', '');

      measures.push({ chords, section });
    }

    return {
      title: song.title || 'Untitled',
      composer: song.composer || 'Unknown',
      style: song.style || '',
      key: song.key || 'C',
      bpm: song.bpm || 120,
      timeSignature: song.timeSignature || '4/4',
      measures,
    };
  });

  return { name: playlist.name || 'Imported Playlist', songs };
}
