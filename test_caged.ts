import { lookupChordShapes } from './src/engine/chordDatabase';

function testChord(symbol: string) {
  console.log(`\n--- Shapes for ${symbol} ---`);
  const res = lookupChordShapes(symbol);
  res.tabs.forEach((tab, i) => {
    console.log(`Pos ${i + 1}:`, JSON.stringify(tab));
  });
}

testChord('Cmaj7');
testChord('C7');
