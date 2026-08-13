import { detectKey, spellPitch } from './pitch';
import { primaryTempoBpm } from './performance';
import type {
  GateResult,
  GridId,
  KeySignature,
  Performance,
  QuantizedNote,
  TimeSignature,
  TranscribeOptions,
} from './types';
import {
  CERTIFY_THRESHOLD,
  DEFAULT_DURATION_TOLERANCE,
  DEFAULT_GRID,
  DEFAULT_ONSET_TOLERANCE,
  DEFAULT_SPLIT,
  DEFAULT_TEMPO_BPM,
} from './types';

export const GRID_PER_QUARTER: Record<GridId, number> = {
  '1/4': 1,
  '1/8': 2,
  '1/8t': 3,
  '1/16': 4,
  '1/16t': 6,
  '1/32': 8,
};

export function gridLabel(grid: GridId): string {
  switch (grid) {
    case '1/4':
      return 'quarter';
    case '1/8':
      return 'eighth';
    case '1/8t':
      return 'eighth triplet';
    case '1/16':
      return 'sixteenth';
    case '1/16t':
      return 'sixteenth triplet';
    case '1/32':
      return 'thirty-second';
  }
}

export interface QuantizeOutput {
  notes: QuantizedNote[];
  gate: GateResult;
}

export function quantizePerformance(perf: Performance, options: TranscribeOptions = {}): QuantizeOutput {
  validateOptions(options);
  const grid = options.grid ?? DEFAULT_GRID;
  const threshold = options.threshold ?? CERTIFY_THRESHOLD;
  const onsetTol = options.onsetToleranceBeats ?? DEFAULT_ONSET_TOLERANCE;
  const durTol = options.durationToleranceBeats ?? DEFAULT_DURATION_TOLERANCE;
  const split = options.splitMidi ?? DEFAULT_SPLIT;
  const staffForNote = resolveStaffAssignment(perf, options.staffMode ?? 'auto', split);

  const { bpm, tempoSource } = resolveTempo(perf, options.tempoBpm);
  const { timeSignature, timeSignatureSource } = resolveMeter(perf, options.timeSignature);
  const { key, keySource } = resolveKey(perf, options.key);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400) throw new Error('Resolved MIDI tempo is outside 20–400 BPM');
  if (
    !Number.isInteger(timeSignature.numerator) ||
    timeSignature.numerator < 1 ||
    timeSignature.numerator > 32 ||
    !Number.isInteger(timeSignature.denominator) ||
    timeSignature.denominator < 1 ||
    timeSignature.denominator > 64 ||
    (timeSignature.denominator & (timeSignature.denominator - 1)) !== 0
  ) throw new Error('Resolved MIDI meter is outside the supported 1–32 / power-of-two profile');
  if (!Number.isInteger(key.fifths) || key.fifths < -7 || key.fifths > 7) {
    throw new Error('Resolved MIDI key signature must contain -7 to 7 fifths');
  }

  const g = 1 / GRID_PER_QUARTER[grid];
  const notes: QuantizedNote[] = perf.notes.map((n) => {
    // PPQ ticks are the symbolic clock. Seconds cannot be converted with one
    // BPM when a file contains a tempo map.
    const onsetBeats = n.onsetTick / perf.ticksPerQuarter;
    const offsetBeats = n.offsetTick / perf.ticksPerQuarter;
    const rawDur = Math.max(offsetBeats - onsetBeats, 1 / perf.ticksPerQuarter);
    const qOnset = snap(onsetBeats, g);
    let qOffset = snap(offsetBeats, g);
    if (qOffset <= qOnset) qOffset = qOnset + g;
    const qDur = qOffset - qOnset;
    const onsetError = Math.abs(onsetBeats - qOnset);
    const durationError = Math.abs(rawDur - qDur);
    return {
      id: n.id,
      pitch: n.pitch,
      spelled: spellPitch(n.pitch, key),
      velocity: n.velocity,
      staff: staffForNote(n),
      onsetBeats: qOnset,
      durationBeats: qDur,
      onsetSec: n.onsetSec,
      durationSec: n.offsetSec - n.onsetSec,
      onsetErrorBeats: onsetError,
      durationErrorBeats: durationError,
      onsetFit: onsetError <= onsetTol,
      durationFit: durationError <= durTol,
    };
  });

  const noteCount = notes.length;
  const onsetMisfits = notes.filter((n) => !n.onsetFit).length;
  const durationMisfits = notes.filter((n) => !n.durationFit).length;
  const jointMisfits = notes.filter((n) => !n.onsetFit || !n.durationFit).length;
  const onsetFitRate = noteCount === 0 ? 1 : (noteCount - onsetMisfits) / noteCount;
  const durationFitRate = noteCount === 0 ? 1 : (noteCount - durationMisfits) / noteCount;
  const jointFitRate = noteCount === 0 ? 1 : (noteCount - jointMisfits) / noteCount;

  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  if (noteCount === 0) {
    if (perf.integrity.sourceNoteOnEvents === 0) {
      reasons.push('This MIDI contains no note events—only timing or other metadata. There is nothing to notate or audition.');
      reasonCodes.push('no-note-events');
    } else if (perf.integrity.percussionNoteOnEvents === perf.integrity.sourceNoteOnEvents) {
      reasons.push(`All ${perf.integrity.sourceNoteOnEvents} note attacks use GM channel 10 and are excluded from the certified solo-piano profile.`);
      reasonCodes.push('percussion-only');
    } else {
      reasons.push('No supported pitched notes remained after applying the solo-piano input policy.');
      reasonCodes.push('no-pitched-notes');
    }
  }
  if (onsetFitRate < threshold) {
    reasons.push(
      `Onset grid fit is ${(onsetFitRate * 100).toFixed(2)}% (need ${(threshold * 100).toFixed(0)}% within ${onsetTol} beats on a ${gridLabel(grid)} grid).`,
    );
    reasonCodes.push('onset-grid-misfit');
  }
  if (durationFitRate < threshold) {
    reasons.push(
      `Duration grid fit is ${(durationFitRate * 100).toFixed(2)}% (need ${(threshold * 100).toFixed(0)}%). Expressive releases will fail this gate — that is intentional.`,
    );
    reasonCodes.push('duration-grid-misfit');
  }
  if (jointFitRate < threshold) {
    reasons.push(
      `Joint grid conformity is ${(jointFitRate * 100).toFixed(2)}% (need ${(threshold * 100).toFixed(0)}% of notes to fit both onset and duration).`,
    );
    reasonCodes.push('joint-grid-misfit');
  }
  if (timeSignatureSource === 'assumed-4/4') {
    reasons.push(
      'Time signature is not certified (missing from the MIDI file / live capture). Supply meter to engrave a score.',
    );
    reasonCodes.push('meter-missing');
  }
  if (tempoSource === 'default-120') {
    reasons.push(
      'Tempo is not certified. Live captures and files without a usable tempo need an explicit BPM before a score can be certified.',
    );
    reasonCodes.push('tempo-missing');
  }

  const meterOk = timeSignatureSource === 'midi-meta' || options.timeSignature !== undefined;
  const tempoOk = tempoSource !== 'default-120' || options.tempoBpm !== undefined;
  const gridConformant =
    noteCount > 0 &&
    onsetFitRate + 1e-12 >= threshold &&
    durationFitRate + 1e-12 >= threshold &&
    jointFitRate + 1e-12 >= threshold &&
    meterOk &&
    tempoOk &&
    reasons.length === 0;

  const gate: GateResult = {
    certified: false,
    status: 'abstained',
    certificationProfile: 'score-note-v1',
    onsetFitRate,
    durationFitRate,
    jointFitRate,
    scoreFidelityRate: 0,
    scoreFidelityEvaluated: false,
    gridConformant,
    noteCount,
    onsetMisfits,
    durationMisfits,
    threshold,
    grid,
    tempoBpm: bpm,
    tempoSource,
    timeSignature,
    timeSignatureSource,
    key,
    keySource,
    reasons,
    reasonCodes,
    claimedDimensions: ['pitch', 'onset', 'duration', 'ties', 'meter', 'tempo'],
  };

  return { notes, gate };
}

function snap(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function resolveTempo(
  perf: Performance,
  userBpm?: number,
): { bpm: number; tempoSource: GateResult['tempoSource'] } {
  if (userBpm !== undefined && userBpm > 0) return { bpm: userBpm, tempoSource: 'user' };
  // Live captures invent ticks from a working tempo; that is not a certified source.
  if (perf.source === 'live-midi') {
    return { bpm: DEFAULT_TEMPO_BPM, tempoSource: 'default-120' };
  }
  // SMF default tempo is 120 BPM when the file omits a tempo event. That is specified.
  if (!perf.integrity.explicitTempo) {
    return { bpm: DEFAULT_TEMPO_BPM, tempoSource: 'default-120' };
  }
  return { bpm: primaryTempoBpm(perf), tempoSource: 'midi-meta' };
}

function resolveMeter(
  perf: Performance,
  user?: TimeSignature,
): { timeSignature: TimeSignature; timeSignatureSource: GateResult['timeSignatureSource'] } {
  if (user) return { timeSignature: user, timeSignatureSource: 'user' };
  if (perf.source === 'live-midi') {
    return { timeSignature: { numerator: 4, denominator: 4 }, timeSignatureSource: 'assumed-4/4' };
  }
  if (perf.timeSignatures.length > 0) {
    const ts = perf.timeSignatures[0];
    return {
      timeSignature: { numerator: ts.numerator, denominator: ts.denominator },
      timeSignatureSource: 'midi-meta',
    };
  }
  return {
    timeSignature: { numerator: 4, denominator: 4 },
    timeSignatureSource: 'assumed-4/4',
  };
}

function resolveKey(
  perf: Performance,
  user?: KeySignature,
): { key: KeySignature; keySource: GateResult['keySource'] } {
  if (user) return { key: user, keySource: 'user' };
  if (perf.keySignatures.length > 0) {
    const k = perf.keySignatures[0];
    return { key: { fifths: k.fifths, minor: k.minor }, keySource: 'midi-meta' };
  }
  const detected = detectKey(perf.notes.map((n) => n.pitch));
  return { key: detected.key, keySource: 'detected' };
}

/**
 * Used by tests to construct a performance whose tempo-source heuristic we
 * can override. Live MIDI never counts as midi-meta tempo unless the user
 * supplies BPM.
 */
export function isLiveWithoutUserTempo(perf: Performance, userBpm?: number): boolean {
  return perf.source === 'live-midi' && userBpm === undefined;
}

export function validateOptions(options: TranscribeOptions): void {
  const threshold = options.threshold ?? CERTIFY_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < CERTIFY_THRESHOLD || threshold > 1) {
    throw new Error(`Certification threshold must be between ${CERTIFY_THRESHOLD} and 1`);
  }
  const onset = options.onsetToleranceBeats ?? DEFAULT_ONSET_TOLERANCE;
  const duration = options.durationToleranceBeats ?? DEFAULT_DURATION_TOLERANCE;
  if (!Number.isFinite(onset) || onset < 0 || onset > DEFAULT_ONSET_TOLERANCE) {
    throw new Error(`Onset tolerance must be finite and no greater than ${DEFAULT_ONSET_TOLERANCE} beats`);
  }
  if (!Number.isFinite(duration) || duration < 0 || duration > DEFAULT_DURATION_TOLERANCE) {
    throw new Error(`Duration tolerance must be finite and no greater than ${DEFAULT_DURATION_TOLERANCE} beats`);
  }
  if (options.tempoBpm !== undefined && (!Number.isFinite(options.tempoBpm) || options.tempoBpm < 20 || options.tempoBpm > 400)) {
    throw new Error('Tempo must be between 20 and 400 BPM');
  }
  if (options.splitMidi !== undefined && (!Number.isInteger(options.splitMidi) || options.splitMidi < 0 || options.splitMidi > 128)) {
    throw new Error('Staff split must be an integer from 0 to 128');
  }
  if (options.staffMode !== undefined && !['auto', 'track', 'pitch'].includes(options.staffMode)) {
    throw new Error('Staff mode must be auto, track, or pitch');
  }
  if (options.timeSignature) {
    const { numerator, denominator } = options.timeSignature;
    if (!Number.isInteger(numerator) || numerator < 1 || numerator > 32) {
      throw new Error('Meter numerator must be an integer from 1 to 32');
    }
    if (!Number.isInteger(denominator) || denominator < 1 || denominator > 64 || (denominator & (denominator - 1)) !== 0) {
      throw new Error('Meter denominator must be a power of two from 1 to 64');
    }
  }
  if (options.key && (!Number.isInteger(options.key.fifths) || options.key.fifths < -7 || options.key.fifths > 7)) {
    throw new Error('Key fifths must be an integer from -7 to 7');
  }
}

function resolveStaffAssignment(
  perf: Performance,
  mode: NonNullable<TranscribeOptions['staffMode']>,
  split: number,
): (note: Performance['notes'][number]) => 1 | 2 {
  const usedTracks = [...new Set(perf.notes.map((note) => note.track))].sort((a, b) => a - b);
  const useTracks = mode === 'track' || (mode === 'auto' && usedTracks.length === 2);
  if (!useTracks) return (note) => note.pitch >= split ? 1 : 2;
  if (usedTracks.length !== 2) {
    throw new Error(`Track staff mode requires exactly two note tracks; found ${usedTracks.length}`);
  }

  const medianPitch = (track: number): number => {
    const pitches = perf.notes
      .filter((note) => note.track === track)
      .map((note) => note.pitch)
      .sort((a, b) => a - b);
    const middle = Math.floor(pitches.length / 2);
    return pitches.length % 2 === 0 ? (pitches[middle - 1] + pitches[middle]) / 2 : pitches[middle];
  };
  const ranked = usedTracks
    .map((track) => ({ track, median: medianPitch(track) }))
    .sort((a, b) => b.median - a.median || a.track - b.track);
  if (ranked[0].median === ranked[1].median && mode === 'auto') {
    return (note) => note.pitch >= split ? 1 : 2;
  }
  const trebleTrack = ranked[0].track;
  return (note) => note.track === trebleTrack ? 1 : 2;
}
