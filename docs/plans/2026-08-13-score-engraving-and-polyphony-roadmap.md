# Score Engraving and Polyphony Roadmap

## Purpose

This document describes future improvements to move ExactKeys score output
toward publication-quality MusicXML piano scores. All proposals are forward-
looking and none are implemented on `main` today unless stated otherwise.

Every enhancement below must satisfy the fail-closed certification contract
defined in `ACCURACY.md` and `AGENTS.md`. In particular:

- Certified score output (`score-note-v1`) requires 100 % MIDI-event
  verification, joint grid conformity at or above the fixed threshold
  (≥ 0.99), score fidelity of 1 after MusicXML reparse, and no unresolved
  blockers or unsupported semantics.
- Audio-derived notes remain permanently uncertified under the current product
  contract. Engraving improvements apply only to the deterministic MIDI path;
  they do not elevate audio drafts to certified status.

---

## 1. Chord Representation and Polyphonic Voice Support

### Current state on `main`

The score engine already groups notes that share an identical quantized onset
**and** identical quantized duration into chords. In `src/engine/score.ts`,
`groupChords()` buckets segments by their `startDivs:endDivs` key, and
`src/engine/musicxml.ts` emits a `<chord/>` element for every note after the
first in each group.

However, `hasUnsupportedPolyphony()` in `src/engine/score.ts` rejects any
input where same-staff notes overlap with **different** onsets or **different**
durations. When this condition is detected the score engine throws and
certification abstains, because the current single-voice-per-staff model
cannot represent independent rhythmic lines without dropping or altering
events.

### Proposed direction

- Support independent same-staff voices that differ in onset or duration.
  This requires assigning notes to distinct MusicXML `<voice>` IDs within
  each staff and interleaving them with correct `<backup>` and `<forward>`
  elements.
- The current `hasUnsupportedPolyphony()` gate would be relaxed only for
  inputs that the new voice allocator can represent exactly. Any polyphonic
  pattern that cannot be losslessly expressed must continue to cause
  abstention.
- No pre-quantization millisecond window may alter certified source events
  or quantized timing. All chord and voice decisions operate on the quantized
  grid, preserving exact event/quantized timing as certified.
- **Certification gate**: Independent voices require explicit score voice
  data, correct MusicXML `<backup>`/`<forward>` semantics, and exact reparse
  fidelity before certification. If the exporter cannot represent overlapping
  voices without dropping or altering a note, it must abstain.

---

## 2. Rolling Key-Change Detection

### Current state on `main`

Key resolution in `src/engine/quantize.ts` (`resolveKey()`) selects a single
key for the entire piece: from MIDI meta-event, user override, or
Krumhansl-Schmuckler detection over all pitches (`detectKey()` in
`src/engine/pitch.ts`). The detected key applies uniformly; pieces that
modulate retain one key signature throughout, producing unnecessary
accidentals in sections that have moved to a different tonal center.

Key detection affects enharmonic spelling only and never changes MIDI pitch
values. It is a notation decision, not a verified fact covered by the
`score-note-v1` certificate.

### Proposed direction

- Implement a sliding-window pitch-class histogram analysis to detect
  modulation boundaries. Candidate parameters — window width of **8
  measures**, step size of **2 measures**, confidence margin of **0.15** for
  accepting a new key — are hypotheses requiring fixture-backed validation
  with diverse modulating inputs before adoption.
- Insert updated `<key>` attributes at measure boundaries where modulation is
  detected.
- The spelling change must not break the reparse round trip or lower
  `scoreFidelityRate`.

---

## 3. Multi-Voice Staff Allocation

### Current state on `main`

Staff assignment is resolved in `src/engine/quantize.ts`
(`resolveStaffAssignment()`). In `auto` mode with exactly two MIDI note
tracks, notes are assigned to treble or bass staff by median-pitch ranking of
the two tracks. When there are not exactly two tracks, or in `pitch` mode,
notes are split by a configurable MIDI pitch threshold (default 60).
Independent contrapuntal voices within a staff are not tracked: all notes on
a staff share a single MusicXML `<voice>` element.

### Proposed direction

- Track pitch-continuity trajectories to assign notes to distinct voice lines
  within each staff, rather than relying solely on a pitch threshold.
- Represent independent voices with distinct MusicXML `<voice>` IDs. This
  requires correct use of MusicXML `<backup>` and `<forward>` elements to
  interleave voice timelines within a measure.
- **Certification gate**: Independent voices require explicit score voice
  data, correct `<backup>`/`<forward>` semantics, and exact reparse fidelity
  before certification. The reparse step must recover every voice's pitch,
  onset, and duration exactly. If the exporter cannot represent overlapping
  voices without dropping or altering a note, it must abstain rather than
  emit an inaccurate score.
- Voice-leading heuristics are notation decisions, not verified facts. They
  are not covered by the `score-note-v1` certificate and must not be
  presented as accuracy claims without a named ground-truth corpus, metric,
  and measured result.

---

## 4. Beat-Group-Aware Duration Splitting

### Current state on `main`

The score engine in `src/engine/score.ts` splits notes at measure boundaries
and emits `<tie>` / `<tied>` elements. Within a measure, `splitDuration()`
decomposes a duration into standard note values using a greedy largest-first
algorithm against a fixed table of binary or triplet durations.

This greedy decomposition is position-unaware: it does not consider where
within the measure a note starts. Common engraving practice splits durations
to expose principal beat boundaries (for example, a dotted quarter beginning
on beat 2 in 4/4 could be written as a quarter tied to an eighth so that
beat 3 is visible). The current implementation may produce valid but
unconventional rhythmic spellings in such cases.

### Proposed enhancement

- Extend the splitting logic to account for the note's position relative to
  beat-group boundaries within the measure, splitting at principal beats as
  standard engraving practice requires.
- Emit correct `<tie type="start"/>` / `<tie type="stop"/>` and
  `<notations><tied type="start|stop"/></notations>` pairs for every split.
- **Risk**: Position-aware splitting increases the number of tied fragments.
  Tied-note chains must round-trip exactly through the MusicXML reparse:
  collapsed tied durations must equal the original quantized duration for
  each note, and `scoreFidelityRate` must remain 1.

---

## 5. Engraving Regression Test Strategy

### Requirements

Any new engraving feature must be accompanied by tests that:

1. Invoke production code paths (not copied logic).
2. Include adversarial cases that would fail if the gate became less strict.
3. Verify MusicXML reparse fidelity: every pitch, quantized onset, and
   quantized duration must survive a write-then-read round trip with
   `scoreFidelityRate == 1`.
4. Confirm that audio-derived notes remain permanently uncertified regardless
   of engraving quality.
5. Cover empty, singleton, boundary, and unsupported cases as required by
   `AGENTS.md` testing policy.

Fixture files committed to the repository must be redistributable, must not
reference private scores or commercial recordings, and must not contain local
paths or credentials.
