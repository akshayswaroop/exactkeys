# Accuracy contract

“99% accurate” is meaningful only when the population, fields, tolerance, and denominator are explicit. ExactKeys therefore exposes two narrow, machine-readable certificates and abstains outside them. It does not claim that arbitrary recordings can be transcribed at 99% accuracy.

## 1. Supported MIDI-event preservation

Profile: `smf-note-events-v1`.

For every accepted, matched, non-percussion MIDI note in a supported Standard MIDI File, the canonical event record contains:

1. source track index;
2. MIDI channel;
3. pitch (`0..127`);
4. note-on velocity (`1..127`);
5. onset tick; and
6. offset tick.

The verifier compares all six fields. `accuracy` is the fraction of source canonical note-event records recovered exactly. `verified: true` requires `accuracy: 1`, so the claim is **100% supported note-event preservation**, not a rounded estimate or a model confidence score.

The normalized MIDI is a canonical rewrite, not a byte-for-byte copy. Running status, event ordering at an equal tick, note-off encoding/velocity, track chunk bytes, unknown metadata, and end-of-track layout can change without changing a claimed field. Parsed tempo, time-signature, key-signature, sustain-pedal regions, program changes, and track names are also rewritten when supported, but they are not dimensions of `smf-note-events-v1` and receive no 100% claim from that certificate.

## 2. MIDI-relative score certificate

Profile: `score-note-v1`.

Each canonical MIDI note is snapped to the selected musical grid. In quarter-note beats:

- onset fits when `abs(MIDI onset - snapped onset) <= 0.08`;
- duration fits when `abs(MIDI duration - snapped duration) <= 0.12`; and
- the note jointly fits only when **both** tests pass for that same note.

The primary conformity statistic is:

```text
jointFitRate = jointly fitting notes / all canonical pitched notes
```

A score can be certified only when `jointFitRate >= threshold`, where the threshold defaults to `0.99` and the CLI refuses values below `0.99`. Separate onset and duration rates are reported for diagnosis; they cannot substitute for the joint rate.

Before release, the emitted MusicXML is reparsed, its tied fragments are collapsed, and every reconstructed note is compared with the quantized source. Certification additionally requires `scoreFidelityRate == 1`: exact pitch, quantized onset, quantized duration, valid tie chains, and complete measure coverage for every score note. Required meter and tempo semantics must come from explicit MIDI metadata or a user override.

The audit's `scoreCertificate.claimedDimensions` is authoritative for the current build. A `certified-score` result means the MusicXML/CSV are permitted; `abstained` means neither score artifact is emitted.

## What the score certificate does not mean

The reference is MIDI, not a microphone recording or a human-annotated score. The certificate does not establish:

- audio-to-note accuracy;
- whether the performer played the intended notes;
- composer's intended rhythm, meter, tempo, voice-leading, staff, hand, fingering, articulation, or dynamics;
- intended enharmonic spelling when the key is inferred rather than supplied;
- semantic preservation of arbitrary controllers, pitch bend, aftertouch, SysEx, lyrics, cue text, proprietary metadata, or percussion; or
- page-layout or engraving aesthetics in a receiving notation editor.

Staff assignment preserves exactly two explicit MIDI note tracks in `auto`/`track` mode, ranked by median pitch; other inputs use a configurable pitch split. Key detection affects spelling only and never changes MIDI pitch. These are useful notation decisions, not inferred facts covered by the 99% statistic.

## Fail-closed and abstention rules

ExactKeys does not “do its best” and label that result accurate. It withholds MusicXML and CSV whenever the full certificate cannot be made. Reasons and stable reason codes are recorded in `<name>.audit.json`.

Examples that can force rejection or abstention include:

- an audio-inferred draft with no MIDI or human-annotated ground truth;
- malformed SMF, format 2, or SMPTE time division (rejected);
- no pitched non-percussion notes;
- joint grid conformity below the selected threshold;
- a meter that cannot be established;
- unmatched or overlapping note semantics that prevent exact event verification;
- non-neutral pitch bend, unsupported controllers, aftertouch, SysEx, percussion, or other semantics outside the score profile; and
- any failure to recover the quantized notes exactly from the generated score.

A parseable MIDI file still receives an audit when score certification abstains. Normalized MIDI is emitted only when the supported note-event round trip is exact. This separation is deliberate: verified event preservation is safe; presenting uncertified inference as notation is not.

## Draft audition is not certification

The browser may synthesize accepted or audio-inferred note events for subjective review even when score certification abstains. Draft audition is a separate, non-certifying path: it uses raw timing, does not mutate the threshold, and reports no audio-accuracy percentage. Its oscillator-based sound is only a convenient preview, not evidence that the inferred notes match a recording.

If the user selects reference audio for A/B listening, the browser plays that local file without analysing or aligning it. Agreement must therefore be judged by the listener; no objective audio precision, recall, or timing score is produced. A metadata-only MIDI with zero note events has nothing to audition.

## YouTube/audio inference contract

Waveform-to-score transcription is probabilistic. Accuracy varies with instrument, room, microphone, repertoire, pedaling, polyphony, annotation policy, and metric. ExactKeys uses Spotify Basic Pitch for piano-only YouTube drafts, but has no independent evidence that it clears the required 99% **joint pitch/onset/duration** criterion. Therefore `audio-draft` is a permanent certification blocker.

The model's events can be auditioned and exported as files containing `uncertified` in their names. Draft MusicXML quantizes events and flattens each staff into one chord stream; independent overlapping durations may be shortened or unified at the next attack. Tempo, meter, key, staff, voices, sustain, dynamics, and enharmonic spelling require review. A future audio certificate would still require a versioned held-out corpus, a matching joint metric, confidence bounds, and abstention behavior.

## Reading the audit

The JSON audit is the durable source of truth. Check, in order:

1. `outcome.status` is `certified-score`;
2. `eventVerification.verified` is `true` and `accuracy` is `1`;
3. `scoreCertificate.certified` is `true`;
4. `scoreCertificate.jointFitRate >= scoreCertificate.threshold`;
5. `scoreCertificate.threshold >= 0.99`;
6. `scoreCertificate.scoreFidelityRate` is `1`; and
7. `outputs.musicXml` and `outputs.notesCsv` are non-null.

Anything else is an abstention, warning, or invalid input—not a 99%-accurate score.
