/** Shared types for the 99%-gated piano transcript pipeline. */

export type TranscriptSource = 'midi-file' | 'live-midi' | 'audio-draft';

export type GridId = '1/4' | '1/8' | '1/8t' | '1/16' | '1/16t' | '1/32';

export type DurationToken = 'w' | 'h' | 'q' | '8' | '16' | '32';

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface KeySignature {
  /** Circle-of-fifths: +sharps, −flats. */
  fifths: number;
  minor: boolean;
}

export interface TempoEvent {
  tick: number;
  usPerQuarter: number;
}

export interface TimeSignatureEvent extends TimeSignature {
  tick: number;
}

export interface KeySignatureEvent extends KeySignature {
  tick: number;
}

export interface PerformedNote {
  id: string;
  pitch: number;
  velocity: number;
  channel: number;
  track: number;
  onsetTick: number;
  offsetTick: number;
  onsetSec: number;
  offsetSec: number;
}

export interface PedalRegion {
  kind: 'sustain';
  channel: number;
  track: number;
  onsetTick: number;
  offsetTick: number;
  onsetSec: number;
  offsetSec: number;
}

export interface ProgramEvent {
  tick: number;
  channel: number;
  track: number;
  program: number;
}

export interface PerformanceIntegrity {
  smfFormat: 0 | 1;
  explicitTempo: boolean;
  /** All source note-on attacks, before the solo-piano channel policy. */
  sourceNoteOnEvents: number;
  /** Source note-on attacks on GM channel 10. */
  percussionNoteOnEvents: number;
  unmatchedNoteOns: number;
  unmatchedNoteOffs: number;
  overlappingSamePitch: number;
  /** All pitch-bend messages, including centre resets. */
  pitchBendEvents: number;
  neutralPitchBendEvents: number;
  nonNeutralPitchBendEvents: number;
  aftertouchEvents: number;
  percussionNoteEvents: number;
  unsupportedControlEvents: number;
  sysexEvents: number;
}

export interface Performance {
  ticksPerQuarter: number;
  notes: PerformedNote[];
  pedals: PedalRegion[];
  tempoEvents: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  keySignatures: KeySignatureEvent[];
  programEvents: ProgramEvent[];
  source: TranscriptSource;
  filename?: string;
  /** Wall-clock length of the captured performance. */
  durationSec: number;
  trackNames: string[];
  integrity: PerformanceIntegrity;
}

export interface SpelledPitch {
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  alter: number;
  octave: number;
  /** e.g. C#4, Bb3 */
  name: string;
}

export interface QuantizedNote {
  id: string;
  pitch: number;
  spelled: SpelledPitch;
  velocity: number;
  staff: 1 | 2;
  onsetBeats: number;
  durationBeats: number;
  onsetSec: number;
  durationSec: number;
  onsetErrorBeats: number;
  durationErrorBeats: number;
  onsetFit: boolean;
  durationFit: boolean;
}

export interface GateResult {
  certified: boolean;
  status: 'certified-score' | 'abstained';
  certificationProfile: 'score-note-v1';
  onsetFitRate: number;
  durationFitRate: number;
  /** Notes whose onset AND duration fit the fixed release tolerances. */
  jointFitRate: number;
  /** Exact canonical-note recovery after reparsing emitted MusicXML. */
  scoreFidelityRate: number;
  scoreFidelityEvaluated: boolean;
  gridConformant: boolean;
  noteCount: number;
  onsetMisfits: number;
  durationMisfits: number;
  threshold: number;
  grid: GridId;
  tempoBpm: number;
  tempoSource: 'midi-meta' | 'user' | 'default-120';
  timeSignature: TimeSignature;
  timeSignatureSource: 'midi-meta' | 'user' | 'assumed-4/4';
  key: KeySignature;
  keySource: 'midi-meta' | 'user' | 'detected';
  reasons: string[];
  reasonCodes: string[];
  claimedDimensions: string[];
}

export type ScoreLeaf =
  | {
      kind: 'chord';
      duration: DurationToken;
      dots: 0 | 1;
      ticks: number;
      notes: Array<{
        id: string;
        spelled: SpelledPitch;
        pitch: number;
        tieStart: boolean;
        tieEnd: boolean;
      }>;
    }
  | {
      kind: 'rest';
      duration: DurationToken;
      dots: 0 | 1;
      ticks: number;
    };

export interface ScoreMeasure {
  number: number;
  startBeats: number;
  durationBeats: number;
  timeSignature: TimeSignature;
  key: KeySignature;
  treble: ScoreLeaf[];
  bass: ScoreLeaf[];
}

export interface EngravedScore {
  title: string;
  measures: ScoreMeasure[];
  divisions: number;
  tempoBpm: number;
  certified: boolean;
}

export interface EventVerification {
  verified: boolean;
  profile: 'smf-note-events-v1';
  accuracy: number;
  claimedFields: Array<'track' | 'channel' | 'pitch' | 'velocity' | 'onsetTick' | 'offsetTick'>;
  reasons: string[];
}

export interface Transcript {
  performance: Performance;
  eventVerification: EventVerification;
  quantized: QuantizedNote[];
  gate: GateResult;
  score: EngravedScore | null;
  musicxml: string | null;
  /** Non-certifying notation derived from probabilistic audio events. */
  draftMusicxml?: string | null;
  warnings: string[];
}

export type StaffMode = 'auto' | 'track' | 'pitch';

export interface TranscribeOptions {
  grid?: GridId;
  /** Override or supply tempo in BPM. */
  tempoBpm?: number;
  timeSignature?: TimeSignature;
  key?: KeySignature;
  /** Preserve two explicit hand tracks when available, or fall back to pitch. */
  staffMode?: StaffMode;
  /** MIDI note number split between bass (<) and treble (>=). Default 60. */
  splitMidi?: number;
  /** Certification threshold. Default 0.99. */
  threshold?: number;
  /** Max onset error in quarter-note beats to count as a fit. Default 0.08. */
  onsetToleranceBeats?: number;
  /** Max duration error in beats. Default 0.12. */
  durationToleranceBeats?: number;
  title?: string;
}

export interface Rejection {
  rejected: true;
  filename: string;
  code:
    | 'audio-below-threshold'
    | 'unsupported-type'
    | 'malformed-midi'
    | 'unsupported-midi'
    | 'invalid-options';
  reason: string;
  approach: string;
  publishedCeiling: string;
}

export interface FidelityReport {
  precision: number;
  recall: number;
  f1: number;
  matched: number;
  onlyA: number;
  onlyB: number;
  onsetMaeMs: number;
  offsetMaeMs: number;
  pitchExact: boolean;
  certified: boolean;
}

export const AUDIO_EXTENSIONS = [
  '.wav',
  '.wave',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aiff',
  '.aif',
  '.wma',
  '.caf',
  '.mp4',
  '.mov',
  '.webm',
] as const;

export const MIDI_EXTENSIONS = ['.mid', '.midi'] as const;

export const CERTIFY_THRESHOLD = 0.99;
export const DEFAULT_SPLIT = 60;
export const DEFAULT_GRID: GridId = '1/16';
export const DEFAULT_ONSET_TOLERANCE = 0.08;
export const DEFAULT_DURATION_TOLERANCE = 0.12;
export const DEFAULT_TEMPO_BPM = 120;
export const MUSICXML_DIVISIONS = 24;
