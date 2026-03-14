import { lookupChordShapes } from './src/engine/chordDatabase.js';

console.log('--- Cmaj11 ---');
console.log(JSON.stringify(lookupChordShapes('Cmaj11')));

console.log('--- Cm6/9 ---');
console.log(JSON.stringify(lookupChordShapes('Cm6/9')));

console.log('--- Cmaj7 ---');
console.log(JSON.stringify(lookupChordShapes('Cmaj7')));
