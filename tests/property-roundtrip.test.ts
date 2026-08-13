import { describe, expect, it } from 'vitest';
import { transcribePerformance } from '../src/engine/transcribe';
import { verifyEventRoundTrip } from '../src/engine/verify';
import { performanceFixture, type TestNote } from './helpers';

function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('deterministic property corpus', () => {
  it('preserves every claimed tuple across 50 generated supported performances', () => {
    const random = randomSource(0x45584143);
    for (let fixture = 0; fixture < 50; fixture++) {
      const count = 1 + Math.floor(random() * 80);
      const notes: TestNote[] = [];
      let beat = 0;
      for (let index = 0; index < count; index++) {
        const duration = [0.25, 0.5, 0.75, 1, 1.5][Math.floor(random() * 5)];
        notes.push({
          beat,
          duration,
          pitch: 21 + Math.floor(random() * 88),
          velocity: 1 + Math.floor(random() * 127),
          channel: Math.floor(random() * 4),
          track: Math.floor(random() * 3),
        });
        beat += duration + [0, 0.25, 0.5][Math.floor(random() * 3)];
      }
      const performance = performanceFixture(notes, { trackNames: ['Conductor', 'Piano A', 'Piano B'] });
      const verification = verifyEventRoundTrip(performance);
      expect(verification.verified, `fixture ${fixture}: ${verification.reasons.join('; ')}`).toBe(true);

      // A score may abstain for overlapping staff voices or other profile
      // limits, but it may never expose score artifacts without certification.
      const transcript = transcribePerformance(performance);
      expect(Boolean(transcript.musicxml)).toBe(transcript.gate.certified);
      expect(Boolean(transcript.score)).toBe(transcript.gate.certified);
    }
  });
});
