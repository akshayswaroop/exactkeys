/**
 * Non-certifying playback of the raw performed-note timeline.
 *
 * This module deliberately consumes onsetSec/offsetSec rather than quantized
 * score data: auditioning must never imply that the certification pipeline has
 * accepted or altered the performance.
 */

export interface AuditionInputNote {
  readonly pitch: number;
  readonly velocity: number;
  readonly onsetSec: number;
  readonly offsetSec: number;
}

export interface AuditionPlanNote {
  readonly sourceIndex: number;
  readonly pitch: number;
  readonly velocity: number;
  readonly frequencyHz: number;
  readonly gain: number;
  readonly startSec: number;
  readonly endSec: number;
}

export interface AuditionPlan {
  readonly notes: readonly AuditionPlanNote[];
  readonly durationSec: number;
}

export interface AuditionHandle {
  /** Length of the original performance timeline, excluding the synth tail. */
  readonly durationSec: number;
  /** Stop this playback and release every oscillator and scheduling timer. */
  stop(): void;
}

const MIDI_MIN = 0;
const MIDI_MAX = 127;
const START_LEAD_SEC = 0.05;
const LOOKAHEAD_SEC = 2;
const SCHEDULER_INTERVAL_MS = 100;
const ATTACK_SEC = 0.008;
const RELEASE_TAIL_SEC = 0.36;
const MASTER_LEVEL = 0.28;

/** Convert a MIDI note number to equal-tempered frequency (A4 = MIDI 69 = 440 Hz). */
export function midiToFrequency(midi: number): number {
  if (!Number.isInteger(midi) || midi < MIDI_MIN || midi > MIDI_MAX) {
    throw new RangeError(`MIDI pitch must be an integer from ${MIDI_MIN} to ${MIDI_MAX}.`);
  }

  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Map MIDI velocity onto a normalized, perceptual amplitude curve.
 * Out-of-range finite values are clamped so this helper is safe at UI edges.
 */
export function velocityToGain(velocity: number): number {
  if (!Number.isFinite(velocity)) {
    throw new RangeError('MIDI velocity must be finite.');
  }

  const normalized = Math.min(MIDI_MAX, Math.max(0, velocity)) / MIDI_MAX;
  return normalized ** 1.5;
}

/**
 * Make an immutable, deterministic schedule without modifying or quantizing the
 * source notes. Times remain relative to performance time zero, including any
 * silence before the first attack.
 */
export function createAuditionPlan(notes: readonly AuditionInputNote[]): AuditionPlan {
  const planned = notes.map((note, sourceIndex): AuditionPlanNote => {
    assertAuditionNote(note, sourceIndex);

    return Object.freeze({
      sourceIndex,
      pitch: note.pitch,
      velocity: note.velocity,
      frequencyHz: midiToFrequency(note.pitch),
      gain: velocityToGain(note.velocity),
      startSec: note.onsetSec,
      endSec: note.offsetSec,
    });
  });

  planned.sort((left, right) => (
    left.startSec - right.startSec
    || left.pitch - right.pitch
    || left.endSec - right.endSec
    || left.sourceIndex - right.sourceIndex
  ));

  const durationSec = planned.reduce((maximum, note) => Math.max(maximum, note.endSec), 0);
  return Object.freeze({
    notes: Object.freeze(planned),
    durationSec,
  });
}

function assertAuditionNote(note: AuditionInputNote, sourceIndex: number): void {
  if (!Number.isInteger(note.pitch) || note.pitch < MIDI_MIN || note.pitch > MIDI_MAX) {
    throw new RangeError(`Note ${sourceIndex} has an invalid MIDI pitch.`);
  }
  if (!Number.isInteger(note.velocity) || note.velocity < 0 || note.velocity > MIDI_MAX) {
    throw new RangeError(`Note ${sourceIndex} has an invalid MIDI velocity.`);
  }
  if (!Number.isFinite(note.onsetSec) || note.onsetSec < 0) {
    throw new RangeError(`Note ${sourceIndex} has an invalid onsetSec.`);
  }
  if (!Number.isFinite(note.offsetSec) || note.offsetSec < note.onsetSec) {
    throw new RangeError(`Note ${sourceIndex} must not end before its onset.`);
  }
}

interface VoiceNodes {
  readonly oscillators: OscillatorNode[];
  readonly partialGains: GainNode[];
  readonly filter: BiquadFilterNode;
  readonly envelope: GainNode;
  remainingOscillators: number;
}

type AudioContextConstructor = new () => AudioContext;

class BrowserAuditionSession {
  private readonly context: AudioContext;
  private readonly plan: AuditionPlan;
  private readonly onEnded: (() => void) | undefined;
  private readonly onFinished: (session: BrowserAuditionSession) => void;
  private readonly voices = new Set<VoiceNodes>();
  private master: GainNode | undefined;
  private compressor: DynamicsCompressorNode | undefined;
  private timer: ReturnType<typeof globalThis.setInterval> | undefined;
  private startAt = 0;
  private nextNoteIndex = 0;
  private stopped = false;

  constructor(
    context: AudioContext,
    plan: AuditionPlan,
    onEnded: (() => void) | undefined,
    onFinished: (session: BrowserAuditionSession) => void,
  ) {
    this.context = context;
    this.plan = plan;
    this.onEnded = onEnded;
    this.onFinished = onFinished;
  }

  start(): void {
    const master = this.context.createGain();
    const compressor = this.context.createDynamicsCompressor();

    master.gain.value = MASTER_LEVEL;
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    master.connect(compressor);
    compressor.connect(this.context.destination);

    this.master = master;
    this.compressor = compressor;
    this.startAt = this.context.currentTime + START_LEAD_SEC;
    this.tick();
    if (!this.stopped) {
      this.timer = globalThis.setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
    }
  }

  handle(): AuditionHandle {
    return Object.freeze({
      durationSec: this.plan.durationSec,
      stop: () => this.stop(),
    });
  }

  stop(): void {
    this.finish(false);
  }

  private tick(): void {
    if (this.stopped) return;

    const now = this.context.currentTime;
    const horizon = now + LOOKAHEAD_SEC;

    while (this.nextNoteIndex < this.plan.notes.length) {
      const note = this.plan.notes[this.nextNoteIndex];
      if (note === undefined || this.startAt + note.startSec > horizon) break;

      this.nextNoteIndex += 1;
      this.scheduleNote(note, now);
    }

    const audibleEnd = this.startAt + this.plan.durationSec + RELEASE_TAIL_SEC;
    if (now >= audibleEnd) this.finish(true);
  }

  private scheduleNote(note: AuditionPlanNote, now: number): void {
    const master = this.master;
    if (master === undefined) return;

    const intendedAttack = this.startAt + note.startSec;
    const intendedRelease = this.startAt + note.endSec;
    // A same-tick note-on/note-off is still represented in the raw plan, but it
    // intentionally has no synthesized duration.
    if (note.endSec === note.startSec) return;
    if (intendedRelease <= now) return;

    // The lead time and rolling lookahead keep normal attacks sample-timed at
    // intendedAttack. This fallback only applies after severe main-thread stalls.
    const attackAt = Math.max(intendedAttack, now + 0.005);
    const releaseAt = Math.max(intendedRelease, attackAt + 0.005);
    const stopAt = releaseAt + RELEASE_TAIL_SEC;
    const envelope = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    const peak = Math.max(0.0001, note.gain);
    const attackEnd = Math.min(attackAt + ATTACK_SEC, releaseAt);

    envelope.gain.setValueAtTime(0.0001, attackAt);
    envelope.gain.linearRampToValueAtTime(peak, attackEnd);
    envelope.gain.setTargetAtTime(Math.max(0.0001, peak * 0.24), attackEnd, 0.12);
    envelope.gain.setTargetAtTime(0.0001, releaseAt, 0.07);

    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(
      Math.min(12_000, Math.max(1_800, note.frequencyHz * 9 + note.velocity * 28)),
      attackAt,
    );
    filter.connect(envelope);
    envelope.connect(master);

    const harmonicPartials = [
      { ratio: 1, level: 1, type: 'triangle' as OscillatorType },
      { ratio: 2, level: 0.16, type: 'sine' as OscillatorType },
      { ratio: 3, level: 0.055, type: 'sine' as OscillatorType },
    ];
    const nyquist = this.context.sampleRate / 2;
    const oscillators: OscillatorNode[] = [];
    const partialGains: GainNode[] = [];

    for (const partial of harmonicPartials) {
      const frequency = note.frequencyHz * partial.ratio;
      if (frequency >= nyquist) continue;

      const oscillator = this.context.createOscillator();
      const partialGain = this.context.createGain();
      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(frequency, attackAt);
      partialGain.gain.value = partial.level;
      oscillator.connect(partialGain);
      partialGain.connect(filter);
      oscillator.start(attackAt);
      oscillator.stop(stopAt);
      oscillators.push(oscillator);
      partialGains.push(partialGain);
    }

    const voice: VoiceNodes = {
      oscillators,
      partialGains,
      filter,
      envelope,
      remainingOscillators: oscillators.length,
    };
    this.voices.add(voice);

    for (const oscillator of oscillators) {
      oscillator.onended = () => {
        voice.remainingOscillators -= 1;
        if (voice.remainingOscillators === 0) this.disconnectVoice(voice);
      };
    }
  }

  private disconnectVoice(voice: VoiceNodes): void {
    if (!this.voices.delete(voice)) return;

    for (const oscillator of voice.oscillators) oscillator.disconnect();
    for (const gain of voice.partialGains) gain.disconnect();
    voice.filter.disconnect();
    voice.envelope.disconnect();
  }

  private finish(naturalEnd: boolean): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.timer !== undefined) {
      globalThis.clearInterval(this.timer);
      this.timer = undefined;
    }

    for (const voice of [...this.voices]) {
      for (const oscillator of voice.oscillators) {
        oscillator.onended = null;
        try {
          oscillator.stop();
        } catch {
          // A source that already ended is safe to disconnect below.
        }
      }
      this.disconnectVoice(voice);
    }

    this.master?.disconnect();
    this.compressor?.disconnect();
    this.master = undefined;
    this.compressor = undefined;
    this.onFinished(this);

    if (naturalEnd && this.onEnded !== undefined) queueMicrotask(this.onEnded);
  }
}

let sharedContext: AudioContext | undefined;
let activeSession: BrowserAuditionSession | undefined;
let startGeneration = 0;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

function getAudioContext(): AudioContext {
  if (sharedContext?.state === 'closed') sharedContext = undefined;
  if (sharedContext !== undefined) return sharedContext;

  const Constructor = audioContextConstructor();
  if (Constructor === undefined) {
    throw new Error('Web Audio is not supported in this browser.');
  }

  sharedContext = new Constructor();
  return sharedContext;
}

function inertHandle(durationSec: number): AuditionHandle {
  return Object.freeze({ durationSec, stop: () => undefined });
}

/**
 * Start raw-timeline playback. A new call replaces the prior audition. The
 * callback fires only after natural completion, never after stop/replacement.
 */
export async function startAudition(
  notes: readonly AuditionInputNote[],
  onEnded?: () => void,
): Promise<AuditionHandle> {
  const plan = createAuditionPlan(notes);
  const generation = ++startGeneration;
  activeSession?.stop();
  activeSession = undefined;

  if (plan.notes.length === 0) {
    if (onEnded !== undefined) queueMicrotask(onEnded);
    return inertHandle(0);
  }

  const context = getAudioContext();
  if (context.state !== 'running') await context.resume();

  // Another click may have replaced this request while audio permission was
  // resolving. Such a stale request must never start or stop the newer source.
  if (generation !== startGeneration) return inertHandle(plan.durationSec);

  const session = new BrowserAuditionSession(
    context,
    plan,
    onEnded,
    (finished) => {
      if (activeSession === finished) activeSession = undefined;
    },
  );
  activeSession = session;
  session.start();
  return session.handle();
}
