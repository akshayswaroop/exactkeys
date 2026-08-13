# ExactKeys

ExactKeys is a fail-closed piano notation utility for Standard MIDI files, direct digital-piano MIDI, and explicitly uncertified piano-only YouTube drafts. For supported MIDI it writes a canonical representation of the note events plus an audit trail and emits certified MusicXML only under the profile in [ACCURACY.md](./ACCURACY.md).

The browser can infer notes from one public, piano-only YouTube video using Spotify Basic Pitch. Those results are always labelled **audio draft / uncertified**; they never receive a 99% claim, even if the inferred events happen to align with a notation grid.

## Supported profile

- Standard MIDI File format 0 or 1 with metrical PPQ time division (`.mid` or `.midi`). Format 2, karaoke files, and SMPTE division are unsupported.
- The deterministic `smf-note-events-v1` verification covers track, channel, pitch, note-on velocity, onset tick, and offset tick for every accepted non-percussion note. A verified result means **100% preservation of those supported MIDI-event fields** in the normalized representation.
- The `score-note-v1` certificate requires at least **99% joint grid conformity**: the same note must pass both onset and duration tolerances. It also requires 100% recovery of certified pitch, quantized onset, quantized duration, and ties after reparsing the emitted MusicXML.
- The score certificate is relative to the supplied MIDI events. It is not a claim about audio ground truth, compositional intent, fingering, voices, enharmonic intent, or the acoustic performance.
- Unsupported or ambiguous semantics cause score abstention. The normalized MIDI and JSON audit are still written for a parseable MIDI file; MusicXML and CSV are not.
- YouTube drafts may export `.uncertified.mid`, `.uncertified.musicxml`, and `.uncertified.notes.csv`. They are convenience artifacts for listening and correction, not certificate outputs.

See [ACCURACY.md](./ACCURACY.md) for the exact claim boundary and abstention rules.

## Run the app

Requires a current Node.js release with npm.

```bash
npm install
npm run dev
```

The browser UI inspects MIDI locally. Setup copies Spotify Basic Pitch's model and Apache license from the installed npm package. On the first development or preview run, it also downloads a pinned official yt-dlp macOS release and verifies its SHA-256 checksum; neither third-party artifact is committed to this repository. A pasted YouTube URL is then resolved by the local Vite server, and Spotify Basic Pitch runs in the browser. The temporary audio download is removed by the server after delivery. Use only videos you are authorized to process. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

### YouTube piano draft

1. Paste a direct `youtube.com/watch` or `youtu.be` video URL.
2. Confirm permission and click **Make draft**.
3. Keep the tab open while the progress indicator downloads, decodes, and processes 30-second chunks.
4. Listen to the original player and **Draft audition**, correct BPM/meter if needed, and export only as an uncertified working draft.

Limits: one public video, piano-only assumption, 10 minutes, 80 MB audio stream, no playlists, and macOS local runtime. Static hosting alone cannot provide the downloader endpoint.

### Draft audition in the browser

After loading a MIDI file, the browser can play its accepted note events through a small local Web Audio synth. This surface is deliberately labelled **Draft audition — not certified**:

- it uses the parsed performance's original onset, offset, pitch, and velocity rather than the quantized score;
- it remains separate from the certification configuration and never lowers the fixed 99% threshold;
- playing or stopping it never changes the audit or turns an abstention into a certificate; and
- it is an audible review aid, not an acoustic-piano rendering or an accuracy measurement.

An optional local reference-audio control can be used for manual A/B listening. The app does not align, analyse, or upload that recording. A MIDI file containing no note events cannot be auditioned; the UI reports that condition directly instead of attributing it to percussion filtering.

## CLI

```bash
npm run cli -- performance.mid
npm run cli -- performance.mid --out-dir transcript
npm run cli -- performance.mid --grid 1/8t --meter 6/8 --tempo-bpm 96
npm run cli -- performance.mid --key=-3:minor --title "Nocturne"
npm run cli -- --help
```

For a private MP3 + MusicXML challenge fixture, run the explicit hard-test harness:

```bash
npm run hard-test -- \
  --audio /path/to/piano.mp3 \
  --reference /path/to/reference.musicxml \
  --out /path/to/hard-test.json \
  --ours /path/to/reference-derived.musicxml
```

This deliberately separates two results. The MP3 safety gate confirms that no unproven audio inference received a certificate. The serializer fixture copies the supported pitch/onset/duration tuples from the reference and verifies that ExactKeys can reproduce those tuples through its MusicXML exporter. That second result is not an audio-transcription score and cannot establish that either system is correct against the recording.

Options:

| Option | Meaning |
| --- | --- |
| `-o, --out-dir <dir>` | Output directory; defaults to the input file's directory |
| `--grid <grid>` | `1/4`, `1/8`, `1/8t`, `1/16`, `1/16t`, or `1/32` (default `1/16`) |
| `--tempo-bpm <bpm>` | Explicit positive tempo override |
| `--meter <n/d>` | Explicit meter, such as `4/4` or `6/8` |
| `--key <fifths[:mode]>` | Circle-of-fifths value `-7..7`, optionally followed by `major` or `minor` |
| `--staff-mode <mode>` | `auto` preserves exactly two note tracks as hands; `track` requires them; `pitch` always uses the split |
| `--split-midi <0..127>` | Fallback lowest pitch placed on the treble staff (default `60`, middle C) |
| `--threshold <rate>` | Certificate threshold from `0.99` through `1`; values below `0.99` are refused |
| `--title <text>` | Score title |

For every parseable MIDI input, the CLI writes:

- `<name>.audit.json` — input profile, integrity counters, exact event verification, grid evidence, score fidelity, notes, warnings, and reasons for abstention.

When exact supported note-event preservation is verified, it also writes:

- `<name>.normalized.mid` — canonical MIDI containing the verified note-event representation.

Only a certified run also writes:

- `<name>.musicxml` — importable MusicXML 4.0 piano score.
- `<name>.notes.csv` — source-event and certified quantization evidence, one row per note.

An abstaining rerun removes same-name stale MusicXML and CSV files so an old score cannot be mistaken for the current result. A failed event-verification rerun likewise removes stale normalized MIDI.

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Score certified; all four artifacts written |
| `1` | MIDI valid, but the utility abstained from producing a score |
| `2` | Invalid CLI invocation |
| `3` | Audio or another non-MIDI input rejected |
| `4` | MIDI malformed or outside the supported SMF profile |
| `5` | Read/write failure |
| `70` | Internal certificate invariant failed; score output was refused |

This makes automation fail closed: treat only exit code `0` as a certified notation result. Exit code `1` is still a successfully audited, valid MIDI ingest.

## Verify the project

```bash
npm test
npm run build
```

No API key or third-party converter website is required. YouTube import requires network access for the one-time yt-dlp setup and while resolving a video; the Basic Pitch model is supplied by the installed npm package.
