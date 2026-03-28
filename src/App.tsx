import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { MouseEvent } from 'react';
import { Note, Chord, Scale } from 'tonal';
import type { Song, Measure, ChordInfo, ScaleSuggestion, KeyAnalysis } from './types/music';
import { getScalesForChord } from './engine/scaleEngine';
import { getScaleRelation } from './engine/scaleRelations';
import { analyzeKey } from './engine/keyAnalyzer';
import {
  assignOctaves,
  buildChordMidis,
  COMPACT_PIANO_ROLL_MIDIS,
  mapNotesToCompactPianoRollKeyboard,
  normalizeNotes,
  snapMidiToCompactPianoRoll,
  spellChordNotesLikePianoRoll,
  spellLikeChordChart,
} from './engine/noteUtils';
import {
  mergeHarmonyNoteStrings,
  mergeStaffWithScratch,
  normalizeStaffScratchSpelling,
  scratchApplyAccidental,
  type StaffScratchEntry,
} from './engine/staffScratchAccidentals';
import { spellPitchOnStaffInKey } from './engine/staffKey';
import { DEMO_SONGS } from './engine/demoData';
import { parseIRealData } from './engine/iRealParser';
import {
  computeVoicing,
  computeGuitarPositions,
  splitSlashChordForPiano,
  slashBassDisplayLabel,
  VOICING_OPTIONS,
  type VoicingType,
} from './engine/voicingEngine';
import {
  generatePlayableVoicings,
  filterTabNotesAtOrAboveRoot,
  midiForDisplayStringFret,
  resolveGuitarMirrorPick,
  tabToMidiNotes,
  type GuitarMirrorPick,
  type GuitarTab,
} from './engine/guitarVoicings';
import { buildDegreeColorMap } from './engine/degreeColors';
import { ChordPlayer, type RepeatMark } from './engine/player';
import { Header } from './components/Header';
import { Staff } from './components/Staff';
import { PianoRoll } from './components/PianoRoll';
import { Fretboard } from './components/Fretboard';
import { ChordChart } from './components/ChordChart';
import { ScalePanel } from './components/ScalePanel';
import { ImportModal } from './components/ImportModal';
import { Library } from './components/Library';
import './App.css';

import { transposeNote, FLAT_KEYS, FLAT_NOTES, SHARP_NOTES } from './engine/noteUtils';
import {
  getChordNotes,
  lookupChordShapes,
  CANONICAL_SUFFIX_MAP,
  detectLibraryChords,
  tabMatchesChordSymbol,
  canonicalChordSymbol,
} from './engine/chordDatabase';
import { generateWalkingBassBar } from './engine/walk';
import { chordBeatsForSlot, findNextChordInfo } from './engine/bassFretboard';

type InstrumentId = 'staff' | 'piano' | 'guitar';
type FretboardInstrument = 'guitar' | 'bass';

const BASS_STRINGS = [
  { name: 'g', chroma: 7 },
  { name: 'd', chroma: 2 },
  { name: 'a', chroma: 9 },
  { name: 'e', chroma: 4 },
];
/** Open-string MIDI for each row in BASS_STRINGS (g, d, a, e top → bottom). */
const BASS_OPEN_MIDIS = [43, 38, 33, 28] as const;

/** Click the Guitar mode button this many times (while using the app) to reveal Save Default + neck-shift arrows. */
const GUITAR_CHORD_TOOLS_REVEAL_CLICKS = 5;
/** Chord voicings and highlights stay within frets 0…this (per-position view). */
const GUITAR_CHORD_MAX_FRET = 14;

function uniquePitchClassNoteStrings(midis: Iterable<number>): string[] {
  const byChroma = new Map<number, string>();
  const sorted = [...midis].filter(m => m >= 0 && m <= 127).sort((a, b) => a - b);
  for (const m of sorted) {
    const n = Note.fromMidi(m);
    if (!n) continue;
    const ch = Note.chroma(n);
    if (ch == null) continue;
    if (!byChroma.has(ch)) byChroma.set(ch, n);
  }
  return [...byChroma.values()];
}

function mergeNoteStringsUniqueByChroma(a: string[], b: string[]): string[] {
  const byChroma = new Map<number, string>();
  for (const n of [...a, ...b]) {
    const ch = Note.chroma(n);
    if (ch == null) continue;
    if (!byChroma.has(ch)) byChroma.set(ch, n);
  }
  return [...byChroma.values()];
}
/** Guitar "All" position: show one octave of frets (nut through 12). */
const GUITAR_ALL_POSITION_END_FRET = 12;

/** localStorage: canonical chord symbol → preferred Pos index (0…4) when opening that chord from the chart. */
const CHART_GUITAR_DEFAULT_POS_KEY = 'primer-chart-guitar-default-pos';

function findFirstBarreIndex(tabs: GuitarTab[]): number {
  const barreIdx = tabs.findIndex((tab) => {
    const frets = tab.filter((f): f is number => f != null && f > 0);
    const counts: Record<number, number> = {};
    frets.forEach((f) => (counts[f] = (counts[f] || 0) + 1));
    return Object.values(counts).some((c) => c >= 3);
  });
  return barreIdx >= 0 ? barreIdx : 0;
}

/**
 * High voicings can have min fret > 14 while endFret is capped — that made startFret > endFret and the
 * fretboard SVG used zero/negative width. Clamp so start ≤ end and both stay within maxFret.
 */
function clampGuitarChordViewRange(startFret: number, endFret: number, maxFret: number) {
  let s = Math.max(0, startFret);
  let e = Math.min(endFret, maxFret);
  if (s <= e) return { startFret: s, endFret: e };
  e = Math.min(maxFret, Math.max(s, maxFret - 4));
  s = Math.max(0, e - 5);
  if (s > e) {
    s = Math.max(0, maxFret - 5);
    e = maxFret;
  }
  return { startFret: s, endFret: Math.max(s, e) };
}

/** P1/P2/P3 (not "All"): at most this many fret columns inclusive. */
const FRETBOARD_MAX_POSITION_FRETS = 5;

function clampFretWindowToSpan(
  startFret: number,
  endFret: number,
  maxInclusive: number,
  maxFretCap: number,
): { startFret: number; endFret: number } {
  let s = Math.max(0, Math.min(startFret, endFret));
  let e = Math.min(maxFretCap, Math.max(startFret, endFret));
  if (e - s + 1 <= maxInclusive) return { startFret: s, endFret: e };
  e = s + maxInclusive - 1;
  if (e > maxFretCap) {
    e = maxFretCap;
    s = Math.max(0, e - maxInclusive + 1);
  }
  return { startFret: s, endFret: e };
}

/** Grow visible [s,e] so every sounding fret in `tab` is on the diagram (up to `cap`). */
function mergeGuitarTabIntoFretWindow(
  tab: (number | null)[] | null,
  startFret: number,
  endFret: number,
  cap: number,
): { startFret: number; endFret: number } {
  if (!tab || tab.length !== 6) return { startFret, endFret };
  let tMin: number | null = null;
  let tMax: number | null = null;
  for (const f of tab) {
    if (f == null) continue;
    tMin = tMin === null ? f : Math.min(tMin, f);
    tMax = tMax === null ? f : Math.max(tMax, f);
  }
  if (tMin == null || tMax == null) return { startFret, endFret };
  let s = Math.min(startFret, tMin);
  let e = Math.max(endFret, tMax);
  s = Math.max(0, s);
  e = Math.min(cap, Math.max(e, s));
  return { startFret: s, endFret: e };
}

function chordFretRangeFromPressedBounds(
  minPressed: number,
  maxPressed: number,
  maxFret: number,
) {
  const cappedMin = Math.min(minPressed, maxFret);
  const cappedMax = Math.min(maxPressed, maxFret);
  const start = Math.max(0, cappedMin - 1);
  const end = Math.min(cappedMax + 2, maxFret);
  return clampGuitarChordViewRange(start, end, maxFret);
}

function bassChordRootReferenceMidi(root: string): number | null {
  const ch = Note.chroma(root);
  if (ch == null) return null;
  return 28 + ((ch - 4 + 12) % 12);
}

const BASS_POSITIONS = [
  { label: 'P1', startFret: 0, endFret: 4 },
  { label: 'P2', startFret: 4, endFret: 8 },
  { label: 'P3', startFret: 8, endFret: 12 },
] as const;

/** Bass "All": full visible neck (same idea as guitar All). */
const BASS_ALL_FRET_RANGE = { label: 'All', startFret: 0, endFret: 16 } as const;

type BassPositionIdx = -1 | 0 | 1 | 2;

/** Visible fretboard right edge for guitar (positions + All). */
const GUITAR_NECK_END_FRET = 24;

function toPitchClass(note: string): string {
  return Note.pitchClass(note) || note.replace(/\d+$/, '');
}

function transposeChord(chord: ChordInfo, semi: number, useFlats: boolean): ChordInfo {
  const newRoot = transposeNote(chord.root, semi, useFlats);
  const suffix = chord.symbol.slice(chord.root.length);
  const newSymbol = newRoot + suffix;
  const notes = getChordNotes(newSymbol);

  return {
    symbol: newSymbol,
    root: newRoot,
    quality: chord.quality,
    bass: chord.bass ? transposeNote(chord.bass, semi, useFlats) : undefined,
    notes: notes.length > 0 ? notes : chord.notes.map(n => transposeNote(n, semi, useFlats)),
  };
}

function transposeSong(song: Song, semi: number): Song {
  const keyRoot = song.key.replace(/[-m].*$/, '');
  const keyCh = Note.chroma(keyRoot);
  const newKeyCh = keyCh != null ? (keyCh + semi + 12) % 12 : 0;
  const useFlats = FLAT_KEYS.has(newKeyCh);
  const keySuffix = song.key.slice(keyRoot.length);
  const newKey = (useFlats ? FLAT_NOTES : SHARP_NOTES)[newKeyCh] + keySuffix;

  const measures: Measure[] = song.measures.map(m => ({
    ...m,
    chords: m.chords.map(c => transposeChord(c, semi, useFlats)),
  }));

  return { ...song, key: newKey, measures };
}

export default function App() {
  const [songs, setSongs] = useState<Song[]>(DEMO_SONGS);
  const [selectedSongIndex, setSelectedSongIndex] = useState(0);
  const [selectedMeasure, setSelectedMeasure] = useState<number | null>(0);
  const [selectedChordIdx, setSelectedChordIdx] = useState(0);
  const [selectedScale, setSelectedScale] = useState<ScaleSuggestion | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [importError, setImportError] = useState('');
  const [voicingType, setVoicingType] = useState<VoicingType>('all');
  const [guitarPosition, setGuitarPosition] = useState(0);
  /** Library: avoid re-syncing editable from DB until symbol, position, or resolved shapes actually change. */
  const prevLibraryFretKeyRef = useRef<string>('');
  const guitarToolsRevealClicksRef = useRef(0);
  const [guitarChordToolsUnlocked, setGuitarChordToolsUnlocked] = useState(false);
  /** Pans the visible chord fret window (after unlock); reset when position/chord changes. */
  const [guitarChordViewPan, setGuitarChordViewPan] = useState(0);
  const [activeDegrees, setActiveDegrees] = useState<Set<number>>(new Set());
  const [expandedInstrument, setExpandedInstrument] = useState<InstrumentId | null>(null);
  const [collapsedInstruments, setCollapsedInstruments] = useState<Set<InstrumentId>>(new Set());
  const [fretboardInstrument, setFretboardInstrument] = useState<FretboardInstrument>('guitar');
  const [bassPosition, setBassPosition] = useState<BassPositionIdx>(0);
  const [guitarVoicingVariant, setGuitarVoicingVariant] = useState(0);
  const [transposeSemitones, setTransposeSemitones] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [metronomeOn, setMetronomeOn] = useState(true);
  const [pianoOn, setPianoOn] = useState(true);
  const [bassOn, setBassOn] = useState(true);
  const [swingPercent, setSwingPercent] = useState(50);
  const [showStaffNoteNames, setShowStaffNoteNames] = useState(true);
  /** Grand staff: bass (F) clef below treble; default off. */
  const [showStaffBassClef, setShowStaffBassClef] = useState(false);
  /** User-placed notes on the staff (click to add; NESW to edit). */
  const [staffScratch, setStaffScratch] = useState<StaffScratchEntry[]>([]);
  /** Chart/voicing midis hidden after removing the scratch row that replaced them. */
  const [staffOmittedMidis, setStaffOmittedMidis] = useState<Set<number>>(() => new Set());
  /** Pitch classes hidden on staff when piano uses chroma-level dim (7+ note chords). */
  const [staffOmittedChromas, setStaffOmittedChromas] = useState<Set<number>>(() => new Set());
  const [selectedStaffScratchId, setSelectedStaffScratchId] = useState<string | null>(null);
  /** Piano key to ring when pointer maps to a staff line (same MIDI as compact roll). */
  const [staffHoverMidi, setStaffHoverMidi] = useState<number | null>(null);
  /** Pitch-class label for hover (matches chord chart spelling, not `Note.fromMidi` default). */
  const [staffHoverPitchClass, setStaffHoverPitchClass] = useState<string | null>(null);
  const [showPianoNoteNames, setShowPianoNoteNames] = useState(true);
  const [showGuitarFretNoteNames, setShowGuitarFretNoteNames] = useState(true);
  /** When true, show pitch-class names on ghost + played dots (each string/fret labeled). */
  const [showBassAllNoteNames, setShowBassAllNoteNames] = useState(false);
  /** Guitar: extend visible end fret after clicking a fret (e.g. click 12 → show 13). */
  const [guitarPeekEndExtend, setGuitarPeekEndExtend] = useState<number | null>(null);
  const [bpmOverride, setBpmOverride] = useState<number | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryChord, setLibraryChord] = useState<ChordInfo | null>(null);
  const [libraryRoot, setLibraryRoot] = useState('C');
  const [librarySuffix, setLibrarySuffix] = useState('');
  const [scalesOnPlay, setScalesOnPlay] = useState(false);
  const [repeatFrom, setRepeatFrom] = useState<RepeatMark | null>(null);
  const [repeatTo, setRepeatTo] = useState<RepeatMark | null>(null);
  const [repeatPicker, setRepeatPicker] = useState<'from' | 'to' | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  /** When in library + chord mode, editable shape for save; click fretboard to edit. */
  const [editableGuitarTab, setEditableGuitarTab] = useState<(number | null)[] | null>(null);
  const [mirrorGuitarToPiano, setMirrorGuitarToPiano] = useState(false);
  const [tappedMidis, setTappedMidis] = useState<Set<number>>(new Set());
  /** Piano keys dimmed by click (chord/voicing highlights); cleared with chord / chart clear. */
  const [pianoOmittedMidis, setPianoOmittedMidis] = useState<Set<number>>(() => new Set());
  const [pianoOmittedChromas, setPianoOmittedChromas] = useState<Set<number>>(() => new Set());
  const [tappedGuitarTab, setTappedGuitarTab] = useState<(number | null)[] | null>(null);
  const [liveBassNote, setLiveBassNote] = useState<string | null>(null);
  const [liveBassMidi, setLiveBassMidi] = useState<number | null>(null);
  /** Skip one chordScales sync so panel scale choice is not replaced by chordScales[0]. */
  const skipPanelScaleSyncRef = useRef(false);

  const fretboardHeaderActionsRef = useRef<HTMLDivElement | null>(null);
  const guitarPosFooterRef = useRef<HTMLDivElement | null>(null);
  /** Collapsed card: width of fretboard column (between ◀ ▶), for fitting All/P1… below */
  const guitarFretboardBoardRef = useRef<HTMLDivElement | null>(null);

  const playerRef = useRef<ChordPlayer | null>(null);
  if (!playerRef.current) playerRef.current = new ChordPlayer();

  const currentSong = songs[selectedSongIndex] || null;

  const activeSong = useMemo(() => {
    if (!currentSong) return null;
    return transposeSong(currentSong, transposeSemitones);
  }, [currentSong, transposeSemitones]);

  const effectiveBpm = activeSong ? (bpmOverride ?? activeSong.bpm) : 120;

  const selectedChord = useMemo(() => {
    if (showLibrary) return libraryChord || null;
    if (!activeSong || selectedMeasure === null) return null;
    const measure = activeSong.measures[selectedMeasure];
    return measure?.chords[selectedChordIdx] || measure?.chords[0] || null;
  }, [activeSong, selectedMeasure, selectedChordIdx, showLibrary, libraryChord]);

  const keyAnalysis: KeyAnalysis | null = useMemo(() => {
    if (!activeSong) return null;
    const allChords = activeSong.measures.flatMap(m => m.chords);
    return analyzeKey(allChords);
  }, [activeSong]);

  const chordScales = useMemo(() => {
    if (!selectedChord || !activeSong) return [];
    const measures = activeSong.measures;
    const flat: { measureIdx: number; chordIdx: number; symbol: string }[] = [];
    measures.forEach((m, mi) => {
      m.chords.forEach((c, ci) => {
        flat.push({ measureIdx: mi, chordIdx: ci, symbol: c.symbol });
      });
    });
    const currentIdx = flat.findIndex(
      (e) => e.measureIdx === selectedMeasure && e.chordIdx === selectedChordIdx
    );

    const chromaKey = (notes: string[]): string =>
      [...new Set(notes.map((n) => Note.chroma(n)).filter((c): c is number => c != null))]
        .sort((a, b) => a - b)
        .join(',');

    let prevEntry: typeof flat[0] | null = null;
    for (let i = currentIdx - 1; i >= 0; i--) {
      if (flat[i].symbol !== selectedChord.symbol) { prevEntry = flat[i]; break; }
    }
    let nextEntry: typeof flat[0] | null = null;
    for (let i = currentIdx + 1; i < flat.length; i++) {
      if (flat[i].symbol !== selectedChord.symbol) { nextEntry = flat[i]; break; }
    }

    const prevChromaKeys = prevEntry
      ? new Set(getScalesForChord(prevEntry.symbol).map((s) => chromaKey(s.notes)))
      : new Set<string>();
    const nextChromaKeys = nextEntry
      ? new Set(getScalesForChord(nextEntry.symbol).map((s) => chromaKey(s.notes)))
      : new Set<string>();

    const mappedScales = getScalesForChord(selectedChord.symbol).map((scale, index) => {
      const key = chromaKey(scale.notes);
      return {
        ...scale,
        originalIndex: index,
        relatedToPrevious: prevEntry != null && prevChromaKeys.has(key),
        relatedToNext: nextEntry != null && nextChromaKeys.has(key),
      };
    });

    mappedScales.sort((a, b) => {
      const aScore = (a.relatedToPrevious ? 1 : 0) + (a.relatedToNext ? 1 : 0);
      const bScore = (b.relatedToPrevious ? 1 : 0) + (b.relatedToNext ? 1 : 0);
      if (aScore !== bScore) return bScore - aScore;
      return a.originalIndex - b.originalIndex;
    });

    return mappedScales;
  }, [selectedChord, activeSong, selectedMeasure, selectedChordIdx]);

  const neighborChords = useMemo(() => {
    if (!activeSong || selectedMeasure === null || !selectedChord) return { prev: null, next: null };
    const flat: string[] = [];
    let currentIdx = -1;
    activeSong.measures.forEach((m, mi) => {
      m.chords.forEach((c, ci) => {
        if (mi === selectedMeasure && ci === selectedChordIdx) currentIdx = flat.length;
        flat.push(c.symbol);
      });
    });
    let prev: string | null = null;
    for (let i = currentIdx - 1; i >= 0; i--) {
      if (flat[i] !== selectedChord.symbol) { prev = flat[i]; break; }
    }
    let next: string | null = null;
    for (let i = currentIdx + 1; i < flat.length; i++) {
      if (flat[i] !== selectedChord.symbol) { next = flat[i]; break; }
    }
    return { prev, next };
  }, [activeSong, selectedMeasure, selectedChordIdx, selectedChord]);

  const displayRoot = selectedChord?.root || (selectedScale ? selectedScale.notes[0] : '');
  const bassDisplayNote = isPlaying && liveBassNote ? liveBassNote : displayRoot;
  const bassGhostNotes = useMemo(() => {
    if (fretboardInstrument !== 'bass' || !selectedChord) return [];
    const rootCh = Note.chroma(bassDisplayNote || displayRoot);
    const chordGhosts = selectedChord.notes.filter((n) => {
      const ch = Note.chroma(n);
      return ch != null && ch !== rootCh;
    });
    const scaleGhosts = (selectedScale?.notes ?? []).filter((n) => {
      const ch = Note.chroma(n);
      return ch != null && ch !== rootCh;
    });
    return normalizeNotes([...chordGhosts, ...scaleGhosts]).map(toPitchClass);
  }, [fretboardInstrument, selectedChord, selectedScale, bassDisplayNote, displayRoot]);

  /** Walking-bass MIDI targets for current chord slot (matches player). Used for bass chord-mode ghosts. */
  const bassChordGhostMidis = useMemo((): readonly number[] | null => {
    if (fretboardInstrument !== 'bass' || !activeSong || !selectedChord || selectedScale) {
      return null;
    }
    const mi = selectedMeasure ?? 0;
    const m = activeSong.measures[mi];
    if (!m) return null;
    const bpb = parseInt(activeSong.timeSignature.split('/')[0], 10) || 4;
    const beats = chordBeatsForSlot(m, selectedChordIdx, bpb);
    const nextChord = findNextChordInfo(activeSong.measures, mi, selectedChordIdx);
    const bar = generateWalkingBassBar(selectedChord, nextChord, beats, mi + selectedChordIdx);
    return [...new Set(bar)];
  }, [
    fretboardInstrument,
    activeSong,
    selectedChord,
    selectedScale,
    selectedMeasure,
    selectedChordIdx,
  ]);

  const voicing = useMemo(() => {
    if (!selectedChord || selectedScale || voicingType === 'all') return null;
    return computeVoicing(selectedChord.symbol, voicingType);
  }, [selectedChord, selectedScale, voicingType]);

  const staffMode: 'chord' | 'scale' | 'empty' = selectedScale
    ? 'scale'
    : selectedChord
      ? 'chord'
      : 'empty';

  const staffLabel = selectedScale ? selectedScale.name : selectedChord ? selectedChord.symbol : '';

  const displayNotes = useMemo(() => {
    if (fretboardInstrument === 'bass') {
      return bassDisplayNote ? [toPitchClass(bassDisplayNote)] : [];
    }
    let result: string[] = [];
    if (selectedScale) {
      result = selectedScale.notes;
    } else if (voicing) {
      const all = [...voicing.leftHand, ...voicing.rightHand];
      result = [...new Set(all.map(n => n.replace(/\d+$/, '')))];
    } else if (selectedChord) {
      result = selectedChord.notes;
    }
    return normalizeNotes(result);
  }, [selectedChord, selectedScale, voicing, fretboardInstrument, bassDisplayNote]);

  const fretboardMode: 'chord' | 'scale' = selectedScale ? 'scale' : 'chord';


  const CUSTOM_CHORDS_KEY = 'primer-custom-chords';

  const [customChordsOverride, setCustomChordsOverride] = useState<Record<string, (GuitarTab | null)[]> | null>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CUSTOM_CHORDS_KEY) : null;
      if (raw) {
        const data = JSON.parse(raw) as Record<string, (GuitarTab | null)[]>;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          console.info(`[ChordLoad] Loaded ${Object.keys(data).length} symbols from localStorage`);
          return data;
        }
      }
    } catch (err) { console.error('[ChordLoad] LocalStorage error:', err); }
    return null;
  });

  const [chartGuitarDefaultPos, setChartGuitarDefaultPos] = useState<Record<string, number>>(() => {
    try {
      const raw =
        typeof localStorage !== 'undefined' ? localStorage.getItem(CHART_GUITAR_DEFAULT_POS_KEY) : null;
      if (raw) {
        const data = JSON.parse(raw) as Record<string, number>;
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
      }
    } catch (_) {}
    return {};
  });

  const lastChartChordNavKeyRef = useRef('');
  const prevShowLibraryForChartNavRef = useRef(showLibrary);

  useEffect(() => {
    fetch('/api/custom-chords')
      .then(res => (res.ok ? res.json() : null))
      .then((data: Record<string, (GuitarTab | null)[]> | null) => {
        if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0) {
          console.info(`[ChordLoad] Merging ${Object.keys(data).length} symbols from API`);
          setCustomChordsOverride(prev => ({ ...data, ...(prev ?? {}) }));
        }
      })
      .catch(err => console.warn('[ChordLoad] API fetch failed:', err));
  }, []);

  useEffect(() => {
    if (customChordsOverride != null && Object.keys(customChordsOverride).length > 0) {
      try {
        localStorage.setItem(CUSTOM_CHORDS_KEY, JSON.stringify(customChordsOverride));
      } catch (_) {}
    }
  }, [customChordsOverride]);

  const chordShapesResult = useMemo(() => {
    if (!selectedChord) return { tabs: [] as (number | null)[][], shapeLabels: null as string[] | null };
    return lookupChordShapes(selectedChord.symbol, customChordsOverride);
  }, [selectedChord, customChordsOverride]);

  const dbShapes = chordShapesResult.tabs;
  const dbShapeLabels = chordShapesResult.shapeLabels;
  /** When lookup output changes without symbol/position change, re-sync library editor from engine. */
  const voicingSourceSig = useMemo(
    () => dbShapes.map((t) => (t && t.length ? t.join(',') : '')).join('|'),
    [dbShapes],
  );

  const guitarPositions = useMemo(() => {
    if (!displayRoot) return [];
    const ch = Note.chroma(displayRoot);
    if (ch == null) return [];
    if (fretboardMode === 'chord' && dbShapes.length > 0) {
      return dbShapes.map((tab, i) => {
        const frets = tab.filter((f): f is number => f != null && f >= 0);
        const minF = frets.length ? Math.min(...frets) : 0;
        const maxF = frets.length ? Math.max(...frets) : 4;
        const r = chordFretRangeFromPressedBounds(minF, maxF, GUITAR_CHORD_MAX_FRET);
        return {
          label: `Pos ${i + 1}`,
          ...clampFretWindowToSpan(r.startFret, r.endFret, FRETBOARD_MAX_POSITION_FRETS, GUITAR_CHORD_MAX_FRET),
        };
      });
    }
    const base = computeGuitarPositions(ch);
    if (fretboardMode === 'chord') {
      return base.map((p) => {
        const r = clampGuitarChordViewRange(p.startFret, p.endFret, GUITAR_CHORD_MAX_FRET);
        return {
          label: p.label,
          ...clampFretWindowToSpan(r.startFret, r.endFret, FRETBOARD_MAX_POSITION_FRETS, GUITAR_CHORD_MAX_FRET),
        };
      });
    }
    return base;
  }, [displayRoot, fretboardMode, dbShapes, dbShapeLabels]);

  const fretRange = useMemo(() => {
    if (fretboardInstrument === 'bass') {
      if (bassPosition === -1) return BASS_ALL_FRET_RANGE;
      return BASS_POSITIONS[bassPosition];
    }
    if (guitarPosition >= 0 && guitarPositions[guitarPosition])
      return guitarPositions[guitarPosition];
    return {
      startFret: 0,
      endFret:
        fretboardInstrument === 'guitar' ? GUITAR_ALL_POSITION_END_FRET : GUITAR_NECK_END_FRET,
      label: 'All',
    };
  }, [guitarPosition, guitarPositions, fretboardInstrument, bassPosition, fretboardMode]);

  useEffect(() => {
    setGuitarPeekEndExtend(null);
  }, [fretboardInstrument, guitarPosition, fretRange.startFret, fretRange.endFret]);

  /** Chord mode: Pos 1…5 cap at 14; "All" caps at 12. */
  const guitarChordNeckCap = useMemo(() => {
    if (fretboardInstrument !== 'guitar' || fretboardMode !== 'chord') {
      return GUITAR_CHORD_MAX_FRET;
    }
    return guitarPosition < 0 ? GUITAR_ALL_POSITION_END_FRET : GUITAR_CHORD_MAX_FRET;
  }, [fretboardInstrument, fretboardMode, guitarPosition]);

  const guitarChordFretWindow = useMemo(() => {
    if (fretboardInstrument !== 'guitar' || fretboardMode !== 'chord') return null;
    const cap = guitarChordNeckCap;
    const a = fretRange.startFret;
    const b = fretRange.endFret;
    let s = a + guitarChordViewPan;
    let e = b + guitarChordViewPan;
    if (e > cap) {
      s = Math.max(0, s - (e - cap));
      e = cap;
    }
    if (s < 0) {
      e = Math.min(cap, e - s);
      s = 0;
    }
    const r = clampGuitarChordViewRange(s, e, cap);
    if (guitarPosition < 0) return r;
    return clampFretWindowToSpan(r.startFret, r.endFret, FRETBOARD_MAX_POSITION_FRETS, cap);
  }, [
    fretboardInstrument,
    fretboardMode,
    guitarPosition,
    fretRange.startFret,
    fretRange.endFret,
    guitarChordViewPan,
    guitarChordNeckCap,
  ]);

  const bassFretDotLabel = useCallback(
    (p: { chroma: number; stringIndex: number; fret: number; kind: 'highlight' | 'ghost' }) => {
      const rootCh = Note.chroma(displayRoot);
      if (rootCh == null) return undefined;
      const shouldLabel =
        p.chroma === rootCh ||
        (showBassAllNoteNames && (p.kind === 'highlight' || p.kind === 'ghost'));
      if (!shouldLabel) return undefined;
      const open = BASS_OPEN_MIDIS[p.stringIndex];
      if (open == null) return undefined;
      const name = Note.fromMidi(open + p.fret);
      if (!name) return undefined;
      return toPitchClass(name);
    },
    [displayRoot, showBassAllNoteNames],
  );

  const handleGuitarFretPeek = useCallback(
    (fret: number) => {
      setGuitarPeekEndExtend((prev) => {
        const next = Math.max(prev ?? 0, fret + 1);
        return fretboardMode === 'chord' ? Math.min(next, guitarChordNeckCap) : next;
      });
    },
    [fretboardMode, guitarChordNeckCap],
  );

  const playableVoicings = useMemo(() => {
    if (fretboardMode !== 'chord' || guitarPosition < 0 || !displayRoot) return [];
    const rootCh = Note.chroma(displayRoot);
    if (rootCh == null) return [];
    const hlSet = new Set(
      displayNotes.map(n => Note.chroma(n)).filter((c): c is number => c != null),
    );
    const preferredShape = (guitarPosition >= 0 && dbShapes[guitarPosition]) ? dbShapes[guitarPosition] : null;

    const fr = guitarChordFretWindow ?? { startFret: fretRange.startFret, endFret: fretRange.endFret };
    return generatePlayableVoicings(fr.startFret, fr.endFret, hlSet, rootCh, dbShapes, preferredShape);
  }, [fretboardMode, guitarPosition, displayRoot, displayNotes, fretRange, dbShapes, guitarChordFretWindow]);

  const guitarChordTab = useMemo(() => {
    if (playableVoicings.length === 0 || !displayRoot) return null;
    const idx = guitarVoicingVariant % playableVoicings.length;
    const rootCh = Note.chroma(displayRoot);
    const raw = playableVoicings[idx];
    // Library chord editor: don't strip notes below root — that diverges from saved/db shapes and
    // the sync effect would overwrite the board right after Save Default.
    const inChordShapeEdit =
      fretboardMode === 'chord' &&
      selectedChord &&
      guitarPosition >= 0 &&
      (showLibrary || guitarChordToolsUnlocked);
    const filtered =
      !inChordShapeEdit && rootCh != null ? filterTabNotesAtOrAboveRoot(raw, rootCh) : raw;
    return filtered.slice().reverse();
  }, [
    playableVoicings,
    guitarVoicingVariant,
    displayRoot,
    showLibrary,
    guitarChordToolsUnlocked,
    fretboardMode,
    selectedChord,
    guitarPosition,
  ]);

  const handleToggleGuitarFret = useCallback((si: number, fret: number | null) => {
    setTappedGuitarTab(prev => {
      let next = prev ? [...prev] : (guitarChordTab ? [...guitarChordTab] : [null, null, null, null, null, null]);
      if (next[si] === fret) next[si] = null;
      else next[si] = fret;

      if (tappedMidis.size > 0) setTappedMidis(new Set());

      return next;
    });
  }, [guitarChordTab, tappedMidis]);

  useEffect(() => {
    setTappedMidis(new Set());
    setTappedGuitarTab(null);
    setPianoOmittedMidis(new Set());
    setPianoOmittedChromas(new Set());
    setStaffOmittedMidis(new Set());
    setStaffOmittedChromas(new Set());
  }, [selectedChord?.symbol, selectedScale?.name, voicingType, guitarPosition, guitarVoicingVariant]);

  const chromaColorMap = useMemo(() => {
    if (activeDegrees.size === 0 || !displayRoot) return null;
    return buildDegreeColorMap(displayRoot, activeDegrees);
  }, [activeDegrees, displayRoot]);

  const guitarMaxVariants = Math.max(playableVoicings.length, 1);

  const isFretboardEditable =
    fretboardMode === 'chord' &&
    selectedChord &&
    guitarPosition >= 0 &&
    (showLibrary || guitarChordToolsUnlocked);
  const displayChordTab = isFretboardEditable && editableGuitarTab != null
    ? editableGuitarTab
    : guitarChordTab;
  /** Library edits must update editableGuitarTab (not tappedGuitarTab), or Save reads stale frets. */
  const guitarChordTabForFretboard =
    fretboardInstrument === 'bass'
      ? null
      : isFretboardEditable
        ? editableGuitarTab ?? guitarChordTab
        : tappedGuitarTab || displayChordTab;

  /** Final visible frets; widened to include all tab frets and enough span (not stuck at 5) when needed. */
  const clippedFretboardRange = useMemo(() => {
    if (fretboardInstrument === 'guitar') {
      const isAll = guitarPosition < 0;
      let s =
        fretboardMode === 'chord' && guitarChordFretWindow != null
          ? guitarChordFretWindow.startFret
          : fretRange.startFret;
      let e =
        fretboardMode === 'chord' && guitarChordFretWindow != null
          ? guitarChordFretWindow.endFret
          : fretRange.endFret;
      if (guitarPeekEndExtend != null) e = Math.max(e, guitarPeekEndExtend);
      if (fretboardMode === 'chord') e = Math.min(e, guitarChordNeckCap);
      const cap = fretboardMode === 'chord' ? guitarChordNeckCap : GUITAR_CHORD_MAX_FRET;
      const tabForStretch = fretboardMode === 'chord' ? guitarChordTabForFretboard : null;
      const merged = mergeGuitarTabIntoFretWindow(tabForStretch, s, e, cap);
      s = merged.startFret;
      e = merged.endFret;
      if (isAll) return { startFret: s, endFret: e };
      const spanNeeded = e - s + 1;
      const maxSpan = Math.max(FRETBOARD_MAX_POSITION_FRETS, spanNeeded);
      return clampFretWindowToSpan(s, e, maxSpan, cap);
    }
    if (fretboardInstrument === 'bass') {
      if (bassPosition < 0) return { startFret: fretRange.startFret, endFret: fretRange.endFret };
      return clampFretWindowToSpan(
        fretRange.startFret,
        fretRange.endFret,
        FRETBOARD_MAX_POSITION_FRETS,
        BASS_ALL_FRET_RANGE.endFret,
      );
    }
    return { startFret: fretRange.startFret, endFret: fretRange.endFret };
  }, [
    fretboardInstrument,
    guitarPosition,
    bassPosition,
    fretboardMode,
    guitarChordFretWindow,
    fretRange.startFret,
    fretRange.endFret,
    guitarPeekEndExtend,
    guitarChordNeckCap,
    guitarChordTabForFretboard,
  ]);

  const pianoNotes = useMemo(() => {
    if (mirrorGuitarToPiano && fretboardInstrument === 'guitar') {
      const tab = guitarChordTabForFretboard ?? displayChordTab;
      if (tab && tab.length === 6) {
        const midiNotes = tabToMidiNotes(tab, true);
        const onKeyboard = mapNotesToCompactPianoRollKeyboard(midiNotes);
        const all =
          displayRoot != null
            ? spellChordNotesLikePianoRoll(onKeyboard, displayRoot)
            : onKeyboard;
        return { all, lh: [] as string[], rh: [] as string[] };
      }
    }
    if (selectedScale)
      return { all: selectedScale.notes, lh: [] as string[], rh: [] as string[] };
    if (voicing)
      return { all: [] as string[], lh: voicing.leftHand, rh: voicing.rightHand };
    if (selectedChord) {
      const slash = splitSlashChordForPiano(
        selectedChord.symbol,
        selectedChord.root,
        selectedChord.notes,
      );
      if (slash)
        return { all: [] as string[], lh: slash.leftHand, rh: slash.rightHand };
      return { all: selectedChord.notes, lh: [] as string[], rh: [] as string[] };
    }
    return { all: [] as string[], lh: [] as string[], rh: [] as string[] };
  }, [
    selectedScale,
    selectedChord,
    voicing,
    mirrorGuitarToPiano,
    fretboardInstrument,
    guitarChordTabForFretboard,
    displayChordTab,
    displayRoot,
  ]);

  const pianoDefaultLitMidis = useMemo(() => {
    const { all, lh, rh } = pianoNotes;
    const s = new Set<number>();
    if (lh.length > 0 || rh.length > 0) {
      for (const n of lh) {
        const m = Note.midi(n);
        if (m != null) s.add(m);
      }
      for (const n of rh) {
        const m = Note.midi(n);
        if (m != null) s.add(m);
      }
      return s;
    }
    const chordAll = all.length > 0 && all.length <= 6 && !!displayRoot;
    if (chordAll && displayRoot) {
      const built = buildChordMidis(all, displayRoot);
      if (built) for (const m of built.midis) s.add(m);
    }
    return s;
  }, [pianoNotes, displayRoot]);

  const pianoLitChromas = useMemo(() => {
    const { all, lh, rh } = pianoNotes;
    const voicing = lh.length > 0 || rh.length > 0;
    const chordAll = !voicing && all.length > 0 && all.length <= 6 && !!displayRoot;
    if (voicing || chordAll || selectedScale) return new Set<number>();
    const s = new Set<number>();
    for (const n of all) {
      const c = Note.chroma(n);
      if (c != null) s.add(c);
    }
    return s;
  }, [pianoNotes, displayRoot, selectedScale]);

  /** Taps ∪ chord/voicing keys still lit on the piano (respects click-to-dim omissions). */
  const effectiveHarmonyPianoMidis = useMemo(() => {
    const midis = new Set<number>();
    for (const m of tappedMidis) midis.add(m);

    if (selectedScale) {
      return midis;
    }

    const { all, lh, rh } = pianoNotes;
    const voicing = lh.length > 0 || rh.length > 0;
    const chordAll = !voicing && all.length > 0 && all.length <= 6 && !!displayRoot;

    if (voicing || chordAll) {
      for (const m of pianoDefaultLitMidis) {
        if (!pianoOmittedMidis.has(m)) midis.add(m);
      }
      return midis;
    }

    if (pianoLitChromas.size === 0) {
      return midis;
    }

    for (const m of COMPACT_PIANO_ROLL_MIDIS) {
      const ch = m % 12;
      if (!pianoLitChromas.has(ch)) continue;
      if (pianoOmittedChromas.has(ch)) continue;
      midis.add(m);
    }
    return midis;
  }, [
    tappedMidis,
    selectedScale,
    pianoNotes,
    pianoDefaultLitMidis,
    pianoOmittedMidis,
    pianoLitChromas,
    pianoOmittedChromas,
  ]);

  const effectiveHarmonyPianoNotes = useMemo(
    () => uniquePitchClassNoteStrings(effectiveHarmonyPianoMidis),
    [effectiveHarmonyPianoMidis],
  );

  const interactiveAnalysis = useMemo(() => {
    let notes: string[] = [];
    if (mirrorGuitarToPiano) {
      const tab =
        fretboardInstrument === 'guitar' && guitarChordTabForFretboard?.length === 6
          ? guitarChordTabForFretboard
          : tappedGuitarTab;
      const gNotes = tab ? tabToMidiNotes(tab, true) : [];
      notes = mergeNoteStringsUniqueByChroma(effectiveHarmonyPianoNotes, gNotes);
    } else if (tappedGuitarTab) {
      const g = tabToMidiNotes(tappedGuitarTab, true);
      notes = uniquePitchClassNoteStrings(
        g.map(n => Note.midi(n)).filter((m): m is number => m != null),
      );
    } else {
      notes = effectiveHarmonyPianoNotes;
    }

    if (notes.length === 0) return { library: [], theory: [] };
    const libMatches = detectLibraryChords(notes);
    const theoryMatches = Chord.detect(notes).filter((c: string) => !libMatches.includes(c));
    return { library: libMatches, theory: theoryMatches };
  }, [
    mirrorGuitarToPiano,
    tappedGuitarTab,
    effectiveHarmonyPianoNotes,
    fretboardInstrument,
    guitarChordTabForFretboard,
  ]);

  /** Piano/fret tap IDs — same row as the written chord, between instruments and chart (not in the chart). */
  const chartTapHarmonyLine = useMemo(() => {
    if (!activeSong || selectedScale) return null;
    if (
      tappedMidis.size === 0 &&
      !tappedGuitarTab &&
      staffScratch.length === 0 &&
      !(mirrorGuitarToPiano && effectiveHarmonyPianoNotes.length > 0)
    )
      return null;

    let tapNotes: string[] = [];
    if (mirrorGuitarToPiano) {
      const tab =
        fretboardInstrument === 'guitar' && guitarChordTabForFretboard?.length === 6
          ? guitarChordTabForFretboard
          : tappedGuitarTab;
      const gNotes = tab ? tabToMidiNotes(tab, true) : [];
      tapNotes = mergeNoteStringsUniqueByChroma(effectiveHarmonyPianoNotes, gNotes);
    } else if (tappedGuitarTab) {
      tapNotes = tabToMidiNotes(tappedGuitarTab, true);
    } else {
      tapNotes = effectiveHarmonyPianoNotes;
    }

    const activeNotes = mergeHarmonyNoteStrings(tapNotes, staffScratch);
    if (activeNotes.length === 0) return null;

    const analysis = interactiveAnalysis;
    const names = [...analysis.library, ...analysis.theory];

    const clear = (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setTappedMidis(new Set());
      setTappedGuitarTab(null);
      setStaffScratch([]);
      setStaffOmittedMidis(new Set());
      setStaffOmittedChromas(new Set());
      setPianoOmittedMidis(new Set());
      setPianoOmittedChromas(new Set());
      setSelectedStaffScratchId(null);
    };

    return (
      <>
        <span className="chord-tap-harmony-symbols">
          {names.length > 0 ? (
            names.map((c, i) => (
              <span key={`${c}-${i}`}>
                {i > 0 ? <span className="chord-tap-harmony-sep"> · </span> : null}
                <span className={i < analysis.library.length ? 'chord-tap-lib' : 'chord-tap-theory'}>{c}</span>
              </span>
            ))
          ) : activeNotes.length < 3 ? (
            '…'
          ) : (
            <span className="chord-tap-pcs">{activeNotes.map(n => Note.get(n).pc).join(' ')}</span>
          )}
        </span>
        <button type="button" className="chord-tap-harmony-clear" onClick={clear} title="Clear tapped notes">
          ×
        </button>
      </>
    );
  }, [
    activeSong,
    selectedScale,
    tappedMidis,
    tappedGuitarTab,
    mirrorGuitarToPiano,
    interactiveAnalysis,
    staffScratch,
    effectiveHarmonyPianoNotes,
    fretboardInstrument,
    guitarChordTabForFretboard,
  ]);

  /** Same pitches as the piano panel: lh/rh voicings, slash splits, and chord-all / mirror spelling via buildChordMidis. */
  const staffNotes = useMemo(() => {
    if (selectedScale)
      return assignOctaves(selectedScale.notes, showStaffBassClef ? 3 : 4);
    const { all, lh, rh } = pianoNotes;
    if (lh.length > 0 || rh.length > 0) {
      const combined = [...lh, ...rh];
      combined.sort((a, b) => (Note.midi(a) || 0) - (Note.midi(b) || 0));
      return combined;
    }
    if (all.length === 0) return [];
    const root = displayRoot;
    const isChordAll = all.length > 0 && all.length <= 6 && !!root;
    if (isChordAll && root) return spellChordNotesLikePianoRoll(all, root);
    return assignOctaves(all.map(n => n.replace(/\d+$/, '')));
  }, [selectedScale, pianoNotes, displayRoot, showStaffBassClef]);

  const baseForStaff = useMemo(
    () =>
      staffNotes.filter(n => {
        const m = Note.midi(n);
        const ch = Note.chroma(n);
        if (m != null && staffOmittedMidis.has(m)) return false;
        if (ch != null && staffOmittedChromas.has(ch)) return false;
        return true;
      }),
    [staffNotes, staffOmittedMidis, staffOmittedChromas],
  );

  const mergedStaffDisplay = useMemo(
    () => mergeStaffWithScratch(baseForStaff, staffScratch),
    [baseForStaff, staffScratch],
  );

  /** Staff scratch + merged staff spelling for each lit MIDI (piano key labels, ##/bb). */
  const pianoPitchClassByMidi = useMemo(() => {
    const map = new Map<number, string>();
    const mergedNotes = mergedStaffDisplay.notes;
    const { all, lh, rh } = pianoNotes;
    const voicingNotes = [...lh, ...rh, ...all];
    for (const midi of effectiveHarmonyPianoMidis) {
      let label: string | undefined;
      const sc = staffScratch.find(s => Note.midi(s.note) === midi);
      if (sc) label = sc.note.replace(/\d+$/, '');
      if (!label) {
        const sn = mergedNotes.find(n => Note.midi(n) === midi);
        if (sn) label = sn.replace(/\d+$/, '');
      }
      if (!label) {
        const vn = voicingNotes.find(n => Note.midi(n) === midi);
        if (vn) label = vn.replace(/\d+$/, '');
      }
      if (!label) label = Note.pitchClass(Note.fromMidi(midi) ?? '') || '';
      map.set(midi, label);
    }
    return map;
  }, [
    effectiveHarmonyPianoMidis,
    mergedStaffDisplay.notes,
    staffScratch,
    pianoNotes,
  ]);

  const mergedStaffNoteColors = useMemo(() => {
    if (!chromaColorMap || mergedStaffDisplay.notes.length === 0) return undefined;
    return mergedStaffDisplay.notes.map(n => {
      const ch = Note.chroma(n);
      return ch != null ? chromaColorMap.get(ch) : undefined;
    });
  }, [mergedStaffDisplay.notes, chromaColorMap]);

  const selectedStaffScratchNote = useMemo(
    () => staffScratch.find(s => s.id === selectedStaffScratchId)?.note ?? null,
    [staffScratch, selectedStaffScratchId],
  );

  useEffect(() => {
    if (selectedStaffScratchId != null) {
      setStaffHoverMidi(null);
      setStaffHoverPitchClass(null);
    }
  }, [selectedStaffScratchId]);

  useEffect(() => {
    setStaffScratch([]);
    setStaffOmittedMidis(new Set());
    setStaffOmittedChromas(new Set());
    setSelectedStaffScratchId(null);
    setStaffHoverMidi(null);
    setStaffHoverPitchClass(null);
  }, [selectedChord?.symbol, selectedScale?.name, selectedSongIndex]);

  const handleStaffScratchRemove = useCallback((id: string) => {
    let omitMidi: number | undefined;
    let tapMidi: number | undefined;
    setStaffScratch(prev => {
      const entry = prev.find(s => s.id === id);
      omitMidi = entry?.replacesChartMidi;
      const mm = entry ? Note.midi(entry.note) : null;
      if (mm != null) tapMidi = mm;
      return prev.filter(s => s.id !== id);
    });
    if (tapMidi != null) {
      setTappedMidis(tm => {
        const next = new Set(tm);
        next.delete(tapMidi!);
        return next;
      });
    }
    if (omitMidi != null) {
      setStaffOmittedMidis(om => {
        const next = new Set(om);
        next.add(omitMidi!);
        return next;
      });
      setPianoOmittedMidis(om => {
        const next = new Set(om);
        next.add(omitMidi!);
        return next;
      });
    }
    setSelectedStaffScratchId(cur => (cur === id ? null : cur));
  }, []);

  const bumpStaffScratchAccidental = useCallback(
    (id: string, dir: 'sharp' | 'flat' | 'natural') => {
      let oldMidi: number | undefined;
      let newMidi: number | undefined;
      setStaffScratch(prev => {
        const s = prev.find(x => x.id === id);
        if (!s) return prev;
        const newNote = scratchApplyAccidental(s.note, dir);
        const o = Note.midi(s.note);
        const n = Note.midi(newNote);
        if (o != null && n != null && o !== n) {
          oldMidi = o;
          newMidi = n;
        }
        return prev.map(x => (x.id !== id ? x : { ...x, note: newNote }));
      });
      if (oldMidi != null && newMidi != null) {
        setTappedMidis(tm => {
          const next = new Set(tm);
          next.delete(oldMidi!);
          next.add(newMidi!);
          return next;
        });
      }
    },
    [],
  );

  const handleStaffScratchSharp = useCallback(
    (id: string) => bumpStaffScratchAccidental(id, 'sharp'),
    [bumpStaffScratchAccidental],
  );
  const handleStaffScratchFlat = useCallback(
    (id: string) => bumpStaffScratchAccidental(id, 'flat'),
    [bumpStaffScratchAccidental],
  );
  const handleStaffScratchNatural = useCallback(
    (id: string) => bumpStaffScratchAccidental(id, 'natural'),
    [bumpStaffScratchAccidental],
  );

  const handleMirrorGuitarPianoPick = useCallback(
    (pick: GuitarMirrorPick) => {
      const { stringIndex: d, fret } = pick;
      if (d < 0 || d > 5) return;
      const base = guitarChordTabForFretboard;
      const tab: GuitarTab =
        base && base.length === 6 ? [...base] : [null, null, null, null, null, null];
      if (tab[d] === fret) tab[d] = null;
      else tab[d] = fret;
      if (isFretboardEditable) setEditableGuitarTab(tab);
      else setTappedGuitarTab(tab);
    },
    [guitarChordTabForFretboard, isFretboardEditable],
  );

  const handleTogglePianoNote = useCallback(
    (midi: number, mirrorPick?: GuitarMirrorPick) => {
      const guitarMirrorSlots =
        mirrorGuitarToPiano &&
        voicingType === 'guitar' &&
        fretboardInstrument === 'guitar' &&
        !selectedScale &&
        fretboardMode === 'chord';

      if (guitarMirrorSlots && mirrorPick) {
        handleMirrorGuitarPianoPick(mirrorPick);
        return;
      }

      const ch = midi % 12;
      const voicing = pianoNotes.lh.length > 0 || pianoNotes.rh.length > 0;
      const chordAll =
        !voicing && pianoNotes.all.length > 0 && pianoNotes.all.length <= 6 && !!displayRoot;

      if (tappedMidis.has(midi)) {
        setTappedMidis(prev => {
          const next = new Set(prev);
          next.delete(midi);
          return next;
        });
        setStaffScratch(prev => prev.filter(s => Note.midi(s.note) !== midi));
        if (!mirrorGuitarToPiano && tappedGuitarTab) setTappedGuitarTab(null);
        return;
      }
      if (pianoOmittedMidis.has(midi)) {
        setPianoOmittedMidis(prev => {
          const next = new Set(prev);
          next.delete(midi);
          return next;
        });
        setStaffOmittedMidis(prev => {
          const next = new Set(prev);
          next.delete(midi);
          return next;
        });
        return;
      }
      if (pianoOmittedChromas.has(ch)) {
        setPianoOmittedChromas(prev => {
          const next = new Set(prev);
          next.delete(ch);
          return next;
        });
        setStaffOmittedChromas(prev => {
          const next = new Set(prev);
          next.delete(ch);
          return next;
        });
        return;
      }
      if (voicing || chordAll) {
        if (pianoDefaultLitMidis.has(midi)) {
          setPianoOmittedMidis(prev => {
            const next = new Set(prev);
            next.add(midi);
            return next;
          });
          setStaffOmittedMidis(prev => {
            const next = new Set(prev);
            next.add(midi);
            return next;
          });
          return;
        }
      } else if (!selectedScale && pianoLitChromas.has(ch)) {
        setPianoOmittedChromas(prev => {
          const next = new Set(prev);
          next.add(ch);
          return next;
        });
        setStaffOmittedChromas(prev => {
          const next = new Set(prev);
          next.add(ch);
          return next;
        });
        return;
      }

      if (tappedMidis.size < 12) {
        setTappedMidis(prev => {
          const next = new Set(prev);
          next.add(midi);
          return next;
        });
        if (!mirrorGuitarToPiano && tappedGuitarTab) setTappedGuitarTab(null);

        if (activeSong) {
          let newScratchId: string | null = null;
          setStaffScratch(prevScratch => {
            const merged = mergeStaffWithScratch(baseForStaff, prevScratch);
            if (merged.notes.some(n => Note.midi(n) === midi)) return prevScratch;
            const name = Note.fromMidi(midi);
            if (!name) return prevScratch;
            newScratchId = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const note = normalizeStaffScratchSpelling(name);
            return [...prevScratch, { id: newScratchId!, note, replacesChartMidi: midi }];
          });
          if (newScratchId) setSelectedStaffScratchId(newScratchId);
        }
      }
    },
    [
      tappedMidis,
      pianoOmittedMidis,
      pianoOmittedChromas,
      pianoNotes,
      displayRoot,
      pianoDefaultLitMidis,
      pianoLitChromas,
      mirrorGuitarToPiano,
      tappedGuitarTab,
      selectedScale,
      activeSong,
      baseForStaff,
      voicingType,
      fretboardMode,
      fretboardInstrument,
      handleMirrorGuitarPianoPick,
    ],
  );

  const guitarDrawPianoMirror =
    mirrorGuitarToPiano &&
    voicingType === 'guitar' &&
    fretboardInstrument === 'guitar' &&
    !selectedScale &&
    fretboardMode === 'chord';

  const handleStaffPitchClick = useCallback(
    (rawStaffPitch: string, mirrorHint?: { x: number; width: number }) => {
      if (!activeSong) return;
      const spelled = spellPitchOnStaffInKey(rawStaffPitch, activeSong.key);

      if (
        guitarDrawPianoMirror &&
        mirrorHint &&
        guitarChordTabForFretboard?.length === 6
      ) {
        const aligned = spellLikeChordChart(spelled, baseForStaff);
        const clickMidi = Note.midi(aligned) ?? Note.midi(spelled);
        if (clickMidi != null) {
          const mergedEarly = mergeStaffWithScratch(baseForStaff, staffScratch);
          let idxEarly = mergedEarly.notes.findIndex(n => Note.midi(n) === clickMidi);
          if (idxEarly < 0) {
            const ch = ((clickMidi % 12) + 12) % 12;
            const byChroma = mergedEarly.notes
              .map((n, i) => ({ i, m: Note.midi(n) }))
              .filter(
                (x): x is { i: number; m: number } =>
                  x.m != null && ((x.m % 12) + 12) % 12 === ch,
              );
            byChroma.sort((a, b) => Math.abs(a.m - clickMidi) - Math.abs(b.m - clickMidi));
            if (byChroma.length > 0) idxEarly = byChroma[0]!.i;
          }
          if (idxEarly >= 0) {
            const sidEarly = mergedEarly.scratchIdPerIndex[idxEarly];
            if (sidEarly) {
              setSelectedStaffScratchId(sidEarly);
              setTappedMidis(prev => new Set(prev).add(clickMidi));
              return;
            }
          }
          const pick = resolveGuitarMirrorPick({
            centerX: mirrorHint.x,
            totalWidth: Math.max(1, mirrorHint.width),
            clickedMidi: clickMidi,
            chordTab: guitarChordTabForFretboard,
            fretWindow: clippedFretboardRange,
          });
          if (pick) {
            if (idxEarly >= 0) {
              handleTogglePianoNote(clickMidi, pick);
              const displayNote = normalizeStaffScratchSpelling(mergedEarly.notes[idxEarly]!);
              const slotMidi = Note.midi(displayNote);
              const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              setStaffScratch(prev => [
                ...prev,
                { id, note: displayNote, replacesChartMidi: slotMidi ?? undefined },
              ]);
              setSelectedStaffScratchId(id);
              setTappedMidis(prev => new Set(prev).add(Note.midi(displayNote) ?? clickMidi));
            } else {
              setSelectedStaffScratchId(null);
              handleTogglePianoNote(clickMidi, pick);
            }
            return;
          }
        }
      }

      const m = Note.midi(spelled);
      if (m == null) return;

      if (selectedStaffScratchId) {
        const cur = staffScratch.find(s => s.id === selectedStaffScratchId)?.note;
        const curM = cur != null ? Note.midi(cur) : null;
        if (curM === m) {
          setSelectedStaffScratchId(null);
          return;
        }
      }

      const merged = mergeStaffWithScratch(baseForStaff, staffScratch);
      const idx = merged.notes.findIndex(n => Note.midi(n) === m);
      if (idx >= 0) {
        const sid = merged.scratchIdPerIndex[idx];
        if (sid) {
          setSelectedStaffScratchId(sid);
          setTappedMidis(prev => new Set(prev).add(m));
          return;
        }
        const displayNote = normalizeStaffScratchSpelling(merged.notes[idx]!);
        const slotMidi = Note.midi(displayNote);
        const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setStaffScratch(prev => [
          ...prev,
          { id, note: displayNote, replacesChartMidi: slotMidi ?? undefined },
        ]);
        setSelectedStaffScratchId(id);
        setTappedMidis(prev => new Set(prev).add(Note.midi(displayNote) ?? m));
        return;
      }

      const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const note = normalizeStaffScratchSpelling(spellLikeChordChart(spelled, baseForStaff));
      const noteMidi = Note.midi(note) ?? m;
      setStaffScratch(prev => [...prev, { id, note, replacesChartMidi: noteMidi }]);
      setSelectedStaffScratchId(id);
      setTappedMidis(prev => new Set(prev).add(noteMidi));
    },
    [
      activeSong,
      baseForStaff,
      staffScratch,
      selectedStaffScratchId,
      guitarDrawPianoMirror,
      guitarChordTabForFretboard,
      clippedFretboardRange,
      handleTogglePianoNote,
    ],
  );

  const handleStaffHoverPitch = useCallback(
    (raw: string | null, mirrorHint?: { x: number; width: number } | null) => {
      if (raw == null || !activeSong) {
        setStaffHoverMidi(null);
        setStaffHoverPitchClass(null);
        return;
      }
      const spelled = spellPitchOnStaffInKey(raw, activeSong.key);
      const aligned = spellLikeChordChart(spelled, baseForStaff);
      const m = Note.midi(aligned);

      if (
        guitarDrawPianoMirror &&
        mirrorHint &&
        m != null &&
        guitarChordTabForFretboard?.length === 6
      ) {
        const pick = resolveGuitarMirrorPick({
          centerX: mirrorHint.x,
          totalWidth: Math.max(1, mirrorHint.width),
          clickedMidi: m,
          chordTab: guitarChordTabForFretboard,
          fretWindow: clippedFretboardRange,
        });
        if (pick != null) {
          const sound = midiForDisplayStringFret(pick.stringIndex, pick.fret);
          if (sound != null) {
            setStaffHoverMidi(snapMidiToCompactPianoRoll(sound));
            setStaffHoverPitchClass(aligned.replace(/\d+$/, ''));
            return;
          }
        }
      }

      setStaffHoverMidi(m ?? null);
      setStaffHoverPitchClass(m != null ? aligned.replace(/\d+$/, '') : null);
    },
    [
      activeSong,
      baseForStaff,
      guitarDrawPianoMirror,
      guitarChordTabForFretboard,
      clippedFretboardRange,
    ],
  );

  const mirrorGuitarPianoActiveMidis = useMemo(() => {
    if (
      !mirrorGuitarToPiano ||
      voicingType !== 'guitar' ||
      fretboardInstrument !== 'guitar' ||
      !guitarChordTabForFretboard ||
      guitarChordTabForFretboard.length !== 6
    )
      return null;
    const s = new Set<number>();
    for (const n of tabToMidiNotes(guitarChordTabForFretboard, true)) {
      const m = Note.midi(n);
      if (m != null) s.add(snapMidiToCompactPianoRoll(m));
    }
    return s;
  }, [mirrorGuitarToPiano, voicingType, fretboardInstrument, guitarChordTabForFretboard]);

  const guitarSlashBassCaption = useMemo(
    () =>
      selectedChord ? slashBassDisplayLabel(selectedChord.symbol, selectedChord.bass) : null,
    [selectedChord],
  );

  const guitarChordTabRef = useRef(guitarChordTab);
  guitarChordTabRef.current = guitarChordTab;
  useEffect(() => {
    if (!isFretboardEditable || !selectedChord) {
      setEditableGuitarTab(null);
      prevLibraryFretKeyRef.current = '';
      return;
    }
    const editCtx = showLibrary ? 'lib' : 'tools';
    const key = `${selectedChord.symbol}|${guitarPosition}|${voicingSourceSig}|${editCtx}`;
    if (prevLibraryFretKeyRef.current === key) {
      return;
    }
    prevLibraryFretKeyRef.current = key;
    // Use the DB shape for this position, not guitarChordTab (that follows guitarVoicingVariant and can
    // show a different voicing — after Save, the effect was overwriting the saved shape).
    const fromDb = dbShapes[guitarPosition];
    const source =
      fromDb != null && fromDb.length === 6
        ? [...fromDb].reverse()
        : guitarChordTabRef.current;
    setEditableGuitarTab(source ? [...source] : [null, null, null, null, null, null]);
  }, [
    isFretboardEditable,
    showLibrary,
    selectedChord?.symbol,
    guitarPosition,
    voicingSourceSig,
    dbShapes,
  ]);

  useEffect(() => {
    if (prevShowLibraryForChartNavRef.current && !showLibrary) {
      lastChartChordNavKeyRef.current = '';
    }
    prevShowLibraryForChartNavRef.current = showLibrary;
  }, [showLibrary]);

  useEffect(() => {
    if (showLibrary || !activeSong || selectedMeasure === null) return;
    const chord = activeSong.measures[selectedMeasure]?.chords[selectedChordIdx];
    if (!chord) return;
    const key = `${selectedSongIndex}-${selectedMeasure}-${selectedChordIdx}-${chord.symbol}`;
    if (lastChartChordNavKeyRef.current === key) return;
    lastChartChordNavKeyRef.current = key;
    const { tabs } = lookupChordShapes(chord.symbol, customChordsOverride);
    const sym = canonicalChordSymbol(chord.symbol);
    const stored = chartGuitarDefaultPos[sym];
    const pos =
      stored !== undefined && Number.isFinite(stored) && stored >= 0 && stored <= 4
        ? Math.floor(stored)
        : findFirstBarreIndex(tabs);
    setGuitarPosition(pos);
    setGuitarVoicingVariant(0);
  }, [
    showLibrary,
    activeSong,
    selectedSongIndex,
    selectedMeasure,
    selectedChordIdx,
    chartGuitarDefaultPos,
    customChordsOverride,
  ]);

  useEffect(() => {
    setGuitarChordViewPan(0);
  }, [guitarPosition, selectedChord?.symbol, fretboardMode, fretRange.startFret, fretRange.endFret]);

  const handleGuitarModeButtonClick = useCallback(() => {
    if (fretboardInstrument !== 'guitar') {
      setFretboardInstrument('guitar');
    }
    guitarToolsRevealClicksRef.current += 1;
    if (guitarToolsRevealClicksRef.current >= GUITAR_CHORD_TOOLS_REVEAL_CLICKS) {
      guitarToolsRevealClicksRef.current = 0;
      setGuitarChordToolsUnlocked(true);
    }
  }, [fretboardInstrument]);

  const handleGuitarChordViewShift = useCallback((delta: number) => {
    setGuitarChordViewPan((p) => p + delta);
  }, []);

  const handleFretClick = useCallback((stringIndex: number, fret: number | null) => {
    setEditableGuitarTab(prev => {
      const next = [...(prev ?? [null, null, null, null, null, null])];
      if (stringIndex >= 0 && stringIndex < 6) next[stringIndex] = fret;
      return next;
    });
  }, []);

  const handleImport = useCallback((data: string) => {
    try {
      setImportError('');
      const result = parseIRealData(data);
      if (result.songs.length === 0) {
        setImportError('No songs found in the imported data');
        return;
      }
      setSongs(result.songs);
      setSelectedSongIndex(0);
      setSelectedMeasure(0);
      setSelectedChordIdx(0);
      setGuitarPosition(0);
      setSelectedScale(null);
      setBpmOverride(null);
      setRepeatFrom(null);
      setRepeatTo(null);
      setRepeatPicker(null);
      setShowImport(false);
    } catch (e) {
      console.error('Import error:', e);
      setImportError("Failed to parse. Make sure it's a valid iReal Pro file or URL.");
    }
  }, []);

  const handleMeasureSelect = useCallback((index: number, chordIndex?: number) => {
    const ci = chordIndex ?? 0;
    if (repeatPicker === 'from') {
      setRepeatFrom({ measureIdx: index, chordIdx: ci });
      setRepeatPicker(null);
      return;
    }
    if (repeatPicker === 'to') {
      setRepeatTo({ measureIdx: index, chordIdx: ci });
      setRepeatPicker(null);
      return;
    }
    setSelectedMeasure(index);
    setSelectedChordIdx(ci);
    setSelectedScale(null);

    // Sync with Library and select voicing
    const measure = activeSong?.measures?.[index];
    const chord = measure?.chords?.[ci];
    if (chord) {
      setLibraryRoot(chord.root);
      const rawSuffix = chord.symbol.slice(chord.root.length);
      const normalizedSuffix = CANONICAL_SUFFIX_MAP[rawSuffix] ?? rawSuffix;
      setLibrarySuffix(normalizedSuffix);
      setLibraryChord(chord);
    }

    setGuitarVoicingVariant(0);
  }, [repeatPicker, activeSong]);

  const handleScaleSelect = useCallback((scale: ScaleSuggestion) => {
    setSelectedScale(prev => {
      if (prev?.name === scale.name) {
        setScalesOnPlay(false);
        return null;
      }
      skipPanelScaleSyncRef.current = true;
      setScalesOnPlay(true);
      return scale;
    });
  }, []);

  const handleSongSelect = useCallback((index: number) => {
    setSelectedSongIndex(index);
    setSelectedMeasure(0);
    setSelectedChordIdx(0);
    setSelectedScale(null);
    setGuitarPosition(0);
    setGuitarVoicingVariant(0);
    setTransposeSemitones(0);
    setBpmOverride(null);
    setRepeatFrom(null);
    setRepeatTo(null);
    setRepeatPicker(null);
  }, []);

  const handleKeyChange = useCallback((newKey: string) => {
    if (!currentSong) return;
    const origRoot = currentSong.key.replace(/[-m].*$/, '');
    const origCh = Note.chroma(origRoot);
    const newCh = Note.chroma(newKey);
    if (origCh == null || newCh == null) return;
    setTransposeSemitones((newCh - origCh + 12) % 12);
    setSelectedScale(null);
    setGuitarVoicingVariant(0);
  }, [currentSong]);

  const handleToggleDegree = useCallback((d: number) => {
    setActiveDegrees(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }, []);

  const handleToggleAllDegrees = useCallback(() => {
    setActiveDegrees(prev =>
      prev.size > 0 ? new Set() : new Set([1, 2, 3, 4, 5, 6, 7]),
    );
  }, []);

  const toggleExpand = useCallback((id: InstrumentId) => {
    setExpandedInstrument(prev => {
      const next = prev === id ? null : id;
      if (next == null) {
        setCollapsedInstruments(new Set());
      } else {
        const collapsed = new Set<InstrumentId>(['staff', 'piano', 'guitar']);
        collapsed.delete(next);
        setCollapsedInstruments(collapsed);
      }
      return next;
    });
  }, []);

  const toggleCollapse = useCallback((id: InstrumentId) => {
    setCollapsedInstruments(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Top-right −/+ : expanded layout → return to default strip; strip → hide/show panel body. */
  const instrumentPanelHeaderCollapseClick = useCallback(
    (id: InstrumentId, expanded: boolean) => {
      if (expanded) toggleExpand(id);
      else toggleCollapse(id);
    },
    [toggleCollapse, toggleExpand],
  );

  useEffect(() => {
    const player = playerRef.current!;
    player.setCallbacks(
      (mi, ci) => {
        setSelectedMeasure(mi);
        setSelectedChordIdx(ci);
      },
      () => {
        setIsPlaying(false);
        setLiveBassMidi(null);
        setLiveBassNote(null);
      },
      (bassMidi) => {
        const note = Note.fromMidi(bassMidi);
        setLiveBassMidi(bassMidi);
        setLiveBassNote(note ?? null);
      },
    );
  }, []);

  useEffect(() => {
    if (isPlaying) playerRef.current?.stop();
    setIsPlaying(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSong]);

  useEffect(() => {
    if (isPlaying && playerRef.current) playerRef.current.setVoicingType(voicingType);
  }, [voicingType, isPlaying]);

  useEffect(() => {
    playerRef.current?.setRepeatRange(repeatFrom, repeatTo);
  }, [repeatFrom, repeatTo]);

  useEffect(() => {
    if (skipPanelScaleSyncRef.current) {
      skipPanelScaleSyncRef.current = false;
      return;
    }
    if (scalesOnPlay) {
      setSelectedScale(chordScales.length > 0 ? chordScales[0] : null);
      return;
    }
    if (isPlaying) setSelectedScale(null);
  }, [isPlaying, chordScales, scalesOnPlay]);

  const handleScalesToggle = useCallback(() => {
    setScalesOnPlay(prev => {
      const next = !prev;
      if (!next) {
        setSelectedScale(null);
      } else {
        setSelectedScale(chordScales.length > 0 ? chordScales[0] : null);
      }
      return next;
    });
  }, [chordScales]);

  const handlePlay = useCallback(() => {
    const player = playerRef.current!;
    if (player.playing) return;
    if (!activeSong) return;
    player.loop = isLooping;
    player.metronomeOn = metronomeOn;
    player.setPianoOn(pianoOn);
    player.setBassOn(bassOn);
    player.setBassVolume(0.75);
    player.setSwingPercent(swingPercent);
    player.load(activeSong.measures, effectiveBpm, activeSong.timeSignature, voicingType);
    player.setRepeatRange(repeatFrom, repeatTo);
    player.play();
    setIsPlaying(true);
  }, [activeSong, isLooping, metronomeOn, pianoOn, bassOn, swingPercent, effectiveBpm, voicingType, repeatFrom, repeatTo]);

  const handleStop = useCallback(() => {
    playerRef.current!.stop();
    setLiveBassMidi(null);
    setLiveBassNote(null);
  }, []);

  const handleLoopToggle = useCallback(() => {
    setIsLooping(prev => {
      const next = !prev;
      playerRef.current!.loop = next;
      return next;
    });
  }, []);

  const handleMetronomeToggle = useCallback(() => {
    setMetronomeOn(prev => {
      const next = !prev;
      playerRef.current!.metronomeOn = next;
      return next;
    });
  }, []);

  const handlePianoToggle = useCallback(() => {
    setPianoOn(prev => {
      const next = !prev;
      playerRef.current?.setPianoOn(next);
      return next;
    });
  }, []);

  const handleBassToggle = useCallback(() => {
    setBassOn(prev => {
      const next = !prev;
      playerRef.current?.setBassOn(next);
      return next;
    });
  }, []);

  const handleSwingChange = useCallback((percent: number) => {
    const v = Math.max(50, Math.min(75, percent));
    setSwingPercent(v);
    playerRef.current?.setSwingPercent(v);
  }, []);

  const handleBpmChange = useCallback((delta: number) => {
    setBpmOverride(prev => {
      const current = prev ?? activeSong?.bpm ?? 120;
      const next = Math.max(30, Math.min(300, current + delta));
      if (playerRef.current?.playing) playerRef.current.setBpm(next);
      return next;
    });
  }, [activeSong?.bpm]);

  const handleBpmSet = useCallback((bpm: number) => {
    const clamped = Math.max(30, Math.min(300, bpm));
    setBpmOverride(clamped);
    if (playerRef.current?.playing) playerRef.current.setBpm(clamped);
  }, []);

  const handleBpmReset = useCallback(() => {
    setBpmOverride(null);
    if (activeSong && playerRef.current?.playing)
      playerRef.current.setBpm(activeSong.bpm);
  }, [activeSong?.bpm]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) return;
      e.preventDefault();
      if (isPlaying) handleStop();
      else handlePlay();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPlaying, handlePlay, handleStop]);

  const showVoicingSelect = !!selectedChord && !selectedScale;

  const renderStaff = (expanded: boolean) => (
    <div
      className={`instrument-card ${expanded ? 'expanded-card' : 'staff-card'}${
        collapsedInstruments.has('staff') ? ' instrument-card--body-collapsed' : ''
      }`}
    >
      <div className="instrument-header">
        <span className="instrument-label">Staff</span>
        <div className="instrument-header-actions">
          <button
            type="button"
            className={`staff-names-btn ${showStaffBassClef ? 'active' : ''}`}
            onClick={() => setShowStaffBassClef(v => !v)}
            title={
              showStaffBassClef
                ? 'Hide bass staff (B clef)'
                : 'Show grand staff with bass (B / F clef) staff'
            }
          >
            BClef
          </button>
          {!collapsedInstruments.has('staff') && (
            <button
              type="button"
              className={`staff-names-btn ${showStaffNoteNames ? 'active' : ''}`}
              onClick={() => setShowStaffNoteNames(v => !v)}
              title={showStaffNoteNames ? 'Hide note names' : 'Show note names'}
            >
              Names
            </button>
          )}
          <button
            type="button"
            className="expand-btn"
            onClick={() => instrumentPanelHeaderCollapseClick('staff', expanded)}
            title={
              expanded
                ? 'Return to default view'
                : collapsedInstruments.has('staff')
                  ? 'Show panel content'
                  : 'Collapse panel'
            }
          >
            {!expanded && collapsedInstruments.has('staff') ? '+' : '−'}
          </button>
          {collapsedInstruments.has('staff') && (
            <button
              type="button"
              className="expand-btn instrument-panel-expand"
              onClick={() => toggleExpand('staff')}
              title={expanded ? 'Return to default view' : 'Expand panel'}
            >
              {expanded ? '△' : '▽'}
            </button>
          )}
        </div>
      </div>
      <div className="instrument-card-body">
        {!collapsedInstruments.has('staff') && (
          <Staff
            notes={mergedStaffDisplay.notes}
            mode={staffMode}
            keySignature={activeSong!.key}
            showNoteNames={showStaffNoteNames}
            noteColors={mergedStaffNoteColors}
            showBassClef={showStaffBassClef}
            scratchIdPerIndex={selectedScale ? null : mergedStaffDisplay.scratchIdPerIndex}
            staffInteractive={!selectedScale}
            selectedScratchId={selectedStaffScratchId}
            selectedScratchNote={selectedStaffScratchNote}
            onStaffSelectScratch={setSelectedStaffScratchId}
            onStaffPitchClick={handleStaffPitchClick}
            onStaffHoverPitch={handleStaffHoverPitch}
            chartSpellNotes={baseForStaff}
            onStaffScratchRemove={handleStaffScratchRemove}
            onStaffScratchSharp={handleStaffScratchSharp}
            onStaffScratchFlat={handleStaffScratchFlat}
            onStaffScratchNatural={handleStaffScratchNatural}
            staffDrawMode={guitarDrawPianoMirror}
          />
        )}
      </div>
      {!collapsedInstruments.has('staff') && (
        <div className="instrument-card-footer">
          <div className="instrument-card-footer-actions">
            <button
              type="button"
              className="expand-btn instrument-panel-expand"
              onClick={() => toggleExpand('staff')}
              title={expanded ? 'Return to default view' : 'Expand panel'}
            >
              {expanded ? '△' : '▽'}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const pianoVoicingIdx = VOICING_OPTIONS.findIndex(o => o.value === voicingType);

  const renderPiano = (expanded: boolean) => (
    <div
      className={`instrument-card ${expanded ? 'expanded-card' : 'piano-card'}${
        collapsedInstruments.has('piano') ? ' instrument-card--body-collapsed' : ''
      }`}
    >
      <div className="instrument-header">
        <span className="instrument-label">Piano</span>
        <div className="instrument-header-actions">
          {showVoicingSelect && (
            <div className="dropdown-cycle">
              <span className="dropdown-cycle-label">Voicing:</span>
              <button
                className="cycle-btn"
                onClick={() => {
                  const prev = (pianoVoicingIdx - 1 + VOICING_OPTIONS.length) % VOICING_OPTIONS.length;
                  const val = VOICING_OPTIONS[prev].value;
                  setVoicingType(val);
                  if (val !== 'guitar') setMirrorGuitarToPiano(false);
                  else setMirrorGuitarToPiano(true);
                }}
              >
                ◀
              </button>
              <select
                className="voicing-select"
                value={voicingType}
                onChange={(e) => {
                  const val = e.target.value as VoicingType;
                  setVoicingType(val);
                  if (val !== 'guitar') setMirrorGuitarToPiano(false);
                  else setMirrorGuitarToPiano(true);
                }}
              >
                {VOICING_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button
                className="cycle-btn"
                onClick={() => {
                  const next = (VOICING_OPTIONS.findIndex(o => o.value === voicingType) + 1) % VOICING_OPTIONS.length;
                  const val = VOICING_OPTIONS[next].value;
                  setVoicingType(val);
                  if (val !== 'guitar') setMirrorGuitarToPiano(false);
                  else setMirrorGuitarToPiano(true);
                }}
              >
                ▶
              </button>
            </div>
          )}
          {!collapsedInstruments.has('piano') && (
            <button
              type="button"
              className={`staff-names-btn ${showPianoNoteNames ? 'active' : ''}`}
              onClick={() => setShowPianoNoteNames((v) => !v)}
              title={showPianoNoteNames ? 'Hide note names on keys' : 'Show note names on keys'}
            >
              Names
            </button>
          )}
          <button
            type="button"
            className="expand-btn"
            onClick={() => instrumentPanelHeaderCollapseClick('piano', expanded)}
            title={
              expanded
                ? 'Return to default view'
                : collapsedInstruments.has('piano')
                  ? 'Show panel content'
                  : 'Collapse panel'
            }
          >
            {!expanded && collapsedInstruments.has('piano') ? '+' : '−'}
          </button>
          {collapsedInstruments.has('piano') && (
            <button
              type="button"
              className="expand-btn instrument-panel-expand"
              onClick={() => toggleExpand('piano')}
              title={expanded ? 'Return to default view' : 'Expand panel'}
            >
              {expanded ? '△' : '▽'}
            </button>
          )}
        </div>
      </div>
      <div className="instrument-card-body">
      {!collapsedInstruments.has('piano') && (
        <div className="piano-wrapper">
          <PianoRoll
            allNotes={pianoNotes.all}
            leftHand={pianoNotes.lh}
            rightHand={pianoNotes.rh}
            root={displayRoot}
            scaleRoot={selectedScale ? selectedScale.notes[0] : undefined}
            degreeColorMap={chromaColorMap}
            onToggleNote={selectedScale ? undefined : handleTogglePianoNote}
            readOnlyKeys={!!selectedScale}
            guitarMirrorSlotMode={
              mirrorGuitarToPiano &&
              voicingType === 'guitar' &&
              fretboardInstrument === 'guitar' &&
              !selectedScale &&
              fretboardMode === 'chord'
            }
            guitarMirrorChordTab={guitarChordTabForFretboard}
            guitarMirrorFretWindow={clippedFretboardRange}
            activeMidis={
              mirrorGuitarToPiano &&
              voicingType === 'guitar' &&
              fretboardInstrument === 'guitar' &&
              mirrorGuitarPianoActiveMidis &&
              mirrorGuitarPianoActiveMidis.size > 0
                ? mirrorGuitarPianoActiveMidis
                : tappedMidis.size > 0
                  ? tappedMidis
                  : mirrorGuitarPianoActiveMidis && mirrorGuitarPianoActiveMidis.size > 0
                    ? mirrorGuitarPianoActiveMidis
                    : tappedGuitarTab
                      ? new Set(
                          tabToMidiNotes(tappedGuitarTab, true)
                            .map(n => Note.midi(n))
                            .filter((m): m is number => m != null),
                        )
                      : undefined
            }
            omittedMidis={pianoOmittedMidis}
            omittedChromas={pianoOmittedChromas}
            showKeyNoteNames={showPianoNoteNames}
            staffHoverMidi={staffHoverMidi}
            staffHoverPitchClass={staffHoverPitchClass}
            pitchClassByMidi={pianoPitchClassByMidi}
          />
        </div>
      )}
      </div>
      {!collapsedInstruments.has('piano') && (
        <div className="instrument-card-footer">
          <div className="instrument-card-footer-actions">
            <button
              type="button"
              className="expand-btn instrument-panel-expand"
              onClick={() => toggleExpand('piano')}
              title={expanded ? 'Return to default view' : 'Expand panel'}
            >
              {expanded ? '△' : '▽'}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const guitarOptionLabels = useMemo(() => {
    const labels: { value: number; label: string }[] = [{ value: -1, label: 'All Frets' }];
    guitarPositions.forEach((p, i) => labels.push({ value: i, label: p.label }));
    return labels;
  }, [guitarPositions]);

  const guitarOptionIdx = guitarOptionLabels.findIndex(o => o.value === guitarPosition);

  const bassOptionLabels = useMemo(
    () => [
      { value: -1 as const, label: 'All Frets' },
      ...BASS_POSITIONS.map((p, i) => ({ value: i as 0 | 1 | 2, label: p.label })),
    ],
    [],
  );

  const bassOptionIdx = bassOptionLabels.findIndex((o) => o.value === bassPosition);

  const renderGuitar = (expanded: boolean) => {
    const showGuitarPositions =
      fretboardInstrument === 'guitar' && displayNotes.length > 0;
    const showBassPositions =
      fretboardInstrument === 'bass' && displayNotes.length > 0;
    const showFretboardPositionFooter =
      (showGuitarPositions || showBassPositions) &&
      !expanded &&
      !collapsedInstruments.has('guitar');
    const guitarPositionNav = showGuitarPositions ? (
      <div className="guitar-position-nav">
        <div className="position-buttons guitar-position-buttons">
          {guitarOptionLabels.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`pos-btn ${guitarPosition === opt.value ? 'active' : ''}`}
              onClick={() => {
                setGuitarPosition(opt.value);
                setGuitarVoicingVariant(0);
              }}
            >
              {opt.label === 'All Frets' ? 'All' : opt.label.replace('Pos ', 'P')}
            </button>
          ))}
        </div>
      </div>
    ) : null;

    const bassPositionNav = showBassPositions ? (
      <div className="guitar-position-nav">
        <div className="position-buttons guitar-position-buttons">
          {bassOptionLabels.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`pos-btn ${bassPosition === opt.value ? 'active' : ''}`}
              onClick={() => setBassPosition(opt.value)}
            >
              {opt.label === 'All Frets' ? 'All' : opt.label}
            </button>
          ))}
        </div>
      </div>
    ) : null;

    const fretboard = (
      <Fretboard
        highlightNotes={displayNotes}
        ghostNotes={
          fretboardInstrument === 'bass' && selectedScale ? bassGhostNotes : []
        }
        highlightMidis={
          fretboardInstrument === 'bass' && isPlaying && liveBassMidi != null
            ? [liveBassMidi]
            : null
        }
        ghostMidis={
          fretboardInstrument === 'bass' && !selectedScale ? bassChordGhostMidis : null
        }
        root={displayRoot}
        startFret={clippedFretboardRange.startFret}
        endFret={clippedFretboardRange.endFret}
        mode={fretboardInstrument === 'bass' ? 'scale' : fretboardMode}
        strings={fretboardInstrument === 'bass' ? BASS_STRINGS : undefined}
        degreeColorMap={chromaColorMap}
        chordTab={guitarChordTabForFretboard}
        editable={
          fretboardInstrument === 'guitar' &&
          !selectedScale &&
          mirrorGuitarToPiano
        }
        onFretClick={
          fretboardInstrument === 'guitar' && !selectedScale && mirrorGuitarToPiano
            ? isFretboardEditable
              ? handleFretClick
              : handleToggleGuitarFret
            : undefined
        }
        onFretPeek={
          fretboardInstrument === 'guitar' && !selectedScale && mirrorGuitarToPiano
            ? handleGuitarFretPeek
            : undefined
        }
        showNoteLabels={
          fretboardInstrument === 'guitar' ? showGuitarFretNoteNames : false
        }
        pitchClassLabels={fretboardInstrument === 'bass'}
        getFretDotLabel={fretboardInstrument === 'bass' ? bassFretDotLabel : undefined}
        dedupeHighlightGhostToLowest={false}
        stringOpenMidis={fretboardInstrument === 'bass' ? BASS_OPEN_MIDIS : undefined}
      />
    );

    return (
    <div
      className={`instrument-card ${expanded ? 'expanded-card' : 'fretboard-card'}${
        collapsedInstruments.has('guitar') ? ' instrument-card--body-collapsed' : ''
      }`}
    >
      <div className="instrument-header instrument-header--fretboard-only">
        <div
          className="instrument-header-actions instrument-header-actions--fretboard"
          ref={fretboardHeaderActionsRef}
        >
          <div className="fretboard-header-leading">
            <div className="fretboard-mode-toggle" role="group" aria-label="Instrument">
              <button
                type="button"
                className={`fretboard-mode-btn ${fretboardInstrument === 'guitar' ? 'active' : ''}`}
                onClick={handleGuitarModeButtonClick}
                title={
                  guitarChordToolsUnlocked
                    ? 'Guitar'
                    : `Guitar — ${GUITAR_CHORD_TOOLS_REVEAL_CLICKS} quick clicks: Save Default + neck shift`
                }
              >
                Guitar
              </button>
              <button
                type="button"
                className={`fretboard-mode-btn ${fretboardInstrument === 'bass' ? 'active' : ''}`}
                onClick={() => {
                  guitarToolsRevealClicksRef.current = 0;
                  setFretboardInstrument('bass');
                }}
              >
                Bass
              </button>
            </div>
            {guitarChordToolsUnlocked &&
              fretboardInstrument === 'guitar' &&
              fretboardMode === 'chord' &&
              selectedChord &&
              guitarPosition >= 0 && (
              <>
                <button
                  className="save-chord-btn"
                  type="button"
                  onClick={handleSaveShape}
                  title={`Save this shape to the library for Pos ${guitarPosition + 1} (overwrites after confirm)`}
                  style={{
                    marginLeft: '6px',
                    background: 'var(--bg-lighter)',
                    border: '1px solid var(--border-color)',
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
                <button
                  className="save-chord-btn"
                  type="button"
                  onClick={handleSaveChartGuitarDefaultPos}
                  title="When browsing the chart, open this chord at this position until you pick another position"
                  style={{
                    marginLeft: '6px',
                    background: 'var(--bg-lighter)',
                    border: '1px solid var(--border-color)',
                    cursor: 'pointer',
                  }}
                >
                  Chart default
                </button>
              </>
            )}
            {saveStatus && (
              <span
                className="save-chord-status"
                style={{
                  fontSize: '11px',
                  color: saveStatus.startsWith('Not saved')
                    ? '#ff6b6b'
                    : saveStatus.startsWith('Saved')
                      ? '#00d4aa'
                      : 'var(--text-secondary)',
                  marginLeft: '8px',
                  fontWeight: 600,
                }}
              >
                {saveStatus}
              </span>
            )}
          </div>
          <div className="fretboard-header-trailing">
            {showGuitarPositions &&
              expanded &&
              !collapsedInstruments.has('guitar') &&
              guitarPositionNav}
            {showBassPositions &&
              expanded &&
              !collapsedInstruments.has('guitar') &&
              bassPositionNav}
            {fretboardInstrument === 'guitar' && (
              <button
                type="button"
                className={`staff-names-btn ${mirrorGuitarToPiano ? 'active' : ''}`}
                onClick={() => {
                  const next = !mirrorGuitarToPiano;
                  setMirrorGuitarToPiano(next);
                  if (next) {
                    setVoicingType('guitar');
                    setTappedMidis(new Set());
                  } else if (voicingType === 'guitar') setVoicingType('all');
                }}
                title={
                  mirrorGuitarToPiano
                    ? 'Draw on — click the neck to edit; compact piano shows the chord'
                    : 'Draw off — turn on to edit the neck and sync the compact piano'
                }
              >
                Draw
              </button>
            )}
            {fretboardInstrument === 'guitar' && !collapsedInstruments.has('guitar') && (
              <button
                type="button"
                className={`staff-names-btn ${showGuitarFretNoteNames ? 'active' : ''}`}
                onClick={() => setShowGuitarFretNoteNames((v) => !v)}
                title={
                  showGuitarFretNoteNames
                    ? 'Hide note names on fretboard dots'
                    : 'Show note names on fretboard dots'
                }
              >
                Names
              </button>
            )}
            {fretboardInstrument === 'bass' && !collapsedInstruments.has('guitar') && (
              <button
                type="button"
                className={`staff-names-btn ${showBassAllNoteNames ? 'active' : ''}`}
                onClick={() => setShowBassAllNoteNames((v) => !v)}
                title={
                  showBassAllNoteNames
                    ? 'Names: chord root + scale/chord tones (pitch class on each dot)'
                    : 'Names: chord root only on the board'
                }
              >
                Names
              </button>
            )}
            <button
              type="button"
              className="expand-btn"
              onClick={() => instrumentPanelHeaderCollapseClick('guitar', expanded)}
              title={
                expanded
                  ? 'Return to default view'
                  : collapsedInstruments.has('guitar')
                    ? 'Show panel content'
                    : 'Collapse panel'
              }
            >
              {!expanded && collapsedInstruments.has('guitar') ? '+' : '−'}
            </button>
            {collapsedInstruments.has('guitar') && (
              <button
                type="button"
                className="expand-btn instrument-panel-expand"
                onClick={() => toggleExpand('guitar')}
                title={expanded ? 'Return to default view' : 'Expand panel'}
              >
                {expanded ? '△' : '▽'}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="instrument-card-body">
      {!collapsedInstruments.has('guitar') && (
        <>
          {(fretboardInstrument === 'guitar' || fretboardInstrument === 'bass') &&
          displayNotes.length > 0 ? (
            <div className="fretboard-with-pos-arrows">
              {fretboardInstrument === 'guitar' &&
                guitarChordToolsUnlocked &&
                fretboardMode === 'chord' &&
                guitarChordFretWindow != null && (
                  <button
                    type="button"
                    className="fretboard-pos-arrow fretboard-chord-shift-arrow"
                    aria-label="Shift neck view toward nut"
                    title="Shift view toward nut"
                    disabled={guitarChordFretWindow.startFret === 0}
                    onClick={() => handleGuitarChordViewShift(-1)}
                  >
                    «
                  </button>
                )}
              <button
                type="button"
                className="fretboard-pos-arrow"
                aria-label="Previous position"
                title="Previous position"
                onClick={() => {
                  if (fretboardInstrument === 'guitar') {
                    const nextIdx =
                      (guitarOptionIdx - 1 + guitarOptionLabels.length) %
                      guitarOptionLabels.length;
                    setGuitarPosition(guitarOptionLabels[nextIdx].value);
                    setGuitarVoicingVariant(0);
                  } else {
                    const nextIdx =
                      (bassOptionIdx - 1 + bassOptionLabels.length) %
                      bassOptionLabels.length;
                    setBassPosition(bassOptionLabels[nextIdx].value);
                  }
                }}
              >
                ◀
              </button>
              <div className="fretboard-with-pos-arrows-board" ref={guitarFretboardBoardRef}>
                {fretboard}
              </div>
              <button
                type="button"
                className="fretboard-pos-arrow"
                aria-label="Next position"
                title="Next position"
                onClick={() => {
                  if (fretboardInstrument === 'guitar') {
                    const nextIdx = (guitarOptionIdx + 1) % guitarOptionLabels.length;
                    setGuitarPosition(guitarOptionLabels[nextIdx].value);
                    setGuitarVoicingVariant(0);
                  } else {
                    const nextIdx = (bassOptionIdx + 1) % bassOptionLabels.length;
                    setBassPosition(bassOptionLabels[nextIdx].value);
                  }
                }}
              >
                ▶
              </button>
              {fretboardInstrument === 'guitar' &&
                guitarChordToolsUnlocked &&
                fretboardMode === 'chord' &&
                guitarChordFretWindow != null && (
                  <button
                    type="button"
                    className="fretboard-pos-arrow fretboard-chord-shift-arrow"
                    aria-label="Shift neck view toward body"
                    title="Shift view toward body"
                    disabled={guitarChordFretWindow.endFret >= guitarChordNeckCap}
                    onClick={() => handleGuitarChordViewShift(1)}
                  >
                    »
                  </button>
                )}
            </div>
          ) : (
            fretboard
          )}
          {fretboardInstrument === 'guitar' && fretboardMode === 'chord' && guitarSlashBassCaption && (
            <div className="guitar-slash-bass-caption" role="status">
              {guitarSlashBassCaption}
            </div>
          )}
          {fretboardInstrument === 'bass' ? (
            <div className="analysis-empty" style={{ marginTop: '8px' }}>
              Bass:{' '}
              {(() => {
                if (isPlaying && liveBassMidi != null) {
                  const n = Note.fromMidi(liveBassMidi);
                  if (!n) return '—';
                  return toPitchClass(n);
                }
                if (displayRoot) {
                  const refM = bassChordRootReferenceMidi(displayRoot);
                  if (refM == null) return '—';
                  const n = Note.fromMidi(refM);
                  if (!n) return '—';
                  return toPitchClass(n);
                }
                return '—';
              })()}
            </div>
          ) : null}
        </>
      )}
      </div>
      {!collapsedInstruments.has('guitar') && (
        <div
          className={`instrument-card-footer${
            showFretboardPositionFooter ? ' instrument-card-footer--fretboard' : ''
          }`}
        >
          {showFretboardPositionFooter && (
            <div className="guitar-position-footer" ref={guitarPosFooterRef}>
              {fretboardInstrument === 'guitar' ? guitarPositionNav : bassPositionNav}
            </div>
          )}
          <div className="instrument-card-footer-actions">
            <button
              type="button"
              className="expand-btn instrument-panel-expand"
              onClick={() => toggleExpand('guitar')}
              title={expanded ? 'Return to default view' : 'Expand panel'}
            >
              {expanded ? '△' : '▽'}
            </button>
          </div>
        </div>
      )}
    </div>
    );
  };

  const handleSaveChartGuitarDefaultPos = useCallback(() => {
    if (!selectedChord || guitarPosition < 0 || !guitarChordToolsUnlocked) return;
    const sym = canonicalChordSymbol(selectedChord.symbol);
    setChartGuitarDefaultPos((prev) => {
      const next = { ...prev, [sym]: guitarPosition };
      try {
        localStorage.setItem(CHART_GUITAR_DEFAULT_POS_KEY, JSON.stringify(next));
      } catch (_) {}
      return next;
    });
    setSaveStatus(`Chart uses Pos ${guitarPosition + 1} for ${sym}`);
    setTimeout(() => setSaveStatus(null), 3500);
  }, [selectedChord, guitarPosition, guitarChordToolsUnlocked]);

  const handleSaveShape = useCallback(async () => {
    if (!selectedChord || guitarPosition < 0 || !guitarChordToolsUnlocked) return;

    const tabToSave =
      isFretboardEditable && editableGuitarTab ? editableGuitarTab : guitarChordTab;
    if (!tabToSave || tabToSave.length !== 6) {
      setSaveStatus('Not saved — no voicing to save (select a chord & position)');
      setTimeout(() => setSaveStatus(null), 4000);
      return;
    }

    const tabPhysical = [...tabToSave].reverse();
    const symbol = canonicalChordSymbol(selectedChord.symbol);
    const positionIdx = guitarPosition;

    const existingRow = customChordsOverride?.[symbol]?.[positionIdx];
    const hasExisting =
      existingRow != null &&
      Array.isArray(existingRow) &&
      existingRow.some((f) => f != null);
    if (hasExisting) {
      if (
        !window.confirm(`Overwrite saved voicing for ${symbol} at Pos ${positionIdx + 1}?`)
      ) {
        return;
      }
    }

    if (
      !tabMatchesChordSymbol(tabPhysical, selectedChord.symbol, selectedChord.notes, {
        requireRootOnFretboard: false,
      })
    ) {
      setSaveStatus('Not saved — frets must match chord tones, ≥3 strings');
      setTimeout(() => setSaveStatus(null), 4500);
      return;
    }

    setCustomChordsOverride(prev => {
      const next = { ...(prev ?? {}) };
      const list = [...(next[symbol] ?? [])] as (GuitarTab | null)[];
      while (list.length <= positionIdx) list.push(null);
      list[positionIdx] = tabPhysical;
      next[symbol] = list as any;
      
      try {
        localStorage.setItem(CUSTOM_CHORDS_KEY, JSON.stringify(next));
        console.info(`[ChordSave] Persisted to localStorage key: "${CUSTOM_CHORDS_KEY}" for ${symbol} at Pos ${positionIdx + 1}`);
      } catch (err) {
        console.error('Failed to save to localStorage', err);
      }
      
      return next;
    });

    setGuitarVoicingVariant(0);
    setEditableGuitarTab([...tabToSave]);
    
    setSaveStatus(`Saved to Pos ${positionIdx + 1}`);
    setTimeout(() => setSaveStatus(null), 3000);

    try {
      const res = await fetch('/api/save-chord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, positionIdx, tab: tabPhysical })
      });
      if (!res.ok) {
        console.error('Save to server failed', res.status);
      }
    } catch (e) {
      console.error('Network error during save', e);
    }
  }, [
    selectedChord,
    guitarPosition,
    guitarChordTab,
    isFretboardEditable,
    editableGuitarTab,
    guitarChordToolsUnlocked,
    customChordsOverride,
  ]);

  return (
    <div className="app">
      <Header
        songs={songs}
        selectedSongIndex={selectedSongIndex}
        onSongSelect={handleSongSelect}
        onImportClick={() => setShowImport(true)}
        onLibraryClick={() => {
          setShowLibrary(true);
          setLibraryChord(null);
          setLibrarySuffix('');
          setSelectedScale(null);
        }}
        activeDegrees={activeDegrees}
        onToggleDegree={handleToggleDegree}
        onToggleAllDegrees={handleToggleAllDegrees}
      />

      {currentSong && activeSong ? (
        <div className="app-body">
          <main className="main-content">
            <div className="instrument-bar">
              {expandedInstrument !== 'staff' && renderStaff(false)}
              {expandedInstrument !== 'piano' && renderPiano(false)}
              {expandedInstrument !== 'guitar' && renderGuitar(false)}
            </div>

            {expandedInstrument === 'staff' && renderStaff(true)}
            {expandedInstrument === 'piano' && renderPiano(true)}
            {expandedInstrument === 'guitar' && renderGuitar(true)}

            {showLibrary ? (
              <Library
                selectedRoot={libraryRoot}
                selectedSuffix={librarySuffix}
                selectedScale={selectedScale}
                onRootChange={r => {
                  setLibraryRoot(r);
                  if (libraryChord?.symbol) {
                    const symbol = `${r}${librarySuffix}`;
                    const aliasedSuffix = librarySuffix === 'm6/9' ? 'm69' : librarySuffix;
                    const c = Chord.get(`${r}${aliasedSuffix}`);
                    let notes = c.notes.length > 0 ? c.notes : [];
                    
                    if (notes.length === 0) {
                      // Fallback for chords tonal doesn't natively support building
                      const rootNote = r;
                      if (librarySuffix === 'maj11') {
                        notes = [rootNote, transposeNote(rootNote, 4, false), transposeNote(rootNote, 7, false), transposeNote(rootNote, 11, false), transposeNote(rootNote, 14, false), transposeNote(rootNote, 17, false)];
                      } else if (librarySuffix === 'mM11') {
                        notes = [rootNote, transposeNote(rootNote, 3, true), transposeNote(rootNote, 7, false), transposeNote(rootNote, 11, false), transposeNote(rootNote, 14, false), transposeNote(rootNote, 17, false)];
                      } else if (librarySuffix === 'mb6') {
                        notes = [rootNote, transposeNote(rootNote, 3, true), transposeNote(rootNote, 7, false), transposeNote(rootNote, 8, true)];
                      }
                    }

                    setLibraryChord({
                      symbol,
                      root: c.tonic || r,
                      quality: c.type || librarySuffix,
                      notes: normalizeNotes(notes),
                    });
                  }
                  if (selectedScale) {
                    const scale = Scale.get(`${r} ${selectedScale.type}`);
                    if (scale.notes.length)
                      setSelectedScale({
                        name: `${r} ${selectedScale.type}`,
                        type: selectedScale.type,
                        notes: normalizeNotes(scale.notes),
                        relevance: 'high',
                        relationLabel: getScaleRelation(r, selectedScale.type) ?? undefined,
                      });
                  }
                }}
                onChordSelect={(chord, suffix) => {
                  let parsedChord = { ...chord };
                  if (parsedChord.notes.length === 0) {
                      const rootNote = parsedChord.root;
                      if (suffix === 'maj11') {
                        parsedChord.notes = [rootNote, transposeNote(rootNote, 4, false), transposeNote(rootNote, 7, false), transposeNote(rootNote, 11, false), transposeNote(rootNote, 14, false), transposeNote(rootNote, 17, false)];
                      } else if (suffix === 'mM11') {
                        parsedChord.notes = [rootNote, transposeNote(rootNote, 3, true), transposeNote(rootNote, 7, false), transposeNote(rootNote, 11, false), transposeNote(rootNote, 14, false), transposeNote(rootNote, 17, false)];
                      } else if (suffix === 'm6/9') {
                        const cAlias = Chord.get(`${rootNote}m69`);
                        parsedChord.notes = cAlias.notes.length > 0 ? cAlias.notes : [];
                      } else if (suffix === 'mb6') {
                        parsedChord.notes = [rootNote, transposeNote(rootNote, 3, true), transposeNote(rootNote, 7, false), transposeNote(rootNote, 8, true)];
                      }
                      parsedChord.notes = normalizeNotes(parsedChord.notes);
                  }
                  setLibraryChord(parsedChord);
                  setLibrarySuffix(suffix);
                  setSelectedScale(null);
                  setGuitarPosition(0);
                  setGuitarVoicingVariant(0);
                }}
                onScaleSelect={scale => {
                  setSelectedScale(scale);
                  if (scale != null) {
                    skipPanelScaleSyncRef.current = true;
                    setScalesOnPlay(true);
                    setLibraryChord(null);
                    setLibrarySuffix('');
                  } else {
                    setScalesOnPlay(false);
                  }
                }}
                onBack={() => {
                  setShowLibrary(false);
                  setLibraryChord(null);
                }}
              />
            ) : (
              <>
                {chartTapHarmonyLine != null || staffLabel ? (
                  <div
                    className={`chord-context-above-chart instrument-panel-harmony-label${chartTapHarmonyLine != null ? ' chord-context-above-chart--tap' : ''}`}
                    aria-live="polite"
                  >
                    {chartTapHarmonyLine ?? staffLabel}
                  </div>
                ) : null}
                <ChordChart
                measures={activeSong.measures}
                selectedMeasure={selectedMeasure}
                selectedChordIdx={selectedChordIdx}
                onMeasureSelect={handleMeasureSelect}
                songTitle={activeSong.title}
                composer={activeSong.composer}
                style={activeSong.style}
                songKey={activeSong.key}
                bpm={effectiveBpm}
                originalBpm={activeSong?.bpm}
                onBpmChange={handleBpmChange}
                onBpmSet={handleBpmSet}
                onBpmReset={handleBpmReset}
                onKeyChange={handleKeyChange}
              isPlaying={isPlaying}
              onPlay={handlePlay}
              onStop={handleStop}
              scalesOnPlay={scalesOnPlay}
              onScalesOnPlayToggle={handleScalesToggle}
              isLooping={isLooping}
                onLoopToggle={handleLoopToggle}
                repeatFrom={repeatFrom}
                repeatTo={repeatTo}
                repeatPicker={repeatPicker}
                onRepeatFromClick={() => {
                  if (repeatPicker === 'from') setRepeatPicker(null);
                  else if (repeatFrom) {
                    setRepeatFrom(null);
                    setRepeatPicker(null);
                  } else setRepeatPicker('from');
                }}
                onRepeatToClick={() => {
                  if (repeatPicker === 'to') setRepeatPicker(null);
                  else if (repeatTo) {
                    setRepeatTo(null);
                    setRepeatPicker(null);
                  } else setRepeatPicker('to');
                }}
                isMetronomeOn={metronomeOn}
                onMetronomeToggle={handleMetronomeToggle}
                isPianoOn={pianoOn}
                onPianoToggle={handlePianoToggle}
                isBassOn={bassOn}
                onBassToggle={handleBassToggle}
                swingPercent={swingPercent}
                onSwingChange={handleSwingChange}
              />
              </>
            )}
          </main>

          <ScalePanel
            songKey={activeSong.key}
            keyAnalysis={keyAnalysis}
            chordScales={chordScales}
            selectedChordSymbol={selectedChord?.symbol || null}
            selectedScale={selectedScale}
            onScaleSelect={handleScaleSelect}
            degreeColorMap={chromaColorMap}
            prevChordSymbol={neighborChords.prev}
            nextChordSymbol={neighborChords.next}
          />
        </div>
      ) : null}

      {showImport && (
        <ImportModal
          onImport={handleImport}
          onClose={() => {
            setShowImport(false);
            setImportError('');
          }}
          error={importError}
        />
      )}

    </div>
  );
}
