import { AUDIO_EXTENSIONS, MIDI_EXTENSIONS, type Rejection } from './types';

const AUDIO_SET = new Set<string>(AUDIO_EXTENSIONS);
const MIDI_SET = new Set<string>(MIDI_EXTENSIONS);

export function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot).toLowerCase();
}

export function isMidiFilename(filename: string): boolean {
  return MIDI_SET.has(extensionOf(filename));
}

export function isAudioFilename(filename: string): boolean {
  return AUDIO_SET.has(extensionOf(filename));
}

/**
 * Audio-to-MIDI is discarded. Published solo-piano note F1 on MAESTRO sits
 * around 96–97% (onset+pitch) and ~83–85% with offsets — below the 99% bar.
 */
export function rejectIfNotMidi(filename: string): Rejection | null {
  if (isMidiFilename(filename)) return null;
  if (isAudioFilename(filename) || filename.toLowerCase() === 'audio' || filename === '') {
    return {
      rejected: true,
      filename,
      code: 'audio-below-threshold',
      reason:
        'Audio-to-MIDI is not enabled because this release has no independent evidence that waveform inference clears the required 99% pitch-onset-duration threshold. Use a Standard MIDI file or record MIDI directly from a digital piano.',
      approach: 'waveform inference (Onsets-and-Frames, high-resolution regression, Basic Pitch, MT3, …)',
      publishedCeiling: 'Not certified by this product at the required 99% joint threshold',
    };
  }
  return {
    rejected: true,
    filename,
    code: 'unsupported-type',
    reason: `Unsupported file type "${extensionOf(filename) || '(none)'}". ExactKeys accepts Standard MIDI (.mid/.midi) or a live digital-piano MIDI stream.`,
    approach: 'non-MIDI ingest',
    publishedCeiling: 'n/a',
  };
}

export function rejectAudioBytes(filename: string, bytes: Uint8Array): Rejection | null {
  const named = rejectIfNotMidi(filename);
  if (named) return named;
  if (bytes.length >= 4) {
    const ascii = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (ascii === 'MThd') return null;
    if (ascii === 'RIFF' || ascii === 'fLaC' || ascii === 'OggS' || ascii.startsWith('ID3')) {
      return rejectIfNotMidi(filename.replace(/\.\w+$/, '.wav'));
    }
  }
  if (bytes.length >= 12) {
    const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (box === 'ftyp') return rejectIfNotMidi('file.m4a');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2)) {
    return rejectIfNotMidi('file.mp3');
  }
  return null;
}
