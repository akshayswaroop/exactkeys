import type { NoteEventTime } from '@spotify/basic-pitch';
import {
  estimateKeySignature,
  transcribePerformance,
  type Performance,
  type PerformedNote,
  type Transcript,
  type TranscribeOptions,
} from './engine';

export interface YouTubeAudio {
  bytes: ArrayBuffer;
  contentType: string;
  title: string;
  sourceUrl: string;
}

export interface AudioDraftProgress {
  stage: 'downloading' | 'decoding' | 'transcribing' | 'building';
  progress: number;
  detail: string;
}

const SAMPLE_RATE = 22_050;
const CHUNK_SECONDS = 30;
const OVERLAP_SECONDS = 1;
const MAX_NOTES = 12_000;

export async function fetchYouTubeAudio(url: string): Promise<YouTubeAudio> {
  const response = await fetch('/api/youtube-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    let message = `YouTube import failed (${response.status}).`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the status-based message when the server did not return JSON.
    }
    throw new Error(message);
  }
  const encodedTitle = response.headers.get('X-ExactKeys-Title');
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
    title: encodedTitle ? decodeURIComponent(encodedTitle) : 'YouTube piano',
    sourceUrl: url,
  };
}

export async function transcribeYouTubePiano(
  audio: YouTubeAudio,
  options: TranscribeOptions,
  onProgress: (progress: AudioDraftProgress) => void,
): Promise<{ transcript: Transcript; audioUrl: string }> {
  onProgress({ stage: 'decoding', progress: 0.03, detail: 'Decoding the downloaded audio locally' });
  const decoded = await decodeAndResample(audio.bytes.slice(0));
  const { BasicPitch, noteFramesToTime, outputToNotesPoly } = await import('@spotify/basic-pitch');
  const modelUrl = new URL('/basic-pitch-model/model.json', window.location.origin).href;
  const model = new BasicPitch(modelUrl);
  const samples = decoded.getChannelData(0);
  const detected: NoteEventTime[] = [];
  const totalSeconds = samples.length / SAMPLE_RATE;
  const chunkCount = Math.max(1, Math.ceil(totalSeconds / CHUNK_SECONDS));

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const nominalStart = chunkIndex * CHUNK_SECONDS;
    const nominalEnd = Math.min(totalSeconds, nominalStart + CHUNK_SECONDS);
    const windowStart = Math.max(0, nominalStart - OVERLAP_SECONDS);
    const windowEnd = Math.min(totalSeconds, nominalEnd + OVERLAP_SECONDS);
    const sampleStart = Math.floor(windowStart * SAMPLE_RATE);
    const sampleEnd = Math.ceil(windowEnd * SAMPLE_RATE);
    const frames: number[][] = [];
    const onsets: number[][] = [];
    await model.evaluateModel(
      samples.slice(sampleStart, sampleEnd),
      (nextFrames, nextOnsets) => {
        frames.push(...nextFrames);
        onsets.push(...nextOnsets);
      },
      (chunkProgress) => {
        const overall = (chunkIndex + chunkProgress) / chunkCount;
        onProgress({
          stage: 'transcribing',
          progress: 0.08 + overall * 0.84,
          detail: `Detecting piano notes · chunk ${chunkIndex + 1} of ${chunkCount}`,
        });
      },
    );
    // Spotify's published defaults are intentionally retained for the first
    // release. Lower thresholds sound fuller but increase harmonic false positives.
    const localNotes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 5));
    for (const note of localNotes) {
      const absoluteStart = note.startTimeSeconds + windowStart;
      if (absoluteStart + 1e-6 < nominalStart || (chunkIndex < chunkCount - 1 && absoluteStart >= nominalEnd)) continue;
      detected.push({ ...note, startTimeSeconds: Math.max(0, absoluteStart) });
    }
    if (detected.length > MAX_NOTES) throw new Error(`Audio produced more than ${MAX_NOTES.toLocaleString()} note candidates; shorten the video.`);
  }

  onProgress({ stage: 'building', progress: 0.94, detail: 'Building an editable, uncertified note draft' });
  const bpm = finiteBpm(options.tempoBpm);
  const performance = performanceFromDetectedNotes(detected, audio.title, bpm, options.timeSignature ?? { numerator: 4, denominator: 4 });
  const estimatedKey = options.key ?? estimateKeySignature(performance.notes);
  const transcript = transcribePerformance(performance, {
    ...options,
    tempoBpm: bpm,
    timeSignature: options.timeSignature ?? { numerator: 4, denominator: 4 },
    key: estimatedKey,
    title: options.title || audio.title,
  });
  onProgress({ stage: 'building', progress: 1, detail: `Draft ready · ${performance.notes.length.toLocaleString()} inferred notes` });
  const blob = new Blob([audio.bytes], { type: audio.contentType });
  return { transcript, audioUrl: URL.createObjectURL(blob) };
}

export function retimeAudioDraftPerformance(
  performance: Performance,
  bpm: number,
  meter: { numerator: number; denominator: number },
): Performance {
  const secondsToTick = (seconds: number) => Math.max(0, Math.round(seconds * bpm / 60 * performance.ticksPerQuarter));
  return {
    ...performance,
    notes: performance.notes.map((note) => {
      const onsetTick = secondsToTick(note.onsetSec);
      return { ...note, onsetTick, offsetTick: Math.max(onsetTick + 1, secondsToTick(note.offsetSec)) };
    }),
    tempoEvents: [{ tick: 0, usPerQuarter: Math.round(60_000_000 / bpm) }],
    timeSignatures: [{ tick: 0, ...meter }],
  };
}

async function decodeAndResample(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) throw new Error('Web Audio is unavailable in this browser.');
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(bytes);
    const frameCount = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frameCount, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return await offline.startRendering();
  } finally {
    await context.close();
  }
}

function finiteBpm(value: number | undefined): number {
  return Number.isFinite(value) && value! >= 20 && value! <= 400 ? value! : 120;
}

function performanceFromDetectedNotes(
  detected: NoteEventTime[],
  title: string,
  bpm: number,
  meter: { numerator: number; denominator: number },
): Performance {
  const ticksPerQuarter = 480;
  const secondsToTick = (seconds: number) => Math.max(0, Math.round(seconds * bpm / 60 * ticksPerQuarter));
  const prepared = detected
    .filter((note) => note.pitchMidi >= 21 && note.pitchMidi <= 108 && note.durationSeconds >= 0.04)
    .map((note, index) => ({
      id: `audio-${index}`,
      pitch: Math.round(note.pitchMidi),
      velocity: Math.max(1, Math.min(127, Math.round(24 + Math.sqrt(Math.max(0, note.amplitude)) * 103))),
      channel: 0,
      track: note.pitchMidi >= 60 ? 0 : 1,
      onsetSec: note.startTimeSeconds,
      offsetSec: note.startTimeSeconds + note.durationSeconds,
    }))
    .sort((a, b) => a.onsetSec - b.onsetSec || a.pitch - b.pitch);

  const nextSamePitch = new Map<string, number>();
  for (let index = prepared.length - 1; index >= 0; index--) {
    const note = prepared[index];
    const key = `${note.track}:${note.pitch}`;
    const next = nextSamePitch.get(key);
    if (next !== undefined && note.offsetSec > next) note.offsetSec = Math.max(note.onsetSec + 0.04, next - 0.001);
    nextSamePitch.set(key, note.onsetSec);
  }
  const notes: PerformedNote[] = prepared.map((note) => {
    const onsetTick = secondsToTick(note.onsetSec);
    const offsetTick = Math.max(onsetTick + 1, secondsToTick(note.offsetSec));
    return { ...note, onsetTick, offsetTick };
  });
  const durationSec = notes.reduce((maximum, note) => Math.max(maximum, note.offsetSec), 0);
  const keyEst = estimateKeySignature(notes);
  return {
    ticksPerQuarter,
    notes,
    pedals: [],
    tempoEvents: [{ tick: 0, usPerQuarter: Math.round(60_000_000 / bpm) }],
    timeSignatures: [{ tick: 0, ...meter }],
    keySignatures: [{ tick: 0, fifths: keyEst.fifths, minor: keyEst.minor }],
    programEvents: [
      { tick: 0, channel: 0, track: 0, program: 0 },
      { tick: 0, channel: 0, track: 1, program: 0 },
    ],
    source: 'audio-draft',
    filename: `${title}.audio-draft.mid`,
    durationSec,
    trackNames: ['Audio draft · upper', 'Audio draft · lower'],
    integrity: {
      smfFormat: 1,
      explicitTempo: true,
      sourceNoteOnEvents: notes.length,
      percussionNoteOnEvents: 0,
      unmatchedNoteOns: 0,
      unmatchedNoteOffs: 0,
      overlappingSamePitch: 0,
      pitchBendEvents: detected.filter((note) => note.pitchBends?.some((bend) => bend !== 0)).length,
      neutralPitchBendEvents: 0,
      nonNeutralPitchBendEvents: 0,
      aftertouchEvents: 0,
      percussionNoteEvents: 0,
      unsupportedControlEvents: 0,
      sysexEvents: 0,
    },
  };
}

declare global {
  interface Window { webkitAudioContext?: typeof AudioContext }
}

export const audioDraftTestables = { performanceFromDetectedNotes, finiteBpm };
