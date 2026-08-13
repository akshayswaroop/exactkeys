import type { KeySignature, PerformedNote } from './types';

// Krumhansl-Schmuckler key probe tone profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 2.69, 3.34, 3.17, 3.18];

// Map root pitch class (0=C, 1=C#, ..., 11=B) and mode (false=major, true=minor) to circle-of-fifths (-7..+7)
const FIFTHS_MAP_MAJOR: Record<number, number> = {
  0: 0,   // C
  1: 7,   // C#
  2: 2,   // D
  3: -5,  // Db / Eb... (Db = -5)
  4: 4,   // E
  5: -1,  // F
  6: 6,   // F#
  7: 1,   // G
  8: -4,  // Ab
  9: 3,   // A
  10: -2, // Bb
  11: 5,  // B
};

const FIFTHS_MAP_MINOR: Record<number, number> = {
  0: -3,  // Cm
  1: 4,   // C#m
  2: -2,  // Dm
  3: 5,   // D#m / Ebm (-5)
  4: 1,   // Em
  5: -4,  // Fm
  6: 3,   // F#m
  7: -1,  // Gm
  8: 6,   // G#m
  9: 0,   // Am
  10: -5, // Bbm
  11: 2,  // Bm
};

function pearsonCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    sumX += xi;
    sumY += yi;
    sumXY += xi * yi;
    sumX2 += xi * xi;
    sumY2 += yi * yi;
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

/**
 * Estimate the optimal key signature (fifths -7..+7 and mode) from a note population
 * using the Krumhansl-Schmuckler key-finding algorithm over pitch-class duration profiles.
 */
export function estimateKeySignature(notes: readonly PerformedNote[]): KeySignature {
  if (notes.length === 0) {
    return { fifths: 0, minor: false };
  }

  const pitchClassHistogram = new Array<number>(12).fill(0);
  for (const note of notes) {
    const pc = ((note.pitch % 12) + 12) % 12;
    const duration = Math.max(0.001, note.offsetSec - note.onsetSec);
    pitchClassHistogram[pc] += duration;
  }

  let bestCorrelation = -Infinity;
  let bestFifths = 0;
  let bestMinor = false;

  for (let root = 0; root < 12; root++) {
    // Shift profiles by root
    const majorShifted = new Array<number>(12);
    const minorShifted = new Array<number>(12);
    for (let i = 0; i < 12; i++) {
      majorShifted[i] = MAJOR_PROFILE[(i - root + 12) % 12];
      minorShifted[i] = MINOR_PROFILE[(i - root + 12) % 12];
    }

    const rMajor = pearsonCorrelation(pitchClassHistogram, majorShifted);
    if (rMajor > bestCorrelation) {
      bestCorrelation = rMajor;
      bestFifths = FIFTHS_MAP_MAJOR[root] ?? 0;
      bestMinor = false;
    }

    const rMinor = pearsonCorrelation(pitchClassHistogram, minorShifted);
    if (rMinor > bestCorrelation) {
      bestCorrelation = rMinor;
      bestFifths = FIFTHS_MAP_MINOR[root] ?? 0;
      bestMinor = true;
    }
  }

  return { fifths: Math.max(-7, Math.min(7, bestFifths)), minor: bestMinor };
}
