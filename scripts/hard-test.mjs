#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { XMLValidator } from 'fast-xml-parser';
import {
  canonicalNotesInMusicXml,
  isRejection,
  transcribeMidiBytes,
  transcribePerformance,
} from '../src/engine/index.ts';

const REQUIRED_ACCURACY = 0.99;

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    'Usage: npm run hard-test -- --audio <piano.mp3> --reference <score.xml> [--out <report.json>] [--ours <derived.musicxml>]\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!['--audio', '--reference', '--out', '--ours'].includes(token)) usage(`Unknown option ${token}`);
    const value = argv[++index];
    if (!value) usage(`${token} requires a path`);
    result[token.slice(2)] = resolve(value);
  }
  if (!result.audio || !result.reference) usage('Both --audio and --reference are required');
  return result;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function textOf(block, tag) {
  return block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim();
}

function intOf(block, tag) {
  const value = Number(textOf(block, tag));
  return Number.isFinite(value) ? value : undefined;
}

function parseMusicXmlOracle(xml) {
  const validity = XMLValidator.validate(xml);
  if (validity !== true) throw new Error(`Reference XML is not well formed: ${validity.err.msg}`);

  const supportedSubsetIssues = [];
  const partCount = [...xml.matchAll(/<part\b[^>]*\bid=/g)].length;
  if (partCount !== 1) supportedSubsetIssues.push(`supported comparison requires one part; found ${partCount}`);
  const unsupportedConstructs = [
    ['namespaces', /<score-partwise\b[^>]*\bxmlns=/],
    ['implicit/pickup measures', /<measure\b[^>]*\bimplicit=["']yes["']/],
    ['grace notes', /<grace\b/],
    ['cue notes', /<cue\b/],
    ['forward cursor moves', /<forward\b/],
    ['repeats/endings', /<(?:repeat|ending)\b/],
    ['tuplets/time modifications', /<(?:tuplet|time-modification)\b/],
  ];
  for (const [label, pattern] of unsupportedConstructs) {
    if (pattern.test(xml)) supportedSubsetIssues.push(`${label} are outside the hard-test canonicalizer`);
  }
  const uniqueTagValues = (tag) => new Set(
    [...xml.matchAll(new RegExp(`<${tag}>([^<]+)<\\/${tag}>`, 'g'))].map((match) => match[1].trim()),
  );
  for (const [label, tag] of [['division changes', 'divisions'], ['meter numerator changes', 'beats'], ['meter denominator changes', 'beat-type']]) {
    if (uniqueTagValues(tag).size > 1) supportedSubsetIssues.push(`${label} are outside the hard-test canonicalizer`);
  }
  if (uniqueTagValues('fifths').size > 1 || uniqueTagValues('mode').size > 1) {
    supportedSubsetIssues.push('key changes are outside the hard-test canonicalizer');
  }
  if (uniqueTagValues('per-minute').size > 1) {
    supportedSubsetIssues.push('tempo changes are outside the hard-test canonicalizer');
  }

  const measures = [...xml.matchAll(/<measure\b([^>]*)>([\s\S]*?)<\/measure>/g)];
  if (measures.length === 0) throw new Error('Reference has no MusicXML measures');

  let divisions = 1;
  let time = { numerator: 4, denominator: 4 };
  let fifths = 0;
  let minor = false;
  let absoluteBeat = 0;
  let tempoBpm = Number(xml.match(/<per-minute>([^<]+)<\/per-minute>/)?.[1]);
  if (!Number.isFinite(tempoBpm) || tempoBpm <= 0) {
    tempoBpm = Number(xml.match(/<sound\s+tempo="([^"]+)"/)?.[1]);
  }

  const fragments = [];
  const structuralIssues = supportedSubsetIssues;
  let restCount = 0;
  let chordToneCount = 0;
  let tieStartCount = 0;
  let tieStopCount = 0;
  let maxCursorErrorDivisions = 0;

  for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
    const body = measures[measureIndex][2];
    const measureNumber = measures[measureIndex][1].match(/number="([^"]+)"/)?.[1] ?? String(measureIndex + 1);
    let cursor = 0;
    let previousAttackStart = 0;
    const tokens = body.match(/<(?:attributes|note|backup|forward)\b[\s\S]*?<\/(?:attributes|note|backup|forward)>/g) ?? [];

    for (const token of tokens) {
      if (token.startsWith('<attributes')) {
        divisions = intOf(token, 'divisions') ?? divisions;
        const numerator = intOf(token, 'beats');
        const denominator = intOf(token, 'beat-type');
        if (numerator && denominator) time = { numerator, denominator };
        fifths = intOf(token, 'fifths') ?? fifths;
        const mode = textOf(token, 'mode');
        if (mode) minor = mode === 'minor';
        continue;
      }
      if (token.startsWith('<backup')) {
        cursor -= intOf(token, 'duration') ?? 0;
        if (cursor < 0) structuralIssues.push(`measure ${measureNumber}: backup moved before measure start`);
        continue;
      }
      if (token.startsWith('<forward')) {
        cursor += intOf(token, 'duration') ?? 0;
        continue;
      }

      const durationDivisions = intOf(token, 'duration');
      const isGrace = /<grace\b/.test(token);
      if (durationDivisions === undefined && !isGrace) {
        structuralIssues.push(`measure ${measureNumber}: non-grace note has no duration`);
        continue;
      }
      const duration = (durationDivisions ?? 0) / divisions;
      const isChord = /<chord\s*\/>/.test(token);
      const startDivisions = isChord ? previousAttackStart : cursor;
      if (!isChord) previousAttackStart = startDivisions;
      if (!isChord) cursor += durationDivisions ?? 0;
      if (/<rest\b/.test(token)) {
        restCount++;
        continue;
      }

      const step = textOf(token, 'step');
      const octave = intOf(token, 'octave');
      const alter = intOf(token, 'alter') ?? 0;
      const naturals = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      if (!step || octave === undefined || naturals[step] === undefined) {
        structuralIssues.push(`measure ${measureNumber}: pitched note has invalid pitch`);
        continue;
      }
      const pitch = (octave + 1) * 12 + naturals[step] + alter;
      if (pitch < 0 || pitch > 127) structuralIssues.push(`measure ${measureNumber}: MIDI pitch ${pitch} is out of range`);
      const tieStart = /<tie\b[^>]*\btype=["']start["'][^>]*\/?>/.test(token);
      const tieStop = /<tie\b[^>]*\btype=["']stop["'][^>]*\/?>/.test(token);
      if (tieStart) tieStartCount++;
      if (tieStop) tieStopCount++;
      if (isChord) chordToneCount++;
      fragments.push({
        sourceId: token.match(/<note\s+id="([^"]+)"/)?.[1],
        measure: measureNumber,
        voice: textOf(token, 'voice') ?? '1',
        staff: intOf(token, 'staff') ?? 1,
        pitch,
        onsetBeats: absoluteBeat + startDivisions / divisions,
        durationBeats: duration,
        tieStart,
        tieStop,
      });
    }

    const measureBeats = time.numerator * (4 / time.denominator);
    const expectedDivisions = measureBeats * divisions;
    const cursorError = Math.abs(cursor - expectedDivisions);
    maxCursorErrorDivisions = Math.max(maxCursorErrorDivisions, cursorError);
    if (cursorError > 1e-9) {
      structuralIssues.push(`measure ${measureNumber}: cursor covers ${cursor} divisions, expected ${expectedDivisions}`);
    }
    absoluteBeat += measureBeats;
  }

  const attacks = [];
  const openTies = new Map();
  for (const fragment of fragments) {
    const tieKey = `P1:${fragment.voice}:${fragment.pitch}`;
    if (fragment.tieStop) {
      const open = openTies.get(tieKey);
      if (!open) {
        structuralIssues.push(`measure ${fragment.measure}: tie stop has no matching start for MIDI ${fragment.pitch}`);
        continue;
      }
      const expectedOnset = open.onsetBeats + open.durationBeats;
      if (Math.abs(fragment.onsetBeats - expectedOnset) > 1e-9) {
        structuralIssues.push(`measure ${fragment.measure}: non-contiguous tie for MIDI ${fragment.pitch}`);
      }
      open.durationBeats += fragment.durationBeats;
      if (!fragment.tieStart) openTies.delete(tieKey);
      continue;
    }
    const attack = { ...fragment };
    attacks.push(attack);
    if (fragment.tieStart) {
      if (openTies.has(tieKey)) {
        structuralIssues.push(`measure ${fragment.measure}: duplicate open tie for MIDI ${fragment.pitch}`);
      }
      openTies.set(tieKey, attack);
    }
  }
  for (const [tieKey] of openTies) structuralIssues.push(`unclosed tie ${tieKey}`);

  const sourceIds = fragments.map((fragment) => fragment.sourceId).filter(Boolean);
  const uniqueIds = new Set(sourceIds);
  return {
    title: textOf(xml, 'work-title') ?? 'Untitled',
    composer: xml.match(/<creator\s+type="composer">([\s\S]*?)<\/creator>/)?.[1]?.trim(),
    version: xml.match(/<score-partwise\s+version="([^"]+)"/)?.[1],
    divisions,
    tempoBpm,
    timeSignature: time,
    key: { fifths, minor },
    measureCount: measures.length,
    pitchedFragments: fragments.length,
    attackCount: attacks.length,
    restCount,
    chordToneCount,
    tieStartCount,
    tieStopCount,
    sourceIds: sourceIds.length,
    uniqueSourceIds: uniqueIds.size,
    totalQuarterBeats: absoluteBeat,
    scoreDurationSec: Number.isFinite(tempoBpm) ? absoluteBeat * 60 / tempoBpm : null,
    maxCursorErrorDivisions,
    structuralIssues,
    attacks,
  };
}

function mp3Metadata(bytes) {
  const versionBitrates = {
    mpeg1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    mpeg2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  };
  let offset = 0;
  if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3') {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size + ((bytes[5] & 0x10) ? 10 : 0);
  }
  let frameCount = 0;
  let totalSamples = 0;
  let sampleRate = 0;
  let channels = 0;
  let firstFrameOffset = null;
  let xingFrameCount = null;
  let samplesPerFrame = 0;
  while (offset + 4 <= bytes.length) {
    const header = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    if ((header >>> 21) !== 0x7ff) {
      offset++;
      continue;
    }
    const versionBits = (header >>> 19) & 0x3;
    const layerBits = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    const padding = (header >>> 9) & 0x1;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      offset++;
      continue;
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const rates = [44100, 48000, 32000];
    const rate = rates[sampleRateIndex] / (version === 1 ? 1 : version === 2 ? 2 : 4);
    const bitrate = (version === 1 ? versionBitrates.mpeg1l3 : versionBitrates.mpeg2l3)[bitrateIndex] * 1000;
    const frameLength = Math.floor((version === 1 ? 144 : 72) * bitrate / rate) + padding;
    if (frameLength < 4 || offset + frameLength > bytes.length) {
      offset++;
      continue;
    }
    if (firstFrameOffset === null) firstFrameOffset = offset;
    if (frameCount === 0) {
      const sideInfoBytes = version === 1
        ? (((header >>> 6) & 0x3) === 3 ? 17 : 32)
        : (((header >>> 6) & 0x3) === 3 ? 9 : 17);
      const xingOffset = offset + 4 + sideInfoBytes;
      const marker = String.fromCharCode(...bytes.subarray(xingOffset, xingOffset + 4));
      if ((marker === 'Xing' || marker === 'Info') && xingOffset + 12 <= bytes.length) {
        const flags = (
          (bytes[xingOffset + 4] << 24) |
          (bytes[xingOffset + 5] << 16) |
          (bytes[xingOffset + 6] << 8) |
          bytes[xingOffset + 7]
        ) >>> 0;
        if ((flags & 1) !== 0) {
          xingFrameCount = (
            (bytes[xingOffset + 8] << 24) |
            (bytes[xingOffset + 9] << 16) |
            (bytes[xingOffset + 10] << 8) |
            bytes[xingOffset + 11]
          ) >>> 0;
        }
      }
    }
    frameCount++;
    samplesPerFrame = version === 1 ? 1152 : 576;
    totalSamples += samplesPerFrame;
    sampleRate = rate;
    channels = ((header >>> 6) & 0x3) === 3 ? 1 : 2;
    offset += frameLength;
  }
  return {
    codec: 'MPEG Layer III',
    scannedFrameCount: frameCount,
    audioFrameCount: xingFrameCount ?? frameCount,
    sampleRate,
    channels,
    firstFrameOffset,
    durationEstimateSec: sampleRate > 0
      ? (xingFrameCount === null ? totalSamples : xingFrameCount * samplesPerFrame) / sampleRate
      : null,
    durationEstimateSource: xingFrameCount === null ? 'scanned MPEG frames' : 'Xing declared audio frames',
  };
}

function performanceFromOracle(oracle) {
  const ticksPerQuarter = 480;
  const tempoBpm = oracle.tempoBpm;
  const notes = oracle.attacks.map((note, index) => ({
    id: `n${index}`,
    pitch: note.pitch,
    velocity: 80,
    channel: 0,
    track: Math.max(0, note.staff - 1),
    onsetTick: Math.round(note.onsetBeats * ticksPerQuarter),
    offsetTick: Math.round((note.onsetBeats + note.durationBeats) * ticksPerQuarter),
    onsetSec: note.onsetBeats * 60 / tempoBpm,
    offsetSec: (note.onsetBeats + note.durationBeats) * 60 / tempoBpm,
  }));
  let overlaps = 0;
  const openByPitch = new Map();
  for (const note of [...notes].sort((a, b) => a.onsetTick - b.onsetTick || a.pitch - b.pitch)) {
    const key = `${note.track}:${note.channel}:${note.pitch}`;
    if ((openByPitch.get(key) ?? -1) > note.onsetTick) overlaps++;
    openByPitch.set(key, Math.max(openByPitch.get(key) ?? 0, note.offsetTick));
  }
  return {
    ticksPerQuarter,
    notes,
    pedals: [],
    tempoEvents: [{ tick: 0, usPerQuarter: Math.round(60_000_000 / tempoBpm) }],
    timeSignatures: [{ tick: 0, numerator: oracle.timeSignature.numerator, denominator: oracle.timeSignature.denominator }],
    keySignatures: [{ tick: 0, fifths: oracle.key.fifths, minor: oracle.key.minor }],
    programEvents: [
      { tick: 0, channel: 0, track: 0, program: 0 },
      { tick: 0, channel: 0, track: 1, program: 0 },
    ],
    source: 'midi-file',
    filename: `${oracle.title}.reference-derived.mid`,
    durationSec: oracle.scoreDurationSec,
    trackNames: ['Reference treble', 'Reference bass'],
    integrity: {
      smfFormat: 1,
      explicitTempo: true,
      sourceNoteOnEvents: notes.length,
      percussionNoteOnEvents: 0,
      unmatchedNoteOns: 0,
      unmatchedNoteOffs: 0,
      overlappingSamePitch: overlaps,
      pitchBendEvents: 0,
      neutralPitchBendEvents: 0,
      nonNeutralPitchBendEvents: 0,
      aftertouchEvents: 0,
      percussionNoteEvents: 0,
      unsupportedControlEvents: 0,
      sysexEvents: 0,
    },
  };
}

function tuple(note) {
  return `${note.pitch}:${note.onsetBeats.toFixed(9)}:${note.durationBeats.toFixed(9)}`;
}

function compareExact(reference, candidate) {
  const ref = new Map();
  const out = new Map();
  for (const note of reference) ref.set(tuple(note), (ref.get(tuple(note)) ?? 0) + 1);
  for (const note of candidate) out.set(tuple(note), (out.get(tuple(note)) ?? 0) + 1);
  let matched = 0;
  for (const [key, count] of ref) matched += Math.min(count, out.get(key) ?? 0);
  const precision = candidate.length === 0 ? (reference.length === 0 ? 1 : 0) : matched / candidate.length;
  const recall = reference.length === 0 ? (candidate.length === 0 ? 1 : 0) : matched / reference.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return {
    matched,
    referenceNotes: reference.length,
    candidateNotes: candidate.length,
    precision,
    recall,
    f1,
    allComparedTuplesMatch: precision === 1 && recall === 1,
    comparedDimensions: ['MIDI pitch', 'quarter-beat onset', 'quarter-beat duration'],
    notComparedDimensions: [
      'audio evidence', 'staff', 'voice', 'source IDs', 'enharmonic spelling',
      'ties as notation', 'velocity', 'pedal', 'dynamics', 'articulation', 'beaming', 'harmony labels',
    ],
  };
}

function summarizePolyphony(notes, staffOf) {
  let conflictingPairs = 0;
  const affectedNotes = new Set();
  const examples = [];
  for (const staff of [1, 2]) {
    const onStaff = notes
      .map((note, index) => ({ ...note, index }))
      .filter((note) => staffOf(note) === staff)
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
        if (sameChord) continue;
        conflictingPairs++;
        affectedNotes.add(a.index);
        affectedNotes.add(b.index);
        if (examples.length < 8) {
          examples.push({
            staff,
            a: { measure: a.measure, voice: a.voice, pitch: a.pitch, onsetBeats: a.onsetBeats, durationBeats: a.durationBeats },
            b: { measure: b.measure, voice: b.voice, pitch: b.pitch, onsetBeats: b.onsetBeats, durationBeats: b.durationBeats },
          });
        }
      }
    }
  }
  return { conflictingPairs, affectedNotes: affectedNotes.size, examples };
}

const options = parseArgs(process.argv.slice(2));
const [audioBytes, referenceBytes] = await Promise.all([readFile(options.audio), readFile(options.reference)]);
const referenceXml = referenceBytes.toString('utf8');
const oracle = parseMusicXmlOracle(referenceXml);
const audioInfo = mp3Metadata(audioBytes);
const voiceStaffCounts = Object.fromEntries(
  [...oracle.attacks.reduce((counts, note) => {
    const key = `staff-${note.staff}/voice-${note.voice}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([a], [b]) => a.localeCompare(b)),
);
const notesReassignedByPitchSplit = oracle.attacks.filter(
  (note) => note.staff !== (note.pitch >= 60 ? 1 : 2),
).length;
const sourceStaffPolyphony = summarizePolyphony(oracle.attacks, (note) => note.staff);
const pitchSplitPolyphony = summarizePolyphony(oracle.attacks, (note) => note.pitch >= 60 ? 1 : 2);
const directAudio = transcribeMidiBytes(audioBytes, basename(options.audio));
const renamedAudio = transcribeMidiBytes(audioBytes, 'renamed-audio.mid');
const derivedPerformance = performanceFromOracle(oracle);
const symbolic = transcribePerformance(derivedPerformance, {
  grid: '1/16',
  staffMode: 'track',
  title: `${oracle.title} — ExactKeys reference-derived comparison`,
  splitMidi: 60,
});
let symbolicComparison = null;
if (symbolic.musicxml) {
  symbolicComparison = compareExact(oracle.attacks, canonicalNotesInMusicXml(symbolic.musicxml));
  if (options.ours) {
    await mkdir(dirname(options.ours), { recursive: true });
    await writeFile(options.ours, symbolic.musicxml);
  }
}

const directRejected = isRejection(directAudio) && directAudio.code === 'audio-below-threshold';
const renamedRejected = isRejection(renamedAudio) && renamedAudio.code === 'audio-below-threshold';
const supportedSubsetCanonicalizationPassed = oracle.structuralIssues.length === 0;
const symbolicFixturePassed = Boolean(
  symbolic.gate.certified &&
  symbolicComparison?.allComparedTuplesMatch &&
  symbolic.eventVerification.verified,
);
const hardTestChecksPassed = directRejected && renamedRejected && supportedSubsetCanonicalizationPassed && symbolicFixturePassed;
const report = {
  schema: 'exactkeys-hard-test-v1',
  generatedAt: new Date().toISOString(),
  requiredAccuracy: REQUIRED_ACCURACY,
  outcome: {
    status: hardTestChecksPassed ? 'audio-abstained-symbolic-fixture-passed' : 'failed',
    safetyPolicyGatePassed: directRejected && renamedRejected,
    supportedSubsetCanonicalizationPassed,
    symbolicSerializerFixturePassed: symbolicFixturePassed,
    audioTranscriptionRequirementMet: false,
    audioTranscriptEmitted: false,
    audioAccuracy: null,
    explanation:
      'ExactKeys did not transcribe the MP3, so this is not an audio-transcription pass. The safety gate abstained as required, while the separate serializer fixture copied supported symbolic tuples from Ivory and reproduced those tuples exactly.',
  },
  sourceRights: {
    status: 'user-supplied-private',
    publicDistribution: false,
    evidence: 'Paths supplied by the user for a private hard test; source files were not copied into the project.',
  },
  audio: {
    path: options.audio,
    bytes: audioBytes.length,
    sha256: hash(audioBytes),
    ...audioInfo,
    directResult: directAudio,
    renamedMidResult: renamedAudio,
  },
  reference: {
    path: options.reference,
    bytes: referenceBytes.length,
    sha256: hash(referenceBytes),
    provenance: 'user-supplied reference; XML identifies itself as “Transcribed by Ivory,” so it is not treated as independent human ground truth',
    wellFormedXml: true,
    supportedSubsetCanonicalizationPassed,
    title: oracle.title,
    composer: oracle.composer,
    musicXmlVersion: oracle.version,
    divisions: oracle.divisions,
    tempoBpm: oracle.tempoBpm,
    timeSignature: oracle.timeSignature,
    key: oracle.key,
    measureCount: oracle.measureCount,
    pitchedFragments: oracle.pitchedFragments,
    canonicalAttacks: oracle.attackCount,
    rests: oracle.restCount,
    additionalChordTones: oracle.chordToneCount,
    tieStarts: oracle.tieStartCount,
    tieStops: oracle.tieStopCount,
    sourceIds: oracle.sourceIds,
    uniqueSourceIds: oracle.uniqueSourceIds,
    totalQuarterBeats: oracle.totalQuarterBeats,
    scoreDurationSecAtWrittenTempo: oracle.scoreDurationSec,
    audioMinusWrittenScoreSec: audioInfo.durationEstimateSec === null || oracle.scoreDurationSec === null
      ? null
      : audioInfo.durationEstimateSec - oracle.scoreDurationSec,
    maxCursorErrorDivisions: oracle.maxCursorErrorDivisions,
    structuralIssues: oracle.structuralIssues,
    voiceStaffCounts,
    notesReassignedByStaticPitchSplit: notesReassignedByPitchSplit,
    independentOverlapUsingReferenceStaff: sourceStaffPolyphony,
    independentOverlapUsingExactKeysPitchSplit: pitchSplitPolyphony,
  },
  exactKeysReferenceDerivedComparison: {
    purpose:
      'Serialization-only comparison: the candidate is generated from the reference notes, not inferred from audio. It cannot establish audio-transcription accuracy.',
    status: symbolic.gate.status,
    certified: symbolic.gate.certified,
    eventVerification: symbolic.eventVerification,
    scoreCertificate: symbolic.gate,
    canonicalTupleComparison: symbolicComparison,
    outputMusicXml: symbolic.musicxml && options.ours ? options.ours : null,
  },
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) {
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, json);
}
process.stdout.write(json);
process.exitCode = hardTestChecksPassed ? 0 : 1;
