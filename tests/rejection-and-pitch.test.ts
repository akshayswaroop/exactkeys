import { describe, expect, it } from 'vitest';
import { comparePerformances } from '../src/engine/fidelity';
import { spellPitch, spelledToMidi } from '../src/engine/pitch';
import { transcribeMidiBytes } from '../src/engine/transcribe';
import { frozenMidiFixture, performanceFixture } from './helpers';

describe('rejection and independent pitch invariants', () => {
  it('rejects audio even when renamed .mid', () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(transcribeMidiBytes(wav, 'renamed.mid')).toMatchObject({
      rejected: true,
      code: 'audio-below-threshold',
    });
  });

  it('returns structured invalid-option rejection from byte ingest', () => {
    expect(transcribeMidiBytes(frozenMidiFixture(), 'oracle.mid', { threshold: 0 })).toMatchObject({
      rejected: true,
      code: 'invalid-options',
    });
  });

  it('round-trips all MIDI pitches, including B and B-flat octave traps', () => {
    for (let midi = 0; midi <= 127; midi++) {
      for (const fifths of [-3, 0, 4]) {
        const spelled = spellPitch(midi, { fifths, minor: false });
        expect(spelledToMidi(spelled)).toBe(midi);
      }
    }
    expect(spellPitch(59, { fifths: -2, minor: false }).name).toBe('B3');
    expect(spellPitch(58, { fifths: -2, minor: false }).name).toBe('Bb3');
  });

  it('never promotes tolerant performance comparison to certification', () => {
    const a = performanceFixture([{ beat: 0, duration: 1, pitch: 60 }]);
    const b = performanceFixture([{ beat: 0.05, duration: 2, pitch: 60 }]);
    const report = comparePerformances(a, b, { onsetWindowMs: 50 });
    expect(report.f1).toBe(1);
    expect(report.certified).toBe(false);
  });
});
