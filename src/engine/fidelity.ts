import type { FidelityReport, PerformedNote, Performance } from './types';

export interface MatchOptions {
  /** Onset window in milliseconds. Default 50 (mir_eval note onset). */
  onsetWindowMs?: number;
}

/**
 * Greedy one-to-one matching by pitch + nearest onset.
 * This is a non-certifying diagnostic for comparing two performances. Exact
 * MIDI certification uses verifyEventRoundTrip and tick-domain equality.
 */
export function comparePerformances(
  a: Performance,
  b: Performance,
  opts: MatchOptions = {},
): FidelityReport {
  const window = opts.onsetWindowMs ?? 50;
  const used = new Set<number>();
  const matches: Array<{ a: PerformedNote; b: PerformedNote }> = [];

  for (const na of a.notes) {
    let best = -1;
    let bestDt = Infinity;
    b.notes.forEach((nb, i) => {
      if (used.has(i) || nb.pitch !== na.pitch) return;
      const dt = Math.abs(nb.onsetSec - na.onsetSec) * 1000;
      if (dt <= window && dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      matches.push({ a: na, b: b.notes[best] });
    }
  }

  const matched = matches.length;
  const onlyA = a.notes.length - matched;
  const onlyB = b.notes.length - matched;
  const precision = b.notes.length === 0 ? (a.notes.length === 0 ? 1 : 0) : matched / b.notes.length;
  const recall = a.notes.length === 0 ? (b.notes.length === 0 ? 1 : 0) : matched / a.notes.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const onsetMaeMs =
    matched === 0 ? 0 : matches.reduce((s, m) => s + Math.abs(m.a.onsetSec - m.b.onsetSec) * 1000, 0) / matched;
  const offsetMaeMs =
    matched === 0 ? 0 : matches.reduce((s, m) => s + Math.abs(m.a.offsetSec - m.b.offsetSec) * 1000, 0) / matched;

  const pitchExact = onlyA === 0 && onlyB === 0;
  return {
    precision,
    recall,
    f1,
    matched,
    onlyA,
    onlyB,
    onsetMaeMs,
    offsetMaeMs,
    pitchExact,
    // A tolerant, greedy seconds-domain match is not evidence for the fixed
    // accuracy certificate, even when its descriptive F1 is high.
    certified: false,
  };
}

export function noteMultiset(notes: PerformedNote[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of notes) m.set(n.pitch, (m.get(n.pitch) ?? 0) + 1);
  return m;
}

export function samePitchMultiset(a: Performance, b: Performance): boolean {
  const ma = noteMultiset(a.notes);
  const mb = noteMultiset(b.notes);
  if (ma.size !== mb.size) return false;
  for (const [p, c] of ma) if (mb.get(p) !== c) return false;
  return true;
}
