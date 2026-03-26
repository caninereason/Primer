# Guitar tab validator - checks physical playability
# Tab format: list of 6 fret numbers, -1 = muted string
# Strings ordered low E to high E: [E, A, D, G, B, e]

STANDARD_TUNING = [0, 5, 10, 15, 19, 24]  # semitones from low E

def validate_tab(tab, max_span=4, max_fingers=4):
    """
    Returns (is_valid, reasons) tuple.
    tab = [6 ints], -1 for muted, 0 for open, 1+ for fretted
    """
    issues = []
    
    fretted = [f for f in tab if f > 0]
    
    # 1. Span check
    if fretted:
        span = max(fretted) - min(fretted)
        if span > max_span:
            issues.append(f"Span too wide: {span} frets (max {max_span})")
    
    # 2. Finger count check
    # Notes on same fret adjacent strings = potential barre (1 finger)
    # All other fretted notes = 1 finger each
    fingers_needed = count_fingers(tab)
    if fingers_needed > max_fingers:
        issues.append(f"Needs {fingers_needed} fingers (max {max_fingers})")
    
    # 3. Open string below fretted check
    # Muting a string between two sounding strings is awkward
    sounding = [i for i, f in enumerate(tab) if f != -1]
    if sounding:
        low, high = min(sounding), max(sounding)
        for i in range(low, high):
            if tab[i] == -1:
                issues.append(f"Muted string {i+1} between sounding strings (awkward)")
    
    # 4. Extreme fret position
    if fretted and max(fretted) > 15:
        issues.append(f"Very high fret position ({max(fretted)}), hard to reach")
    
    return len(issues) == 0, issues


def count_fingers(tab):
    """
    Estimate fingers needed accounting for barre detection.
    A barre = multiple adjacent strings at the same lowest fret.
    """
    fretted = [(i, f) for i, f in enumerate(tab) if f > 0]
    if not fretted:
        return 0
    
    min_fret = min(f for _, f in fretted)
    
    # Find barre candidates: adjacent strings at the minimum fret
    barre_strings = [i for i, f in fretted if f == min_fret]
    is_barre = False
    if len(barre_strings) >= 2:
        # Check if they're consecutive strings
        barre_strings.sort()
        if barre_strings == list(range(barre_strings[0], barre_strings[-1]+1)):
            is_barre = True
    
    # Count fingers: barre = 1 finger, everything else = 1 each
    barre_notes = set(barre_strings) if is_barre else set()
    other_notes = [(i, f) for i, f in fretted if i not in barre_notes]
    
    # Deduplicate same fret (unlikely but possible)
    unique_other_frets = len(set(f for _, f in other_notes))
    
    return (1 if is_barre else len(barre_strings)) + unique_other_frets


def tab_to_notes(tab):
    """Convert tab to semitone values for basic pitch content check."""
    notes = []
    for string_idx, fret in enumerate(tab):
        if fret >= 0:
            notes.append((STANDARD_TUNING[string_idx] + fret) % 12)
    return notes


# ─── Usage examples ───────────────────────────────────────

tests = {
    "Open G":       [3, 2, 0, 0, 0, 3],
    "E barre (A)":  [-1, 0, 2, 2, 2, 0],
    "Impossible":   [0, -1, -1, 9, -1, 12],
    "Too many":     [2, 3, 4, 5, 6, 7],
    "Awkward mute": [0, -1, 2, 2, 0, 0],
    "Cmaj7":        [-1, 3, 2, 0, 0, 0],
}

for name, tab in tests.items():
    valid, issues = validate_tab(tab)
    status = "✅ OK" if valid else "❌ INVALID"
    print(f"{name:20} {status}")
    for issue in issues:
        print(f"  → {issue}")
