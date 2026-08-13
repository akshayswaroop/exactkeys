import { GRID_PER_QUARTER } from './quantize';
import type {
  DurationToken,
  EngravedScore,
  GateResult,
  GridId,
  KeySignature,
  QuantizedNote,
  ScoreLeaf,
  ScoreMeasure,
  TimeSignature,
} from './types';
import { MUSICXML_DIVISIONS } from './types';

export function measureBeats(ts: TimeSignature): number {
  return ts.numerator * (4 / ts.denominator);
}

export function beatsToDivs(beats: number): number {
  return Math.round(beats * MUSICXML_DIVISIONS);
}

export function isTripletGrid(grid: GridId): boolean {
  return grid === '1/8t' || grid === '1/16t';
}

interface Segment {
  id: string;
  pitch: number;
  spelled: QuantizedNote['spelled'];
  staff: 1 | 2;
  startDivs: number;
  endDivs: number;
  tieStart: boolean;
  tieEnd: boolean;
  measure: number;
}

export function engraveScore(
  notes: QuantizedNote[],
  gate: GateResult,
  title: string,
): EngravedScore {
  if (hasUnsupportedPolyphony(notes)) {
    throw new Error('Overlapping same-staff voices are outside score-note-v1');
  }
  const ts = gate.timeSignature;
  const mBeats = measureBeats(ts);
  const mDivs = beatsToDivs(mBeats);
  if (mDivs <= 0) throw new Error('Invalid time signature');

  const lastBeat = notes.reduce((m, n) => Math.max(m, n.onsetBeats + n.durationBeats), 0);
  const measureCount = Math.max(1, Math.ceil((lastBeat - 1e-9) / mBeats));

  const segs: Segment[] = [];
  for (const n of notes) {
    let start = n.onsetBeats;
    const end = n.onsetBeats + n.durationBeats;
    const trueStart = start;
    while (start < end - 1e-9) {
      const mi = Math.floor(start / mBeats + 1e-9);
      const mStart = mi * mBeats;
      const mEnd = mStart + mBeats;
      const segEnd = Math.min(end, mEnd);
      segs.push({
        id: n.id,
        pitch: n.pitch,
        spelled: n.spelled,
        staff: n.staff,
        startDivs: beatsToDivs(start - mStart),
        endDivs: beatsToDivs(segEnd - mStart),
        tieStart: segEnd < end - 1e-9,
        tieEnd: start > trueStart + 1e-9,
        measure: mi,
      });
      start = segEnd;
    }
  }

  const measures: ScoreMeasure[] = [];
  for (let i = 0; i < measureCount; i++) {
    const inM = segs.filter((s) => s.measure === i);
    measures.push({
      number: i + 1,
      startBeats: i * mBeats,
      durationBeats: mBeats,
      timeSignature: ts,
      key: gate.key,
      treble: staffLeaves(inM.filter((s) => s.staff === 1), mDivs, gate.grid),
      bass: staffLeaves(inM.filter((s) => s.staff === 2), mDivs, gate.grid),
    });
  }

  return {
    title,
    measures,
    divisions: MUSICXML_DIVISIONS,
    tempoBpm: gate.tempoBpm,
    certified: gate.certified,
  };
}

/**
 * v1 deliberately abstains instead of dropping overlapping voices. Chord
 * tones are representable only when onset and duration are identical.
 */
export function hasUnsupportedPolyphony(notes: QuantizedNote[]): boolean {
  for (const staff of [1, 2] as const) {
    const onStaff = notes
      .filter((note) => note.staff === staff)
      .sort((a, b) => a.onsetBeats - b.onsetBeats || a.pitch - b.pitch);
    for (let i = 0; i < onStaff.length; i++) {
      const a = onStaff[i];
      const aEnd = a.onsetBeats + a.durationBeats;
      for (let j = i + 1; j < onStaff.length; j++) {
        const b = onStaff[j];
        if (b.onsetBeats >= aEnd - 1e-9) break;
        const sameChord =
          Math.abs(a.onsetBeats - b.onsetBeats) < 1e-9 &&
          Math.abs(a.durationBeats - b.durationBeats) < 1e-9;
        if (!sameChord) return true;
      }
    }
  }
  return false;
}

export interface CanonicalScoreNote {
  id: string;
  pitch: number;
  onsetBeats: number;
  durationBeats: number;
}

/** Collapse tied score fragments back into one canonical note per event ID. */
export function notesFromEngravedScore(score: EngravedScore): CanonicalScoreNote[] {
  const recovered = new Map<string, CanonicalScoreNote>();
  for (const measure of score.measures) {
    for (const leaves of [measure.treble, measure.bass]) {
      let cursor = 0;
      for (const leaf of leaves) {
        if (leaf.kind === 'chord') {
          for (const note of leaf.notes) {
            const current = recovered.get(note.id);
            if (current) {
              current.durationBeats += leaf.ticks / score.divisions;
            } else {
              recovered.set(note.id, {
                id: note.id,
                pitch: note.pitch,
                onsetBeats: measure.startBeats + cursor / score.divisions,
                durationBeats: leaf.ticks / score.divisions,
              });
            }
          }
        }
        cursor += leaf.ticks;
      }
    }
  }
  return [...recovered.values()].sort((a, b) => a.onsetBeats - b.onsetBeats || a.pitch - b.pitch);
}

export function scoreFidelityRate(notes: QuantizedNote[], score: EngravedScore): number {
  const recovered = notesFromEngravedScore(score);
  if (notes.length === 0) return recovered.length === 0 ? 1 : 0;
  const expected = new Map(notes.map((note) => [note.id, note]));
  let matched = 0;
  for (const note of recovered) {
    const source = expected.get(note.id);
    if (
      source &&
      source.pitch === note.pitch &&
      Math.abs(source.onsetBeats - note.onsetBeats) < 1e-9 &&
      Math.abs(source.durationBeats - note.durationBeats) < 1e-9
    ) {
      matched++;
    }
  }
  return matched / Math.max(notes.length, recovered.length);
}

function staffLeaves(segs: Segment[], measureDivs: number, grid: GridId): ScoreLeaf[] {
  if (segs.length === 0) {
    return wholeMeasureRest(measureDivs, grid);
  }

  const voices = assignVoices(segs);
  // Flatten to a single sequential stream if only one voice; otherwise
  // merge voice 0 as the primary stream. Extra voices are interleaved as
  // additional chords at the same onset when durations match, else we keep
  // voice 0 and append leftover notes as same-onset chords when possible.
  const primary = voices[0] ?? [];
  const extras = voices.slice(1).flat();

  const grouped = groupChords(primary, extras);
  return fillRests(grouped, measureDivs, grid);
}

interface ChordSeed {
  startDivs: number;
  endDivs: number;
  notes: Segment[];
}

function assignVoices(segs: Segment[]): Segment[][] {
  const sorted = [...segs].sort(
    (a, b) => a.startDivs - b.startDivs || b.endDivs - a.endDivs || a.pitch - b.pitch,
  );
  const voices: Segment[][] = [];
  const lastEnd: number[] = [];
  for (const s of sorted) {
    let placed = false;
    for (let v = 0; v < voices.length; v++) {
      if (lastEnd[v] <= s.startDivs) {
        voices[v].push(s);
        lastEnd[v] = s.endDivs;
        placed = true;
        break;
      }
    }
    if (!placed) {
      voices.push([s]);
      lastEnd.push(s.endDivs);
    }
  }
  return voices;
}

function groupChords(primary: Segment[], extras: Segment[]): ChordSeed[] {
  const buckets = new Map<string, Segment[]>();
  const add = (s: Segment) => {
    const k = `${s.startDivs}:${s.endDivs}`;
    const list = buckets.get(k) ?? [];
    list.push(s);
    buckets.set(k, list);
  };
  for (const s of primary) add(s);
  for (const s of extras) add(s);

  return [...buckets.entries()]
    .map(([, notes]) => ({
      startDivs: notes[0].startDivs,
      endDivs: notes[0].endDivs,
      notes: notes.sort((a, b) => a.pitch - b.pitch),
    }))
    .sort((a, b) => a.startDivs - b.startDivs || a.endDivs - b.endDivs);
}

function fillRests(chords: ChordSeed[], measureDivs: number, grid: GridId): ScoreLeaf[] {
  const out: ScoreLeaf[] = [];
  let cursor = 0;
  for (const c of chords) {
    if (c.startDivs > cursor) {
      out.push(...decompose(cursor, c.startDivs - cursor, grid, 'rest'));
    }
    if (c.startDivs < cursor) {
      // Overlap from a second voice with a different duration. Emit the
      // extra notes as a zero-advance chord attached to the previous leaf
      // when possible; otherwise skip (they still exist in the event table).
      continue;
    }
    out.push(...decompose(c.startDivs, c.endDivs - c.startDivs, grid, 'chord', c.notes));
    cursor = c.endDivs;
  }
  if (cursor < measureDivs) {
    out.push(...decompose(cursor, measureDivs - cursor, grid, 'rest'));
  }
  return out;
}

function wholeMeasureRest(measureDivs: number, grid: GridId): ScoreLeaf[] {
  return decompose(0, measureDivs, grid, 'rest');
}

function decompose(
  _start: number,
  divs: number,
  grid: GridId,
  kind: 'rest' | 'chord',
  segs: Segment[] = [],
): ScoreLeaf[] {
  if (divs <= 0) return [];
  const parts = splitDuration(divs, isTripletGrid(grid));
  return parts.map((p, i) => {
    if (kind === 'rest') {
      return { kind: 'rest', duration: p.duration, dots: p.dots, ticks: p.ticks };
    }
    return {
      kind: 'chord',
      duration: p.duration,
      dots: p.dots,
      ticks: p.ticks,
      notes: segs.map((s) => ({
        id: s.id,
        spelled: s.spelled,
        pitch: s.pitch,
        tieStart: s.tieStart || i < parts.length - 1,
        tieEnd: s.tieEnd || i > 0,
      })),
    };
  });
}

export interface DurPart {
  duration: DurationToken;
  dots: 0 | 1;
  ticks: number;
}

const BINARY_DURS: DurPart[] = [
  { duration: 'w', dots: 0, ticks: 96 },
  { duration: 'h', dots: 1, ticks: 72 },
  { duration: 'h', dots: 0, ticks: 48 },
  { duration: 'q', dots: 1, ticks: 36 },
  { duration: 'q', dots: 0, ticks: 24 },
  { duration: '8', dots: 1, ticks: 18 },
  { duration: '8', dots: 0, ticks: 12 },
  { duration: '16', dots: 1, ticks: 9 },
  { duration: '16', dots: 0, ticks: 6 },
  { duration: '32', dots: 0, ticks: 3 },
];

const TRIPLET_DURS: DurPart[] = [
  { duration: 'h', dots: 0, ticks: 48 },
  { duration: 'q', dots: 0, ticks: 24 },
  { duration: 'q', dots: 0, ticks: 16 },
  { duration: '8', dots: 0, ticks: 12 },
  { duration: '8', dots: 0, ticks: 8 },
  { duration: '16', dots: 0, ticks: 6 },
  { duration: '16', dots: 0, ticks: 4 },
];

export function splitDuration(divs: number, triplet: boolean): DurPart[] {
  const table = triplet ? TRIPLET_DURS : BINARY_DURS;
  const out: DurPart[] = [];
  let left = divs;
  while (left > 0) {
    const part = table.find((p) => p.ticks <= left);
    if (!part) {
      // Should not happen with a 24-division grid. Drain 1 tick as 32nd so
      // we never drop time (better a slightly long 32nd than a hole).
      out.push({ duration: '32', dots: 0, ticks: left });
      break;
    }
    out.push(part);
    left -= part.ticks;
  }
  return out;
}

export function timeSigLabel(ts: TimeSignature): string {
  return `${ts.numerator}/${ts.denominator}`;
}

export function keyLabel(key: KeySignature): string {
  const majors = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'] as const;
  const minors = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'] as const;
  const flatMaj = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'] as const;
  const flatMin = ['A', 'D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab'] as const;
  if (key.fifths >= 0) {
    const name = key.minor ? minors[key.fifths] : majors[key.fifths];
    return key.minor ? `${name} minor` : `${name} major`;
  }
  const i = -key.fifths;
  const name = key.minor ? flatMin[i] : flatMaj[i];
  return key.minor ? `${name} minor` : `${name} major`;
}

export function gridUnitBeats(grid: GridId): number {
  return 1 / GRID_PER_QUARTER[grid];
}
