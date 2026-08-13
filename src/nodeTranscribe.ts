import { spawn } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, parse, resolve } from 'node:path';
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { audioDraftTestables } from './audioTranscription';
import { transcribePerformance } from './engine/transcribe';
import { performanceToMidi } from './engine/exportMidi';
import type { TranscribeOptions } from './engine/types';

export async function transcribeAudioOrYouTubeCli(
  input: string,
  outDir: string,
  options: TranscribeOptions = {},
  onProgress?: (text: string) => void,
): Promise<{ musicXmlPath: string; midiPath: string; auditPath: string; title: string }> {
  let audioPath = input;
  let title = parse(basename(input)).name;
  let tempDir: string | undefined;

  const isUrl = /^https?:\/\//i.test(input);
  if (isUrl) {
    onProgress?.('Downloading YouTube audio stream...');
    tempDir = await mkdtemp(join(tmpdir(), 'exactkeys-cli-yt-'));
    const executable = resolve(process.cwd(), 'tools/yt-dlp_macos');
    const args = [
      '--ignore-config',
      '--no-playlist',
      '--no-warnings',
      '--no-simulate',
      '--force-ipv4',
      '--format', 'bestaudio[ext=m4a]/bestaudio',
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

  onProgress?.('Converting audio to 22,050 Hz PCM WAV...');
  const wavDir = tempDir ?? await mkdtemp(join(tmpdir(), 'exactkeys-cli-wav-'));
  const wavPath = join(wavDir, 'resampled.wav');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('afconvert', ['-f', 'WAVE', '-c', '1', '-d', 'LEI16@22050', audioPath, wavPath]);
    child.on('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`afconvert failed with status ${code}`)));
    child.on('error', rejectPromise);
  });

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

  onProgress?.('Running Spotify Basic Pitch neural model...');
  const modelUrl = 'http://localhost:5173/basic-pitch-model/model.json';
  const model = new BasicPitch(modelUrl);
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
  const perf = audioDraftTestables.performanceFromDetectedNotes(rawNotes, title, options.tempoBpm ?? 120, options.timeSignature ?? { numerator: 4, denominator: 4 });
  const transcript = transcribePerformance(perf, { ...options, title });

  const safeStem = title.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 100);
  const musicXmlPath = join(outDir, `${safeStem}.uncertified.musicxml`);
  const midiPath = join(outDir, `${safeStem}.uncertified.mid`);
  const auditPath = join(outDir, `${safeStem}.audit.json`);

  const xmlContent = transcript.draftMusicxml || transcript.musicxml || '';
  await writeFile(musicXmlPath, xmlContent);
  await writeFile(midiPath, performanceToMidi(perf));
  await writeFile(auditPath, JSON.stringify(transcript, null, 2));

  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  if (wavDir !== tempDir) await rm(wavDir, { recursive: true, force: true });

  return { musicXmlPath, midiPath, auditPath, title };
}
