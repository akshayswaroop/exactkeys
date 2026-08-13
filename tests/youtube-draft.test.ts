import { describe, expect, it } from 'vitest';
import { audioDraftTestables, retimeAudioDraftPerformance } from '../src/audioTranscription';
import { transcribePerformance } from '../src/engine';
import { youtubeTestables } from '../vite.youtube';

describe('YouTube piano draft safety boundary', () => {
  it('accepts direct YouTube video URLs and rejects unrelated or collection URLs', () => {
    expect(youtubeTestables.normalizeYouTubeUrl('https://www.youtube.com/watch?v=xoGZrg29aRk'))
      .toContain('youtube.com/watch?v=xoGZrg29aRk');
    expect(youtubeTestables.normalizeYouTubeUrl('https://youtu.be/xoGZrg29aRk')).toContain('youtu.be/xoGZrg29aRk');
    expect(() => youtubeTestables.normalizeYouTubeUrl('https://example.com/watch?v=xoGZrg29aRk')).toThrow(/Only youtube/i);
    expect(() => youtubeTestables.normalizeYouTubeUrl('https://www.youtube.com/playlist?list=abc')).toThrow(/direct.*video/i);
  });

  it('turns detected notes into a playable performance but never a certificate', () => {
    const performance = audioDraftTestables.performanceFromDetectedNotes([
      { startTimeSeconds: 0, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.8 },
      { startTimeSeconds: 0.5, durationSeconds: 0.5, pitchMidi: 64, amplitude: 0.7 },
    ], 'Audio fixture', 120, { numerator: 4, denominator: 4 });
    const transcript = transcribePerformance(performance, {
      tempoBpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      title: 'Audio fixture',
    });

    expect(transcript.performance.source).toBe('audio-draft');
    expect(transcript.gate.certified).toBe(false);
    expect(transcript.gate.reasonCodes).toContain('audio-inference-uncertified');
    expect(transcript.draftMusicxml).toContain('<miscellaneous-field name="accuracy-certified">false</miscellaneous-field>');
    expect(transcript.draftMusicxml).toContain('probabilistic-audio-inference');
  });

  it('retimes inferred events from exact seconds when the user changes BPM', () => {
    const performance = audioDraftTestables.performanceFromDetectedNotes([
      { startTimeSeconds: 1, durationSeconds: 0.5, pitchMidi: 69, amplitude: 1 },
    ], 'Tempo fixture', 120, { numerator: 4, denominator: 4 });
    const retimed = retimeAudioDraftPerformance(performance, 60, { numerator: 3, denominator: 4 });

    expect(retimed.notes[0]?.onsetTick).toBe(480);
    expect(retimed.notes[0]?.offsetTick).toBe(720);
    expect(retimed.timeSignatures[0]).toMatchObject({ numerator: 3, denominator: 4 });
  });
});
