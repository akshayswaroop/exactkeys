import { performanceToMidi } from './exportMidi';
import { parseMidiFile } from './performance';
import type { EventVerification, Performance } from './types';

const CLAIMED_FIELDS: EventVerification['claimedFields'] = [
  'track',
  'channel',
  'pitch',
  'velocity',
  'onsetTick',
  'offsetTick',
];

function noteTuple(note: Performance['notes'][number]): string {
  return [
    note.track,
    note.channel,
    note.pitch,
    note.velocity,
    note.onsetTick,
    note.offsetTick,
  ].join(':');
}

function multiset(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/**
 * Proves that the normalised MIDI export preserves every supported note-event
 * field. This is a deterministic event-fidelity claim, separate from the
 * inferred notation certificate.
 */
export function verifyEventRoundTrip(performance: Performance): EventVerification {
  const reasons: string[] = [];
  if (performance.notes.length === 0) reasons.push('No pitched note events to verify.');
  if (performance.integrity.unmatchedNoteOns > 0) {
    reasons.push(`${performance.integrity.unmatchedNoteOns} note-on event(s) had no matching note-off.`);
  }
  if (performance.integrity.unmatchedNoteOffs > 0) {
    reasons.push(`${performance.integrity.unmatchedNoteOffs} note-off event(s) had no matching note-on.`);
  }
  if (performance.integrity.overlappingSamePitch > 0) {
    reasons.push('Overlapping repeats of the same pitch make note-on/off pairing ambiguous.');
  }

  let accuracy = 0;
  try {
    const reparsed = parseMidiFile(performanceToMidi(performance), 'roundtrip.mid');
    const source = multiset(performance.notes.map(noteTuple));
    const output = multiset(reparsed.notes.map(noteTuple));
    let matched = 0;
    for (const [tuple, count] of source) matched += Math.min(count, output.get(tuple) ?? 0);
    accuracy = Math.max(performance.notes.length, reparsed.notes.length) === 0
      ? 1
      : matched / Math.max(performance.notes.length, reparsed.notes.length);
    if (accuracy < 1) reasons.push('Normalised MIDI did not preserve every claimed note-event tuple.');
  } catch (error) {
    reasons.push(`Round-trip verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    verified: accuracy === 1 && reasons.length === 0,
    profile: 'smf-note-events-v1',
    accuracy,
    claimedFields: CLAIMED_FIELDS,
    reasons,
  };
}
