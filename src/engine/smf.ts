import { decodeVlq, encodeVlq } from './vlq';

export type SmfMeta =
  | { type: 'trackName'; text: string }
  | { type: 'tempo'; usPerQuarter: number }
  | { type: 'timeSignature'; numerator: number; denominator: number; clocks: number; thirtySeconds: number }
  | { type: 'keySignature'; fifths: number; minor: boolean }
  | { type: 'endOfTrack' }
  | { type: 'text'; text: string }
  | { type: 'unknown'; metaType: number; data: Uint8Array };

export type SmfEvent =
  | { tick: number; type: 'noteOn'; channel: number; pitch: number; velocity: number }
  | { tick: number; type: 'noteOff'; channel: number; pitch: number; velocity: number }
  | { tick: number; type: 'cc'; channel: number; controller: number; value: number }
  | { tick: number; type: 'program'; channel: number; program: number }
  | { tick: number; type: 'pitchBend'; channel: number; value: number }
  | { tick: number; type: 'polyAftertouch'; channel: number; pitch: number; pressure: number }
  | { tick: number; type: 'channelPressure'; channel: number; pressure: number }
  | { tick: number; type: 'meta'; meta: SmfMeta }
  | { tick: number; type: 'sysex'; data: Uint8Array };

export interface SmfTrack {
  events: SmfEvent[];
}

export interface SmfFile {
  format: 0 | 1 | 2;
  ticksPerQuarter: number;
  tracks: SmfTrack[];
}

function readU16(data: Uint8Array, i: number): number {
  return (data[i] << 8) | data[i + 1];
}

function readU32(data: Uint8Array, i: number): number {
  return ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
}

function ascii(data: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...data.subarray(i, i + n));
}

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  } catch {
    return String.fromCharCode(...data);
  }
}

export function parseSmf(bytes: Uint8Array): SmfFile {
  if (bytes.length > 64 * 1024 * 1024) {
    throw new Error('MIDI file exceeds the 64 MiB safety limit');
  }
  if (bytes.length < 14 || ascii(bytes, 0, 4) !== 'MThd') {
    throw new Error('Not a Standard MIDI File (missing MThd)');
  }
  const headerLen = readU32(bytes, 4);
  if (headerLen < 6) throw new Error('Invalid MIDI header length');
  const format = readU16(bytes, 8) as 0 | 1 | 2;
  const ntrks = readU16(bytes, 10);
  const division = readU16(bytes, 12);
  if (division & 0x8000) {
    throw new Error('SMPTE time-division MIDI is not supported. Export the file with metrical PPQ ticks.');
  }
  if (format > 2) throw new Error(`Unsupported MIDI format ${format}`);
  if (format === 2) {
    throw new Error('MIDI format 2 contains independent sequences and is not supported by the exactness profile');
  }
  if (ntrks === 0 || ntrks > 1024) throw new Error(`Invalid MIDI track count ${ntrks}`);
  if (format === 0 && ntrks !== 1) throw new Error('MIDI format 0 must contain exactly one track');
  if (division === 0) throw new Error('ticksPerQuarter cannot be 0');

  const tracks: SmfTrack[] = [];
  let offset = 8 + headerLen;
  for (let t = 0; t < ntrks; t++) {
    if (offset + 8 > bytes.length) throw new Error(`Truncated MIDI: expected track ${t + 1}`);
    if (ascii(bytes, offset, 4) !== 'MTrk') {
      throw new Error(`Expected MTrk at offset ${offset}`);
    }
    const len = readU32(bytes, offset + 4);
    const start = offset + 8;
    const end = start + len;
    if (end > bytes.length) throw new Error(`Track ${t + 1} overruns file`);
    tracks.push({ events: parseTrack(bytes.subarray(start, end)) });
    offset = end;
  }

  if (offset !== bytes.length) throw new Error('MIDI file contains trailing bytes after the declared tracks');

  return { format, ticksPerQuarter: division, tracks };
}

function parseTrack(data: Uint8Array): SmfEvent[] {
  const events: SmfEvent[] = [];
  let i = 0;
  let tick = 0;
  let running = 0;
  let sawEndOfTrack = false;

  while (i < data.length) {
    const vlq = decodeVlq(data, i);
    i = vlq.next;
    tick += vlq.value;
    if (i >= data.length) throw new Error('Truncated MIDI event');

    let status = data[i];
    if (status < 0x80) {
      if (running < 0x80) throw new Error('Running status with no prior status byte');
      status = running;
    } else {
      i++;
      if (status < 0xf0) running = status;
    }

    if (status === 0xff) {
      running = 0;
      if (i + 1 > data.length) throw new Error('Truncated meta event');
      const metaType = data[i++];
      const len = decodeVlq(data, i);
      i = len.next;
      const payload = data.subarray(i, i + len.value);
      if (i + len.value > data.length) throw new Error('Truncated meta payload');
      i += len.value;
      const meta = parseMeta(metaType, payload);
      events.push({ tick, type: 'meta', meta });
      if (meta.type === 'endOfTrack') {
        sawEndOfTrack = true;
        if (i !== data.length) throw new Error('MIDI track contains data after end-of-track');
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      running = 0;
      const len = decodeVlq(data, i);
      i = len.next;
      if (i + len.value > data.length) throw new Error('Truncated SysEx payload');
      const payload = data.subarray(i, i + len.value);
      i += len.value;
      events.push({ tick, type: 'sysex', data: payload });
      continue;
    }

    if (status >= 0xf0) throw new Error(`Unsupported system status 0x${status.toString(16)} in MIDI track`);

    const hi = status & 0xf0;
    const ch = status & 0x0f;
    const need = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
    if (i + need > data.length) throw new Error('Truncated channel event');
    const a = data[i++];
    const b = need === 2 ? data[i++] : 0;
    if (a > 0x7f || b > 0x7f) throw new Error('MIDI channel data byte exceeds 7 bits');

    if (hi === 0x80) {
      events.push({ tick, type: 'noteOff', channel: ch, pitch: a, velocity: b });
    } else if (hi === 0x90) {
      if (b === 0) events.push({ tick, type: 'noteOff', channel: ch, pitch: a, velocity: 0 });
      else events.push({ tick, type: 'noteOn', channel: ch, pitch: a, velocity: b });
    } else if (hi === 0xb0) {
      events.push({ tick, type: 'cc', channel: ch, controller: a, value: b });
    } else if (hi === 0xc0) {
      events.push({ tick, type: 'program', channel: ch, program: a });
    } else if (hi === 0xe0) {
      events.push({ tick, type: 'pitchBend', channel: ch, value: ((b << 7) | a) - 8192 });
    } else if (hi === 0xa0) {
      events.push({ tick, type: 'polyAftertouch', channel: ch, pitch: a, pressure: b });
    } else if (hi === 0xd0) {
      events.push({ tick, type: 'channelPressure', channel: ch, pressure: a });
    }
  }

  if (!sawEndOfTrack) throw new Error('MIDI track is missing end-of-track');

  return events;
}

function parseMeta(metaType: number, data: Uint8Array): SmfMeta {
  if (metaType === 0x03) return { type: 'trackName', text: decodeText(data) };
  if (metaType === 0x01) return { type: 'text', text: decodeText(data) };
  if (metaType === 0x2f) {
    if (data.length !== 0) throw new Error('Invalid end-of-track meta-event length');
    return { type: 'endOfTrack' };
  }
  if (metaType === 0x51) {
    if (data.length !== 3) throw new Error('Invalid tempo meta-event length');
    return { type: 'tempo', usPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2] };
  }
  if (metaType === 0x58) {
    if (data.length !== 4) throw new Error('Invalid time-signature meta-event length');
    return {
      type: 'timeSignature',
      numerator: data[0],
      denominator: 2 ** data[1],
      clocks: data[2],
      thirtySeconds: data[3],
    };
  }
  if (metaType === 0x59) {
    if (data.length !== 2) throw new Error('Invalid key-signature meta-event length');
    const fifths = data[0] > 127 ? data[0] - 256 : data[0];
    return { type: 'keySignature', fifths, minor: data[1] === 1 };
  }
  return { type: 'unknown', metaType, data };
}

export function writeSmf(file: SmfFile): Uint8Array {
  const tracks = file.tracks.map(writeTrack);
  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06]);
  header[8] = 0;
  header[9] = file.format;
  header[10] = (tracks.length >> 8) & 0xff;
  header[11] = tracks.length & 0xff;
  header[12] = (file.ticksPerQuarter >> 8) & 0xff;
  header[13] = file.ticksPerQuarter & 0xff;

  let total = header.length;
  for (const t of tracks) total += t.length;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let o = header.length;
  for (const t of tracks) {
    out.set(t, o);
    o += t.length;
  }
  return out;
}

function writeTrack(track: SmfTrack): Uint8Array {
  const body: number[] = [];
  let lastTick = 0;
  let running = -1;
  const events = [...track.events].sort((a, b) => a.tick - b.tick);

  const ensureEot = events.some((e) => e.type === 'meta' && e.meta.type === 'endOfTrack');
  if (!ensureEot) {
    const last = events.length ? events[events.length - 1].tick : 0;
    events.push({ tick: last, type: 'meta', meta: { type: 'endOfTrack' } });
  }

  for (const ev of events) {
    const delta = ev.tick - lastTick;
    if (delta < 0) throw new Error('SMF events must be non-decreasing in tick');
    body.push(...encodeVlq(delta));
    lastTick = ev.tick;
    writeEvent(body, ev, (status) => {
      if (status === running) return false;
      running = status < 0xf0 ? status : -1;
      return true;
    });
    if (ev.type === 'meta' || ev.type === 'sysex') running = -1;
  }

  const len = body.length;
  const out = new Uint8Array(8 + len);
  out.set([0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  out.set(body, 8);
  return out;
}

function writeEvent(body: number[], ev: SmfEvent, emitStatus: (s: number) => boolean): void {
  if (ev.type === 'noteOn') {
    const st = 0x90 | ev.channel;
    if (emitStatus(st)) body.push(st);
    body.push(ev.pitch & 0x7f, ev.velocity & 0x7f);
    return;
  }
  if (ev.type === 'noteOff') {
    const st = 0x80 | ev.channel;
    if (emitStatus(st)) body.push(st);
    body.push(ev.pitch & 0x7f, ev.velocity & 0x7f);
    return;
  }
  if (ev.type === 'cc') {
    const st = 0xb0 | ev.channel;
    if (emitStatus(st)) body.push(st);
    body.push(ev.controller & 0x7f, ev.value & 0x7f);
    return;
  }
  if (ev.type === 'program') {
    const st = 0xc0 | ev.channel;
    if (emitStatus(st)) body.push(st);
    body.push(ev.program & 0x7f);
    return;
  }
  if (ev.type === 'pitchBend') {
    const st = 0xe0 | ev.channel;
    if (emitStatus(st)) body.push(st);
    const v = ev.value + 8192;
    body.push(v & 0x7f, (v >> 7) & 0x7f);
    return;
  }
  if (ev.type === 'polyAftertouch') {
    const st = 0xa0 | ev.channel;
    if (emitStatus(st)) body.push(st);
    body.push(ev.pitch & 0x7f, ev.pressure & 0x7f);
    return;
  }
  if (ev.type === 'channelPressure') {
    const st = 0xd0 | ev.channel;
    if (emitStatus(st)) body.push(st);
    body.push(ev.pressure & 0x7f);
    return;
  }
  if (ev.type === 'sysex') {
    body.push(0xf0, ...encodeVlq(ev.data.length), ...ev.data);
    return;
  }
  writeMeta(body, ev.meta);
}

function writeMeta(body: number[], meta: SmfMeta): void {
  const push = (type: number, data: number[]) => {
    body.push(0xff, type, ...encodeVlq(data.length), ...data);
  };
  if (meta.type === 'endOfTrack') {
    push(0x2f, []);
    return;
  }
  if (meta.type === 'trackName' || meta.type === 'text') {
    push(meta.type === 'trackName' ? 0x03 : 0x01, [...new TextEncoder().encode(meta.text)]);
    return;
  }
  if (meta.type === 'tempo') {
    const u = meta.usPerQuarter;
    push(0x51, [(u >> 16) & 0xff, (u >> 8) & 0xff, u & 0xff]);
    return;
  }
  if (meta.type === 'timeSignature') {
    const exp = Math.round(Math.log2(meta.denominator));
    push(0x58, [meta.numerator, exp, meta.clocks, meta.thirtySeconds]);
    return;
  }
  if (meta.type === 'keySignature') {
    const f = meta.fifths < 0 ? meta.fifths + 256 : meta.fifths;
    push(0x59, [f & 0xff, meta.minor ? 1 : 0]);
    return;
  }
  push(meta.metaType, [...meta.data]);
}

export interface TimedMidiMessage {
  tMs: number;
  data: number[];
}

/** Convert a live Web MIDI stream (milliseconds) into an SMF at a fixed tempo. */
export function liveMessagesToSmf(
  messages: TimedMidiMessage[],
  opts: { ticksPerQuarter?: number; tempoBpm?: number } = {},
): SmfFile {
  const tpq = opts.ticksPerQuarter ?? 480;
  const bpm = opts.tempoBpm ?? 120;
  const t0 = messages[0]?.tMs ?? 0;
  const events: SmfEvent[] = [
    { tick: 0, type: 'meta', meta: { type: 'tempo', usPerQuarter: Math.round(60_000_000 / bpm) } },
    { tick: 0, type: 'meta', meta: { type: 'timeSignature', numerator: 4, denominator: 4, clocks: 24, thirtySeconds: 8 } },
  ];

  for (const m of messages) {
    const tick = Math.max(0, Math.round(((m.tMs - t0) / 1000) * (bpm / 60) * tpq));
    const d = m.data;
    if (d.length < 1) continue;
    const status = d[0];
    const hi = status & 0xf0;
    const ch = status & 0x0f;
    if (hi === 0x90 && d.length >= 3) {
      if (d[2] === 0) events.push({ tick, type: 'noteOff', channel: ch, pitch: d[1], velocity: 0 });
      else events.push({ tick, type: 'noteOn', channel: ch, pitch: d[1], velocity: d[2] });
    } else if (hi === 0x80 && d.length >= 3) {
      events.push({ tick, type: 'noteOff', channel: ch, pitch: d[1], velocity: d[2] });
    } else if (hi === 0xb0 && d.length >= 3) {
      events.push({ tick, type: 'cc', channel: ch, controller: d[1], value: d[2] });
    } else if (hi === 0xc0 && d.length >= 2) {
      events.push({ tick, type: 'program', channel: ch, program: d[1] });
    } else if (hi === 0xe0 && d.length >= 3) {
      events.push({ tick, type: 'pitchBend', channel: ch, value: ((d[2] << 7) | d[1]) - 8192 });
    } else if (hi === 0xa0 && d.length >= 3) {
      events.push({ tick, type: 'polyAftertouch', channel: ch, pitch: d[1], pressure: d[2] });
    } else if (hi === 0xd0 && d.length >= 2) {
      events.push({ tick, type: 'channelPressure', channel: ch, pressure: d[1] });
    } else if (status >= 0xf0) {
      // Preserve the existence of unsupported system/SysEx messages so the
      // downstream integrity gate abstains instead of silently discarding it.
      const payload = status === 0xf0 && d[d.length - 1] === 0xf7 ? d.slice(1, -1) : d.slice(1);
      events.push({ tick, type: 'sysex', data: Uint8Array.from(payload) });
    }
  }

  events.sort((a, b) => a.tick - b.tick);
  const last = events.length ? events[events.length - 1].tick : 0;
  events.push({ tick: last, type: 'meta', meta: { type: 'endOfTrack' } });
  return { format: 0, ticksPerQuarter: tpq, tracks: [{ events }] };
}
