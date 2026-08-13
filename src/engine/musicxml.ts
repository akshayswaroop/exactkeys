import { escapeXml } from './xml';
import type { EngravedScore, ScoreLeaf, ScoreMeasure, SpelledPitch } from './types';

export function scoreToMusicXml(score: EngravedScore): string {
  const measures = score.measures
    .map((m, i) => renderMeasure(m, i === 0, score.divisions, score.tempoBpm))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>${escapeXml(score.title)}</work-title>
  </work>
  <identification>
    <encoding>
      <software>ExactKeys</software>
    </encoding>
    <miscellaneous>
      <miscellaneous-field name="accuracy-certified">${score.certified ? 'true' : 'false'}</miscellaneous-field>
    </miscellaneous>
  </identification>
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
      <score-instrument id="P1-I1">
        <instrument-name>Piano</instrument-name>
      </score-instrument>
      <midi-device></midi-device>
      <midi-instrument id="P1-I1">
        <midi-channel>1</midi-channel>
        <midi-program>1</midi-program>
        <volume>80</volume>
        <pan>0</pan>
      </midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
${measures}
  </part>
</score-partwise>
`;
}

function renderMeasure(m: ScoreMeasure, isFirst: boolean, divisions: number, tempoBpm: number): string {
  const attrs = isFirst
    ? `      <attributes>
        <divisions>${divisions}</divisions>
        <key>
          <fifths>${m.key.fifths}</fifths>
          <mode>${m.key.minor ? 'minor' : 'major'}</mode>
        </key>
        <time>
          <beats>${m.timeSignature.numerator}</beats>
          <beat-type>${m.timeSignature.denominator}</beat-type>
        </time>
        <staves>2</staves>
        <clef number="1">
          <sign>G</sign>
          <line>2</line>
        </clef>
        <clef number="2">
          <sign>F</sign>
          <line>4</line>
        </clef>
      </attributes>
`
    : '';

  const tempo = isFirst
    ? `      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${formatNumber(tempoBpm)}</per-minute></metronome></direction-type>
        <sound tempo="${formatNumber(tempoBpm)}"/>
      </direction>
`
    : '';

  const measureDivs = Math.round(m.durationBeats * divisions);
  const treble = renderStaff(m.treble, 1);
  const bass = renderStaff(m.bass, 2);
  return `    <measure number="${m.number}">
${attrs}${tempo}${treble}      <backup>
        <duration>${measureDivs}</duration>
      </backup>
${bass}    </measure>`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function renderStaff(leaves: ScoreLeaf[], staff: 1 | 2): string {
  const parts: string[] = [];
  for (const leaf of leaves) {
    if (leaf.kind === 'rest') {
      parts.push(noteXml({ rest: true, duration: leaf.ticks, type: leaf.duration, dots: leaf.dots, staff }));
      continue;
    }
    leaf.notes.forEach((n, i) => {
      parts.push(
        noteXml({
          rest: false,
          chord: i > 0,
          pitch: n.spelled,
          duration: leaf.ticks,
          type: leaf.duration,
          dots: leaf.dots,
          staff,
          tieStart: n.tieStart,
          tieEnd: n.tieEnd,
          eventId: n.id,
        }),
      );
    });
  }
  return parts.join('');
}

function noteXml(opts: {
  rest: boolean;
  chord?: boolean;
  pitch?: SpelledPitch;
  duration: number;
  type: string;
  dots: number;
  staff: 1 | 2;
  tieStart?: boolean;
  tieEnd?: boolean;
  eventId?: string;
}): string {
  const type = typeName(opts.type);
  const chord = opts.chord ? '        <chord/>\n' : '';
  const dots = opts.dots ? '        <dot/>\n' : '';
  const pitch = opts.rest
    ? '        <rest/>\n'
    : `        <pitch>
          <step>${opts.pitch!.step}</step>${opts.pitch!.alter ? `\n          <alter>${opts.pitch!.alter}</alter>` : ''}
          <octave>${opts.pitch!.octave}</octave>
        </pitch>
`;
  const ties: string[] = [];
  const notations: string[] = [];
  if (opts.tieStart) {
    ties.push('        <tie type="start"/>');
    notations.push('          <tied type="start"/>');
  }
  if (opts.tieEnd) {
    ties.push('        <tie type="stop"/>');
    notations.push('          <tied type="stop"/>');
  }
  const tieBlock = ties.length ? `${ties.join('\n')}\n` : '';
  const notBlock = notations.length
    ? `        <notations>\n${notations.join('\n')}\n        </notations>\n`
    : '';
  const id = opts.eventId ? ` id="${escapeXml(opts.eventId)}"` : '';
  return `      <note${id}>
${chord}${pitch}        <duration>${opts.duration}</duration>
        <voice>${opts.staff}</voice>
        <type>${type}</type>
${dots}        <staff>${opts.staff}</staff>
${tieBlock}${notBlock}      </note>
`;
}

function typeName(token: string): string {
  switch (token) {
    case 'w':
      return 'whole';
    case 'h':
      return 'half';
    case 'q':
      return 'quarter';
    case '8':
      return 'eighth';
    case '16':
      return '16th';
    case '32':
      return '32nd';
    default:
      return 'quarter';
  }
}

/** Extract MIDI pitches in document order (chords expand). Used for fidelity tests. */
export function pitchesInMusicXml(xml: string): number[] {
  const pitches: number[] = [];
  const re =
    /<pitch>\s*<step>([A-G])<\/step>(?:\s*<alter>(-?\d+(?:\.\d+)?)<\/alter>)?\s*<octave>(-?\d+)<\/octave>\s*<\/pitch>/g;
  const natural: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const step = m[1];
    const alter = m[2] ? Number(m[2]) : 0;
    const oct = Number(m[3]);
    pitches.push((oct + 1) * 12 + natural[step] + alter);
  }
  return pitches;
}

export interface MusicXmlCanonicalNote {
  id: string;
  pitch: number;
  onsetBeats: number;
  durationBeats: number;
}

/** Reparse our exported MusicXML into canonical tied notes for certification. */
export function canonicalNotesInMusicXml(xml: string): MusicXmlCanonicalNote[] {
  const divisions = Number(xml.match(/<divisions>(\d+)<\/divisions>/)?.[1]);
  if (!Number.isFinite(divisions) || divisions <= 0) throw new Error('MusicXML has no valid divisions');
  const recovered = new Map<string, MusicXmlCanonicalNote>();
  const tieFragments = new Map<string, Array<{
    start: boolean;
    stop: boolean;
    onsetDivs: number;
    durationDivs: number;
    pitch: number;
    voice: number;
    staff: number;
  }>>();
  const measureRe = /<measure\s+number="[^"]+">([\s\S]*?)<\/measure>/g;
  let measureStartDivs = 0;
  let measureMatch: RegExpExecArray | null;
  while ((measureMatch = measureRe.exec(xml))) {
    const body = measureMatch[1];
    const backupMatch = body.match(/<backup>\s*<duration>(\d+)<\/duration>\s*<\/backup>/);
    if (!backupMatch) throw new Error('MusicXML piano measure is missing its staff backup');
    const measureDivs = Number(backupMatch[1]);
    const backupAt = backupMatch.index ?? body.length;
    const parts = [body.slice(0, backupAt), body.slice(backupAt + backupMatch[0].length)];
    for (const part of parts) {
      let cursor = 0;
      let lastStart = 0;
      const noteRe = /<note(?:\s+id="([^"]+)")?>([\s\S]*?)<\/note>/g;
      let noteMatch: RegExpExecArray | null;
      while ((noteMatch = noteRe.exec(part))) {
        const id = noteMatch[1];
        const noteBody = noteMatch[2];
        const duration = Number(noteBody.match(/<duration>(\d+)<\/duration>/)?.[1]);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('MusicXML note has no valid duration');
        const isChord = /<chord\s*\/>/.test(noteBody);
        const start = isChord ? lastStart : cursor;
        if (!isChord) lastStart = start;
        if (id) {
          const pitchMatch = noteBody.match(
            /<pitch>\s*<step>([A-G])<\/step>(?:\s*<alter>(-?\d+)<\/alter>)?\s*<octave>(-?\d+)<\/octave>\s*<\/pitch>/,
          );
          if (!pitchMatch) throw new Error(`MusicXML event ${id} has no pitch`);
          const natural: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
          const pitch = (Number(pitchMatch[3]) + 1) * 12 + natural[pitchMatch[1]] + Number(pitchMatch[2] ?? 0);
          const voice = Number(noteBody.match(/<voice>(\d+)<\/voice>/)?.[1]);
          const staff = Number(noteBody.match(/<staff>(\d+)<\/staff>/)?.[1]);
          if (!Number.isInteger(voice) || voice <= 0 || !Number.isInteger(staff) || staff <= 0) {
            throw new Error(`MusicXML event ${id} has no valid voice/staff identity`);
          }
          const existing = recovered.get(id);
          const fragments = tieFragments.get(id) ?? [];
          fragments.push({
            start: /<tie\s+type="start"\s*\/>/.test(noteBody),
            stop: /<tie\s+type="stop"\s*\/>/.test(noteBody),
            onsetDivs: measureStartDivs + start,
            durationDivs: duration,
            pitch,
            voice,
            staff,
          });
          tieFragments.set(id, fragments);
          if (existing) {
            if (existing.pitch !== pitch) throw new Error(`MusicXML event ${id} changes pitch across a tie`);
            existing.durationBeats += duration / divisions;
          } else {
            recovered.set(id, {
              id,
              pitch,
              onsetBeats: (measureStartDivs + start) / divisions,
              durationBeats: duration / divisions,
            });
          }
        }
        if (!isChord) cursor += duration;
      }
      if (cursor !== measureDivs) {
        throw new Error(`MusicXML staff covers ${cursor} divisions; expected ${measureDivs}`);
      }
    }
    measureStartDivs += measureDivs;
  }
  for (const [id, fragments] of tieFragments) {
    if (fragments.length === 1) {
      if (fragments[0].start || fragments[0].stop) throw new Error(`MusicXML event ${id} has a dangling tie`);
      continue;
    }
    fragments.forEach((fragment, index) => {
      const first = index === 0;
      const last = index === fragments.length - 1;
      if (fragment.start !== !last || fragment.stop !== !first) {
        throw new Error(`MusicXML event ${id} has a broken tie chain`);
      }
      if (!first) {
        const previous = fragments[index - 1];
        if (
          fragment.pitch !== previous.pitch ||
          fragment.voice !== previous.voice ||
          fragment.staff !== previous.staff
        ) {
          throw new Error(`MusicXML event ${id} changes pitch, voice, or staff across a tie`);
        }
        if (fragment.onsetDivs !== previous.onsetDivs + previous.durationDivs) {
          throw new Error(`MusicXML event ${id} has a non-contiguous tie chain`);
        }
      }
    });
  }
  return [...recovered.values()].sort((a, b) => a.onsetBeats - b.onsetBeats || a.pitch - b.pitch);
}

export function musicXmlMetadataMatches(score: EngravedScore, xml: string): boolean {
  const first = score.measures[0];
  if (!first) return false;
  const beats = Number(xml.match(/<beats>(\d+)<\/beats>/)?.[1]);
  const beatType = Number(xml.match(/<beat-type>(\d+)<\/beat-type>/)?.[1]);
  const fifths = Number(xml.match(/<fifths>(-?\d+)<\/fifths>/)?.[1]);
  const tempo = Number(xml.match(/<sound\s+tempo="([^"]+)"\s*\/>/)?.[1]);
  return (
    beats === first.timeSignature.numerator &&
    beatType === first.timeSignature.denominator &&
    fifths === first.key.fifths &&
    Math.abs(tempo - score.tempoBpm) < 0.001
  );
}

export function musicXmlFidelityRate(
  expected: Array<{ id: string; pitch: number; onsetBeats: number; durationBeats: number }>,
  xml: string,
): number {
  const actual = canonicalNotesInMusicXml(xml);
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const expectedById = new Map(expected.map((note) => [note.id, note]));
  let matched = 0;
  for (const note of actual) {
    const source = expectedById.get(note.id);
    if (
      source &&
      source.pitch === note.pitch &&
      Math.abs(source.onsetBeats - note.onsetBeats) < 1e-9 &&
      Math.abs(source.durationBeats - note.durationBeats) < 1e-9
    ) matched++;
  }
  return matched / Math.max(expected.length, actual.length);
}
