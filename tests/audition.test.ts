import { describe, expect, it } from 'vitest';
import {
  createAuditionPlan,
  midiToFrequency,
  velocityToGain,
  type AuditionInputNote,
} from '../src/audition';

describe('raw performance audition planning', () => {
  it('converts MIDI pitches against the A4 = 440 Hz reference', () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(60)).toBeCloseTo(261.625565, 6);
    expect(midiToFrequency(21)).toBeCloseTo(27.5, 8);
    expect(() => midiToFrequency(69.5)).toThrow(RangeError);
    expect(() => midiToFrequency(128)).toThrow(RangeError);
  });

  it('maps velocity monotonically onto a bounded perceptual gain curve', () => {
    expect(velocityToGain(0)).toBe(0);
    expect(velocityToGain(127)).toBe(1);
    expect(velocityToGain(-20)).toBe(0);
    expect(velocityToGain(200)).toBe(1);
    expect(velocityToGain(96)).toBeGreaterThan(velocityToGain(64));
    expect(velocityToGain(64)).toBeGreaterThan(velocityToGain(32));
    expect(() => velocityToGain(Number.NaN)).toThrow(RangeError);
  });

  it('preserves absolute performance-relative onset and offset seconds', () => {
    const plan = createAuditionPlan([
      { pitch: 60, velocity: 80, onsetSec: 2.5, offsetSec: 3.125 },
      { pitch: 67, velocity: 96, onsetSec: 3.75, offsetSec: 5.25 },
    ]);

    expect(plan.notes.map(({ startSec, endSec }) => ({ startSec, endSec }))).toEqual([
      { startSec: 2.5, endSec: 3.125 },
      { startSec: 3.75, endSec: 5.25 },
    ]);
    expect(plan.notes[0]?.startSec).not.toBe(0);
    expect(plan.durationSec).toBe(5.25);
  });

  it('sorts attacks deterministically while preserving every raw event', () => {
    const plan = createAuditionPlan([
      { pitch: 72, velocity: 70, onsetSec: 2, offsetSec: 3 },
      { pitch: 67, velocity: 71, onsetSec: 1, offsetSec: 2.5 },
      { pitch: 60, velocity: 72, onsetSec: 1, offsetSec: 1.5 },
      { pitch: 60, velocity: 73, onsetSec: 1, offsetSec: 2 },
    ]);

    expect(plan.notes.map((note) => [
      note.startSec,
      note.pitch,
      note.endSec,
      note.sourceIndex,
    ])).toEqual([
      [1, 60, 1.5, 2],
      [1, 60, 2, 3],
      [1, 67, 2.5, 1],
      [2, 72, 3, 0],
    ]);
  });

  it('does not mutate even a frozen, unsorted source array', () => {
    const first = Object.freeze({ pitch: 72, velocity: 90, onsetSec: 3, offsetSec: 4 });
    const second = Object.freeze({ pitch: 48, velocity: 55, onsetSec: 1, offsetSec: 2 });
    const source: readonly AuditionInputNote[] = Object.freeze([first, second]);
    const snapshot = JSON.stringify(source);

    const plan = createAuditionPlan(source);

    expect(JSON.stringify(source)).toBe(snapshot);
    expect(source[0]).toBe(first);
    expect(plan.notes[0]).not.toBe(second);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.notes)).toBe(true);
    expect(Object.isFrozen(plan.notes[0])).toBe(true);
  });

  it('returns a zero-duration immutable plan for an empty performance', () => {
    const plan = createAuditionPlan([]);

    expect(plan.notes).toEqual([]);
    expect(plan.durationSec).toBe(0);
    expect(Object.isFrozen(plan.notes)).toBe(true);
  });

  it('retains same-tick events but rejects impossible timing', () => {
    expect(createAuditionPlan([
      { pitch: 60, velocity: 80, onsetSec: 1, offsetSec: 1 },
    ]).notes[0]).toMatchObject({ startSec: 1, endSec: 1 });
    expect(() => createAuditionPlan([
      { pitch: 60, velocity: 80, onsetSec: -0.1, offsetSec: 1 },
    ])).toThrow(/onsetSec/);
    expect(() => createAuditionPlan([
      { pitch: 60, velocity: 80, onsetSec: 1, offsetSec: 0.9 },
    ])).toThrow(/end before its onset/);
  });
});
