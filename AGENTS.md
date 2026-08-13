# ExactKeys agent contract

This file applies to the entire repository. Every human or automated contributor must follow it. Nested `AGENTS.md` files may add stricter rules but must not weaken these rules.

The words **MUST**, **MUST NOT**, **REQUIRED**, and **BLOCKING** are normative. If a requirement cannot be proven, the implementation must abstain, reject, or remain unmerged.

## Product truth

ExactKeys is an accuracy-focused, fail-closed transcription utility. It has two deliberately separate products:

1. deterministic, MIDI-relative verification and notation; and
2. probabilistic audio/YouTube drafts for listening and correction.

They must never be presented as equivalent.

- The fixed score-certification threshold MUST remain at least `0.99`.
- A score certificate is relative to supported MIDI events, never to an audio recording, a composer's intention, or a human score unless a named ground-truth corpus is actually supplied and evaluated.
- Audio-derived notes MUST remain permanently uncertified under the current product contract.
- No UI label, API field, CLI exit code, filename, log line, or documentation statement may imply that an audio draft is 99% accurate, verified, exact, lossless, or certified.
- Grid conformity, serializer round-trip fidelity, model confidence, and subjective listening are different measurements. They MUST NOT be renamed or combined into an unqualified “accuracy” number.
- An empty population has no accuracy denominator. Zero notes MUST NOT produce a 100% accuracy claim or a certificate.

Read `ACCURACY.md` before changing parsing, verification, quantization, engraving, MusicXML, draft inference, exports, or CLI status semantics.

## Non-negotiable certificate invariants

### Supported MIDI-event verification

`smf-note-events-v1` is a deterministic claim over a nonempty supported note set. A verified result requires exact recovery of every claimed field for every note:

- track;
- channel;
- pitch;
- note-on velocity;
- onset tick; and
- offset tick.

Verification MUST require 100% equality for these fields. A rounded percentage, average, F1 score, or tolerance match is insufficient.

### MIDI-relative score certification

`score-note-v1` may certify only when all of the following are true:

- there is at least one supported pitched note;
- supported MIDI-event verification is 100%;
- the same note passes both onset and duration tolerances, with joint conformity at or above the fixed threshold;
- every emitted pitch, onset, duration, and tie is recovered after reparsing the generated MusicXML;
- score fidelity is 100%;
- required tempo, meter, and key metadata match after serialization; and
- no blocker or unsupported semantic remains.

Callers MUST NOT lower, bypass, reinterpret, or hide these requirements. Invalid, non-finite, or out-of-range options must reject rather than fail open.

### Fail-closed input handling

- Preserve original within-track event order. Do not sort same-tick events into a more convenient interpretation on the certifying path.
- Follow the Standard MIDI File specification. Meta and SysEx events cancel running status.
- Do not silently repair malformed or ambiguous input and then certify it.
- Unmatched notes, overlapping repeats with ambiguous pairing, unsupported polyphony, non-neutral pitch bend, aftertouch, unsupported controllers, SysEx, percussion, format 2, unsupported tempo/meter/key maps, and other unrepresented semantics must reject or abstain as defined in `ACCURACY.md`.
- Tolerant parsing or normalization may exist only as an explicitly non-certifying path with an audit warning.
- Never drop a musical event during engraving. If the exporter cannot represent it exactly, abstain.
- Preserve provenance. A normalized or inferred representation must never masquerade as the original source stream.

## Audio and YouTube drafts

Audio inference is useful but probabilistic. It must remain operationally separate from certification.

- Every audio artifact filename MUST contain `uncertified`.
- Every audio audit MUST record `audio-draft` provenance and the `audio-inference-uncertified` blocker.
- Audio output MUST NOT unlock certified MusicXML, certified CSV, or any score certificate.
- Playback is review assistance, not accuracy evidence.
- A successful audio draft MUST use a documented nonzero CLI exit code. Exit code `0` is reserved exclusively for a certified score.
- Do not write an empty MusicXML file and report success. Validate nonempty notes and parseable artifacts before success.
- Browser and CLI paths must enforce explicit resource limits for duration, download size, decoded samples, note count, memory, and temporary storage.
- YouTube handling must reject playlists, constrain supported URLs, use the pinned checksummed downloader, and process only content the user is authorized to use.
- Temporary files and subprocesses MUST be cleaned up in `finally`, on cancellation, and on every error path.
- A standalone CLI MUST NOT depend on an undocumented development server or hard-coded localhost port.
- A fresh clone workflow must install or locate every required model/tool through documented, reproducible setup.
- Platform-specific dependencies such as `afconvert` require platform checks, actionable errors, and end-to-end stereo and mono fixtures.

## CLI contract

The exit-code and artifact contract is public API.

- `0`: certified score only.
- `1`: valid MIDI processed but score abstained.
- `2`: invalid invocation.
- `3`: rejected non-MIDI/audio input under the strict path.
- `4`: malformed or unsupported MIDI.
- `5`: I/O failure.
- `70`: internal certificate invariant failure.

Adding a successful uncertified draft outcome requires a new documented nonzero code, README and help updates, and integration tests. Do not reuse `0`.

Certified and uncertified artifacts must have visibly distinct names and metadata. Stale certified outputs must be removed or withheld after an abstaining rerun.

## Testing requirements

Tests are evidence, not decoration.

- Every certificate or parser change MUST include an adversarial regression test that would fail if the gate became less strict.
- Tests MUST invoke production code. Copying production logic into a test and testing the copy is not coverage.
- A test for a lifecycle/resource fix must observe the actual lifecycle seam: created nodes/processes/files, cleanup, cancellation, and error paths.
- Parser fixtures must include both valid and invalid encodings and assert rejection of the invalid case.
- Metrics tests must cover empty, singleton, duplicate, disjoint-error, boundary, malformed, and unsupported cases where relevant.
- Pitch-spelling tests must separate pitch preservation from notation heuristics and include representative MusicXML assertions.
- Audio/YouTube changes require a small, redistributable stereo fixture and a true end-to-end success test. Mock-only tests are insufficient for the release path.
- CLI changes require integration tests for exit code, stdout/stderr contract, artifacts, stale-output behavior, missing dependencies, and failure cleanup.
- Tests must prove audio drafts cannot become certified even when grid conformity is perfect.

Before proposing merge, run:

```bash
npm test
npm run build
```

If the change affects a real ingestion path, also run the relevant real-file hard test. Record commands, fixture provenance, and outcomes in the PR.

A green CI run is necessary but not sufficient. Tests that encode the wrong product behavior do not make a change safe.

## Change and PR discipline

- Keep one coherent purpose per PR. Do not hide a new feature inside a parser, accuracy, or cleanup fix.
- The PR title and body MUST describe the final diff, not an earlier commit.
- Remove superseded or contradictory claims after revisions.
- Use repository-relative or GitHub URLs. Never publish `file:///`, local absolute paths, usernames, Downloads paths, or machine-specific secrets.
- State what is certified, what is not, and which accuracy dimensions are unchanged.
- Include user value, failure modes, checks run, and remaining limitations.
- Do not call a heuristic “accurate” without a named ground truth, metric, denominator, tolerance, and measured result.
- Do not merge with unresolved P0/P1 accuracy, data-loss, misleading-claim, cleanup, or contract findings.
- Do not weaken a gate merely to make a fixture, demo, or CI run pass.
- **Squash Merge Message Discipline**: Squash merges MUST NOT dump raw intermediate commit histories into the squash commit body. When merging via `gh` CLI, specify explicit `--subject` and `--body` flags. In GitHub repository settings, configure squash merge default to PR Title and Description.

## Public repository hygiene

- Never commit user audio, downloaded media, private score fixtures, credentials, `.env` files, local learning logs, generated outputs, model blobs copied from dependencies, or third-party executables.
- Keep `node_modules`, build output, temporary files, and validation artifacts ignored.
- Pin and checksum downloaded tools.
- Preserve required third-party license notices.
- Treat source filenames, PR bodies, commit metadata, fixtures, and logs as public information.
- Run a secret and local-path scan before publishing new ingestion or fixture work.

## Engineering quality

- Validate all external input and numeric options at boundaries.
- Use bounded reads, downloads, allocations, loops, and event counts.
- Propagate subprocess stderr in actionable errors without leaking secrets.
- Create output directories deliberately and write artifacts atomically where practical.
- Do not report success until every promised artifact is nonempty, validated, and durably written.
- Keep browser-only and Node-only dependencies out of each other's bundles.
- Prefer explicit typed result states over overloaded booleans or misleading percentages.
- Preserve existing user work and unrelated changes.

## Merge checklist

A change is mergeable only when all applicable answers are yes:

- Does it preserve the product truth in `ACCURACY.md`?
- Does every certifying path remain fail-closed?
- Are audio and MIDI claims visibly and mechanically separated?
- Are source order and unsupported semantics preserved or blocked?
- Do tests execute production paths and include adversarial failures?
- Do real fixtures pass for changed ingestion paths?
- Are exit codes, filenames, audits, docs, and UI labels consistent?
- Are temporary resources bounded and cleaned on every path?
- Does the PR contain only its stated scope?
- Are `npm test`, `npm run build`, and CI green?

If any answer is no or unknown, do not merge.
