import { describe, expect, it } from 'vitest';
import { parseMidiFile } from '../src/engine/performance';
import { parseSmf, writeSmf } from '../src/engine/smf';
import { transcribeMidiBytes } from '../src/engine/transcribe';
import { performanceToMidi } from '../src/engine/exportMidi';
import { verifyEventRoundTrip } from '../src/engine/verify';
import { frozenMidiFixture, performanceFixture } from './helpers';

describe('independent SMF conformance fixture', () => {
  it('parses exact note, metadata, program, and pedal fields', () => {
    const performance = parseMidiFile(frozenMidiFixture(), 'oracle.mid');
    expect(performance.ticksPerQuarter).toBe(480);
    expect(performance.notes).toHaveLength(1);
    expect(performance.notes[0]).toMatchObject({
      pitch: 60,
      velocity: 100,
      channel: 0,
      track: 0,
      onsetTick: 0,
      offsetTick: 480,
    });
    expect(performance.pedals[0]).toMatchObject({
      channel: 0,
      track: 0,
      onsetTick: 480,
      offsetTick: 960,
    });
    expect(performance.programEvents[0]).toMatchObject({ program: 0, tick: 0 });
    expect(performance.integrity.explicitTempo).toBe(true);
  });

  it('preserves claimed note tuples across normalised export', () => {
    const source = parseMidiFile(frozenMidiFixture(), 'oracle.mid');
    const output = parseMidiFile(performanceToMidi(source), 'normalised.mid');
    expect(output.notes.map(({ track, channel, pitch, velocity, onsetTick, offsetTick }) => ({
      track, channel, pitch, velocity, onsetTick, offsetTick,
    }))).toEqual(source.notes.map(({ track, channel, pitch, velocity, onsetTick, offsetTick }) => ({
      track, channel, pitch, velocity, onsetTick, offsetTick,
    })));
    expect(output.pedals).toEqual(source.pedals);
    expect(verifyEventRoundTrip(source)).toMatchObject({ verified: true, accuracy: 1 });
  });

  it('preserves source track identity for format-1 note tracks', () => {
    const source = performanceFixture([
      { beat: 0, duration: 1, pitch: 48, track: 1, channel: 1 },
      { beat: 0, duration: 1, pitch: 72, track: 2, channel: 2 },
    ], {
      trackNames: ['Conductor', 'Left', 'Right'],
      integrity: {
        smfFormat: 1,
        explicitTempo: true,
        sourceNoteOnEvents: 2,
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
    });
    const roundTrip = parseMidiFile(performanceToMidi(source));
    expect(roundTrip.notes.map((note) => note.track)).toEqual([1, 2]);
    expect(verifyEventRoundTrip(source).verified).toBe(true);
  });

  it('rejects format 2, SMPTE division, and malformed tracks cleanly', () => {
    const format2 = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 2, 0, 1, 1, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0,
    ]);
    const format2Result = transcribeMidiBytes(format2, 'format2.mid');
    expect(format2Result).toMatchObject({ rejected: true, code: 'unsupported-midi' });

    const smpte = frozenMidiFixture();
    smpte[12] = 0xe7;
    expect(() => parseSmf(smpte)).toThrow(/SMPTE/);

    const truncated = frozenMidiFixture().slice(0, -1);
    expect(transcribeMidiBytes(truncated, 'broken.mid')).toMatchObject({
      rejected: true,
      code: 'malformed-midi',
    });

    const trailing = Uint8Array.from([...frozenMidiFixture(), 0]);
    expect(transcribeMidiBytes(trailing, 'trailing.mid')).toMatchObject({
      rejected: true,
      code: 'malformed-midi',
    });

    const illegalSystem = frozenMidiFixture();
    const programStatus = illegalSystem.indexOf(0xc0);
    expect(programStatus).toBeGreaterThan(0);
    illegalSystem[programStatus] = 0xf1;
    expect(transcribeMidiBytes(illegalSystem, 'system.mid')).toMatchObject({
      rejected: true,
      code: 'unsupported-midi',
    });
  });

  it('reports an empty metadata-only MIDI precisely instead of blaming channel 10', () => {
    const empty = writeSmf({
      format: 0,
      ticksPerQuarter: 480,
      tracks: [{ events: [
        { tick: 0, type: 'meta', meta: { type: 'tempo', usPerQuarter: 500_000 } },
        { tick: 0, type: 'meta', meta: { type: 'timeSignature', numerator: 4, denominator: 4, clocks: 24, thirtySeconds: 8 } },
        { tick: 245_760, type: 'meta', meta: { type: 'endOfTrack' } },
      ] }],
    });
    const result = transcribeMidiBytes(empty, 'empty.mid');
    expect(result).toMatchObject({
      gate: {
        noteCount: 0,
        reasonCodes: expect.arrayContaining(['no-note-events']),
      },
      performance: {
        integrity: { sourceNoteOnEvents: 0, percussionNoteOnEvents: 0 },
      },
    });
    if ('gate' in result) {
      expect(result.gate.reasons.join(' ')).toMatch(/contains no note events/i);
      expect(result.gate.reasons.join(' ')).not.toMatch(/channel 10/i);
      expect(result.gate.reasonCodes).not.toContain('event-roundtrip-failed');
    }
  });

  it('does not block a score for a centre-position pitch-bend reset with no pitch effect', () => {
    const reset = writeSmf({
      format: 0,
      ticksPerQuarter: 480,
      tracks: [{ events: [
        { tick: 0, type: 'meta', meta: { type: 'tempo', usPerQuarter: 500_000 } },
        { tick: 0, type: 'meta', meta: { type: 'timeSignature', numerator: 4, denominator: 4, clocks: 24, thirtySeconds: 8 } },
        { tick: 0, type: 'meta', meta: { type: 'keySignature', fifths: 0, minor: false } },
        { tick: 0, type: 'program', channel: 0, program: 0 },
        { tick: 0, type: 'pitchBend', channel: 0, value: 0 },
        { tick: 0, type: 'noteOn', channel: 0, pitch: 60, velocity: 90 },
        { tick: 480, type: 'noteOff', channel: 0, pitch: 60, velocity: 0 },
        { tick: 1920, type: 'meta', meta: { type: 'endOfTrack' } },
      ] }],
    });
    const result = transcribeMidiBytes(reset, 'reset.mid');
    expect(result).toMatchObject({
      gate: { certified: true },
      performance: { integrity: {
        pitchBendEvents: 1,
        neutralPitchBendEvents: 1,
        nonNeutralPitchBendEvents: 0,
      } },
    });
    if ('gate' in result) expect(result.gate.reasonCodes).not.toContain('pitch-bend-unsupported');
  });
});
