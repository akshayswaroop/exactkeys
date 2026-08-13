import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { audioDraftTestables } from './audioTranscription';
import { transcribePerformance } from './engine/transcribe';
import { performanceToMidi } from './engine/exportMidi';
import { estimateKeySignature } from './engine/keyEstimation';
import type { TranscribeOptions } from './engine/types';

const MAX_AUDIO_DURATION_SEC = 1800; // 30 minutes max

export async function transcribeAudioOrYouTubeCli(
  input: string,
  outDir: string,
  options: TranscribeOptions = {},
  onProgress?: (text: string) => void,
): Promise<{ musicXmlPath: string; midiPath: string; auditPath: string; title: string }> {
  let audioPath = input;
  let title = parse(basename(input)).name;
  let tempDir: string | undefined;

  try {
    const isUrl = /^https?:\/\//i.test(input);
    if (isUrl) {
      onProgress?.('Downloading YouTube audio stream via pinned yt-dlp...');
      tempDir = await mkdtemp(join(tmpdir(), 'exactkeys-cli-yt-'));
      const executable = resolve(process.cwd(), 'tools/yt-dlp_macos');
      const args = [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--force-ipv4',
        '--extractor-args', 'youtube:player_client=mweb,android',
        '--format', '18/bestaudio[ext=m4a]/bestaudio',
        '--output', join(tempDir, 'audio.%(ext)s'),
        '--print', '%(title)s',
        input,
      ];
      let stdout = '';
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.on('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`yt-dlp exited with status ${code}`)));
        child.on('error', rejectPromise);
      });
      const files = (await readdir(tempDir)).filter((f) => f.startsWith('audio.'));
      if (files.length === 0) throw new Error('YouTube audio download failed.');
      audioPath = join(tempDir, files[0]);
      title = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || 'YouTube piano draft';
    }

    onProgress?.('Converting audio to 22,050 Hz PCM mono WAV...');
    const wavDir = tempDir ?? await mkdtemp(join(tmpdir(), 'exactkeys-cli-wav-'));
    const wavPath = join(wavDir, 'resampled.wav');

    // Attempt direct afconvert mono mixdown; fallback to stereo decode then mono mixdown if needed
    let convertError: Error | undefined;
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn('afconvert', ['-f', 'WAVE', '-c', '1', '-d', 'LEI16@22050', audioPath, wavPath]);
        child.on('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`afconvert status ${code}`)));
        child.on('error', rejectPromise);
      });
    } catch (err) {
      convertError = err instanceof Error ? err : new Error(String(err));
    }

    if (convertError) {
      // Two-step fallback: decode format to WAV first, then resample/mixdown
      const intermediateWav = join(wavDir, 'intermediate.wav');
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', audioPath, intermediateWav]);
        child.on('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`afconvert step 1 status ${code}`)));
        child.on('error', rejectPromise);
      });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn('afconvert', ['-f', 'WAVE', '-c', '1', '-d', 'LEI16@22050', intermediateWav, wavPath]);
        child.on('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`afconvert step 2 status ${code}`)));
        child.on('error', rejectPromise);
      });
    }

    onProgress?.('Reading PCM audio samples...');
    const wavBuffer = await readFile(wavPath);
    let dataOffset = 12;
    while (dataOffset < wavBuffer.length - 8) {
      const chunkId = wavBuffer.toString('ascii', dataOffset, dataOffset + 4);
      const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4);
      if (chunkId === 'data') {
        dataOffset += 8;
        break;
      }
      dataOffset += 8 + chunkSize;
    }
    const samples = new Float32Array((wavBuffer.length - dataOffset) / 2);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = wavBuffer.readInt16LE(dataOffset + i * 2) / 32768.0;
    }

    const durationSec = samples.length / 22050;
    if (durationSec > MAX_AUDIO_DURATION_SEC) {
      throw new Error(`Audio duration (${(durationSec / 60).toFixed(1)} mins) exceeds max limit of ${MAX_AUDIO_DURATION_SEC / 60} mins.`);
    }

    onProgress?.('Loading Spotify Basic Pitch model offline from disk...');
    const modelJsonText = await readFile(resolve(process.cwd(), 'public/basic-pitch-model/model.json'), 'utf8');
    const shardBuffer = await readFile(resolve(process.cwd(), 'public/basic-pitch-model/group1-shard1of1.bin'));
    const modelJson = JSON.parse(modelJsonText);

    const ioHandler = {
      load: async () => ({
        modelTopology: modelJson.modelTopology,
        format: modelJson.format,
        generatedBy: modelJson.generatedBy,
        convertedBy: modelJson.convertedBy,
        weightSpecs: modelJson.weightsManifest[0].weights,
        weightData: shardBuffer.buffer.slice(shardBuffer.byteOffset, shardBuffer.byteOffset + shardBuffer.byteLength),
      }),
    };

    const tf = await import('@tensorflow/tfjs');
    const graphModel = await tf.loadGraphModel(ioHandler);
    const model = new BasicPitch(Promise.resolve(graphModel));

    const frames: number[][] = [];
    const onsets: number[][] = [];

    await model.evaluateModel(
      samples,
      (nextFrames, nextOnsets) => {
        frames.push(...nextFrames);
        onsets.push(...nextOnsets);
      },
      (pct) => {
        onProgress?.(`Evaluating audio frame candidates · ${(pct * 100).toFixed(1)}%`);
      },
    );

    const rawNotes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.5, 0.3, 5));
    const perf = audioDraftTestables.performanceFromDetectedNotes(
      rawNotes,
      title,
      options.tempoBpm ?? 120,
      options.timeSignature ?? { numerator: 4, denominator: 4 },
    );

    const estimatedKey = options.key ?? estimateKeySignature(perf.notes);
    const transcript = transcribePerformance(perf, { ...options, key: estimatedKey, title });

    await mkdir(outDir, { recursive: true });

    const safeStem = title.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 100);
    const musicXmlPath = join(outDir, `${safeStem}.uncertified.musicxml`);
    const midiPath = join(outDir, `${safeStem}.uncertified.mid`);
    const auditPath = join(outDir, `${safeStem}.audit.json`);

    const xmlContent = transcript.draftMusicxml || transcript.musicxml || '';
    if (!xmlContent || xmlContent.trim().length === 0) {
      throw new Error('Transcriber produced empty MusicXML score content.');
    }

    await writeFile(musicXmlPath, xmlContent);
    await writeFile(midiPath, performanceToMidi(perf));
    await writeFile(auditPath, JSON.stringify(transcript, null, 2));

    return { musicXmlPath, midiPath, auditPath, title };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
