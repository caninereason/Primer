import { Note, Chord } from 'tonal';
import { computeVoicing, type VoicingType } from './voicingEngine';
import type { Measure, ChordInfo } from '../types/music';
import { generateWalkingBassBar } from './walk';

interface BeatEvent {
  measureIdx: number;
  chordIdx: number;
  chordChange: boolean;
  accent: boolean;
  midiNotes: number[];
  bassMidi: number;
}

function chordToMidi(chord: ChordInfo, voicingType: VoicingType): number[] {
  if (voicingType !== 'all') {
    const v = computeVoicing(chord.symbol, voicingType);
    if (v) {
      const all = [...v.leftHand, ...v.rightHand];
      const midis = all.map(n => Note.midi(n)).filter((m): m is number => m != null);
      if (midis.length > 0) return midis;
    }
  }

  const parsed = Chord.get(chord.symbol);
  const notes = parsed.notes.length > 0 ? parsed.notes : chord.notes;
  if (notes.length === 0) return [];

  const rootCh = Note.chroma(chord.root);
  if (rootCh == null) return [];

  let rootMidi = 48 + rootCh;
  if (rootMidi > 54) rootMidi -= 12;

  const midis: number[] = [];
  let prev = rootMidi - 1;

  for (const n of notes) {
    const ch = Note.chroma(n);
    if (ch == null) continue;
    let midi = 48 + ch;
    while (midi <= prev) midi += 12;
    if (midi > 72) midi -= 12;
    midis.push(midi);
    prev = midi;
  }

  return midis;
}

function buildTimeline(
  measures: Measure[],
  beatsPerMeasure: number,
  voicingType: VoicingType = 'all',
): BeatEvent[] {
  const beats: BeatEvent[] = [];
  let lastNotes: number[] = [];
  let lastMi = 0;
  let lastCi = 0;

  for (let mi = 0; mi < measures.length; mi++) {
    const m = measures[mi];
    const hasChords = m.chords.length > 0;
    const numSlots = hasChords ? m.chords.length : 1;

    let beatInMeasure = 0;
    for (let ci = 0; ci < numSlots; ci++) {
      const chordBeats = ci < numSlots - 1
        ? Math.round(beatsPerMeasure / numSlots)
        : beatsPerMeasure - beatInMeasure;

      const chord = hasChords ? m.chords[ci] : null;
      const isChange = chord != null;
      const nextChord = (() => {
        if (!isChange) return null;
        for (let m2 = mi; m2 < measures.length; m2++) {
          const startCi = m2 === mi ? ci + 1 : 0;
          for (let c2 = startCi; c2 < measures[m2].chords.length; c2++) {
            return measures[m2].chords[c2];
          }
        }
        return null;
      })();
      const bassBar = chord
        ? generateWalkingBassBar(chord, nextChord, chordBeats, mi + ci)
        : Array.from({ length: chordBeats }, () => 36);

      if (isChange) {
        lastNotes = chordToMidi(chord, voicingType);
        lastMi = mi;
        lastCi = ci;
      }

      for (let b = 0; b < chordBeats; b++) {
        beats.push({
          measureIdx: isChange ? mi : lastMi,
          chordIdx: isChange ? ci : lastCi,
          chordChange: b === 0 && isChange,
          accent: beatInMeasure === 0,
          midiNotes: lastNotes,
          bassMidi: bassBar[b] ?? bassBar[bassBar.length - 1] ?? 36,
        });
        beatInMeasure++;
      }
    }
  }

  return beats;
}

export type PlayerCallback = (measureIdx: number, chordIdx: number) => void;
export type BassBeatCallback = (bassMidi: number) => void;

export type RepeatMark = { measureIdx: number; chordIdx: number };

export class ChordPlayer {
  private ctx: AudioContext | null = null;
  private timeline: BeatEvent[] = [];
  private bpm = 120;
  private beat = 0;
  private _playing = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private activeOscs: OscillatorNode[] = [];
  private activeGains: GainNode[] = [];
  private onBeat: PlayerCallback | null = null;
  private onBassBeat: BassBeatCallback | null = null;
  private onDone: (() => void) | null = null;
  private lastMeasures: Measure[] = [];
  private lastTimeSig = '4/4';
  loop = true;
  metronomeOn = true;
  pianoOn = true;
  bassOn = true;
  private bassVolume = 0.75;
  private swingPercent = 50;
  private repeatFrom: RepeatMark | null = null;
  private repeatTo: RepeatMark | null = null;
  private repeatStartBeat = 0;
  private repeatEndBeat = -1;

  setCallbacks(onBeat: PlayerCallback, onDone: () => void, onBassBeat?: BassBeatCallback) {
    this.onBeat = onBeat;
    this.onDone = onDone;
    this.onBassBeat = onBassBeat ?? null;
  }

  load(measures: Measure[], bpm: number, timeSig: string, voicingType: VoicingType = 'all') {
    this.bpm = Math.max(30, Math.min(300, bpm));
    this.lastMeasures = measures;
    this.lastTimeSig = timeSig;
    const bpb = parseInt(timeSig.split('/')[0]) || 4;
    this.timeline = buildTimeline(measures, bpb, voicingType);
    this.beat = 0;
    this.updateRepeatBeats();
  }

  setRepeatRange(from: RepeatMark | null, to: RepeatMark | null) {
    this.repeatFrom = from;
    this.repeatTo = to;
    this.updateRepeatBeats();
  }

  private updateRepeatBeats() {
    if (this.timeline.length === 0) {
      this.repeatStartBeat = 0;
      this.repeatEndBeat = -1;
      return;
    }
    let start = -1;
    let end = -1;
    if (this.repeatFrom) {
      const from = this.repeatFrom;
      for (let i = 0; i < this.timeline.length; i++) {
        const ev = this.timeline[i];
        if (ev.measureIdx === from.measureIdx && ev.chordIdx === from.chordIdx && ev.chordChange && start < 0) {
          start = i;
          break;
        }
      }
      this.repeatStartBeat = start >= 0 ? start : 0;
    } else {
      this.repeatStartBeat = 0;
    }
    if (this.repeatTo) {
      const to = this.repeatTo;
      for (let i = 0; i < this.timeline.length; i++) {
        const ev = this.timeline[i];
        if (ev.measureIdx === to.measureIdx && ev.chordIdx === to.chordIdx) end = i;
      }
      this.repeatEndBeat = end >= 0 ? end : -1;
    } else {
      this.repeatEndBeat = this.timeline.length - 1;
    }
  }

  /** Update voicing for playback; keeps current beat. Call while playing to change sound. */
  setVoicingType(voicingType: VoicingType) {
    if (this.lastMeasures.length === 0) return;
    const bpb = parseInt(this.lastTimeSig.split('/')[0]) || 4;
    this.timeline = buildTimeline(this.lastMeasures, bpb, voicingType);
    this.beat = Math.min(this.beat, Math.max(0, this.timeline.length - 1));
    this.updateRepeatBeats();
  }

  get playing() { return this._playing; }

  play(startBeat = 0) {
    if (this.timeline.length === 0) return;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    this._playing = true;
    if (startBeat === 0 && this.repeatFrom != null && this.repeatStartBeat >= 0) {
      this.beat = this.repeatStartBeat;
    } else {
      this.beat = startBeat;
    }
    this.tick();
  }

  stop() {
    this._playing = false;
    if (this.timerId != null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.releaseChord();
    this.onDone?.();
  }

  setBpm(bpm: number) {
    this.bpm = Math.max(30, Math.min(300, bpm));
  }

  setPianoOn(on: boolean) {
    this.pianoOn = on;
    if (!on) this.releaseChord();
  }

  setBassOn(on: boolean) {
    this.bassOn = on;
  }

  setBassVolume(volume: number) {
    this.bassVolume = Math.max(0, Math.min(1, volume));
  }

  setSwingPercent(percent: number) {
    this.swingPercent = Math.max(50, Math.min(75, percent));
  }

  private tick() {
    if (!this._playing || !this.ctx) return;

    const hasRepeatRange = this.repeatFrom != null && this.repeatEndBeat >= 0;

    if (this.beat >= this.timeline.length) {
      if (this.loop) {
        this.beat = hasRepeatRange ? this.repeatStartBeat : 0;
        this.releaseChord();
      } else {
        this.stop();
        return;
      }
    } else if (this.loop && hasRepeatRange && this.beat > this.repeatEndBeat) {
      this.beat = this.repeatStartBeat;
      this.releaseChord();
    }

    const ev = this.timeline[this.beat];
    const now = this.ctx.currentTime;

    if (this.metronomeOn) this.playClick(now, ev.accent);
    if (this.bassOn) this.playBass(now, ev.bassMidi);
    this.onBassBeat?.(ev.bassMidi);

    if (ev.chordChange && this.pianoOn) {
      this.releaseChord();
      this.playChord(ev.midiNotes, now);
      this.onBeat?.(ev.measureIdx, ev.chordIdx);
    } else if (ev.chordChange) {
      this.onBeat?.(ev.measureIdx, ev.chordIdx);
    }

    const currentBeat = this.beat;
    this.beat++;
    const baseMs = (60 / this.bpm) * 1000;
    const swingRatio = this.swingPercent / 100;
    const ms = currentBeat % 2 === 0
      ? baseMs * 2 * swingRatio
      : baseMs * 2 * (1 - swingRatio);
    this.timerId = setTimeout(() => this.tick(), ms);
  }

  private playClick(time: number, accent: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(accent ? 0.18 : 0.09, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.connect(g).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.05);
  }

  private playChord(midis: number[], time: number) {
    if (!this.ctx || midis.length === 0) return;
    const baseVol = 0.2 / Math.sqrt(midis.length);
    // Piano-like partials: fundamental + harmonics with decreasing level
    const partials = [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.35 },
      { ratio: 3, gain: 0.2 },
      { ratio: 4, gain: 0.08 },
      { ratio: 5, gain: 0.04 },
    ];

    for (const midi of midis) {
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      for (const { ratio, gain } of partials) {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * ratio;
        const vol = baseVol * gain;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(vol, time + 0.008);
        g.gain.exponentialRampToValueAtTime(vol * 0.15, time + 0.4);
        osc.connect(g).connect(this.ctx.destination);
        osc.start(time);
        this.activeOscs.push(osc);
        this.activeGains.push(g);
      }
    }
  }

  private playBass(time: number, midi: number) {
    if (!this.ctx) return;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;

    const g = this.ctx.createGain();
    const mainVol = 0.2 * this.bassVolume;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(mainVol, time + 0.015);
    g.gain.exponentialRampToValueAtTime(mainVol * 0.7, time + 0.2);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.42);

    const osc1 = this.ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.value = freq;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;

    const g2 = this.ctx.createGain();
    g2.gain.value = 0.26;

    osc1.connect(filter);
    osc2.connect(g2).connect(filter);
    filter.connect(g).connect(this.ctx.destination);

    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + 0.48);
    osc2.stop(time + 0.48);
  }

  private releaseChord() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const releaseTime = 0.12;
    for (const g of this.activeGains) {
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + releaseTime);
      } catch { /* already stopped */ }
    }
    for (const osc of this.activeOscs) {
      try { osc.stop(now + releaseTime + 0.01); } catch { /* already stopped */ }
    }
    this.activeOscs = [];
    this.activeGains = [];
  }
}
