import type { Performance, TimeSignature } from '../src/engine/types';

export interface TestNote {
  beat: number;
  duration: number;
  pitch: number;
  velocity?: number;
  channel?: number;
  track?: number;
}

export function performanceFixture(
  notes: TestNote[],
  overrides: Partial<Performance> = {},
): Performance {
  const tpq = overrides.ticksPerQuarter ?? 480;
  const bpm = 120;
  const performed = notes.map((note, index) => {
    const onsetTick = Math.round(note.beat * tpq);
    const offsetTick = Math.round((note.beat + note.duration) * tpq);
    return {
      id: `n${index}`,
      pitch: note.pitch,
      velocity: note.velocity ?? 80,
      channel: note.channel ?? 0,
      track: note.track ?? 0,
      onsetTick,
      offsetTick,
      onsetSec: note.beat * (60 / bpm),
      offsetSec: (note.beat + note.duration) * (60 / bpm),
    };
  });
  const timeSignatures = overrides.timeSignatures ?? [
    { tick: 0, numerator: 4, denominator: 4 },
  ];
  const result: Performance = {
    ticksPerQuarter: tpq,
    notes: performed,
    pedals: [],
    tempoEvents: [{ tick: 0, usPerQuarter: 500_000 }],
    timeSignatures,
    keySignatures: [{ tick: 0, fifths: 0, minor: false }],
    programEvents: [{ tick: 0, channel: 0, track: 0, program: 0 }],
    source: 'midi-file',
    filename: 'fixture.mid',
    durationSec: performed.reduce((max, note) => Math.max(max, note.offsetSec), 0),
    trackNames: ['Piano'],
    integrity: {
      smfFormat: 0,
      explicitTempo: true,
      sourceNoteOnEvents: performed.length,
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
  return { ...result, ...overrides };
}

export function sequentialNotes(count: number): TestNote[] {
  return Array.from({ length: count }, (_, index) => ({
    beat: index * 2,
    duration: 1,
    pitch: 60 + (index % 12),
  }));
}

export function frozenMidiFixture(): Uint8Array {
  // Independently-authored format-0 SMF: tempo, 4/4, C major, program 0,
  // middle C for one beat, then one beat of sustain pedal.
  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x2e,
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xff, 0x59, 0x02, 0x00, 0x00,
    0x00, 0xc0, 0x00,
    0x00, 0x90, 0x3c, 0x64,
    0x83, 0x60, 0x80, 0x3c, 0x00,
    0x00, 0xb0, 0x40, 0x7f,
    0x83, 0x60, 0xb0, 0x40, 0x00,
    0x00, 0xff, 0x2f, 0x00,
  ]);
}

export function withMeter(performance: Performance, meter: TimeSignature): Performance {
  return {
    ...performance,
    timeSignatures: [{ tick: 0, ...meter }],
  };
}
