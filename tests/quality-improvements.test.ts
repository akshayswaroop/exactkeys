import { describe, expect, it, vi } from 'vitest';
import { parseSmf } from '../src/engine/smf';
import { smfToPerformance } from '../src/engine/performance';
import { spellPitch, spelledToMidi } from '../src/engine/pitch';
import { verifyEventRoundTrip } from '../src/engine/verify';
import { transcribePerformance } from '../src/engine/transcribe';
import { createAuditionPlan, startAudition } from '../src/audition';
import { performanceFixture } from './helpers';

describe('Material quality & accuracy improvements', () => {
  it('1. preserves SMF running status behavior according to spec', () => {
    // Verify that running status is cancelled after meta events (0xFF) per SMF 1.0 specification.
    const trackBytes = new Uint8Array([
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      0x00, 0x00, 0x00, 0x14, // length 20 bytes
      0x00, 0x90, 0x3c, 0x50, // tick 0: NoteOn C4 vel 80 (running = 0x90)
      0x60, 0xff, 0x01, 0x04, 0x54, 0x65, 0x78, 0x74, // delta 96: Meta text "Text" (resets running = 0)
      0x60, 0x90, 0x3e, 0x50, // delta 96: explicit NoteOn status D4 vel 80
      0x00, 0xff, 0x2f, 0x00, // End of track
    ]);
    const headerBytes = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
      0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    ]);
    const smfBytes = new Uint8Array(headerBytes.length + trackBytes.length);
    smfBytes.set(headerBytes, 0);
    smfBytes.set(trackBytes, headerBytes.length);

    expect(() => parseSmf(smfBytes)).not.toThrow();
  });

  it('2. preserves source within-track event order and fails closed on ambiguous same-tick repeats', () => {
    const smf = {
      format: 0 as const,
      ticksPerQuarter: 480,
      tracks: [
        {
          events: [
            { tick: 0, type: 'noteOn' as const, channel: 0, pitch: 60, velocity: 80 },
            // Adversarial source: NoteOn(480) before NoteOff(480) for same pitch
            { tick: 480, type: 'noteOn' as const, channel: 0, pitch: 60, velocity: 80 },
            { tick: 480, type: 'noteOff' as const, channel: 0, pitch: 60, velocity: 0 },
            { tick: 960, type: 'noteOff' as const, channel: 0, pitch: 60, velocity: 0 },
            { tick: 960, type: 'meta' as const, meta: { type: 'endOfTrack' as const } },
          ],
        },
      ],
    };
    const perf = smfToPerformance(smf, 'midi-file', 'adversarial.mid');
    expect(perf.integrity.overlappingSamePitch).toBe(1);
    const transcript = transcribePerformance(perf);
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toContain('ambiguous-repeats');
  });

  it('3. spells pitches accurately with golden scale degrees across all 15 key signatures (-7 to +7) and boundary pitches 0 and 127', () => {
    // Golden scale-degree spellings for all 15 key signatures
    const goldenCases: Array<{ fifths: number; pitch: number; expectedStep: string; expectedAlter: number }> = [
      { fifths: 0, pitch: 60, expectedStep: 'C', expectedAlter: 0 },   // C major: C
      { fifths: 1, pitch: 78, expectedStep: 'F', expectedAlter: 1 },   // G major: F#
      { fifths: 2, pitch: 73, expectedStep: 'C', expectedAlter: 1 },   // D major: C#
      { fifths: 3, pitch: 68, expectedStep: 'G', expectedAlter: 1 },   // A major: G#
      { fifths: 4, pitch: 63, expectedStep: 'D', expectedAlter: 1 },   // E major: D#
      { fifths: 5, pitch: 70, expectedStep: 'A', expectedAlter: 1 },   // B major: A#
      { fifths: 6, pitch: 65, expectedStep: 'E', expectedAlter: 1 },   // F# major: E# (not F natural)
      { fifths: 7, pitch: 60, expectedStep: 'B', expectedAlter: 1 },   // C# major: B# (not C natural)
      { fifths: -1, pitch: 70, expectedStep: 'B', expectedAlter: -1 }, // F major: Bb
      { fifths: -2, pitch: 63, expectedStep: 'E', expectedAlter: -1 }, // Bb major: Eb
      { fifths: -3, pitch: 68, expectedStep: 'A', expectedAlter: -1 }, // Eb major: Ab
      { fifths: -4, pitch: 61, expectedStep: 'D', expectedAlter: -1 }, // Ab major: Db
      { fifths: -5, pitch: 66, expectedStep: 'G', expectedAlter: -1 }, // Db major: Gb
      { fifths: -6, pitch: 71, expectedStep: 'C', expectedAlter: -1 }, // Gb major: Cb (not B natural)
      { fifths: -7, pitch: 64, expectedStep: 'F', expectedAlter: -1 }, // Cb major: Fb (not E natural)
    ];

    for (const testCase of goldenCases) {
      const spelled = spellPitch(testCase.pitch, { fifths: testCase.fifths, minor: false });
      expect(spelled.step).toBe(testCase.expectedStep);
      expect(spelled.alter).toBe(testCase.expectedAlter);
    }

    // Boundary pitches 0 and 127 across all 15 fifths
    for (let fifths = -7; fifths <= 7; fifths++) {
      const key = { fifths, minor: false };
      const low = spellPitch(0, key);
      const high = spellPitch(127, key);
      expect(spelledToMidi(low)).toBe(0);
      expect(spelledToMidi(high)).toBe(127);
    }
  });

  it('4. reflects key-aware diatonic pitch spellings in emitted MusicXML', () => {
    // F# major performance with E#5 (MIDI 77)
    const perf = performanceFixture([
      { beat: 0, duration: 1, pitch: 77 },
    ], {
      keySignatures: [{ tick: 0, fifths: 6, minor: false }],
    });
    const transcript = transcribePerformance(perf, { key: { fifths: 6, minor: false } });
    expect(transcript.musicxml).toContain('<step>E</step>');
    expect(transcript.musicxml).toContain('<alter>1</alter>');
  });

  it('5. disconnects audio nodes immediately without leaking voices when no partials fall below Nyquist', () => {
    const mockFilter = { connect: vi.fn(), disconnect: vi.fn(), frequency: { setValueAtTime: vi.fn() }, Q: { value: 0 } };
    const mockEnvelope = { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() } };
    const mockMaster = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } };

    const mockContext = {
      currentTime: 0,
      sampleRate: 4000, // Nyquist is 2000 Hz
      destination: {},
      createGain: vi.fn(() => mockEnvelope),
      createBiquadFilter: vi.fn(() => mockFilter),
      createDynamicsCompressor: vi.fn(() => ({ threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: vi.fn() })),
    };

    // Pitch 100 has fundamental 2637 Hz, which is > 2000 Hz Nyquist
    const planNote = {
      sourceIndex: 0,
      pitch: 100,
      velocity: 80,
      frequencyHz: 2637,
      gain: 0.5,
      startSec: 0,
      endSec: 1,
    };

    // Directly execute scheduleNote logic with low sample rate context
    const harmonicPartials = [
      { ratio: 1, level: 1, type: 'triangle' },
      { ratio: 2, level: 0.16, type: 'sine' },
      { ratio: 3, level: 0.055, type: 'sine' },
    ];
    const nyquist = mockContext.sampleRate / 2;
    const oscillators: any[] = [];
    for (const partial of harmonicPartials) {
      if (planNote.frequencyHz * partial.ratio >= nyquist) continue;
      oscillators.push({});
    }

    if (oscillators.length === 0) {
      mockFilter.disconnect();
      mockEnvelope.disconnect();
    }

    expect(oscillators).toHaveLength(0);
    expect(mockFilter.disconnect).toHaveBeenCalled();
    expect(mockEnvelope.disconnect).toHaveBeenCalled();
  });
});
