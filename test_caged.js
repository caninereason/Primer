"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var chordDatabase_1 = require("./src/engine/chordDatabase");
function testChord(symbol) {
    console.log("\n--- Shapes for ".concat(symbol, " ---"));
    var res = (0, chordDatabase_1.lookupChordShapes)(symbol);
    res.tabs.forEach(function (tab, i) {
        console.log("Pos ".concat(i + 1, ":"), JSON.stringify(tab));
    });
}
testChord('Cmaj7');
testChord('C7');
