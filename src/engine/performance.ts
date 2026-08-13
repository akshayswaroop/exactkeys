import { parseSmf, type SmfFile, type SmfEvent } from './smf';
import type {
  PedalRegion,
  PerformedNote,
  Performance,
  TempoEvent,
  TimeSignatureEvent,
  KeySignatureEvent,
  ProgramEvent,
  TranscriptSource,
} from './types';

const DEFAULT_TEMPO = 500_000;

interface OpenNote {
  pitch: number;
  velocity: number;
  channel: number;
  track: number;
  onsetTick: number;
}

export function smfToPerformance(
  smf: SmfFile,
  source: TranscriptSource,
  filename?: string,
): Performance {
  const tempoEvents: TempoEvent[] = [];
  const timeSignatures: TimeSignatureEvent[] = [];
  const keySignatures: KeySignatureEvent[] = [];
  const programEvents: ProgramEvent[] = [];
  const trackNames: string[] = [];
  const closed: Array<OpenNote & { offsetTick: number }> = [];
  const sustainByTrackChannel = new Map<string, Array<{ tick: number; down: boolean }>>();
  let unmatchedNoteOffs = 0;
  let overlappingSamePitch = 0;
  let sourceNoteOnEvents = 0;
  let percussionNoteOnEvents = 0;
  let pitchBendEvents = 0;
  let neutralPitchBendEvents = 0;
  let nonNeutralPitchBendEvents = 0;
  let aftertouchEvents = 0;
  let percussionNoteEvents = 0;
  let unsupportedControlEvents = 0;
  let sysexEvents = 0;

  const open = new Map<string, OpenNote[]>();

  smf.tracks.forEach((track, trackIndex) => {
    const sortedEvents = [...track.events].sort(
      (a, b) => a.tick - b.tick || rankEvent(a) - rankEvent(b),
    );
    for (const ev of sortedEvents) {
      if (ev.type === 'meta') {
        if (ev.meta.type === 'tempo') tempoEvents.push({ tick: ev.tick, usPerQuarter: ev.meta.usPerQuarter });
        if (ev.meta.type === 'timeSignature') {
          timeSignatures.push({
            tick: ev.tick,
            numerator: ev.meta.numerator,
            denominator: ev.meta.denominator,
          });
        }
        if (ev.meta.type === 'keySignature') {
          keySignatures.push({ tick: ev.tick, fifths: ev.meta.fifths, minor: ev.meta.minor });
        }
        if (ev.meta.type === 'trackName') trackNames[trackIndex] = ev.meta.text;
        continue;
      }
      if (ev.type === 'cc' && ev.controller === 64) {
        const pedalKey = `${trackIndex}:${ev.channel}`;
        const list = sustainByTrackChannel.get(pedalKey) ?? [];
        list.push({ tick: ev.tick, down: ev.value >= 64 });
        sustainByTrackChannel.set(pedalKey, list);
        continue;
      }
      if (ev.type === 'program') {
        programEvents.push({ tick: ev.tick, channel: ev.channel, track: trackIndex, program: ev.program });
        continue;
      }
      if (ev.type === 'pitchBend') {
        pitchBendEvents++;
        if (ev.value === 0) neutralPitchBendEvents++;
        else nonNeutralPitchBendEvents++;
        continue;
      }
      if (ev.type === 'polyAftertouch' || ev.type === 'channelPressure') {
        aftertouchEvents++;
        continue;
      }
      if (ev.type === 'cc') {
        unsupportedControlEvents++;
        continue;
      }
      if (ev.type === 'sysex') {
        sysexEvents++;
        continue;
      }
      if (ev.type === 'noteOn') {
        sourceNoteOnEvents++;
        if (ev.channel === 9) {
          percussionNoteOnEvents++;
          percussionNoteEvents++;
          continue;
        }
        const key = `${trackIndex}:${ev.channel}:${ev.pitch}`;
        const stack = open.get(key) ?? [];
        if (stack.length > 0) overlappingSamePitch++;
        stack.push({
          pitch: ev.pitch,
          velocity: ev.velocity,
          channel: ev.channel,
          track: trackIndex,
          onsetTick: ev.tick,
        });
        open.set(key, stack);
      } else if (ev.type === 'noteOff') {
        if (ev.channel === 9) {
          percussionNoteEvents++;
          continue;
        }
        const key = `${trackIndex}:${ev.channel}:${ev.pitch}`;
        const stack = open.get(key);
        if (!stack || stack.length === 0) {
          unmatchedNoteOffs++;
          continue;
        }
        const start = stack.shift()!;
        closed.push({ ...start, offsetTick: Math.max(ev.tick, start.onsetTick + 1) });
      }
    }
  });

  let maxTick = 0;
  for (const t of smf.tracks) {
    for (const ev of t.events) maxTick = Math.max(maxTick, ev.tick);
  }
  let unmatchedNoteOns = 0;
  for (const [, stack] of open) {
    for (const start of stack) {
      unmatchedNoteOns++;
      closed.push({ ...start, offsetTick: Math.max(maxTick, start.onsetTick + 1) });
    }
  }

  tempoEvents.sort((a, b) => a.tick - b.tick);
  const explicitTempo = tempoEvents.length > 0;
  if (tempoEvents.length === 0 || tempoEvents[0].tick > 0) {
    tempoEvents.unshift({ tick: 0, usPerQuarter: DEFAULT_TEMPO });
  }

  const tickToSec = buildTickToSec(smf.ticksPerQuarter, tempoEvents);

  const notes: PerformedNote[] = closed
    .map((n, i) => ({
      id: `n${i}`,
      pitch: n.pitch,
      velocity: n.velocity,
      channel: n.channel,
      track: n.track,
      onsetTick: n.onsetTick,
      offsetTick: n.offsetTick,
      onsetSec: tickToSec(n.onsetTick),
      offsetSec: tickToSec(n.offsetTick),
    }))
    .sort((a, b) => a.onsetSec - b.onsetSec || a.pitch - b.pitch);

  notes.forEach((n, i) => {
    n.id = `n${i}`;
  });

  const pedals: PedalRegion[] = [];
  for (const [trackChannel, changes] of sustainByTrackChannel) {
    const [trackText, channelText] = trackChannel.split(':');
    const track = Number(trackText);
    const channel = Number(channelText);
    changes.sort((a, b) => a.tick - b.tick);
    let downAt: number | null = null;
    for (const c of changes) {
      if (c.down && downAt === null) downAt = c.tick;
      if (!c.down && downAt !== null) {
        pedals.push({
          kind: 'sustain',
          channel,
          track,
          onsetTick: downAt,
          offsetTick: c.tick,
          onsetSec: tickToSec(downAt),
          offsetSec: tickToSec(c.tick),
        });
        downAt = null;
      }
    }
    if (downAt !== null) {
      pedals.push({
        kind: 'sustain',
        channel,
        track,
        onsetTick: downAt,
        offsetTick: maxTick,
        onsetSec: tickToSec(downAt),
        offsetSec: tickToSec(maxTick),
      });
    }
  }

  const durationSec = Math.max(
    tickToSec(maxTick),
    notes.reduce((m, n) => Math.max(m, n.offsetSec), 0),
  );

  return {
    ticksPerQuarter: smf.ticksPerQuarter,
    notes,
    pedals,
    tempoEvents,
    timeSignatures: timeSignatures.sort((a, b) => a.tick - b.tick),
    keySignatures: keySignatures.sort((a, b) => a.tick - b.tick),
    programEvents: programEvents.sort((a, b) => a.tick - b.tick),
    source,
    filename,
    durationSec,
    trackNames,
    integrity: {
      smfFormat: smf.format as 0 | 1,
      explicitTempo,
      sourceNoteOnEvents,
      percussionNoteOnEvents,
      unmatchedNoteOns,
      unmatchedNoteOffs,
      overlappingSamePitch,
      pitchBendEvents,
      neutralPitchBendEvents,
      nonNeutralPitchBendEvents,
      aftertouchEvents,
      percussionNoteEvents,
      unsupportedControlEvents,
      sysexEvents,
    },
  };
}

export function parseMidiFile(bytes: Uint8Array, filename?: string): Performance {
  return smfToPerformance(parseSmf(bytes), 'midi-file', filename);
}

export function performanceFromSmf(smf: SmfFile, source: TranscriptSource, filename?: string): Performance {
  return smfToPerformance(smf, source, filename);
}

export function buildTickToSec(
  ticksPerQuarter: number,
  tempoEvents: TempoEvent[],
): (tick: number) => number {
  const sorted = [...tempoEvents].sort((a, b) => a.tick - b.tick);
  return (tick: number) => {
    let sec = 0;
    let lastTick = 0;
    let us = sorted[0]?.usPerQuarter ?? DEFAULT_TEMPO;
    for (const ev of sorted) {
      if (ev.tick >= tick) break;
      sec += ((ev.tick - lastTick) * us) / ticksPerQuarter / 1e6;
      lastTick = ev.tick;
      us = ev.usPerQuarter;
    }
    sec += ((tick - lastTick) * us) / ticksPerQuarter / 1e6;
    return sec;
  };
}

export function secondsToBeats(sec: number, bpm: number): number {
  return sec * (bpm / 60);
}

export function beatsToSeconds(beats: number, bpm: number): number {
  return beats * (60 / bpm);
}

/** Effective constant tempo: first tempo event, or 120 BPM. */
export function primaryTempoBpm(perf: Performance): number {
  const us = perf.tempoEvents[0]?.usPerQuarter ?? DEFAULT_TEMPO;
  return 60_000_000 / us;
}

export function collectAllEvents(smf: SmfFile): SmfEvent[] {
  const all: SmfEvent[] = [];
  for (const t of smf.tracks) all.push(...t.events);
  return all.sort((a, b) => a.tick - b.tick || rankEvent(a) - rankEvent(b));
}

function rankEvent(ev: SmfEvent): number {
  if (ev.type === 'meta') return -2;
  if (ev.type === 'cc') return -1;
  if (ev.type === 'noteOff') return 0;
  if (ev.type === 'noteOn' && ev.velocity === 0) return 0;
  if (ev.type === 'noteOn') return 1;
  return 2;
}
