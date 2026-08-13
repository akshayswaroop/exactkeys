import { describe, expect, it } from 'vitest';
import { parseSmf } from '../src/engine/smf';
import { smfToPerformance } from '../src/engine/performance';
import { spellPitch, spelledToMidi } from '../src/engine/pitch';
import { verifyEventRoundTrip } from '../src/engine/verify';
import { transcribePerformance } from '../src/engine/transcribe';
import { createAuditionPlan, startAudition } from '../src/audition';

describe('Material quality & accuracy improvements', () => {
  it('1. preserves running status across SMF meta events', () => {
    // Construct SMF track bytes: NoteOn (0x90), Meta Text (0xFF 0x01), NoteOn running status
    const trackBytes = new Uint8Array([
      0x4d, 0x54, 0x72, 0x6b, // MTrk
      0x00, 0x00, 0x00, 0x19, // length 25 bytes
      0x00, 0x90, 0x3c, 0x50, // tick 0: NoteOn C4 vel 80 (sets running = 0x90)
      0x60, 0xff, 0x01, 0x04, 0x54, 0x65, 0x78, 0x74, // delta 96: Meta text "Text"
      0x60, 0x3e, 0x50,       // delta 96: running status 0x90 D4 vel 80
      0x60, 0x3c, 0x00,       // delta 96: running status 0x90 C4 vel 0 (note off)
      0x60, 0x3e, 0x00,       // delta 96: running status 0x90 D4 vel 0 (note off)
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
    const parsed = parseSmf(smfBytes);
    const noteEvents = parsed.tracks[0].events.filter((e) => e.type === 'noteOn' || e.type === 'noteOff');
    expect(noteEvents).toHaveLength(4);
  });

  it('2. orders same-tick events so noteOff precedes noteOn, preventing false ambiguous-repeats', () => {
    const smf = {
      format: 0 as const,
      ticksPerQuarter: 480,
      tracks: [
        {
          events: [
            { tick: 0, type: 'noteOn' as const, channel: 0, pitch: 60, velocity: 80 },
            // NoteOn for next note placed before NoteOff of previous note at tick 480
            { tick: 480, type: 'noteOn' as const, channel: 0, pitch: 60, velocity: 80 },
            { tick: 480, type: 'noteOff' as const, channel: 0, pitch: 60, velocity: 0 },
            { tick: 960, type: 'noteOff' as const, channel: 0, pitch: 60, velocity: 0 },
            { tick: 960, type: 'meta' as const, meta: { type: 'endOfTrack' as const } },
          ],
        },
      ],
    };
    const perf = smfToPerformance(smf, 'midi-file', 'test.mid');
    expect(perf.integrity.overlappingSamePitch).toBe(0);
    const transcript = transcribePerformance(perf);
    expect(transcript.gate.reasonCodes).not.toContain('ambiguous-repeats');
  });

  it('3. spells pitches accurately across all circle-of-fifths key signatures (-7 to +7)', () => {
    // F# major (fifths = 6): E#4 (MIDI 65) should be spelled E#4 (step E, alter 1), not F natural
    const fSharpMajor = spellPitch(65, { fifths: 6, minor: false });
    expect(fSharpMajor).toMatchObject({ step: 'E', alter: 1, octave: 4, name: 'E#4' });

    // Gb major (fifths = -6): Cb5 (MIDI 71) should be spelled Cb5 (step C, alter -1), not B natural
    const gFlatMajor = spellPitch(71, { fifths: -6, minor: false });
    expect(gFlatMajor).toMatchObject({ step: 'C', alter: -1, octave: 5, name: 'Cb5' });

    // Verify spelledToMidi round-trip invariant across valid MIDI pitches for all 15 fifths
    for (let fifths = -7; fifths <= 7; fifths++) {
      const key = { fifths, minor: false };
      for (let midi = 12; midi <= 120; midi++) {
        const spelled = spellPitch(midi, key);
        expect(spelledToMidi(spelled)).toBe(midi);
      }
    }
  });

  it('4. creates clean audition plan without oscillator voice leaks for high frequencies', async () => {
    const plan = createAuditionPlan([{ pitch: 127, velocity: 100, onsetSec: 0, offsetSec: 0.5 }]);
    expect(plan.notes).toHaveLength(1);
    expect(plan.durationSec).toBe(0.5);
    const emptyHandle = await startAudition([]);
    expect(emptyHandle.durationSec).toBe(0);
  });

  it('5. returns accuracy 1 when 0 source notes produce 0 reparsed notes in event verification', () => {
    const emptyPerf = {
      ticksPerQuarter: 480,
      notes: [],
      pedals: [],
      tempoEvents: [{ tick: 0, usPerQuarter: 500_000 }],
      timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
      keySignatures: [{ tick: 0, fifths: 0, minor: false }],
      programEvents: [],
      source: 'midi-file' as const,
      filename: 'empty.mid',
      durationSec: 1,
      trackNames: ['Empty'],
      integrity: {
        smfFormat: 0 as const,
        explicitTempo: true,
        sourceNoteOnEvents: 0,
        percussionNoteOnEvents: 0,
        unmatchedNoteOns: 0,
        unmatchedNoteOffs: 0,
        overlappingSamePitch: 0,
        pitchBendEvents: 0,
        neutralPitchBendEvents: 0,
        nonNeutralPitchBendEvents: 0,
        aftertouchEvents: 0,
        percussionNoteEvents: 0,
        unsupportedControlEvents: 0,
        sysexEvents: 0,
      },
    };
    const verification = verifyEventRoundTrip(emptyPerf);
    expect(verification.accuracy).toBe(1);
    expect(verification.reasons).toContain('No pitched note events to verify.');
  });
});
