#!/usr/bin/env node

import {
  isAudioFilename,
  isRejection,
  performanceToMidi,
  rejectIfNotMidi,
  transcribeMidiBytes,
  type GridId,
  type KeySignature,
  type QuantizedNote,
  type TimeSignature,
  type Transcript,
  type TranscribeOptions,
} from './engine/index';
import { transcribeAudioOrYouTubeCli } from './nodeTranscribe';

/*
 * The browser build deliberately has no dependency on @types/node. Keep the
 * small Node surface used by this standalone entry point structural so the UI
 * and CLI can share one strict TypeScript project.
 */
declare const process: {
  argv: string[];
  cwd(): string;
  exitCode?: number;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
};

interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  unlink(path: string): Promise<void>;
}

interface PathApi {
  basename(path: string): string;
  dirname(path: string): string;
  join(...parts: string[]): string;
  parse(path: string): { name: string };
  resolve(...parts: string[]): string;
}

type DynamicImport = (specifier: string) => Promise<unknown>;
const dynamicImport = Function('specifier', 'return import(specifier)') as DynamicImport;
const fs = (await dynamicImport('node:fs/promises')) as FileSystem;
const path = (await dynamicImport('node:path')) as PathApi;

const VERSION = '1.0.0';
const GRIDS = new Set<GridId>(['1/4', '1/8', '1/8t', '1/16', '1/16t', '1/32']);
const EXIT = {
  certified: 0,
  abstained: 1,
  usage: 2,
  rejected: 3,
  invalidMidi: 4,
  io: 5,
  uncertifiedDraft: 6,
  software: 70,
} as const;

interface CliOptions {
  input: string;
  outDir?: string;
  transcribe: TranscribeOptions;
}

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const HELP = `ExactKeys ${VERSION}

Fail-closed, MIDI-relative piano notation plus explicitly uncertified YouTube/audio piano drafts.

Usage:
  npm run cli -- <input.mid|youtube_url|audio_file> [options]

Options:
  -o, --out-dir <dir>       Output directory (default: input directory)
      --grid <grid>         1/4, 1/8, 1/8t, 1/16, 1/16t, or 1/32
      --tempo-bpm <bpm>     Override tempo with a positive BPM
      --meter <n/d>         Supply score meter, for example 4/4 or 6/8
      --key <fifths[:mode]> Supply -7..7 fifths and optional major/minor mode
      --staff-mode <mode>   auto, track, or pitch (default auto)
      --split-midi <0..127> First pitch assigned to the treble staff (default 60)
      --threshold <rate>    Certification rate in [0.99, 1] (default 0.99)
      --title <text>        Score title
  -h, --help                Show this help
  -v, --version             Show the version

Exit codes:
  0  certified score written       1  valid MIDI; score abstained
  2  command-line error             3  audio or non-MIDI rejected
  4  malformed/unsupported MIDI     5  file-system error
  6  uncertified draft written     70 internal invariant failure
`;

async function main(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return EXIT.certified;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.certified;
  }

  const cli = parseArgs(args);
  const isUrl = /^https?:\/\//i.test(cli.input);
  const inputPath = isUrl ? cli.input : path.resolve(process.cwd(), cli.input);
  const filename = isUrl ? cli.input : path.basename(inputPath);

  if (isUrl || isAudioFilename(filename)) {
    const outDir = path.resolve(process.cwd(), cli.outDir ?? (isUrl ? process.cwd() : path.dirname(inputPath)));
    try {
      const res = await transcribeAudioOrYouTubeCli(cli.input, outDir, cli.transcribe, (msg) => {
        process.stderr.write(`${msg}\n`);
      });
      process.stdout.write(
        [
          `UNCERTIFIED AUDIO DRAFT (${res.title})`,
          `XML   ${res.musicXmlPath}`,
          `MIDI  ${res.midiPath}`,
          `Audit ${res.auditPath}`,
        ].join('\n') + '\n',
      );
      return EXIT.uncertifiedDraft;
    } catch (error) {
      printJsonError({
        status: 'rejected',
        exitCode: EXIT.rejected,
        rejection: {
          code: 'audio-below-threshold',
          reason: errorMessage(error),
          filename,
        },
      });
      return EXIT.rejected;
    }
  }

  const namedRejection = rejectIfNotMidi(filename);
  if (namedRejection) {
    printJsonError({ status: 'rejected', exitCode: EXIT.rejected, rejection: namedRejection });
    return EXIT.rejected;
  }

  let inputBytes: Uint8Array;
  try {
    inputBytes = await fs.readFile(inputPath);
  } catch (error) {
    throw new CliError(`Cannot read ${inputPath}: ${errorMessage(error)}`, EXIT.io);
  }

  let result: ReturnType<typeof transcribeMidiBytes>;
  try {
    result = transcribeMidiBytes(inputBytes, filename, cli.transcribe);
  } catch (error) {
    printJsonError({
      status: 'rejected',
      exitCode: EXIT.invalidMidi,
      rejection: {
        code: classifyMidiFailure(errorMessage(error)),
        reason: errorMessage(error),
        filename,
      },
    });
    return EXIT.invalidMidi;
  }

  if (isRejection(result)) {
    const code = result.code === 'invalid-options'
      ? EXIT.usage
      : result.code === 'malformed-midi' || result.code === 'unsupported-midi'
        ? EXIT.invalidMidi
        : EXIT.rejected;
    printJsonError({ status: 'rejected', exitCode: code, rejection: result });
    return code;
  }

  assertTranscriptInvariant(result);

  const outDir = path.resolve(process.cwd(), cli.outDir ?? path.dirname(inputPath));
  const stem = path.parse(filename).name;
  const output = {
    normalizedMidi: path.join(outDir, `${stem}.normalized.mid`),
    audit: path.join(outDir, `${stem}.audit.json`),
    musicXml: path.join(outDir, `${stem}.musicxml`),
    notesCsv: path.join(outDir, `${stem}.notes.csv`),
  };

  try {
    await fs.mkdir(outDir, { recursive: true });
    if (result.eventVerification.verified) {
      await fs.writeFile(output.normalizedMidi, performanceToMidi(result.performance));
    } else {
      await removeIfPresent(output.normalizedMidi);
    }

    if (!result.gate.certified) {
      // A new abstention must never leave an old score looking current.
      await removeIfPresent(output.musicXml);
      await removeIfPresent(output.notesCsv);
    }

    const audit = createAudit(result, {
      inputPath,
      inputByteLength: inputBytes.byteLength,
      normalizedMidi: result.eventVerification.verified ? output.normalizedMidi : null,
      audit: output.audit,
      musicXml: result.gate.certified ? output.musicXml : null,
      notesCsv: result.gate.certified ? output.notesCsv : null,
    });
    // The audit is written for every valid MIDI, including abstentions.
    await fs.writeFile(output.audit, `${JSON.stringify(audit, null, 2)}\n`);

    if (result.gate.certified) {
      await fs.writeFile(output.musicXml, result.musicxml!);
      await fs.writeFile(output.notesCsv, notesCsv(result));
    }
  } catch (error) {
    throw new CliError(`Cannot write outputs in ${outDir}: ${errorMessage(error)}`, EXIT.io);
  }

  if (result.gate.certified) {
    process.stdout.write(
      [
        `CERTIFIED (${percent(result.gate.jointFitRate)} joint grid conformity; ${percent(result.gate.scoreFidelityRate)} score fidelity)`,
        `MIDI  ${output.normalizedMidi}`,
        `Audit ${output.audit}`,
        `XML   ${output.musicXml}`,
        `CSV   ${output.notesCsv}`,
      ].join('\n') + '\n',
    );
    return EXIT.certified;
  }

  process.stdout.write(
    [
      `ABSTAINED (${percent(result.gate.jointFitRate)} joint grid conformity; need ${percent(result.gate.threshold)})`,
      ...result.gate.reasons.map((reason) => `- ${reason}`),
      result.eventVerification.verified
        ? `MIDI  ${output.normalizedMidi}`
        : 'MIDI  withheld because exact note-event recovery was not proven',
      `Audit ${output.audit}`,
      'MusicXML and notes CSV were not emitted.',
    ].join('\n') + '\n',
  );
  return EXIT.abstained;
}

function parseArgs(args: string[]): CliOptions {
  const positionals: string[] = [];
  const transcribe: TranscribeOptions = {};
  let outDir: string | undefined;
  let optionsEnded = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (optionsEnded || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }

    const equal = token.startsWith('--') ? token.indexOf('=') : -1;
    const option = equal >= 0 ? token.slice(0, equal) : token;
    const inlineValue = equal >= 0 ? token.slice(equal + 1) : undefined;
    const takeValue = (): string => {
      const value = inlineValue ?? args[++i];
      if (value === undefined || value === '') {
        throw usageError(`${option} requires a value`);
      }
      return value;
    };

    switch (option) {
      case '-o':
      case '--out-dir':
      case '--output-dir':
        outDir = takeValue();
        break;
      case '--grid': {
        const value = takeValue() as GridId;
        if (!GRIDS.has(value)) throw usageError(`Unknown grid "${value}"`);
        transcribe.grid = value;
        break;
      }
      case '--tempo':
      case '--tempo-bpm':
        transcribe.tempoBpm = finiteNumber(takeValue(), option, { exclusiveMin: 0 });
        break;
      case '--meter':
      case '--time-signature':
        transcribe.timeSignature = parseMeter(takeValue());
        break;
      case '--key':
        transcribe.key = parseKey(takeValue());
        break;
      case '--staff-mode': {
        const value = takeValue();
        if (value !== 'auto' && value !== 'track' && value !== 'pitch') {
          throw usageError(`Unknown staff mode "${value}"`);
        }
        transcribe.staffMode = value;
        break;
      }
      case '--split':
      case '--split-midi':
        transcribe.splitMidi = integer(takeValue(), option, 0, 127);
        break;
      case '--threshold':
        transcribe.threshold = finiteNumber(takeValue(), option, { min: 0.99, max: 1 });
        break;
      case '--title':
        transcribe.title = takeValue();
        break;
      default:
        throw usageError(`Unknown option "${option}"`);
    }
  }

  if (positionals.length === 0) throw usageError('Missing input MIDI file');
  if (positionals.length > 1) throw usageError(`Expected one input MIDI file; received ${positionals.length}`);
  return { input: positionals[0], outDir, transcribe };
}

function parseMeter(value: string): TimeSignature {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw usageError(`Invalid meter "${value}"; expected numerator/denominator`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator < 1 || numerator > 32) throw usageError('Meter numerator must be in 1..32');
  if (denominator < 1 || denominator > 64 || (denominator & (denominator - 1)) !== 0) {
    throw usageError('Meter denominator must be a power of two in 1..64');
  }
  return { numerator, denominator };
}

function parseKey(value: string): KeySignature {
  const match = /^([+-]?\d+)(?::(major|minor))?$/i.exec(value);
  if (!match) throw usageError(`Invalid key "${value}"; expected fifths[:major|minor]`);
  const fifths = Number(match[1]);
  if (!Number.isInteger(fifths) || fifths < -7 || fifths > 7) {
    throw usageError('Key fifths must be an integer in -7..7');
  }
  return { fifths, minor: match[2]?.toLowerCase() === 'minor' };
}

function finiteNumber(
  value: string,
  option: string,
  bounds: { min?: number; max?: number; exclusiveMin?: number },
): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw usageError(`${option} must be a finite number`);
  if (bounds.min !== undefined && number < bounds.min) throw usageError(`${option} must be at least ${bounds.min}`);
  if (bounds.max !== undefined && number > bounds.max) throw usageError(`${option} must be at most ${bounds.max}`);
  if (bounds.exclusiveMin !== undefined && number <= bounds.exclusiveMin) {
    throw usageError(`${option} must be greater than ${bounds.exclusiveMin}`);
  }
  return number;
}

function integer(value: string, option: string, min: number, max: number): number {
  const result = finiteNumber(value, option, { min, max });
  if (!Number.isInteger(result)) throw usageError(`${option} must be an integer`);
  return result;
}

function usageError(message: string): CliError {
  return new CliError(`${message}\n\nRun with --help for usage.`, EXIT.usage);
}

function assertTranscriptInvariant(transcript: Transcript): void {
  const certifiedShape =
    transcript.gate.status === 'certified-score' &&
    transcript.gate.certified &&
    transcript.gate.jointFitRate + 1e-12 >= transcript.gate.threshold &&
    transcript.gate.threshold >= 0.99 &&
    transcript.gate.scoreFidelityRate === 1 &&
    transcript.eventVerification.verified &&
    transcript.eventVerification.accuracy === 1 &&
    transcript.score !== null &&
    transcript.musicxml !== null;

  if (transcript.gate.certified && !certifiedShape) {
    throw new CliError('Engine returned an inconsistent score certificate; refusing score output.', EXIT.software);
  }
  if (!transcript.gate.certified && (transcript.score !== null || transcript.musicxml !== null)) {
    throw new CliError('Engine returned score data for an abstention; refusing output.', EXIT.software);
  }
}

function createAudit(
  transcript: Transcript,
  files: {
    inputPath: string;
    inputByteLength: number;
    normalizedMidi: string | null;
    audit: string;
    musicXml: string | null;
    notesCsv: string | null;
  },
): object {
  return {
    schema: 'exactkeys-transcript-audit-v1',
    utilityVersion: VERSION,
    outcome: {
      status: transcript.gate.status,
      certified: transcript.gate.certified,
      scoreArtifactsEmitted: transcript.gate.certified,
    },
    input: {
      path: files.inputPath,
      filename: path.basename(files.inputPath),
      byteLength: files.inputByteLength,
      source: transcript.performance.source,
      smfFormat: transcript.performance.integrity.smfFormat,
      ticksPerQuarter: transcript.performance.ticksPerQuarter,
    },
    outputs: {
      normalizedMidi: files.normalizedMidi,
      audit: files.audit,
      musicXml: files.musicXml,
      notesCsv: files.notesCsv,
    },
    eventVerification: transcript.eventVerification,
    scoreCertificate: transcript.gate,
    performance: {
      noteCount: transcript.performance.notes.length,
      durationSec: transcript.performance.durationSec,
      trackNames: transcript.performance.trackNames,
      integrity: transcript.performance.integrity,
      notes: transcript.performance.notes,
      pedals: transcript.performance.pedals,
      tempoEvents: transcript.performance.tempoEvents,
      timeSignatures: transcript.performance.timeSignatures,
      keySignatures: transcript.performance.keySignatures,
      programEvents: transcript.performance.programEvents,
    },
    quantizedNotes: transcript.quantized,
    warnings: transcript.warnings,
  };
}

function notesCsv(transcript: Transcript): string {
  const performed = new Map(transcript.performance.notes.map((note) => [note.id, note]));
  const header = [
    'id',
    'pitch',
    'spelled_pitch',
    'velocity',
    'track',
    'channel',
    'staff',
    'onset_tick',
    'offset_tick',
    'onset_seconds',
    'offset_seconds',
    'quantized_onset_beats',
    'quantized_duration_beats',
    'onset_error_beats',
    'duration_error_beats',
    'onset_fit',
    'duration_fit',
    'joint_fit',
  ];
  const rows = transcript.quantized.map((note) => noteCsvRow(note, performed.get(note.id)));
  return [header.join(','), ...rows].join('\n') + '\n';
}

function noteCsvRow(note: QuantizedNote, performed: Transcript['performance']['notes'][number] | undefined): string {
  if (!performed) throw new CliError(`Missing performed event for ${note.id}`, EXIT.software);
  return [
    note.id,
    note.pitch,
    note.spelled.name,
    note.velocity,
    performed.track,
    performed.channel,
    note.staff,
    performed.onsetTick,
    performed.offsetTick,
    performed.onsetSec,
    performed.offsetSec,
    note.onsetBeats,
    note.durationBeats,
    note.onsetErrorBeats,
    note.durationErrorBeats,
    note.onsetFit,
    note.durationFit,
    note.onsetFit && note.durationFit,
  ].map(csvCell).join(',');
}

function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function removeIfPresent(filename: string): Promise<void> {
  try {
    await fs.unlink(filename);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function classifyMidiFailure(message: string): 'malformed-midi' | 'unsupported-midi' {
  return /not supported|unsupported|SMPTE|format 2/i.test(message) ? 'unsupported-midi' : 'malformed-midi';
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function printJsonError(value: object): void {
  process.stderr.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const exitCode = error instanceof CliError ? error.exitCode : EXIT.software;
  printJsonError({ status: 'error', exitCode, reason: errorMessage(error) });
  process.exitCode = exitCode;
}
