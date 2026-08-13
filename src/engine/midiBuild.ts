import { writeSmf, type SmfEvent, type SmfFile } from './smf';

export interface NoteSpec {
  /** Onset in quarter-note beats from 0. */
  beat: number;
  /** Duration in quarter-note beats. */
  dur: number;
  pitch: number;
  velocity?: number;
  channel?: number;
}

export interface MidiBuildOptions {
  ticksPerQuarter?: number;
  tempoBpm?: number;
  timeSignature?: { numerator: number; denominator: number };
  key?: { fifths: number; minor: boolean };
  notes: NoteSpec[];
  pedals?: Array<{ beat: number; dur: number }>;
}

/** Deterministic SMF builder used by tests and the "load example" button. */
export function buildMidi(opts: MidiBuildOptions): Uint8Array {
  return writeSmf(buildSmf(opts));
}

export function buildSmf(opts: MidiBuildOptions): SmfFile {
  const tpq = opts.ticksPerQuarter ?? 480;
  const bpm = opts.tempoBpm ?? 120;
  const ts = opts.timeSignature ?? { numerator: 4, denominator: 4 };
  const events: SmfEvent[] = [
    { tick: 0, type: 'meta', meta: { type: 'trackName', text: 'Piano' } },
    { tick: 0, type: 'meta', meta: { type: 'tempo', usPerQuarter: Math.round(60_000_000 / bpm) } },
    {
      tick: 0,
      type: 'meta',
      meta: {
        type: 'timeSignature',
        numerator: ts.numerator,
        denominator: ts.denominator,
        clocks: 24,
        thirtySeconds: 8,
      },
    },
  ];
  if (opts.key) {
    events.push({
      tick: 0,
      type: 'meta',
      meta: { type: 'keySignature', fifths: opts.key.fifths, minor: opts.key.minor },
    });
  }

  for (const n of opts.notes) {
    const on = Math.round(n.beat * tpq);
    const off = Math.round((n.beat + n.dur) * tpq);
    const ch = n.channel ?? 0;
    events.push({ tick: on, type: 'noteOn', channel: ch, pitch: n.pitch, velocity: n.velocity ?? 80 });
    events.push({ tick: Math.max(off, on + 1), type: 'noteOff', channel: ch, pitch: n.pitch, velocity: 0 });
  }

  for (const p of opts.pedals ?? []) {
    const on = Math.round(p.beat * tpq);
    const off = Math.round((p.beat + p.dur) * tpq);
    events.push({ tick: on, type: 'cc', channel: 0, controller: 64, value: 127 });
    events.push({ tick: off, type: 'cc', channel: 0, controller: 64, value: 0 });
  }

  events.sort((a, b) => a.tick - b.tick || order(a) - order(b));
  const last = events.length ? events[events.length - 1].tick : 0;
  events.push({ tick: last, type: 'meta', meta: { type: 'endOfTrack' } });

  return { format: 0, ticksPerQuarter: tpq, tracks: [{ events }] };
}

function order(ev: SmfEvent): number {
  if (ev.type === 'meta') return -2;
  if (ev.type === 'cc') return -1;
  if (ev.type === 'noteOff') return 0;
  if (ev.type === 'noteOn') return 1;
  return 2;
}

/** Ode to Joy, C major, 4/4, all quarter notes — a perfect grid fixture. */
export function odeToJoyMidi(): Uint8Array {
  const melody = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62];
  const bass = [48, 48, 53, 55, 55, 53, 48, 43, 48, 48, 43, 48, 43, 43, 36];
  const notes: NoteSpec[] = [];
  melody.forEach((p, i) => {
    notes.push({ beat: i, dur: 1, pitch: p, velocity: 84 });
    notes.push({ beat: i, dur: 1, pitch: bass[i], velocity: 70 });
  });
  return buildMidi({
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    key: { fifths: 0, minor: false },
    notes,
  });
}
