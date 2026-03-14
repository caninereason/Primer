/// <reference types="vite/client" />

declare module 'ireal-reader' {
  interface IRealMeasure {
    chords: string[];
    annots?: string[];
    timeSignature?: string;
  }

  interface IRealMusic {
    measures: IRealMeasure[];
  }

  interface IRealSong {
    title: string;
    composer: string;
    style: string;
    key: string;
    transpose: number | null;
    bpm: number;
    repeats: number;
    comp: string | null;
    timeSignature?: string;
    music: IRealMusic;
  }

  interface IRealPlaylist {
    name: string;
    songs: IRealSong[];
  }

  function iRealReader(data: string): IRealPlaylist;
  export default iRealReader;
}
