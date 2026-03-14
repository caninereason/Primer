
import fs from 'fs';
import path from 'path';
import iRealReader from 'ireal-reader';

import { Chord, Note } from 'tonal';

const ENHARMONIC_MAP = {
  'Cb': 'B', 'B#': 'C', 'E#': 'F', 'Fb': 'E',
  'Cbb': 'Bb', 'Dbb': 'C', 'Ebb': 'D', 'Fbb': 'Eb',
  'Gbb': 'F', 'Abb': 'G', 'Bbb': 'A',
  'C##': 'D', 'D##': 'E', 'E##': 'F#', 'F##': 'G',
  'G##': 'A', 'A##': 'B', 'B##': 'C#',
};

function normalizeNote(note) {
  const m = note.match(/^([A-G][b#]*)(\d*)$/);
  if (!m) return note;
  const [, pc, oct] = m;
  const replacement = ENHARMONIC_MAP[pc];
  if (replacement) return replacement + oct;
  return note;
}

const QUALITY_MAP = [
  ['-^9', 'mMaj9'], ['-^7', 'mMaj7'], ['^7#11', 'maj7#11'], ['^7#5', 'maj7#5'],
  ['^7', 'maj7'], ['^9', 'maj9'], ['^13', 'maj13'], ['^', 'maj7'],
  ['-7b5', 'm7b5'], ['-9', 'm9'], ['-11', 'm11'], ['-6', 'm6'], ['-7', 'm7'],
  ['-', 'm'], ['h7', 'm7b5'], ['h', 'm7b5'], ['o7', 'dim7'], ['o', 'dim'],
  ['7sus', '7sus4'], ['sus', 'sus4'], ['7alt', '7alt'],
];

function iRealToStandard(iRealChord) {
  if (!iRealChord) return '';
  const chord = iRealChord.trim();
  if (['n', 'x', 'W', 'p', ''].includes(chord)) return '';
  const rootMatch = chord.match(/^([A-G][b#]?)/);
  if (!rootMatch) return chord;
  const root = rootMatch[1];
  let rest = chord.substring(root.length);
  let bass = '';
  const slashIdx = rest.lastIndexOf('/');
  if (slashIdx >= 0) {
    const possibleBass = rest.substring(slashIdx + 1);
    if (/^[A-G][b#]?$/.test(possibleBass)) {
      bass = '/' + possibleBass;
      rest = rest.substring(0, slashIdx);
    }
  }
  for (const [from, to] of QUALITY_MAP) {
    if (rest.startsWith(from)) {
      rest = to + rest.substring(from.length);
      break;
    }
  }
  return root + rest + bass;
}

function parseChordSymbol(raw) {
  if (!raw || raw === 'n' || raw === 'x' || raw === 'W' || raw === 'p') return null;
  const symbol = iRealToStandard(raw);
  if (!symbol) return null;
  
  const c = Chord.get(symbol);
  return {
    symbol,
    root: normalizeNote(c.tonic || symbol.match(/^[A-G][b#]?/)?.[0] || ''),
    quality: c.type || '',
    notes: c.notes.length ? c.notes.map(normalizeNote) : [],
  };
}

function processFile(filename, outputName) {
    const content = fs.readFileSync(filename, 'utf8');
    const regex = /irealb:\/\/[^"]+/g;
    const matches = content.match(regex);
    if (!matches) {
        console.error(`No links found in ${filename}`);
        return;
    }

    const allSongs = [];
    matches.forEach((link, lIndex) => {
        const decodedLink = decodeURIComponent(link);
        console.log(`Processing link ${lIndex + 1} from ${filename} (decoded length: ${decodedLink.length})`);
        
        // Split playlist link into individual songs/playlist name
        const parts = decodedLink.split('===');
        console.log(`  Found ${parts.length} potential parts`);
        
        parts.forEach((part, index) => {
            try {
                let songLink = part;
                if (!part.startsWith('irealb://')) {
                    songLink = 'irealb://' + part;
                }
                
                const playlist = iRealReader(`<a href="${songLink}">song</a>`);
                const songs = (playlist.songs || []).map(song => {
                    const measures = [];
                    const rawMeasures = song.music?.measures || [];
                    for (const m of rawMeasures) {
                        const chords = [];
                        const rawChords = Array.isArray(m) ? m : (m.chords || []);
                        for (const c of rawChords) {
                            if (typeof c === 'string') {
                                const parsed = parseChordSymbol(c);
                                if (parsed) chords.push(parsed);
                            }
                        }
                        const annots = Array.isArray(m) ? [] : (m.annots || []);
                        const section = annots.find(a => typeof a === 'string' && a.startsWith('*'))?.replace('*', '');
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
                allSongs.push(...songs);
            } catch (err) {
                // Ignore the playlist name part or malformed songs
                if (index < parts.length - 1) {
                    console.warn(`Failed to parse part ${index} of link`);
                }
            }
        });
    });

    const output = `import type { Song } from './types/music';\n\nexport const ${outputName}: Song[] = ${JSON.stringify(allSongs, null, 2)};`;
    fs.writeFileSync(path.join('src', 'engine', `${outputName.toLowerCase()}Data.ts`), output);
    console.log(`Saved ${allSongs.length} songs to ${outputName.toLowerCase()}Data.ts`);
}

processFile('Gjazz.html', 'Gjazz');
processFile('Ol 55 Choons.html', 'Ol55');
