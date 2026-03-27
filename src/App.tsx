import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { Note, Chord, Scale } from 'tonal';
import type { Song, Measure, ChordInfo, ScaleSuggestion, KeyAnalysis } from './types/music';
import { getScalesForChord } from './engine/scaleEngine';
import { getScaleRelation } from './engine/scaleRelations';
import { analyzeKey } from './engine/keyAnalyzer';
import { assignOctaves, normalizeNotes } from './engine/noteUtils';
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
import { generatePlayableVoicings, filterTabNotesAtOrAboveRoot, tabToMidiNotes, type GuitarTab } from './engine/guitarVoicings';
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
/** Chord voicings and highlights stay within frets 0…this (scale mode can use the full neck). */
const GUITAR_CHORD_MAX_FRET = 14;

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
  { label: 'P1', startFret: 0, endFret: 5 },
  { label: 'P2', startFret: 4, endFret: 9 },
  { label: 'P3', startFret: 8, endFret: 14 },
] as const;

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
  const [bassPosition, setBassPosition] = useState<0 | 1 | 2>(0);
  const [guitarVoicingVariant, setGuitarVoicingVariant] = useState(0);
  const [transposeSemitones, setTransposeSemitones] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [metronomeOn, setMetronomeOn] = useState(true);
  const [pianoOn, setPianoOn] = useState(true);
  const [bassOn, setBassOn] = useState(true);
  const [swingPercent, setSwingPercent] = useState(50);
  const [showStaffNoteNames, setShowStaffNoteNames] = useState(true);
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
  const [tappedGuitarTab, setTappedGuitarTab] = useState<(number | null)[] | null>(null);
  const [liveBassNote, setLiveBassNote] = useState<string | null>(null);
  const [liveBassMidi, setLiveBassMidi] = useState<number | null>(null);
  /** Skip one chordScales sync so panel scale choice is not replaced by chordScales[0]. */
  const skipPanelScaleSyncRef = useRef(false);

  const fretboardHeaderActionsRef = useRef<HTMLDivElement | null>(null);
  const guitarPosFooterRef = useRef<HTMLDivElement | null>(null);
  /** Collapsed card: width of fretboard column (between ◀ ▶), for fitting All/P1… below */
  const guitarFretboardBoardRef = useRef<HTMLDivElement | null>(null);
  /** Hidden row matching pill buttons — measured width vs board for hamburger */
  const guitarPillsMeasureRowRef = useRef<HTMLDivElement | null>(null);
  const fretboardCompactEnterWidthRef = useRef(0);
  const prevFretboardInstrumentRef = useRef<FretboardInstrument | null>(null);
  const posNavMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const [fretboardPosCompact, setFretboardPosCompact] = useState(false);
  const [fretboardPosMenuOpen, setFretboardPosMenuOpen] = useState(false);

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

  const staffNotes = useMemo(() => {
    if (selectedScale) return assignOctaves(selectedScale.notes);
    if (voicing) {
      const all = [...voicing.leftHand, ...voicing.rightHand];
      all.sort((a, b) => (Note.midi(a) || 0) - (Note.midi(b) || 0));
      return all;
    }
    const notes = selectedChord?.notes ?? [];
    if (notes.length > 0) return assignOctaves(notes);
    return [];
  }, [selectedChord, selectedScale, voicing]);

  const staffMode: 'chord' | 'scale' | 'empty' = selectedScale
    ? 'scale'
    : selectedChord
      ? 'chord'
      : 'empty';

  const staffLabel = selectedScale
    ? selectedScale.name
    : selectedChord
      ? voicingType !== 'all'
        ? `${selectedChord.symbol} — ${VOICING_OPTIONS.find(o => o.value === voicingType)?.label || ''}`
        : selectedChord.symbol
      : '';

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
        const { startFret, endFret } = chordFretRangeFromPressedBounds(
          minF,
          maxF,
          GUITAR_CHORD_MAX_FRET,
        );
        return { label: `Pos ${i + 1}`, startFret, endFret };
      });
    }
    const base = computeGuitarPositions(ch);
    if (fretboardMode === 'chord') {
      return base.map((p) => ({
        label: p.label,
        ...clampGuitarChordViewRange(p.startFret, p.endFret, GUITAR_CHORD_MAX_FRET),
      }));
    }
    return base;
  }, [displayRoot, fretboardMode, dbShapes, dbShapeLabels]);

  const fretRange = useMemo(() => {
    if (fretboardInstrument === 'bass') {
      return BASS_POSITIONS[bassPosition];
    }
    if (guitarPosition >= 0 && guitarPositions[guitarPosition])
      return guitarPositions[guitarPosition];
    return {
      startFret: 0,
      endFret:
        fretboardInstrument === 'guitar' && fretboardMode === 'chord'
          ? GUITAR_CHORD_MAX_FRET
          : GUITAR_NECK_END_FRET,
      label: 'All',
    };
  }, [guitarPosition, guitarPositions, fretboardInstrument, bassPosition, fretboardMode]);

  useEffect(() => {
    setGuitarPeekEndExtend(null);
  }, [fretboardInstrument, guitarPosition, fretRange.startFret, fretRange.endFret]);

  const guitarChordFretWindow = useMemo(() => {
    if (fretboardInstrument !== 'guitar' || fretboardMode !== 'chord') return null;
    const a = fretRange.startFret;
    const b = fretRange.endFret;
    let s = a + guitarChordViewPan;
    let e = b + guitarChordViewPan;
    if (e > GUITAR_CHORD_MAX_FRET) {
      s = Math.max(0, s - (e - GUITAR_CHORD_MAX_FRET));
      e = GUITAR_CHORD_MAX_FRET;
    }
    if (s < 0) {
      e = Math.min(GUITAR_CHORD_MAX_FRET, e - s);
      s = 0;
    }
    return clampGuitarChordViewRange(s, e, GUITAR_CHORD_MAX_FRET);
  }, [fretboardInstrument, fretboardMode, fretRange.startFret, fretRange.endFret, guitarChordViewPan]);

  const guitarDisplayStartFret =
    fretboardInstrument === 'guitar' && fretboardMode === 'chord' && guitarChordFretWindow != null
      ? guitarChordFretWindow.startFret
      : fretRange.startFret;

  const guitarDisplayEndFret = useMemo(() => {
    if (fretboardInstrument !== 'guitar') return fretRange.endFret;
    const baseEnd =
      fretboardMode === 'chord' && guitarChordFretWindow != null
        ? guitarChordFretWindow.endFret
        : fretRange.endFret;
    let end = baseEnd;
    if (guitarPeekEndExtend != null) end = Math.max(end, guitarPeekEndExtend);
    if (fretboardMode === 'chord') end = Math.min(end, GUITAR_CHORD_MAX_FRET);
    return end;
  }, [
    fretboardInstrument,
    fretboardMode,
    guitarChordFretWindow,
    fretRange.endFret,
    guitarPeekEndExtend,
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

  const handleGuitarFretPeek = useCallback((fret: number) => {
    setGuitarPeekEndExtend((prev) => {
      const next = Math.max(prev ?? 0, fret + 1);
      return fretboardMode === 'chord' ? Math.min(next, GUITAR_CHORD_MAX_FRET) : next;
    });
  }, [fretboardMode]);

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
    const inLibraryChordEdit =
      showLibrary && fretboardMode === 'chord' && selectedChord && guitarPosition >= 0;
    const filtered =
      !inLibraryChordEdit && rootCh != null ? filterTabNotesAtOrAboveRoot(raw, rootCh) : raw;
    return filtered.slice().reverse();
  }, [
    playableVoicings,
    guitarVoicingVariant,
    displayRoot,
    showLibrary,
    fretboardMode,
    selectedChord,
    guitarPosition,
  ]);

  const interactiveAnalysis = useMemo(() => {
    let notes: string[] = [];
    if (mirrorGuitarToPiano) {
      // Union of both sets
      const pNotes = Array.from(tappedMidis).map(m => Note.fromMidi(m)).filter((n): n is string => n != null);
      const gNotes = tappedGuitarTab ? tabToMidiNotes(tappedGuitarTab, true) : [];
      notes = [...new Set([...pNotes, ...gNotes])];
    } else {
      // Pick the active one
      if (tappedMidis.size > 0) {
        notes = Array.from(tappedMidis).map(m => Note.fromMidi(m)).filter((n): n is string => n != null);
      } else if (tappedGuitarTab) {
        notes = tabToMidiNotes(tappedGuitarTab, true);
      }
    }

    if (notes.length === 0) return { library: [], theory: [] };
    const libMatches = detectLibraryChords(notes);
    const theoryMatches = Chord.detect(notes).filter((c: string) => !libMatches.includes(c));
    return { library: libMatches, theory: theoryMatches };
  }, [tappedMidis, tappedGuitarTab, mirrorGuitarToPiano]);

  const handleTogglePianoNote = useCallback((midi: number) => {
    setTappedMidis(prev => {
      const next = new Set(prev);
      if (next.has(midi)) next.delete(midi);
      else if (next.size < 12) next.add(midi);
      if (!mirrorGuitarToPiano && tappedGuitarTab) setTappedGuitarTab(null);
      return next;
    });
  }, [tappedGuitarTab, mirrorGuitarToPiano]);

  const handleToggleGuitarFret = useCallback((si: number, fret: number | null) => {
    setTappedGuitarTab(prev => {
      let next = prev ? [...prev] : (guitarChordTab ? [...guitarChordTab] : [null, null, null, null, null, null]);
      if (next[si] === fret) next[si] = null;
      else next[si] = fret;

      // Condition: only clear mirror if toggle is OFF
      if (!mirrorGuitarToPiano && tappedMidis.size > 0) setTappedMidis(new Set());

      return next;
    });
  }, [guitarChordTab, tappedMidis, mirrorGuitarToPiano]);

  useEffect(() => {
    setTappedMidis(new Set());
    setTappedGuitarTab(null);
  }, [selectedChord?.symbol, selectedScale?.name, voicingType, guitarPosition, guitarVoicingVariant]);

  const chromaColorMap = useMemo(() => {
    if (activeDegrees.size === 0 || !displayRoot) return null;
    return buildDegreeColorMap(displayRoot, activeDegrees);
  }, [activeDegrees, displayRoot]);

  const staffNoteColors = useMemo(() => {
    if (!chromaColorMap || staffNotes.length === 0) return undefined;
    return staffNotes.map(n => {
      const ch = Note.chroma(n);
      return ch != null ? chromaColorMap.get(ch) : undefined;
    });
  }, [staffNotes, chromaColorMap]);

  const guitarMaxVariants = Math.max(playableVoicings.length, 1);

  const isFretboardEditable = showLibrary && fretboardMode === 'chord' && selectedChord && guitarPosition >= 0;
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

  const pianoNotes = useMemo(() => {
    if (mirrorGuitarToPiano && displayChordTab) {
      // Physical tab is [high e ... low E] from fretboard, but tabToMidiNotes expects [low E ... high e]
      const midiNotes = tabToMidiNotes([...displayChordTab].reverse());
      return { all: midiNotes, lh: [] as string[], rh: [] as string[] };
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
  }, [selectedScale, selectedChord, voicing, mirrorGuitarToPiano, displayChordTab]);

  const guitarSlashBassCaption = useMemo(
    () =>
      selectedChord ? slashBassDisplayLabel(selectedChord.symbol, selectedChord.bass) : null,
    [selectedChord],
  );

  const guitarChordTabRef = useRef(guitarChordTab);
  guitarChordTabRef.current = guitarChordTab;
  useEffect(() => {
    if (!showLibrary || !selectedChord || guitarPosition < 0) {
      setEditableGuitarTab(null);
      prevLibraryFretKeyRef.current = '';
      return;
    }
    const key = `${selectedChord.symbol}|${guitarPosition}|${voicingSourceSig}`;
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
  }, [showLibrary, selectedChord?.symbol, guitarPosition, voicingSourceSig, dbShapes]);

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

      const { tabs } = lookupChordShapes(chord.symbol, customChordsOverride);
      const barreIdx = findFirstBarreIndex(tabs);
      setGuitarPosition(barreIdx);
    }
    
    setGuitarVoicingVariant(0);
  }, [repeatPicker, activeSong, customChordsOverride]);

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

const TUNING = [4, 9, 2, 7, 11, 4]; // E A D G B e

/** Returns the index of the first "barre" shape in the list (3+ non-open strings on same fret). Defaults to 0 correctly. */
function findFirstBarreIndex(tabs: GuitarTab[]): number {
  const barreIdx = tabs.findIndex(tab => {
    const frets = tab.filter((f): f is number => f != null && f > 0);
    const counts: Record<number, number> = {};
    frets.forEach(f => (counts[f] = (counts[f] || 0) + 1));
    // 3 or more strings on the same fret typically indicates a barre (standard E, A shapes etc.)
    return Object.values(counts).some(c => c >= 3);
  });
  return barreIdx >= 0 ? barreIdx : 0;
}

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
    <div className={`instrument-card ${expanded ? 'expanded-card' : 'staff-card'}`}>
      <div className="instrument-header">
        <span className={staffLabel ? 'instrument-chord-name' : 'instrument-label'}>
          {staffLabel || 'Staff'}
        </span>
        <div className="instrument-header-actions">
          {staffNotes.length > 0 && (
            <button
              className={`staff-names-btn ${showStaffNoteNames ? 'active' : ''}`}
              onClick={() => setShowStaffNoteNames(v => !v)}
              title={showStaffNoteNames ? 'Hide note names' : 'Show note names'}
            >
              Names
            </button>
          )}
          <button
            className="expand-btn"
            onClick={() => toggleCollapse('staff')}
            title={collapsedInstruments.has('staff') ? 'Expand notation panel' : 'Collapse notation panel'}
          >
            {collapsedInstruments.has('staff') ? '+' : '−'}
          </button>
        </div>
      </div>
      <div className="instrument-card-body">
        {!collapsedInstruments.has('staff') && (
          <Staff
            key={`staff-${expanded}`}
            notes={staffNotes}
            mode={staffMode}
            keySignature={activeSong!.key}
            showNoteNames={showStaffNoteNames}
            noteColors={staffNoteColors}
          />
        )}
      </div>
      <div className="instrument-card-footer">
        <button
          type="button"
          className="expand-btn instrument-panel-expand"
          onClick={() => toggleExpand('staff')}
          title={expanded ? 'Collapse panel' : 'Expand panel'}
        >
          {expanded ? '△' : '▽'}
        </button>
      </div>
    </div>
  );

  const pianoVoicingIdx = VOICING_OPTIONS.findIndex(o => o.value === voicingType);

  const renderAnalysis = () => {
    if (selectedScale) return null;
    if (tappedMidis.size === 0 && !tappedGuitarTab) return null;

    let activeNotes: string[] = [];
    if (mirrorGuitarToPiano) {
      const pNotes = Array.from(tappedMidis).map(m => Note.fromMidi(m)).filter((n): n is string => n != null);
      const gNotes = tappedGuitarTab ? tabToMidiNotes(tappedGuitarTab, true) : [];
      activeNotes = [...new Set([...pNotes, ...gNotes])].sort((a,b) => (Note.midi(a)??0) - (Note.midi(b)??0));
    } else {
      if (tappedMidis.size > 0) {
        activeNotes = Array.from(tappedMidis).map(m => Note.fromMidi(m)).filter((n): n is string => n != null).sort((a,b) => (Note.midi(a)??0) - (Note.midi(b)??0));
      } else if (tappedGuitarTab) {
        activeNotes = tabToMidiNotes(tappedGuitarTab, true).sort((a,b) => (Note.midi(a)??0) - (Note.midi(b)??0));
      }
    }

    if (activeNotes.length === 0) return null;

    return (
      <div className="piano-analysis" style={{ marginTop: '12px' }}>
        <div className="analysis-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800 }}>Chord Identification</span>
            <div className="analysis-notes" style={{ fontSize: '11px', opacity: 0.8, background: 'rgba(255,255,255,0.05)', padding: '1px 6px', borderRadius: '4px' }}>
              {activeNotes.map(n => Note.get(n).pc).join(', ')}
            </div>
          </div>
          <button className="clear-btn" onClick={() => { setTappedMidis(new Set()); setTappedGuitarTab(null); }}>Clear</button>
        </div>
        <div className="detected-list">
          {(() => {
            const analysis = interactiveAnalysis;
            if (analysis.library.length > 0 || analysis.theory.length > 0) {
              return (
                <>
                  {analysis.library.map((c: string) => (
                    <span key={c} className="detected-chord library-match" title="Found in library">
                      {c}
                    </span>
                  ))}
                  {analysis.theory.map((c: string) => (
                    <span key={c} className="detected-chord theory-match" title="Theory match">
                      {c}
                    </span>
                  ))}
                </>
              );
            }
            if (activeNotes.length < 3) return <span className="analysis-empty">Add more notes...</span>;
            return <span className="analysis-empty">No chord identified</span>;
          })()}
        </div>
      </div>
    );
  };

  const renderPiano = (expanded: boolean) => (
    <div className={`instrument-card ${expanded ? 'expanded-card' : 'piano-card'}`}>
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
          <button
            className="expand-btn"
            onClick={() => toggleCollapse('piano')}
            title={collapsedInstruments.has('piano') ? 'Expand piano panel' : 'Collapse piano panel'}
          >
            {collapsedInstruments.has('piano') ? '+' : '−'}
          </button>
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
            onToggleNote={handleTogglePianoNote}
            activeMidis={tappedMidis.size > 0 ? tappedMidis : (tappedGuitarTab ? new Set(tabToMidiNotes(tappedGuitarTab, true).map(n => Note.midi(n)).filter((m): m is number => m != null)) : undefined)}
          />
          {renderAnalysis()}
        </div>
      )}
      </div>
      <div className="instrument-card-footer">
        <button
          type="button"
          className="expand-btn instrument-panel-expand"
          onClick={() => toggleExpand('piano')}
          title={expanded ? 'Collapse panel' : 'Expand panel'}
        >
          {expanded ? '△' : '▽'}
        </button>
      </div>
    </div>
  );

  const guitarOptionLabels = useMemo(() => {
    const labels: { value: number; label: string }[] = [{ value: -1, label: 'All Frets' }];
    guitarPositions.forEach((p, i) => labels.push({ value: i, label: p.label }));
    return labels;
  }, [guitarPositions]);

  const guitarOptionIdx = guitarOptionLabels.findIndex(o => o.value === guitarPosition);

  useLayoutEffect(() => {
    if (prevFretboardInstrumentRef.current !== fretboardInstrument) {
      if (prevFretboardInstrumentRef.current !== null) {
        fretboardCompactEnterWidthRef.current = 0;
        setFretboardPosCompact(false);
        setFretboardPosMenuOpen(false);
      }
      prevFretboardInstrumentRef.current = fretboardInstrument;
    }

    const HYSTERESIS_PX = 100;
    const GUITAR_PILLS_PAD_PX = 10;

    const isGuitarGrid =
      fretboardInstrument === 'guitar' &&
      displayNotes.length > 0 &&
      expandedInstrument !== 'guitar';

    if (isGuitarGrid) {
      const checkGuitarGrid = () => {
        const minW = guitarPillsMeasureRowRef.current?.offsetWidth ?? 0;
        const boardW = guitarFretboardBoardRef.current?.clientWidth;
        const footerW = guitarPosFooterRef.current?.clientWidth;
        const cw = boardW ?? footerW ?? 0;
        if (minW <= 0 || cw <= 0) return;

        setFretboardPosCompact((prev) => {
          if (!prev) {
            if (cw < minW + GUITAR_PILLS_PAD_PX) {
              fretboardCompactEnterWidthRef.current = cw;
              return true;
            }
          } else {
            const minExit = Math.max(
              fretboardCompactEnterWidthRef.current + HYSTERESIS_PX,
              minW + GUITAR_PILLS_PAD_PX,
            );
            if (cw >= minExit) return false;
          }
          return prev;
        });
      };

      const ro = new ResizeObserver(() => {
        requestAnimationFrame(checkGuitarGrid);
      });
      const board = guitarFretboardBoardRef.current;
      const row = guitarPillsMeasureRowRef.current;
      if (board) ro.observe(board);
      if (row) ro.observe(row);
      checkGuitarGrid();
      return () => ro.disconnect();
    }

    if (fretboardInstrument !== 'bass') {
      return;
    }

    const el = fretboardHeaderActionsRef.current;
    if (!el) return;
    /** Below this, bass pills + mode + utilities overlap/stack even when scrollWidth matches (flex shrink). */
    const MIN_WIDTH_FOR_PILLS_PX = 520;

    const check = () => {
      const cw = el.clientWidth;
      const sw = el.scrollWidth;
      const overflowsX = sw > cw + 2;
      const tooNarrowForPills = cw < MIN_WIDTH_FOR_PILLS_PX;
      setFretboardPosCompact((prev) => {
        if (!prev) {
          if (overflowsX || tooNarrowForPills) {
            fretboardCompactEnterWidthRef.current = cw;
            return true;
          }
        } else {
          const minExit = Math.max(
            fretboardCompactEnterWidthRef.current + HYSTERESIS_PX,
            MIN_WIDTH_FOR_PILLS_PX,
          );
          if (cw >= minExit) {
            return false;
          }
        }
        return prev;
      });
    };

    check();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(check);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    expandedInstrument,
    collapsedInstruments,
    fretboardInstrument,
    currentSong,
    displayNotes.length,
    guitarOptionLabels.length,
  ]);

  useEffect(() => {
    if (!fretboardPosCompact) setFretboardPosMenuOpen(false);
  }, [fretboardPosCompact]);

  useEffect(() => {
    if (!fretboardPosMenuOpen) return;
    const onPtr = (e: PointerEvent) => {
      const w = posNavMenuWrapRef.current;
      if (w && !w.contains(e.target as Node)) setFretboardPosMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFretboardPosMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPtr);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPtr);
      document.removeEventListener('keydown', onKey);
    };
  }, [fretboardPosMenuOpen]);

  const renderGuitar = (expanded: boolean) => {
    const showGuitarPositions =
      fretboardInstrument === 'guitar' && displayNotes.length > 0;
    const guitarPosCompactUI = !expanded && fretboardPosCompact;

    const guitarPositionNav = showGuitarPositions ? (
      <div className="guitar-position-nav">
        {guitarPosCompactUI ? (
          <div className="pos-nav-menu-wrap" ref={posNavMenuWrapRef}>
            <button
              type="button"
              className={`pos-nav-hamburger cycle-btn guitar-pos-arrow ${fretboardPosMenuOpen ? 'active' : ''}`}
              aria-expanded={fretboardPosMenuOpen}
              aria-haspopup="menu"
              aria-label="Fret positions"
              title="Fret positions"
              onClick={() => setFretboardPosMenuOpen((o) => !o)}
            >
              <span className="pos-nav-hamburger-icon" aria-hidden>
                ☰
              </span>
            </button>
            {fretboardPosMenuOpen && (
              <div
                className={`pos-nav-menu${guitarOptionLabels.length > 2 ? ' pos-nav-menu--grid' : ''}`}
                role="menu"
              >
                {guitarOptionLabels.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitem"
                    className={`pos-nav-menu-item ${guitarPosition === opt.value ? 'active' : ''}`}
                    onClick={() => {
                      setGuitarPosition(opt.value);
                      setGuitarVoicingVariant(0);
                      setFretboardPosMenuOpen(false);
                    }}
                  >
                    {opt.label === 'All Frets' ? 'All' : opt.label.replace('Pos ', 'P')}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
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
        )}
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
        startFret={fretboardInstrument === 'guitar' ? guitarDisplayStartFret : fretRange.startFret}
        endFret={fretboardInstrument === 'guitar' ? guitarDisplayEndFret : fretRange.endFret}
        mode={fretboardInstrument === 'bass' ? 'scale' : fretboardMode}
        strings={fretboardInstrument === 'bass' ? BASS_STRINGS : undefined}
        degreeColorMap={chromaColorMap}
        chordTab={guitarChordTabForFretboard}
        editable={fretboardInstrument === 'guitar'}
        onFretClick={
          fretboardInstrument === 'guitar'
            ? isFretboardEditable
              ? handleFretClick
              : handleToggleGuitarFret
            : undefined
        }
        onFretPeek={fretboardInstrument === 'guitar' ? handleGuitarFretPeek : undefined}
        showNoteLabels={fretboardInstrument !== 'bass'}
        pitchClassLabels={fretboardInstrument === 'bass'}
        getFretDotLabel={fretboardInstrument === 'bass' ? bassFretDotLabel : undefined}
        dedupeHighlightGhostToLowest={false}
        stringOpenMidis={fretboardInstrument === 'bass' ? BASS_OPEN_MIDIS : undefined}
      />
    );

    return (
    <div
      className={`instrument-card ${expanded ? 'expanded-card' : 'fretboard-card'}${
        fretboardPosMenuOpen ? ' instrument-card--pos-menu-open' : ''
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
            {fretboardInstrument === 'bass' && (
              <>
                {fretboardPosCompact ? (
                  <div className="position-buttons position-buttons--compact">
                    <div className="pos-nav-menu-wrap" ref={posNavMenuWrapRef}>
                      <button
                        type="button"
                        className={`pos-nav-hamburger pos-nav-hamburger--bass cycle-btn ${fretboardPosMenuOpen ? 'active' : ''}`}
                        aria-expanded={fretboardPosMenuOpen}
                        aria-haspopup="menu"
                        aria-label="Bass positions"
                        title="Bass positions"
                        onClick={() => setFretboardPosMenuOpen((o) => !o)}
                      >
                        <span className="pos-nav-hamburger-icon" aria-hidden>
                          ☰
                        </span>
                      </button>
                      {fretboardPosMenuOpen && (
                        <div className="pos-nav-menu pos-nav-menu--grid" role="menu">
                          {BASS_POSITIONS.map((pos, idx) => (
                            <button
                              key={pos.label}
                              type="button"
                              role="menuitem"
                              className={`pos-nav-menu-item ${bassPosition === idx ? 'active' : ''}`}
                              onClick={() => {
                                setBassPosition(idx as 0 | 1 | 2);
                                setFretboardPosMenuOpen(false);
                              }}
                            >
                              {pos.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="position-buttons">
                    {BASS_POSITIONS.map((pos, idx) => (
                      <button
                        key={pos.label}
                        type="button"
                        className={`pos-btn ${bassPosition === idx ? 'active' : ''}`}
                        onClick={() => setBassPosition(idx as 0 | 1 | 2)}
                      >
                        {pos.label}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className={`staff-names-btn ${showBassAllNoteNames ? 'active' : ''}`}
                  onClick={() => setShowBassAllNoteNames(v => !v)}
                  title={
                    showBassAllNoteNames
                      ? 'Names: chord root + scale/chord tones (pitch class on each dot)'
                      : 'Names: chord root only on the board'
                  }
                >
                  Names
                </button>
              </>
            )}
            {guitarChordToolsUnlocked &&
              fretboardInstrument === 'guitar' &&
              isFretboardEditable &&
              editableGuitarTab != null && (
              <button
                className="save-chord-btn"
                type="button"
                onClick={handleSaveShape}
                title={`Save this shape as default for Pos ${guitarPosition + 1}`}
                style={{ marginLeft: '6px', background: 'var(--bg-lighter)', border: '1px solid var(--border-color)', cursor: 'pointer' }}
              >
                Save Default
              </button>
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
            {showGuitarPositions && expanded && guitarPositionNav}
            {fretboardInstrument === 'guitar' && (
              <button
                type="button"
                className={`expand-btn ${mirrorGuitarToPiano ? 'active' : ''}`}
                onClick={() => {
                  const next = !mirrorGuitarToPiano;
                  setMirrorGuitarToPiano(next);
                  if (next) setVoicingType('guitar');
                  else if (voicingType === 'guitar') setVoicingType('all');
                }}
                title={mirrorGuitarToPiano ? 'Disconnect from Piano' : 'Mirror notes to Piano'}
                style={{
                  color: mirrorGuitarToPiano ? 'var(--accent-primary)' : 'inherit',
                  background: mirrorGuitarToPiano ? 'var(--accent-primary-dim)' : 'transparent',
                }}
              >
                🔗
              </button>
            )}
            <button
              type="button"
              className="expand-btn"
              onClick={() => toggleCollapse('guitar')}
              title={collapsedInstruments.has('guitar') ? 'Expand guitar panel' : 'Collapse guitar panel'}
            >
              {collapsedInstruments.has('guitar') ? '+' : '−'}
            </button>
          </div>
        </div>
      </div>
      <div className="instrument-card-body">
      {!collapsedInstruments.has('guitar') && (
        <>
          {fretboardInstrument === 'guitar' && displayNotes.length > 0 ? (
            <div className="fretboard-with-pos-arrows">
              {guitarChordToolsUnlocked && fretboardMode === 'chord' && guitarChordFretWindow != null && (
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
                  const nextIdx = (guitarOptionIdx - 1 + guitarOptionLabels.length) % guitarOptionLabels.length;
                  setGuitarPosition(guitarOptionLabels[nextIdx].value);
                  setGuitarVoicingVariant(0);
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
                  const nextIdx = (guitarOptionIdx + 1) % guitarOptionLabels.length;
                  setGuitarPosition(guitarOptionLabels[nextIdx].value);
                  setGuitarVoicingVariant(0);
                }}
              >
                ▶
              </button>
              {guitarChordToolsUnlocked && fretboardMode === 'chord' && guitarChordFretWindow != null && (
                <button
                  type="button"
                  className="fretboard-pos-arrow fretboard-chord-shift-arrow"
                  aria-label="Shift neck view toward body"
                  title="Shift view toward body"
                  disabled={guitarChordFretWindow.endFret >= GUITAR_CHORD_MAX_FRET}
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
          ) : (
            renderAnalysis()
          )}
        </>
      )}
      </div>
      <div
        className={`instrument-card-footer${
          showGuitarPositions && !expanded ? ' instrument-card-footer--fretboard' : ''
        }`}
      >
        {showGuitarPositions && !expanded && (
          <div className="guitar-position-footer" ref={guitarPosFooterRef}>
            <div className="guitar-pos-pills-measure" aria-hidden>
              <div
                ref={guitarPillsMeasureRowRef}
                className="position-buttons guitar-position-buttons"
              >
                {guitarOptionLabels.map((opt) => (
                  <button key={opt.value} type="button" tabIndex={-1} disabled className="pos-btn">
                    {opt.label === 'All Frets' ? 'All' : opt.label.replace('Pos ', 'P')}
                  </button>
                ))}
              </div>
            </div>
            {guitarPositionNav}
          </div>
        )}
        <div className="instrument-card-footer-actions">
          <button
            type="button"
            className="expand-btn instrument-panel-expand"
            onClick={() => toggleExpand('guitar')}
            title={expanded ? 'Collapse panel' : 'Expand panel'}
          >
            {expanded ? '△' : '▽'}
          </button>
        </div>
      </div>
    </div>
    );
  };

  const handleSaveShape = useCallback(async () => {
    if (!selectedChord || guitarPosition < 0) return;
    
    // Use the actual current editable tab if it exists
    const tabToSave = (isFretboardEditable && editableGuitarTab) ? editableGuitarTab : guitarChordTab;
    if (!tabToSave || tabToSave.length !== 6) {
      setSaveStatus('Not saved — no voicing to save (select a chord & position)');
      setTimeout(() => setSaveStatus(null), 4000);
      return;
    }
    
    // The database and localStorage expect physical order [low E ... high e]
    const tabPhysical = [...tabToSave].reverse();
    const symbol = canonicalChordSymbol(selectedChord.symbol);
    const positionIdx = guitarPosition;

    if (!tabMatchesChordSymbol(tabPhysical, selectedChord.symbol, selectedChord.notes)) {
      setSaveStatus('Not saved — frets must match chord tones (incl. root), ≥3 strings');
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
  }, [selectedChord, guitarPosition, guitarChordTab, isFretboardEditable, editableGuitarTab]);

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
            )}

            {expandedInstrument === 'staff' && renderStaff(true)}
            {expandedInstrument === 'piano' && renderPiano(true)}
            {expandedInstrument === 'guitar' && renderGuitar(true)}
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
