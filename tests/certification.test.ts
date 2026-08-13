import { describe, expect, it } from 'vitest';
import { canonicalNotesInMusicXml } from '../src/engine/musicxml';
import { transcribePerformance } from '../src/engine/transcribe';
import { performanceFixture, sequentialNotes } from './helpers';

describe('score-note-v1 certification', () => {
  it('certifies only after exact event and MusicXML round trips', () => {
    const transcript = transcribePerformance(performanceFixture([
      { beat: 0, duration: 1, pitch: 48 },
      { beat: 0, duration: 1, pitch: 64 },
      { beat: 1, duration: 1, pitch: 50 },
      { beat: 1, duration: 1, pitch: 65 },
      { beat: 2, duration: 2, pitch: 52 },
      { beat: 2, duration: 2, pitch: 67 },
    ]));
    expect(transcript.eventVerification).toMatchObject({ verified: true, accuracy: 1 });
    expect(transcript.gate).toMatchObject({
      certified: true,
      status: 'certified-score',
      jointFitRate: 1,
      scoreFidelityRate: 1,
    });
    expect(transcript.musicxml).toContain('<miscellaneous-field name="accuracy-certified">true</miscellaneous-field>');
    expect(canonicalNotesInMusicXml(transcript.musicxml!)).toHaveLength(6);
  });

  it('requires 100% score recovery, including cross-measure ties', () => {
    const transcript = transcribePerformance(performanceFixture([
      { beat: 0, duration: 5, pitch: 64 },
    ]));
    expect(transcript.gate.certified).toBe(true);
    const notes = canonicalNotesInMusicXml(transcript.musicxml!);
    expect(notes).toEqual([{ id: 'n0', pitch: 64, onsetBeats: 0, durationBeats: 5 }]);
    expect(transcript.musicxml).toContain('<tie type="start"/>');
    expect(transcript.musicxml).toContain('<tie type="stop"/>');
  });

  it('rejects tied fragments separated by a rest instead of certifying their summed duration', () => {
    const transcript = transcribePerformance(performanceFixture([
      { beat: 0, duration: 5, pitch: 64 },
    ]));
    // Move the tied continuation one quarter later while keeping both staff
    // cursors complete; a duration-only collapse must not hide this gap.
    const shifted = transcript.musicxml!.replace(
      /(<measure number="2">\n)(      <note id="n0">[\s\S]*?<\/note>\n)(      <note>\n        <rest\/>\n        <duration>)72(<\/duration>[\s\S]*?<\/note>)/,
      '$1      <note>\n        <rest/>\n        <duration>24</duration>\n        <voice>1</voice>\n        <type>quarter</type>\n        <staff>1</staff>\n      </note>\n$2$348$4',
    );
    expect(() => canonicalNotesInMusicXml(shifted)).toThrow(/non-contiguous tie chain/);
  });

  it('passes exactly 99/100 jointly conforming notes', () => {
    const notes = sequentialNotes(100);
    notes[0] = { ...notes[0], beat: notes[0].beat + 0.125 };
    const transcript = transcribePerformance(performanceFixture(notes));
    expect(transcript.gate.jointFitRate).toBe(0.99);
    expect(transcript.gate.certified).toBe(true);
  });

  it('fails 98/100 jointly conforming notes', () => {
    const notes = sequentialNotes(100);
    notes[0] = { ...notes[0], beat: notes[0].beat + 0.125 };
    notes[1] = { ...notes[1], beat: notes[1].beat + 0.125 };
    const transcript = transcribePerformance(performanceFixture(notes));
    expect(transcript.gate.jointFitRate).toBe(0.98);
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toContain('joint-grid-misfit');
  });

  it('cannot hide disjoint onset and duration failures', () => {
    const notes = sequentialNotes(100);
    notes[0] = { ...notes[0], beat: notes[0].beat + 0.125 };
    notes[1] = { ...notes[1], duration: 1.125 };
    const transcript = transcribePerformance(performanceFixture(notes));
    expect(transcript.gate.onsetFitRate).toBe(0.99);
    expect(transcript.gate.durationFitRate).toBe(0.99);
    expect(transcript.gate.jointFitRate).toBe(0.98);
    expect(transcript.gate.certified).toBe(false);
  });

  it('prevents callers from lowering the threshold or widening tolerances', () => {
    const source = performanceFixture([{ beat: 0, duration: 1, pitch: 60 }]);
    expect(() => transcribePerformance(source, { threshold: 0 })).toThrow(/threshold/);
    expect(() => transcribePerformance(source, { onsetToleranceBeats: Infinity })).toThrow(/tolerance/);
    expect(() => transcribePerformance(source, { durationToleranceBeats: 0.13 })).toThrow(/tolerance/);
    expect(() => transcribePerformance(source, { tempoBpm: Infinity })).toThrow(/Tempo/);
    expect(() => transcribePerformance(source, { timeSignature: { numerator: 4, denominator: 3 } })).toThrow(/denominator/);
  });

  it('preserves two explicit hand tracks instead of forcing every note through C4', () => {
    const source = performanceFixture([
      { beat: 0, duration: 1, pitch: 72, track: 4 },
      { beat: 1, duration: 1, pitch: 48, track: 4 },
      { beat: 0, duration: 1, pitch: 36, track: 9 },
      { beat: 1, duration: 1, pitch: 67, track: 9 },
    ], {
      programEvents: [
        { tick: 0, channel: 0, track: 4, program: 0 },
        { tick: 0, channel: 0, track: 9, program: 0 },
      ],
      trackNames: ['metadata', 'metadata', 'metadata', 'metadata', 'Right hand', 'metadata', 'metadata', 'metadata', 'metadata', 'Left hand'],
      integrity: {
        ...performanceFixture([]).integrity,
        smfFormat: 1,
      },
    });
    const transcript = transcribePerformance(source, { staffMode: 'auto' });
    expect(transcript.quantized.map((note) => note.staff)).toEqual([1, 1, 2, 2]);
    expect(transcript.gate).toMatchObject({ certified: true, scoreFidelityRate: 1 });
    expect(transcript.warnings.join(' ')).toMatch(/preserves the two MIDI note tracks/);
  });
});
