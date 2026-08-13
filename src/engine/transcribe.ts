import { performanceToMidi } from './exportMidi';
import { musicXmlFidelityRate, musicXmlMetadataMatches, scoreToMusicXml } from './musicxml';
import { parseMidiFile, performanceFromSmf, smfToPerformance } from './performance';
import { quantizePerformance } from './quantize';
import { rejectAudioBytes, rejectIfNotMidi } from './reject';
import { engraveScore, hasUnsupportedPolyphony } from './score';
import { liveMessagesToSmf, parseSmf, type TimedMidiMessage } from './smf';
import type { Performance, Rejection, Transcript, TranscribeOptions } from './types';
import { verifyEventRoundTrip } from './verify';

export function transcribeMidiBytes(
  bytes: Uint8Array,
  filename: string,
  options: TranscribeOptions = {},
): Transcript | Rejection {
  const rejected = rejectAudioBytes(filename, bytes);
  if (rejected) return rejected;
  const named = rejectIfNotMidi(filename);
  if (named) return named;
  try {
    const perf = parseMidiFile(bytes, filename);
    return transcribePerformance(perf, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unsupported = /not supported|unsupported|independent sequences|SMPTE/i.test(message);
    const invalidOptions = /threshold|tolerance|tempo|meter|key fifths|staff split|staff mode/i.test(message);
    return {
      rejected: true,
      filename,
      code: invalidOptions ? 'invalid-options' : unsupported ? 'unsupported-midi' : 'malformed-midi',
      reason: message,
      approach: 'Standard MIDI parsing',
      publishedCeiling: 'No certificate issued',
    };
  }
}

export function transcribePerformance(perf: Performance, options: TranscribeOptions = {}): Transcript {
  const { notes, gate } = quantizePerformance(perf, options);
  const warnings: string[] = [];
  const eventVerification = verifyEventRoundTrip(perf);
  const addBlocker = (code: string, message: string) => {
    if (!gate.reasonCodes.includes(code)) gate.reasonCodes.push(code);
    if (!gate.reasons.includes(message)) gate.reasons.push(message);
  };

  if (perf.notes.length === 0) {
    if (perf.integrity.sourceNoteOnEvents === 0) {
      warnings.push('The source contains no note-on events. Tempo, meter, key, or track-length metadata alone cannot produce sound.');
    } else if (perf.integrity.percussionNoteOnEvents === perf.integrity.sourceNoteOnEvents) {
      warnings.push(`All ${perf.integrity.sourceNoteOnEvents} source attacks are on GM channel 10 and were treated as percussion.`);
    } else {
      warnings.push('No supported pitched notes remained after solo-piano filtering.');
    }
  }
  const channels = new Set(perf.notes.map((n) => n.channel));
  if (channels.size > 1) {
    warnings.push(`Multiple MIDI channels (${[...channels].join(', ')}). All non-drum notes are included.`);
  }
  const noteTracks = new Set(perf.notes.map((note) => note.track));
  if (options.staffMode === 'track' || (options.staffMode !== 'pitch' && noteTracks.size === 2)) {
    warnings.push('Treble/bass assignment preserves the two MIDI note tracks, ranked by median pitch; staff intent is not part of the accuracy certificate.');
  }
  if (perf.tempoEvents.length > 1) {
    warnings.push(
      'File contains tempo changes. Certification uses a single BPM for the grid; event times in the performance table stay exact.',
    );
    addBlocker('tempo-map-unsupported', 'Changing tempo is not representable by the score-note-v1 exporter.');
  }
  if (perf.timeSignatures.length > 1) {
    warnings.push('Multiple time signatures found. The engraved score uses the first one throughout.');
    addBlocker('meter-map-unsupported', 'Changing meter is outside the score-note-v1 profile.');
  }

  if (perf.keySignatures.length > 1) {
    warnings.push('Multiple key signatures found. Static key spelling would be incomplete.');
    addBlocker('key-map-unsupported', 'Changing key signature is outside the score-note-v1 profile.');
  }
  if (perf.integrity.unmatchedNoteOns > 0 || perf.integrity.unmatchedNoteOffs > 0) {
    addBlocker('unmatched-notes', 'Unpaired note-on or note-off messages make note durations unverifiable.');
  }
  if (perf.integrity.overlappingSamePitch > 0) {
    addBlocker('ambiguous-repeats', 'Overlapping repeats of one pitch have ambiguous note-off pairing.');
  }
  if (perf.integrity.neutralPitchBendEvents > 0) {
    warnings.push(`${perf.integrity.neutralPitchBendEvents} centre-position pitch-bend reset event(s) have no pitch effect and were ignored.`);
  }
  if (perf.integrity.nonNeutralPitchBendEvents > 0) {
    addBlocker('pitch-bend-unsupported', 'Pitch-bend or microtonal content is outside the score-note-v1 profile.');
  }
  if (perf.integrity.aftertouchEvents > 0) {
    addBlocker('aftertouch-unsupported', 'Aftertouch semantics are outside the score-note-v1 profile.');
  }
  if (perf.integrity.percussionNoteEvents > 0) {
    addBlocker('mixed-percussion', 'Percussion events were found; this profile is solo piano only.');
  }
  if (perf.integrity.unsupportedControlEvents > 0) {
    addBlocker('controller-unsupported', 'Non-sustain controller semantics are outside the score-note-v1 profile.');
  }
  if (perf.integrity.sysexEvents > 0) {
    addBlocker('sysex-unsupported', 'SysEx semantics are outside the score-note-v1 profile.');
  }
  if (perf.source === 'audio-draft') {
    addBlocker(
      'audio-inference-uncertified',
      'These note events were inferred from audio and have no MIDI or human-annotated ground truth; certification is unavailable.',
    );
    warnings.push('Audio inference used Spotify Basic Pitch. Pitch, onset, duration, tempo, meter, staff, and voice decisions require listening and correction.');
  }
  const nonPianoPrograms = perf.programEvents.filter((event) => event.program < 0 || event.program > 7);
  if (nonPianoPrograms.length > 0) {
    addBlocker('non-piano-program', 'A non-piano MIDI program was found; solo-piano provenance is not established.');
  }
  if (perf.notes.length > 0 && !eventVerification.verified) {
    addBlocker('event-roundtrip-failed', 'The supported MIDI note-event round trip was not exactly lossless.');
  }
  if (hasUnsupportedPolyphony(notes)) {
    addBlocker('polyphony-unsupported', 'Independent overlapping voices cannot yet be exported without loss.');
  }
  if (gate.grid === '1/8t' || gate.grid === '1/16t') {
    addBlocker('tuplet-export-unsupported', 'Tuplet MusicXML export is not certified in score-note-v1.');
  }

  // Quantizer diagnostics precede structural checks; translate them into
  // stable audit codes instead of presenting them as a generic accuracy claim.
  if (!gate.gridConformant && gate.reasonCodes.length === 0) gate.reasonCodes.push('grid-conformity');

  const title = options.title ?? perf.filename ?? 'Piano transcript';
  let score: Transcript['score'] = null;
  let musicxml: Transcript['musicxml'] = null;
  const eligible = gate.gridConformant && eventVerification.verified && gate.reasons.length === 0;
  if (eligible) {
    const candidate = engraveScore(notes, gate, title);
    const candidateXml = scoreToMusicXml(candidate);
    gate.scoreFidelityEvaluated = true;
    try {
      gate.scoreFidelityRate = musicXmlFidelityRate(notes, candidateXml);
    } catch (error) {
      gate.scoreFidelityRate = 0;
      addBlocker(
        'musicxml-structure-invalid',
        `Generated MusicXML failed structural verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!musicXmlMetadataMatches(candidate, candidateXml)) {
      addBlocker('musicxml-metadata-mismatch', 'Generated MusicXML did not preserve tempo, meter, or key metadata.');
    }
    if (gate.scoreFidelityRate === 1 && gate.reasons.length === 0) {
      gate.certified = true;
      gate.status = 'certified-score';
      candidate.certified = true;
      score = candidate;
      musicxml = scoreToMusicXml(candidate);
    } else {
      addBlocker(
        'musicxml-roundtrip-failed',
        `Generated MusicXML recovered ${(gate.scoreFidelityRate * 100).toFixed(2)}% of canonical notes; 100% is required.`,
      );
    }
  }

  if (!gate.certified && gate.reasons.length === 0) {
    addBlocker('internal-abstention', 'The score certificate abstained because a release invariant was not proven.');
  }

  let draftMusicxml: string | null = null;
  if (perf.source === 'audio-draft' && notes.length > 0 && gate.grid !== '1/8t' && gate.grid !== '1/16t') {
    try {
      const flattened = flattenAudioDraftVoices(notes, gate.grid);
      const draftScore = engraveScore(flattened, gate, `${title} — UNVERIFIED AUDIO DRAFT`);
      draftScore.certified = false;
      draftMusicxml = scoreToMusicXml(draftScore).replace(
        '</miscellaneous>',
        '      <miscellaneous-field name="source-provenance">probabilistic-audio-inference</miscellaneous-field>\n    </miscellaneous>',
      );
      warnings.push('Draft MusicXML flattens each staff to one chord stream; overlapping voice durations are shortened or unified at the next attack.');
    } catch (error) {
      warnings.push(`Draft MusicXML could not be engraved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    performance: perf,
    eventVerification,
    quantized: notes,
    gate,
    score,
    musicxml,
    draftMusicxml,
    warnings,
  };
}

function flattenAudioDraftVoices(notes: import('./types').QuantizedNote[], grid: import('./types').GridId) {
  const step = 1 / ({ '1/4': 1, '1/8': 2, '1/8t': 3, '1/16': 4, '1/16t': 6, '1/32': 8 } as const)[grid];
  const output: import('./types').QuantizedNote[] = [];
  for (const staff of [1, 2] as const) {
    const groups = new Map<number, import('./types').QuantizedNote[]>();
    for (const note of notes.filter((candidate) => candidate.staff === staff)) {
      const group = groups.get(note.onsetBeats) ?? [];
      group.push(note);
      groups.set(note.onsetBeats, group);
    }
    const onsets = [...groups.keys()].sort((a, b) => a - b);
    onsets.forEach((onset, index) => {
      const group = groups.get(onset)!;
      const nextOnset = onsets[index + 1] ?? Number.POSITIVE_INFINITY;
      const shortest = Math.min(...group.map((note) => note.durationBeats));
      const duration = Math.max(step, Math.min(shortest, nextOnset - onset));
      output.push(...group.map((note) => ({ ...note, durationBeats: duration })));
    });
  }
  return output.sort((a, b) => a.onsetBeats - b.onsetBeats || a.pitch - b.pitch);
}

export function transcribeLive(
  messages: TimedMidiMessage[],
  options: TranscribeOptions = {},
): Transcript {
  const smf = liveMessagesToSmf(messages, {
    tempoBpm: options.tempoBpm,
  });
  const perf = smfToPerformance(smf, 'live-midi', 'live-recording.mid');
  return transcribePerformance(perf, options);
}

export function isRejection(value: Transcript | Rejection): value is Rejection {
  return (value as Rejection).rejected === true;
}

export { parseSmf, parseMidiFile, performanceFromSmf, performanceToMidi };
