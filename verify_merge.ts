
import { lookupChordShapes } from './src/engine/chordDatabase';

// Mocking customChords.json values (as they are imported in chordDatabase.ts)
// System Cm7 has 2 shapes.
// System Cmaj7 has 5 shapes.

console.log("--- Testing Merge Logic ---");

// Test 1: No overrides
const res1 = lookupChordShapes("Cm7", null);
console.log("Cm7 (no override) tabs:", res1.tabs.length);
// Expected: at least 5 (padded)

// Test 2: Override one position for Cm7
const mockOverride = {
    "Cm7": [
        [0, 1, 2, 3, 4, 5], // Pos 0 override
        null
    ]
};
const res2 = lookupChordShapes("Cm7", mockOverride);
console.log("Cm7 (with override) Pos 0:", res2.tabs[0]);
console.log("Cm7 (with override) Pos 1 (should be system):", res2.tabs[1]);

// Test 3: Template merge
const mockTemplateOverride = {
    "Cm7": [
        [1, 1, 1, 1, 1, 1], // C template override
        null
    ]
};
const res3 = lookupChordShapes("Dm7", mockTemplateOverride);
console.log("Dm7 (using C template override) Pos 0:", res3.tabs[0]);
// Should be [1,1,1,1,1,1] + 2 frets = [3,3,3,3,3,3]

console.log("--- Verification Done ---");
