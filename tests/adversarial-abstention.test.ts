import { describe, expect, it } from 'vitest';
import { transcribeLive, transcribePerformance } from '../src/engine/transcribe';
import { performanceFixture } from './helpers';

describe('fail-closed abstention', () => {
  it('uses ticks rather than first-tempo seconds, then abstains on tempo changes', () => {
    const source = performanceFixture([{ beat: 2, duration: 1, pitch: 60 }], {
      tempoEvents: [
        { tick: 0, usPerQuarter: 500_000 },
        { tick: 480, usPerQuarter: 1_000_000 },
      ],
    });
    // Deliberately inconsistent wall-clock seconds: musical beats still come from PPQ ticks.
    source.notes[0].onsetSec = 3;
    source.notes[0].offsetSec = 5;
    const transcript = transcribePerformance(source);
    expect(transcript.quantized[0]).toMatchObject({ onsetBeats: 2, durationBeats: 1 });
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toContain('tempo-map-unsupported');
  });

  it('does not silently drop overlapping voices with different durations', () => {
    const transcript = transcribePerformance(performanceFixture([
      { beat: 0, duration: 1, pitch: 64 },
      { beat: 0, duration: 2, pitch: 67 },
    ]));
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toContain('polyphony-unsupported');
    expect(transcript.musicxml).toBeNull();
  });

  it.each([
    ['pitch bend', { pitchBendEvents: 1, nonNeutralPitchBendEvents: 1 }, 'pitch-bend-unsupported'],
    ['aftertouch', { aftertouchEvents: 1 }, 'aftertouch-unsupported'],
    ['unsupported controller', { unsupportedControlEvents: 1 }, 'controller-unsupported'],
    ['SysEx', { sysexEvents: 1 }, 'sysex-unsupported'],
    ['percussion', { percussionNoteEvents: 2 }, 'mixed-percussion'],
    ['unmatched note', { unmatchedNoteOns: 1 }, 'unmatched-notes'],
    ['ambiguous repeat', { overlappingSamePitch: 1 }, 'ambiguous-repeats'],
  ])('abstains for %s integrity failures', (_label, integrityPatch, code) => {
    const base = performanceFixture([{ beat: 0, duration: 1, pitch: 60 }]);
    const transcript = transcribePerformance({
      ...base,
      integrity: { ...base.integrity, ...integrityPatch },
    });
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toContain(code);
  });

  it('abstains on non-piano programs, meter/key maps, and uncertified tuplets', () => {
    const nonPiano = performanceFixture([{ beat: 0, duration: 1, pitch: 60 }], {
      programEvents: [{ tick: 0, channel: 0, track: 0, program: 40 }],
    });
    expect(transcribePerformance(nonPiano).gate.reasonCodes).toContain('non-piano-program');

    const changing = performanceFixture([{ beat: 0, duration: 1, pitch: 60 }], {
      timeSignatures: [
        { tick: 0, numerator: 4, denominator: 4 },
        { tick: 1920, numerator: 3, denominator: 4 },
      ],
      keySignatures: [
        { tick: 0, fifths: 0, minor: false },
        { tick: 1920, fifths: 2, minor: false },
      ],
    });
    const changed = transcribePerformance(changing);
    expect(changed.gate.reasonCodes).toEqual(expect.arrayContaining(['meter-map-unsupported', 'key-map-unsupported']));

    const triplet = transcribePerformance(performanceFixture([
      { beat: 0, duration: 1 / 3, pitch: 60 },
    ]), { grid: '1/8t' });
    expect(triplet.gate.reasonCodes).toContain('tuplet-export-unsupported');
  });

  it('requires explicit live tempo and meter before score certification', () => {
    const messages = [
      { tMs: 0, data: [0x90, 60, 90] },
      { tMs: 500, data: [0x80, 60, 0] },
    ];
    const transcript = transcribeLive(messages);
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toEqual(expect.arrayContaining(['tempo-missing', 'meter-missing']));
  });

  it('retains unsupported live messages as blockers instead of dropping them', () => {
    const messages = [
      { tMs: 0, data: [0x90, 60, 90] },
      { tMs: 100, data: [0xe0, 0, 96] },
      { tMs: 500, data: [0x80, 60, 0] },
    ];
    const transcript = transcribeLive(messages, {
      tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
    });
    expect(transcript.performance.integrity.pitchBendEvents).toBe(1);
    expect(transcript.gate.reasonCodes).toContain('pitch-bend-unsupported');
  });
});
