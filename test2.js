"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var chordDatabase_js_1 = require("./src/engine/chordDatabase.js");
console.log('--- Cmaj11 ---');
console.log(JSON.stringify((0, chordDatabase_js_1.lookupChordShapes)('Cmaj11')));
console.log('--- Cm6/9 ---');
console.log(JSON.stringify((0, chordDatabase_js_1.lookupChordShapes)('Cm6/9')));
console.log('--- Cmaj7 ---');
console.log(JSON.stringify((0, chordDatabase_js_1.lookupChordShapes)('Cmaj7')));
