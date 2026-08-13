/**
 * Web Worker entry point for offloading TensorFlow.js BasicPitch audio inference
 * off the main browser thread.
 */

import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';

self.onmessage = async (event: MessageEvent) => {
  const { type, samples, modelUrl } = event.data;
  if (type !== 'eval') return;

  try {
    const model = new BasicPitch(modelUrl || '/basic-pitch-model/model.json');
    const frames: number[][] = [];
    const onsets: number[][] = [];

    await model.evaluateModel(
      samples,
      (nextFrames, nextOnsets) => {
        frames.push(...nextFrames);
        onsets.push(...nextOnsets);
      },
      (pct) => {
        self.postMessage({ type: 'progress', progress: pct });
      },
    );

    const rawNotes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 5));
    self.postMessage({ type: 'complete', notes: rawNotes });
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
