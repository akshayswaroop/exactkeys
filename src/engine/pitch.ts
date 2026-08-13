import type { KeySignature, SpelledPitch } from './types';

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
type Step = (typeof STEPS)[number];

/** Letter + accidental for each pitch class, indexed by fifths (-7..+7). */
const SHARP_SPELLINGS: Array<[Step, number]> = [
  ['C', 0],
  ['C', 1],
  ['D', 0],
  ['D', 1],
  ['E', 0],
  ['F', 0],
  ['F', 1],
  ['G', 0],
  ['G', 1],
  ['A', 0],
  ['A', 1],
  ['B', 0],
];

const FLAT_SPELLINGS: Array<[Step, number]> = [
  ['C', 0],
  ['D', -1],
  ['D', 0],
  ['E', -1],
  ['E', 0],
  ['F', 0],
  ['G', -1],
  ['G', 0],
  ['A', -1],
  ['A', 0],
  ['B', -1],
  ['B', 0],
];

const KEY_NAME_MAJOR: Record<number, string> = {
  [-7]: 'Cb',
  [-6]: 'Gb',
  [-5]: 'Db',
  [-4]: 'Ab',
  [-3]: 'Eb',
  [-2]: 'Bb',
  [-1]: 'F',
  0: 'C',
  1: 'G',
  2: 'D',
  3: 'A',
  4: 'E',
  5: 'B',
  6: 'F#',
  7: 'C#',
};

const KEY_NAME_MINOR: Record<number, string> = {
  [-7]: 'Ab',
  [-6]: 'Eb',
  [-5]: 'Bb',
  [-4]: 'F',
  [-3]: 'C',
  [-2]: 'G',
  [-1]: 'D',
  0: 'A',
  1: 'E',
  2: 'B',
  3: 'F#',
  4: 'C#',
  5: 'G#',
  6: 'D#',
  7: 'A#',
};

export function keyName(key: KeySignature): string {
  const table = key.minor ? KEY_NAME_MINOR : KEY_NAME_MAJOR;
  const n = table[key.fifths];
  if (!n) return key.minor ? 'A minor' : 'C major';
  return key.minor ? `${n} minor` : `${n} major`;
}

export function vexKeyName(key: KeySignature): string {
  const table = key.minor ? KEY_NAME_MINOR : KEY_NAME_MAJOR;
  const n = table[key.fifths] ?? 'C';
  return key.minor ? `${n}m` : n;
}

const KEY_SPELLINGS: Record<number, Array<[Step, number]>> = {
  7: [['B', 1], ['C', 1], ['C', 2], ['D', 1], ['D', 2], ['E', 1], ['F', 1], ['F', 2], ['G', 1], ['G', 2], ['A', 1], ['A', 2]],
  6: [['B', 1], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['E', 1], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]],
  5: [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['E', 1], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]],
  4: [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]],
  3: [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['B', -1], ['B', 0]],
  2: [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['B', -1], ['B', 0]],
  1: [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['B', -1], ['B', 0]],
  0: [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['B', -1], ['B', 0]],
  '-1': [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]],
  '-2': [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]],
  '-3': [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]],
  '-4': [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]],
  '-5': [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]],
  '-6': [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['C', -1]],
  '-7': [['C', 0], ['D', -1], ['E', -2], ['E', -1], ['F', -1], ['F', 0], ['G', -1], ['A', -2], ['A', -1], ['B', -2], ['B', -1], ['C', -1]],
};

/**
 * Deterministic key-aware pitch spelling heuristic for circle-of-fifths key signatures (-7..+7).
 *
 * Diatonic note steps are chosen according to key signature context. Because full harmonic,
 * melodic, and voice-leading analysis is unavailable, chromatic spelling relies on this stable
 * per-fifths lookup while maintaining the exact `spelledToMidi(spellPitch(midi, key)) === midi`
 * pitch-preservation invariant for all MIDI pitches 0..127.
 */
export function spellPitch(midi: number, key: KeySignature): SpelledPitch {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new Error(`MIDI pitch out of range: ${midi}`);
  }
  const pc = midi % 12;
  const clampedFifths = Math.max(-7, Math.min(7, key.fifths));
  const table = KEY_SPELLINGS[clampedFifths] ?? (key.fifths < 0 ? FLAT_SPELLINGS : SHARP_SPELLINGS);
  const [step, alter] = table[pc];

  let octave = Math.floor(midi / 12) - 1;
  if (step === 'B' && pc <= 1 && alter > 0) octave -= 1;
  if (step === 'C' && pc >= 11 && alter < 0) octave += 1;

  const acc = alter === 1 ? '#' : alter === -1 ? 'b' : alter === 2 ? '##' : alter === -2 ? 'bb' : '';
  return { step, alter, octave, name: `${step}${acc}${octave}` };
}

export function spelledToMidi(p: SpelledPitch): number {
  const natural: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (p.octave + 1) * 12 + natural[p.step] + p.alter;
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function displayPitch(midi: number, key: KeySignature): string {
  const p = spellPitch(midi, key);
  const acc = p.alter === 1 ? '♯' : p.alter === -1 ? '♭' : p.alter === 2 ? '𝄪' : p.alter === -2 ? '𝄫' : '';
  return `${p.step}${acc}${p.octave}`;
}

/**
 * Krumhansl-Schmuckler key-finding. Returns the best major/minor key and a
 * margin vs the runner-up. Detection is spelling-only — it never changes pitch.
 */
export function detectKey(pitches: number[]): { key: KeySignature; confidence: number } {
  if (pitches.length === 0) {
    return { key: { fifths: 0, minor: false }, confidence: 0 };
  }
  const hist = new Array(12).fill(0);
  for (const p of pitches) hist[((p % 12) + 12) % 12] += 1;
  const mag = Math.hypot(...hist) || 1;

  const majorProf = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProf = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  const scores: Array<{ fifths: number; minor: boolean; corr: number }> = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    scores.push({
      fifths: tonicToFifths(tonic),
      minor: false,
      corr: corrRotate(hist, mag, majorProf, tonic),
    });
    scores.push({
      fifths: tonicToFifths((tonic + 3) % 12), // relative major fifths for this minor tonic
      minor: true,
      corr: corrRotate(hist, mag, minorProf, tonic),
    });
  }
  scores.sort((a, b) => b.corr - a.corr);
  const best = scores[0];
  const second = scores[1]?.corr ?? 0;
  const confidence = Math.max(0, Math.min(1, (best.corr - second) * 2 + 0.4));
  return { key: { fifths: best.fifths, minor: best.minor }, confidence };
}

function tonicToFifths(tonicPc: number): number {
  // C=0, G=1, D=2, ... F=-1
  const map = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
  let f = map[tonicPc];
  if (f > 7) f -= 12;
  if (f < -7) f += 12;
  return f;
}

function corrRotate(hist: number[], mag: number, prof: number[], tonic: number): number {
  let dot = 0;
  let pmag = 0;
  for (let i = 0; i < 12; i++) {
    const pv = prof[(i - tonic + 12) % 12];
    dot += hist[i] * pv;
    pmag += pv * pv;
  }
  return dot / (mag * Math.sqrt(pmag));
}
