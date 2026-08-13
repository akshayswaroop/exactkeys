import { writeSmf, type SmfEvent, type SmfFile } from './smf';
import type { Performance } from './types';

/** Event-accurate SMF from a Performance. Pitches, ticks, tempo, meter, pedals preserved. */
export function performanceToMidi(perf: Performance): Uint8Array {
  return writeSmf(performanceToSmf(perf));
}

export function performanceToSmf(perf: Performance): SmfFile {
  const maxTrack = Math.max(
    0,
    perf.trackNames.length - 1,
    ...perf.notes.map((note) => note.track),
    ...perf.pedals.map((pedal) => pedal.track),
    ...perf.programEvents.map((event) => event.track),
  );
  const trackEvents: SmfEvent[][] = Array.from({ length: maxTrack + 1 }, () => []);
  const events = trackEvents[0];
  trackEvents.forEach((track, index) => {
    track.push({
      tick: 0,
      type: 'meta',
      meta: { type: 'trackName', text: perf.trackNames[index] || (index === 0 ? 'Piano' : `Piano ${index + 1}`) },
    });
  });
  for (const t of perf.tempoEvents) {
    events.push({ tick: t.tick, type: 'meta', meta: { type: 'tempo', usPerQuarter: t.usPerQuarter } });
  }
  for (const ts of perf.timeSignatures) {
    events.push({
      tick: ts.tick,
      type: 'meta',
      meta: {
        type: 'timeSignature',
        numerator: ts.numerator,
        denominator: ts.denominator,
        clocks: 24,
        thirtySeconds: 8,
      },
    });
  }
  for (const k of perf.keySignatures) {
    events.push({
      tick: k.tick,
      type: 'meta',
      meta: { type: 'keySignature', fifths: k.fifths, minor: k.minor },
    });
  }
  for (const p of perf.pedals) {
    trackEvents[p.track].push({ tick: p.onsetTick, type: 'cc', channel: p.channel, controller: 64, value: 127 });
    trackEvents[p.track].push({ tick: p.offsetTick, type: 'cc', channel: p.channel, controller: 64, value: 0 });
  }
  for (const p of perf.programEvents) {
    trackEvents[p.track].push({ tick: p.tick, type: 'program', channel: p.channel, program: p.program });
  }
  for (const n of perf.notes) {
    trackEvents[n.track].push({
      tick: n.onsetTick,
      type: 'noteOn',
      channel: n.channel,
      pitch: n.pitch,
      velocity: n.velocity,
    });
    trackEvents[n.track].push({
      tick: n.offsetTick,
      type: 'noteOff',
      channel: n.channel,
      pitch: n.pitch,
      velocity: 0,
    });
  }
  const tracks = trackEvents.map((track) => {
    track.sort((a, b) => a.tick - b.tick || rank(a) - rank(b));
    const last = track.length ? track[track.length - 1].tick : 0;
    track.push({ tick: last, type: 'meta', meta: { type: 'endOfTrack' } });
    return { events: track };
  });
  return { format: tracks.length === 1 ? 0 : 1, ticksPerQuarter: perf.ticksPerQuarter, tracks };
}

function rank(ev: SmfEvent): number {
  if (ev.type === 'meta') return -2;
  if (ev.type === 'cc') return -1;
  if (ev.type === 'noteOff') return 0;
  if (ev.type === 'noteOn') return 1;
  return 2;
}
