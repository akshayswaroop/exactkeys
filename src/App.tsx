import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import {
  isRejection,
  odeToJoyMidi,
  performanceToMidi,
  transcribePerformance,
  transcribeLive,
  transcribeMidiBytes,
  type GridId,
  type PerformedNote,
  type Performance,
  type QuantizedNote,
  type Rejection,
  type StaffMode,
  type TimedMidiMessage,
  type Transcript,
  type TranscribeOptions,
} from './engine';
import { createAuditionPlan, startAudition, type AuditionHandle } from './audition';
import {
  fetchYouTubeAudio,
  retimeAudioDraftPerformance,
  transcribeYouTubePiano,
  type AudioDraftProgress,
} from './audioTranscription';

type SourceAsset =
  | { kind: 'file'; filename: string; bytes: Uint8Array }
  | { kind: 'live'; filename: string; messages: TimedMidiMessage[] }
  | { kind: 'audio'; filename: string; performance: Performance };

interface Configuration {
  grid: GridId;
  tempoBpm: string;
  meterOverride: boolean;
  meterNumerator: string;
  meterDenominator: string;
  staffMode: StaffMode;
  splitMidi: string;
  title: string;
}

type MidiSupportState = 'idle' | 'requesting' | 'ready' | 'unsupported' | 'denied';

const DEFAULT_CONFIGURATION: Configuration = {
  grid: '1/16',
  tempoBpm: '',
  meterOverride: false,
  meterNumerator: '4',
  meterDenominator: '4',
  staffMode: 'auto',
  splitMidi: '60',
  title: '',
};

const GRID_OPTIONS: Array<{ value: GridId; label: string }> = [
  { value: '1/4', label: 'Quarter' },
  { value: '1/8', label: 'Eighth' },
  { value: '1/8t', label: '8th triplet' },
  { value: '1/16', label: 'Sixteenth' },
  { value: '1/16t', label: '16th triplet' },
  { value: '1/32', label: '32nd' },
];

function configurationToOptions(config: Configuration): TranscribeOptions {
  const options: TranscribeOptions = {
    grid: config.grid,
    staffMode: config.staffMode,
    splitMidi: clampNumber(Number(config.splitMidi), 21, 108, 60),
  };
  const bpm = Number(config.tempoBpm);
  if (config.tempoBpm.trim() && Number.isFinite(bpm) && bpm > 0) options.tempoBpm = bpm;
  if (config.meterOverride) {
    options.timeSignature = {
      numerator: clampNumber(Number(config.meterNumerator), 1, 32, 4),
      denominator: clampNumber(Number(config.meterDenominator), 1, 32, 4),
    };
  }
  if (config.title.trim()) options.title = config.title.trim();
  return options;
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readMidiInputs(access: MIDIAccess): MIDIInput[] {
  const inputs: MIDIInput[] = [];
  access.inputs.forEach((input) => inputs.push(input));
  return inputs.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

function App() {
  const [config, setConfig] = useState<Configuration>(DEFAULT_CONFIGURATION);
  const [asset, setAsset] = useState<SourceAsset | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeAuthorized, setYoutubeAuthorized] = useState(false);
  const [youtubeProgress, setYoutubeProgress] = useState<AudioDraftProgress | null>(null);
  const [youtubeError, setYoutubeError] = useState('');
  const [youtubeAudioUrl, setYoutubeAudioUrl] = useState('');
  const youtubeGenerationRef = useRef(0);

  const [midiState, setMidiState] = useState<MidiSupportState>('idle');
  const [midiInputs, setMidiInputs] = useState<MIDIInput[]>([]);
  const [selectedMidiId, setSelectedMidiId] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [capturedCount, setCapturedCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveError, setLiveError] = useState('');
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const midiInitAttemptedRef = useRef(false);
  const liveMessagesRef = useRef<TimedMidiMessage[]>([]);
  const recordingStartedRef = useRef(0);

  const runAnalysis = useCallback((nextAsset: SourceAsset, nextConfig: Configuration) => {
    setNotice('');
    setRejection(null);
    try {
      const options = configurationToOptions(nextConfig);
      const output =
        nextAsset.kind === 'file'
          ? transcribeMidiBytes(nextAsset.bytes, nextAsset.filename, options)
          : nextAsset.kind === 'live'
            ? transcribeLive(nextAsset.messages, options)
            : transcribePerformance(
              retimeAudioDraftPerformance(
                nextAsset.performance,
                options.tempoBpm ?? 120,
                options.timeSignature ?? { numerator: 4, denominator: 4 },
              ),
              options,
            );
      if (isRejection(output)) {
        setTranscript(null);
        setRejection(output);
        return;
      }
      setTranscript(output);
    } catch (error) {
      setTranscript(null);
      setRejection({
        rejected: true,
        filename: nextAsset.filename,
        code: 'malformed-midi',
        reason: error instanceof Error ? error.message : 'The MIDI file could not be parsed safely.',
        approach: 'Standard MIDI event parsing',
        publishedCeiling: 'No transcript produced from malformed input',
      });
    }
  }, []);

  const ingestFile = useCallback(
    async (file: File) => {
      setIsReading(true);
      setNotice('');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const nextAsset: SourceAsset = { kind: 'file', filename: file.name, bytes };
        const nextConfig = {
          ...config,
          title: filenameBase(file.name),
        };
        setConfig(nextConfig);
        setAsset(nextAsset);
        runAnalysis(nextAsset, nextConfig);
      } catch (error) {
        setTranscript(null);
        setRejection({
          rejected: true,
          filename: file.name,
          code: 'malformed-midi',
          reason: error instanceof Error ? error.message : 'The selected file could not be read.',
          approach: 'local file ingest',
          publishedCeiling: 'No transcript produced',
        });
      } finally {
        setIsReading(false);
      }
    },
    [config, runAnalysis],
  );

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void ingestFile(file);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void ingestFile(file);
  };

  const loadExample = () => {
    const nextConfig: Configuration = {
      ...DEFAULT_CONFIGURATION,
      title: 'Ode to Joy — verified example',
    };
    const nextAsset: SourceAsset = {
      kind: 'file',
      filename: 'ode-to-joy.mid',
      bytes: odeToJoyMidi(),
    };
    setConfig(nextConfig);
    setAsset(nextAsset);
    runAnalysis(nextAsset, nextConfig);
  };

  const importYouTube = async () => {
    const generation = ++youtubeGenerationRef.current;
    setYoutubeError('');
    if (!youtubeAuthorized) {
      setYoutubeError('Confirm that you have permission to process this video.');
      return;
    }
    if (!youtubeUrl.trim()) {
      setYoutubeError('Paste a direct YouTube video URL.');
      return;
    }
    setYoutubeProgress({ stage: 'downloading', progress: 0.01, detail: 'Downloading one audio stream locally' });
    try {
      const audio = await fetchYouTubeAudio(youtubeUrl.trim());
      if (generation !== youtubeGenerationRef.current) return;
      const nextConfig: Configuration = {
        ...config,
        title: audio.title,
        tempoBpm: config.tempoBpm.trim() || '120',
        meterOverride: true,
      };
      setConfig(nextConfig);
      const result = await transcribeYouTubePiano(audio, configurationToOptions(nextConfig), (progress) => {
        if (generation === youtubeGenerationRef.current) setYoutubeProgress(progress);
      });
      if (generation !== youtubeGenerationRef.current) {
        URL.revokeObjectURL(result.audioUrl);
        return;
      }
      if (youtubeAudioUrl) URL.revokeObjectURL(youtubeAudioUrl);
      setYoutubeAudioUrl(result.audioUrl);
      const nextAsset: SourceAsset = {
        kind: 'audio',
        filename: `${safeFilename(audio.title)}.youtube-audio`,
        performance: result.transcript.performance,
      };
      setAsset(nextAsset);
      setTranscript(result.transcript);
      setRejection(null);
      setNotice('YouTube audio was transcribed as an uncertified draft. Listen and correct it before relying on the notation.');
    } catch (error) {
      if (generation !== youtubeGenerationRef.current) return;
      setYoutubeProgress(null);
      setYoutubeError(error instanceof Error ? error.message : 'YouTube piano transcription failed.');
    }
  };

  useEffect(() => () => {
    youtubeGenerationRef.current += 1;
    if (youtubeAudioUrl) URL.revokeObjectURL(youtubeAudioUrl);
  }, [youtubeAudioUrl]);

  const rerun = () => {
    if (!asset) return;
    if (asset.kind === 'live' && !hasExplicitLiveTiming(config)) {
      setNotice('Live captures require an explicit BPM and time signature before certification.');
      return;
    }
    runAnalysis(asset, config);
  };

  const connectMidi = async () => {
    setLiveError('');
    if (!navigator.requestMIDIAccess) {
      setMidiState('unsupported');
      return;
    }
    setMidiState('requesting');
    try {
      const access = await navigator.requestMIDIAccess();
      midiAccessRef.current = access;
      const inputs = readMidiInputs(access);
      setMidiInputs(inputs);
      setSelectedMidiId((current) =>
        inputs.some((input) => input.id === current) ? current : (inputs[0]?.id ?? ''),
      );
      access.onstatechange = () => {
        const next = readMidiInputs(access);
        setMidiInputs(next);
        setSelectedMidiId((current) =>
          next.some((input) => input.id === current) ? current : (next[0]?.id ?? ''),
        );
      };
      setMidiState('ready');
    } catch (error) {
      setMidiState('denied');
      setLiveError(error instanceof Error ? error.message : 'MIDI access was not granted.');
    }
  };

  useEffect(() => {
    if (midiInitAttemptedRef.current) return;
    midiInitAttemptedRef.current = true;
    void connectMidi();
  }, []);

  const startCapture = async () => {
    setLiveError('');
    if (!hasExplicitLiveTiming(config)) {
      setLiveError('Enter an explicit BPM and enable a meter override before recording.');
      return;
    }
    const input = midiAccessRef.current?.inputs.get(selectedMidiId);
    if (!input || input.state === 'disconnected') {
      setLiveError('Choose a connected MIDI input first.');
      return;
    }
    try {
      await input.open?.();
      liveMessagesRef.current = [];
      setCapturedCount(0);
      setElapsedMs(0);
      recordingStartedRef.current = performance.now();
      input.onmidimessage = (event) => {
        if (!event.data) return;
        const bytes = Array.from(event.data);
        if (bytes.length === 0) return;
        liveMessagesRef.current.push({ tMs: event.timeStamp, data: bytes });
        setCapturedCount(liveMessagesRef.current.length);
      };
      setIsRecording(true);
      setNotice('');
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : 'The MIDI input could not be opened.');
    }
  };

  const stopCapture = () => {
    const input = midiAccessRef.current?.inputs.get(selectedMidiId);
    if (input) input.onmidimessage = null;
    setIsRecording(false);
    const messages = [...liveMessagesRef.current];
    if (messages.length === 0) {
      setLiveError('No MIDI messages arrived. Check the selected input and play a short phrase.');
      return;
    }
    const nextAsset: SourceAsset = {
      kind: 'live',
      filename: 'live-piano-take.mid',
      messages,
    };
    const nextConfig = {
      ...config,
      title: config.title.trim() || 'Live piano take',
    };
    setConfig(nextConfig);
    setAsset(nextAsset);
    runAnalysis(nextAsset, nextConfig);
  };

  useEffect(() => {
    if (!isRecording) return undefined;
    const timer = window.setInterval(() => {
      setElapsedMs(performance.now() - recordingStartedRef.current);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(
    () => () => {
      const access = midiAccessRef.current;
      access?.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
      if (access) access.onstatechange = null;
    },
    [],
  );

  const selectedMidi = midiInputs.find((input) => input.id === selectedMidiId);
  const sourceName = asset?.filename ?? '';

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ExactKeys home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>ExactKeys</strong>
            <small>evidence-first piano transcription</small>
          </span>
        </a>
        <div className="header-proof" aria-label="Product constraints">
          <span><i className="proof-dot" /> 99% score gate</span>
          <span>Local processing</span>
          <a href="#method">Method</a>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow"><span>01</span> Deterministic input. Defensible output.</p>
            <h1 id="hero-title">A piano transcript that knows when to say <em>no.</em></h1>
            <p className="lede">
              ExactKeys certifies MIDI performances only when pitch, onset, and duration evidence
              clears a strict 99% gate. Piano-only audio can now produce a clearly marked draft.
            </p>
            <div className="principle-row">
              <div><b>100%</b><span>MIDI pitch identity</span></div>
              <div><b>≥99%</b><span>required grid fit</span></div>
              <div><b>DRAFT</b><span>YouTube piano inference</span></div>
            </div>
          </div>

          <div className="ingest-card">
            <div className="card-kicker">
              <span>Start with evidence</span>
              <span className="local-pill">● stays local</span>
            </div>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              accept=".mid,.midi,audio/midi,audio/x-midi"
              onChange={onFileInput}
              data-testid="file-input"
            />
            <button
              className={`drop-zone${isDragging ? ' is-dragging' : ''}`}
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              data-testid="drop-zone"
            >
              <span className="upload-icon" aria-hidden="true"><UploadIcon /></span>
              <strong>{isReading ? 'Reading MIDI…' : 'Drop a MIDI performance'}</strong>
              <span>or click to choose .mid or .midi</span>
              <small>MIDI follows the strict certificate path. YouTube audio uses the draft path below.</small>
            </button>
            <div className="ingest-actions">
              <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                Choose MIDI <ArrowIcon />
              </button>
              <button className="text-button" type="button" onClick={loadExample} data-testid="load-example">
                Load verified example
              </button>
            </div>
            <div className="youtube-import" data-testid="youtube-import">
              <div className="youtube-heading">
                <div><span>YouTube piano</span><small>Probabilistic draft · never 99% certified</small></div>
                <b>LOCAL MODEL</b>
              </div>
              <label className="youtube-url-field">
                <span className="visually-hidden">YouTube video URL</span>
                <input
                  type="url"
                  value={youtubeUrl}
                  onChange={(event) => setYoutubeUrl(event.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  disabled={Boolean(youtubeProgress && youtubeProgress.progress < 1)}
                  data-testid="youtube-url"
                />
                <button
                  type="button"
                  onClick={() => void importYouTube()}
                  disabled={Boolean(youtubeProgress && youtubeProgress.progress < 1)}
                  data-testid="youtube-transcribe"
                >
                  {youtubeProgress && youtubeProgress.progress < 1 ? `${Math.round(youtubeProgress.progress * 100)}%` : 'Make draft'}
                </button>
              </label>
              <label className="youtube-rights">
                <input type="checkbox" checked={youtubeAuthorized} onChange={(event) => setYoutubeAuthorized(event.target.checked)} />
                <span>I have permission to process this video. Single piano, ≤10 minutes.</span>
              </label>
              {youtubeProgress && (
                <div className="youtube-progress" aria-live="polite">
                  <i style={{ width: `${Math.max(2, youtubeProgress.progress * 100)}%` }} />
                  <span>{youtubeProgress.detail}</span>
                </div>
              )}
              {youtubeError && <p className="youtube-error" role="alert">{youtubeError}</p>}
              {youtubeAudioUrl && (
                <audio className="youtube-source-audio" controls preload="metadata" src={youtubeAudioUrl} data-testid="youtube-source-audio">
                  Your browser cannot play this YouTube audio stream.
                </audio>
              )}
            </div>
          </div>
        </section>

        <section className="workbench" aria-label="Transcription workbench">
          <div className="section-heading">
            <div>
              <p className="eyebrow"><span>02</span> Shape the score contract</p>
              <h2>Certification setup</h2>
            </div>
            {asset && (
              <div className="source-chip" title={sourceName}>
                <FileIcon />
                <span>{sourceName}</span>
                <b>{asset.kind === 'live' ? 'LIVE MIDI' : asset.kind === 'audio' ? 'AUDIO DRAFT' : 'SMF'}</b>
              </div>
            )}
          </div>

          <div className="workbench-grid">
            <ConfigurationPanel config={config} setConfig={setConfig} onRun={rerun} hasAsset={Boolean(asset)} />

            <div className="analysis-stage" aria-live="polite">
              {notice && <div className="inline-notice">{notice}</div>}
              {rejection ? (
                <RejectionPanel rejection={rejection} onChoose={() => fileInputRef.current?.click()} />
              ) : transcript ? (
                <CertificatePanel transcript={transcript} />
              ) : (
                <EmptyAnalysis onExample={loadExample} />
              )}
            </div>
          </div>
        </section>

        {transcript && <DraftAudition notes={transcript.performance.notes} sourceName={sourceName} />}

        {transcript && (
          <TranscriptWorkspace transcript={transcript} config={config} sourceName={sourceName} />
        )}

        <section className="live-section" aria-labelledby="live-title">
          <div className="live-intro">
            <p className="eyebrow eyebrow-light"><span>03</span> Direct from the instrument</p>
            <h2 id="live-title">Capture the performance before it becomes a waveform.</h2>
            <p>
              Connect a digital piano over USB or Bluetooth MIDI. Exact event messages retain pitch,
              velocity, timing, and pedal data without acoustic inference.
            </p>
            <ol className="live-steps">
              <li><b>1</b><span>Enter BPM and enable meter above</span></li>
              <li><b>2</b><span>Grant browser MIDI access</span></li>
              <li><b>3</b><span>Record, release the final keys, then stop</span></li>
            </ol>
          </div>

          <div className="live-console">
            <div className="console-topline">
              <span className={`connection-light ${midiState === 'ready' ? 'is-ready' : ''}`} />
              <span>{midiStateLabel(midiState, midiInputs.length)}</span>
              {isRecording && <b className="recording-label">REC</b>}
            </div>

            {midiState !== 'ready' ? (
              <div className="connect-state">
                <MidiPortIcon />
                <h3>Web MIDI input</h3>
                <p>
                  {midiState === 'unsupported'
                    ? 'This browser does not expose Web MIDI. Use a Chromium-based browser or upload a MIDI file.'
                    : midiState === 'denied'
                      ? 'MIDI permission was not granted. Update the site permission and try again.'
                      : 'Connect your piano, then let ExactKeys inspect the available MIDI inputs.'}
                </p>
                <button
                  className="light-button"
                  type="button"
                  onClick={() => void connectMidi()}
                  disabled={midiState === 'requesting' || midiState === 'unsupported'}
                  data-testid="enable-midi"
                >
                  {midiState === 'requesting' ? 'Requesting access…' : 'Enable MIDI access'}
                </button>
              </div>
            ) : (
              <div className="recorder">
                <label className="dark-field">
                  <span>Input device</span>
                  <select
                    value={selectedMidiId}
                    onChange={(event) => setSelectedMidiId(event.target.value)}
                    disabled={isRecording}
                    data-testid="midi-device-select"
                  >
                    {midiInputs.length === 0 && <option value="">No MIDI inputs detected</option>}
                    {midiInputs.map((input) => (
                      <option key={input.id} value={input.id}>
                        {[input.manufacturer, input.name].filter(Boolean).join(' · ') || input.id}
                      </option>
                    ))}
                  </select>
                </label>

                {midiInputs.length === 0 && (
                  <button className="midi-retry" type="button" onClick={() => void connectMidi()}>
                    Retry device discovery
                  </button>
                )}

                <div className="device-readout">
                  <div>
                    <span>Device</span>
                    <strong>{selectedMidi?.name ?? 'Waiting for input'}</strong>
                  </div>
                  <div>
                    <span>Timing contract</span>
                    <strong>
                      {hasExplicitLiveTiming(config)
                        ? `${config.tempoBpm} BPM · ${config.meterNumerator}/${config.meterDenominator}`
                        : 'BPM + meter required'}
                    </strong>
                  </div>
                </div>

                <div className="record-clock">
                  <span>{formatElapsed(elapsedMs)}</span>
                  <small>{capturedCount.toLocaleString()} MIDI messages</small>
                </div>

                {!isRecording ? (
                  <button
                    className="record-button"
                    type="button"
                    onClick={() => void startCapture()}
                    disabled={!selectedMidiId || !hasExplicitLiveTiming(config)}
                    data-testid="live-start"
                  >
                    <i /> Start capture
                  </button>
                ) : (
                  <button className="stop-button" type="button" onClick={stopCapture} data-testid="live-stop">
                    <i /> Stop &amp; certify
                  </button>
                )}
              </div>
            )}
            {liveError && <p className="console-error" role="alert">{liveError}</p>}
          </div>
        </section>

        <section className="method-section" id="method" aria-labelledby="method-title">
          <div>
            <p className="eyebrow"><span>04</span> The refusal is a feature</p>
            <h2 id="method-title">No confidence theatre.</h2>
          </div>
          <div className="method-copy">
            <p>
              Audio transcription is an inference problem: overlapping harmonics, room acoustics,
              pedal resonance, and release timing create ambiguity. ExactKeys therefore separates
              probabilistic YouTube drafts from deterministic instrument events; only supported MIDI
              evidence can earn a certificate.
            </p>
            <div className="method-rule">
              <span>MIDI evidence</span><b>→</b><span>Strict audit</span><b>→</b><span>Certified score or abstention</span>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <div className="footer-brand">ExactKeys</div>
        <p>Runs entirely in your browser. No performance leaves this device.</p>
        <p className="mono">score-note-v1 · threshold 0.9900</p>
      </footer>
    </div>
  );
}

type AuditionStatus = 'idle' | 'starting' | 'playing' | 'error';

function DraftAudition({ notes, sourceName }: { notes: PerformedNote[]; sourceName: string }) {
  const plan = useMemo(() => createAuditionPlan(notes), [notes]);
  const [status, setStatus] = useState<AuditionStatus>('idle');
  const [error, setError] = useState('');
  const handleRef = useRef<AuditionHandle | null>(null);
  const sessionRef = useRef(0);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const referenceAudioRef = useRef<HTMLAudioElement>(null);
  const referenceUrlRef = useRef<string | null>(null);
  const [reference, setReference] = useState<{ name: string; url: string } | null>(null);
  const [referenceError, setReferenceError] = useState('');

  const stopSynth = useCallback((reflectState: boolean) => {
    sessionRef.current += 1;
    handleRef.current?.stop();
    handleRef.current = null;
    if (reflectState) {
      setStatus('idle');
      setError('');
    }
  }, []);

  useEffect(() => {
    stopSynth(false);
    referenceAudioRef.current?.pause();
    setStatus('idle');
    setError('');
    return () => stopSynth(false);
  }, [notes, stopSynth]);

  useEffect(
    () => () => {
      referenceAudioRef.current?.pause();
      if (referenceUrlRef.current) URL.revokeObjectURL(referenceUrlRef.current);
      referenceUrlRef.current = null;
    },
    [],
  );

  const playSynth = async () => {
    if (plan.notes.length === 0 || status === 'starting') return;
    referenceAudioRef.current?.pause();
    stopSynth(false);
    const session = ++sessionRef.current;
    setStatus('starting');
    setError('');
    try {
      const handle = await startAudition(notes, () => {
        if (session !== sessionRef.current) return;
        handleRef.current = null;
        setStatus('idle');
      });
      if (session !== sessionRef.current) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
      setStatus('playing');
    } catch (caught) {
      if (session !== sessionRef.current) return;
      handleRef.current = null;
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'This browser could not start local audio playback.');
    }
  };

  const chooseReference = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    referenceAudioRef.current?.pause();
    const oldUrl = referenceUrlRef.current;
    const url = URL.createObjectURL(file);
    referenceUrlRef.current = url;
    setReference({ name: file.name, url });
    setReferenceError('');
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  };

  const clearReference = () => {
    referenceAudioRef.current?.pause();
    const url = referenceUrlRef.current;
    referenceUrlRef.current = null;
    setReference(null);
    setReferenceError('');
    if (url) URL.revokeObjectURL(url);
  };

  const nothingToPlay = plan.notes.length === 0;
  const auditionActive = status === 'starting' || status === 'playing';
  const buttonLabel = nothingToPlay
    ? 'Nothing to play'
    : auditionActive
      ? 'Stop draft'
      : 'Play draft';

  return (
    <section className="draft-audition-section" aria-labelledby="draft-audition-title" data-testid="draft-audition">
      <div className="draft-audition-inner">
        <div className="draft-audition-copy">
          <p className="draft-label"><span>Draft audition</span><b>Not certified</b></p>
          <h2 id="draft-audition-title">Listen to parsed note events.</h2>
          <p>
            A local synth preview using raw performance timing. Playback sits outside the 99% score
            gate and never becomes certification; any audio-derived exports remain explicitly uncertified.
          </p>
          <div className="draft-facts">
            <span><b>{plan.notes.length.toLocaleString()}</b> pitched note events</span>
            <span><b>{formatElapsed(plan.durationSec * 1000)}</b> raw duration</span>
            <span title={sourceName}><b>Source</b> {sourceName || 'current performance'}</span>
            <span><b>Draft limitation</b> sustain / controller semantics not rendered</span>
          </div>
        </div>

        <div className="draft-audition-controls">
          <div className="draft-play-row">
            <button
              className={`draft-play-button${auditionActive ? ' is-playing' : ''}`}
              type="button"
              onClick={() => auditionActive ? stopSynth(true) : void playSynth()}
              disabled={nothingToPlay}
              data-testid="draft-audition-toggle"
            >
              {auditionActive ? <StopIcon /> : <PlayIcon />}
              {buttonLabel}
            </button>
            <span className={`draft-status is-${status}`} aria-live="polite" data-testid="draft-audition-status">
              <i />
              {nothingToPlay
                ? 'No pitched performance notes are available'
                : status === 'playing'
                  ? 'Playing locally'
                  : status === 'starting'
                    ? 'Preparing Web Audio'
                    : status === 'error'
                      ? 'Playback unavailable'
                      : 'Ready for local playback'}
            </span>
          </div>
          {error && <p className="draft-error" role="alert">{error}</p>}

          <div className="reference-audio">
            <div className="reference-heading">
              <div>
                <span>Original reference</span>
                <small>Optional local A/B listening only — never analyzed</small>
              </div>
              <input
                ref={referenceInputRef}
                className="visually-hidden"
                type="file"
                accept="audio/*,.wav,.wave,.mp3,.m4a,.aac,.flac,.ogg,.opus,.aiff,.aif"
                onChange={chooseReference}
                data-testid="reference-audio-input"
              />
              <button type="button" onClick={() => referenceInputRef.current?.click()}>
                {reference ? 'Replace' : 'Choose audio'}
              </button>
            </div>
            {reference && (
              <div className="reference-player">
                <span title={reference.name}>{reference.name}</span>
                <audio
                  ref={referenceAudioRef}
                  controls
                  preload="metadata"
                  src={reference.url}
                  onPlay={() => stopSynth(true)}
                  onError={() => setReferenceError('This browser could not play the selected reference audio.')}
                  data-testid="reference-audio-player"
                >
                  Your browser does not support local audio playback.
                </audio>
                <button type="button" onClick={clearReference} aria-label="Remove original reference audio">Remove</button>
              </div>
            )}
            {referenceError && <p className="reference-error" role="alert">{referenceError}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function ConfigurationPanel({
  config,
  setConfig,
  onRun,
  hasAsset,
}: {
  config: Configuration;
  setConfig: (config: Configuration) => void;
  onRun: () => void;
  hasAsset: boolean;
}) {
  const update = <K extends keyof Configuration>(key: K, value: Configuration[K]) => {
    setConfig({ ...config, [key]: value });
  };

  return (
    <aside className="config-panel">
      <div className="panel-title">
        <div>
          <span className="panel-number">A</span>
          <h3>Score assumptions</h3>
        </div>
        <small>Re-run after changes</small>
      </div>

      <label className="field field-wide">
        <span>Score title</span>
        <input
          value={config.title}
          onChange={(event) => update('title', event.target.value)}
          placeholder="Use the source filename"
          data-testid="title-input"
        />
      </label>

      <label className="field field-wide">
        <span>Smallest notation grid</span>
        <select
          value={config.grid}
          onChange={(event) => update('grid', event.target.value as GridId)}
          data-testid="grid-select"
        >
          {GRID_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.value})</option>
          ))}
        </select>
        <small>Finer grids preserve more timing detail but may reduce readability.</small>
      </label>

      <div className="field-pair">
        <label className="field">
          <span>Tempo override</span>
          <span className="input-suffix">
            <input
              inputMode="decimal"
              value={config.tempoBpm}
              onChange={(event) => update('tempoBpm', event.target.value)}
              placeholder="Auto"
              aria-label="Tempo override in beats per minute"
              data-testid="tempo-input"
            />
            <b>BPM</b>
          </span>
        </label>
        <label className="field">
          <span>Staff source</span>
          <select
            value={config.staffMode}
            onChange={(event) => update('staffMode', event.target.value as StaffMode)}
            aria-label="Staff assignment source"
            data-testid="staff-mode-select"
          >
            <option value="auto">Auto: preserve 2 tracks</option>
            <option value="track">Require 2 hand tracks</option>
            <option value="pitch">Pitch split only</option>
          </select>
        </label>
      </div>

      <label className="field field-wide">
          <span>Fallback hand split</span>
          <span className="input-suffix">
            <input
              type="number"
              min="21"
              max="108"
              value={config.splitMidi}
              onChange={(event) => update('splitMidi', event.target.value)}
              aria-label="Hand split MIDI note"
              data-testid="split-input"
            />
            <b>{pitchName(clampNumber(Number(config.splitMidi), 21, 108, 60))}</b>
          </span>
          <small>Used for one-track MIDI, or whenever “Pitch split only” is selected.</small>
      </label>

      <div className="meter-box">
        <label className="switch-row">
          <span>
            <b>Override time signature</b>
            <small>Leave off to trust MIDI metadata</small>
          </span>
          <input
            type="checkbox"
            checked={config.meterOverride}
            onChange={(event) => update('meterOverride', event.target.checked)}
            data-testid="meter-toggle"
          />
          <i aria-hidden="true" />
        </label>
        <div className={`meter-fields${config.meterOverride ? '' : ' is-disabled'}`}>
          <input
            type="number"
            min="1"
            max="32"
            value={config.meterNumerator}
            onChange={(event) => update('meterNumerator', event.target.value)}
            disabled={!config.meterOverride}
            aria-label="Time signature numerator"
          />
          <b>/</b>
          <select
            value={config.meterDenominator}
            onChange={(event) => update('meterDenominator', event.target.value)}
            disabled={!config.meterOverride}
            aria-label="Time signature denominator"
          >
            {[2, 4, 8, 16].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </div>

      <button
        className="run-button"
        type="button"
        onClick={onRun}
        disabled={!hasAsset}
        data-testid="analyze-button"
      >
        Run certification audit <ArrowIcon />
      </button>
      <p className="config-note"><LockIcon /> Changing assumptions never lowers the fixed 99% threshold.</p>
    </aside>
  );
}

function EmptyAnalysis({ onExample }: { onExample: () => void }) {
  return (
    <div className="empty-analysis" data-testid="empty-analysis">
      <div className="empty-score" aria-hidden="true">
        <span>𝄞</span>
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <p className="eyebrow"><span>B</span> Evidence report</p>
      <h3>Your certificate will appear here.</h3>
      <p>Load a Standard MIDI file to audit note-event integrity, grid fit, score fidelity, and metadata sources.</p>
      <button className="outline-button" type="button" onClick={onExample}>Preview a passing certificate</button>
      <div className="empty-checks">
        <span><CheckIcon /> Event identity</span>
        <span><CheckIcon /> Joint timing fit</span>
        <span><CheckIcon /> Round-trip score fidelity</span>
      </div>
    </div>
  );
}

function RejectionPanel({ rejection, onChoose }: { rejection: Rejection; onChoose: () => void }) {
  return (
    <div className="rejection-panel" role="alert" data-testid="rejection-card">
      <div className="rejection-icon"><ShieldXIcon /></div>
      <p className="eyebrow danger-eyebrow"><span>REFUSED</span> No uncertain output generated</p>
      <h3>{rejection.code === 'audio-below-threshold' ? 'Audio cannot clear this contract.' : 'This input cannot be certified.'}</h3>
      <p>{rejection.reason}</p>
      <dl>
        <div><dt>Input</dt><dd>{rejection.filename || 'unnamed file'}</dd></div>
        <div><dt>Discarded approach</dt><dd>{rejection.approach}</dd></div>
        <div><dt>Evidence ceiling</dt><dd>{rejection.publishedCeiling}</dd></div>
      </dl>
      <button className="primary-button" type="button" onClick={onChoose}>Choose Standard MIDI <ArrowIcon /></button>
    </div>
  );
}

function CertificatePanel({ transcript }: { transcript: Transcript }) {
  const { gate, performance, warnings } = transcript;
  const jointFit = finiteOrUndefined(gate.jointFitRate) ?? Math.min(gate.onsetFitRate, gate.durationFitRate);
  const fidelity = gate.scoreFidelityEvaluated ? finiteOrUndefined(gate.scoreFidelityRate) : undefined;
  const eventAccuracy = finiteOrUndefined(transcript.eventVerification?.accuracy);
  const reasons = gate.reasons ?? [];
  const reasonCodes = gate.reasonCodes ?? [];
  const certified = gate.certified;
  const hasNotes = gate.noteCount > 0;
  const isAudioDraft = performance.source === 'audio-draft';

  return (
    <article className={`certificate ${certified ? 'is-certified' : 'is-abstained'}`} data-testid="certificate-status">
      <div className="certificate-head">
        <div className="seal" aria-hidden="true">{certified ? <ShieldCheckIcon /> : <ShieldXIcon />}</div>
        <div>
          <p>{certified ? 'Certification issued' : isAudioDraft ? 'Probabilistic audio inference' : 'Fail-closed abstention'}</p>
          <h3>{certified ? 'Score cleared for export' : isAudioDraft ? 'Draft generated — review required' : 'Score intentionally withheld'}</h3>
        </div>
        <span className="status-stamp">{certified ? 'CERTIFIED' : isAudioDraft ? 'AUDIO DRAFT' : 'ABSTAINED'}</span>
      </div>

      <div className="metric-grid">
        <Metric
          label="Joint grid fit"
          value={hasNotes ? percentage(jointFit) : '—'}
          detail={hasNotes ? isAudioDraft ? 'event-grid diagnostic only' : `minimum ${percentage(gate.threshold)}` : 'no note events'}
          pass={hasNotes && jointFit >= gate.threshold}
          neutral={!hasNotes}
        />
        <Metric
          label="Onset fit"
          value={hasNotes ? percentage(gate.onsetFitRate) : '—'}
          detail={hasNotes ? `${gate.onsetMisfits} outside tolerance` : 'no note events'}
          pass={hasNotes && gate.onsetFitRate >= gate.threshold}
          neutral={!hasNotes}
        />
        <Metric
          label="Duration fit"
          value={hasNotes ? percentage(gate.durationFitRate) : '—'}
          detail={hasNotes ? `${gate.durationMisfits} outside tolerance` : 'no note events'}
          pass={hasNotes && gate.durationFitRate >= gate.threshold}
          neutral={!hasNotes}
        />
        <Metric
          label="Score fidelity"
          value={fidelity === undefined ? '—' : percentage(fidelity)}
          detail={fidelity === undefined ? 'not evaluated' : 'canonical round trip'}
          pass={fidelity !== undefined && fidelity >= gate.threshold}
          neutral={fidelity === undefined}
        />
      </div>

      <div className="certificate-facts">
        <div><span>Notes audited</span><b>{gate.noteCount.toLocaleString()}</b></div>
        <div><span>{isAudioDraft ? 'Audio accuracy' : 'Event recovery'}</span><b>{isAudioDraft || !hasNotes || eventAccuracy === undefined ? '—' : percentage(eventAccuracy)}</b></div>
        <div><span>Grid</span><b>{gate.grid}</b></div>
        <div><span>Tempo</span><b>{formatNumber(gate.tempoBpm, 2)} BPM <em>{sourceLabel(gate.tempoSource)}</em></b></div>
        <div><span>Meter</span><b>{gate.timeSignature.numerator}/{gate.timeSignature.denominator} <em>{sourceLabel(gate.timeSignatureSource)}</em></b></div>
        <div><span>Key source</span><b>{sourceLabel(gate.keySource)}</b></div>
      </div>

      {!certified && (
        <div className="reason-box">
          <h4><AlertIcon /> Why notation was withheld</h4>
          <ul>
            {reasons.length > 0
              ? reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)
              : <li>A certification invariant did not pass. No score artifact was created.</li>}
          </ul>
          {reasonCodes.length > 0 && (
            <div className="reason-codes">{reasonCodes.map((code) => <code key={code}>{code}</code>)}</div>
          )}
        </div>
      )}

      {(warnings.length > 0 || performance.integrity) && (
        <details className="audit-details">
          <summary>Warnings &amp; event-integrity details</summary>
          {warnings.length > 0 && <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          {performance.integrity && (
            <div className="integrity-grid">
              <span>Unmatched note-ons <b>{performance.integrity.unmatchedNoteOns}</b></span>
              <span>Unmatched note-offs <b>{performance.integrity.unmatchedNoteOffs}</b></span>
              <span>Same-pitch overlaps <b>{performance.integrity.overlappingSamePitch}</b></span>
              <span>Pitch bends <b>{performance.integrity.pitchBendEvents}</b></span>
              <span>Aftertouch events <b>{performance.integrity.aftertouchEvents}</b></span>
              <span>Percussion notes <b>{performance.integrity.percussionNoteEvents}</b></span>
              <span>Unsupported controls <b>{performance.integrity.unsupportedControlEvents}</b></span>
              <span>SysEx events <b>{performance.integrity.sysexEvents}</b></span>
            </div>
          )}
        </details>
      )}
    </article>
  );
}

function Metric({
  label,
  value,
  detail,
  pass,
  neutral = false,
}: {
  label: string;
  value: string;
  detail: string;
  pass: boolean;
  neutral?: boolean;
}) {
  return (
    <div className={`metric ${neutral ? 'is-neutral' : pass ? 'is-pass' : 'is-fail'}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small><i /> {detail}</small>
    </div>
  );
}

function TranscriptWorkspace({
  transcript,
  config,
  sourceName,
}: {
  transcript: Transcript;
  config: Configuration;
  sourceName: string;
}) {
  const [tableFilter, setTableFilter] = useState<'all' | 'misfits'>('all');
  const filteredNotes = useMemo(
    () => transcript.quantized.filter((note) => tableFilter === 'all' || !note.onsetFit || !note.durationFit),
    [tableFilter, transcript.quantized],
  );
  const tableNotes = filteredNotes.slice(0, 500);
  const basename = safeFilename(filenameBase(sourceName || transcript.performance.filename || 'exactkeys'));
  const isAudioDraft = transcript.performance.source === 'audio-draft';
  const availableMusicxml = isAudioDraft ? transcript.draftMusicxml : transcript.musicxml;

  const exportMusicXml = () => {
    if (!availableMusicxml || (!isAudioDraft && !transcript.gate.certified)) return;
    downloadBlob(
      `${basename}${isAudioDraft ? '.uncertified' : ''}.musicxml`,
      availableMusicxml,
      'application/vnd.recordare.musicxml+xml',
    );
  };

  const exportMidi = () => {
    if (!isAudioDraft && !transcript.eventVerification.verified) return;
    downloadBytes(
      `${basename}.${isAudioDraft ? 'uncertified' : 'normalized'}.mid`,
      performanceToMidi(transcript.performance),
      'audio/midi',
    );
  };

  const exportAudit = () => {
    const payload = {
      schema: 'exactkeys-audit-v1',
      generatedAt: new Date().toISOString(),
      source: {
        filename: sourceName || transcript.performance.filename,
        type: transcript.performance.source,
        durationSec: transcript.performance.durationSec,
        ticksPerQuarter: transcript.performance.ticksPerQuarter,
      },
      requestedOptions: configurationToOptions(config),
      certification: transcript.gate,
      eventVerification: transcript.eventVerification,
      integrity: transcript.performance.integrity,
      warnings: transcript.warnings,
      noteEvents: transcript.performance.notes,
      quantizedNotes: transcript.quantized,
    };
    downloadBlob(`${basename}.audit.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const exportCsv = () => {
    if (!isAudioDraft && !transcript.gate.certified) return;
    const header = [
      'id', 'pitch', 'note', 'staff', 'velocity', 'onset_beats', 'duration_beats',
      'onset_seconds', 'duration_seconds', 'onset_error_beats', 'duration_error_beats',
      'onset_fit', 'duration_fit',
    ];
    const rows = transcript.quantized.map((note) => [
      note.id,
      note.pitch,
      note.spelled.name,
      note.staff === 1 ? 'treble' : 'bass',
      note.velocity,
      note.onsetBeats,
      note.durationBeats,
      note.onsetSec,
      note.durationSec,
      note.onsetErrorBeats,
      note.durationErrorBeats,
      note.onsetFit,
      note.durationFit,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    downloadBlob(`${basename}${isAudioDraft ? '.uncertified' : ''}.notes.csv`, csv, 'text/csv;charset=utf-8');
  };

  return (
    <section className="transcript-workspace" aria-labelledby="transcript-title">
      <div className="section-heading workspace-heading">
        <div>
          <p className="eyebrow"><span>RESULT</span> Inspect every decision</p>
          <h2 id="transcript-title">Performance map</h2>
        </div>
        <div className="roll-legend" aria-label="Piano roll legend">
          <span><i className="treble-swatch" /> Treble</span>
          <span><i className="bass-swatch" /> Bass</span>
          <span><i className="misfit-swatch" /> Outside tolerance</span>
        </div>
      </div>

      <PianoRoll notes={transcript.quantized} meter={transcript.gate.timeSignature} />

      <div className="export-strip" aria-label="Transcript exports">
        <div className="export-copy">
          <span className="panel-number">C</span>
          <div>
            <h3>{isAudioDraft ? 'Export unverified draft' : 'Export evidence'}</h3>
            <p>{isAudioDraft ? 'Listen and correct these inferred events before relying on them.' : 'Notation is available only when the certificate passes.'}</p>
          </div>
        </div>
        <div className="export-actions">
          <button
            type="button"
            onClick={exportMusicXml}
            disabled={!availableMusicxml || (!isAudioDraft && !transcript.gate.certified)}
            data-testid="export-musicxml"
            title={isAudioDraft ? 'Download explicitly uncertified draft MusicXML' : !transcript.gate.certified ? 'Withheld until the score clears certification' : 'Download MusicXML'}
          >
            <DownloadIcon /><span>{isAudioDraft ? 'Draft MusicXML' : 'MusicXML'}<small>{isAudioDraft ? (availableMusicxml ? 'uncertified' : 'unavailable') : transcript.gate.certified ? 'certified score' : 'withheld'}</small></span>
          </button>
          <button
            type="button"
            onClick={exportMidi}
            disabled={!isAudioDraft && !transcript.eventVerification.verified}
            data-testid="export-midi"
            title={isAudioDraft ? 'Download inferred audio-note events as draft MIDI' : !transcript.eventVerification.verified ? 'Withheld because note-event verification failed' : 'Download verified note events'}
          >
            <DownloadIcon /><span>{isAudioDraft ? 'Draft MIDI' : 'Normalized MIDI'}<small>{isAudioDraft ? 'uncertified inferred events' : transcript.eventVerification.verified ? 'verified note events' : 'withheld'}</small></span>
          </button>
          <button type="button" onClick={exportAudit} data-testid="export-audit">
            <DownloadIcon /><span>Audit JSON<small>machine-readable</small></span>
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!isAudioDraft && !transcript.gate.certified}
            data-testid="export-csv"
            title={isAudioDraft ? 'Download inferred note table' : !transcript.gate.certified ? 'Withheld until the score clears certification' : 'Download certified score-note table'}
          >
            <DownloadIcon /><span>Notes CSV<small>{isAudioDraft ? 'uncertified inferred notes' : transcript.gate.certified ? 'certified score notes' : 'withheld'}</small></span>
          </button>
        </div>
      </div>

      <div className="note-table-card">
        <div className="table-toolbar">
          <div>
            <h3>Note-level audit</h3>
            <p>{filteredNotes.length.toLocaleString()} of {transcript.quantized.length.toLocaleString()} notes</p>
          </div>
          <div className="filter-tabs" role="group" aria-label="Filter notes">
            <button className={tableFilter === 'all' ? 'active' : ''} type="button" onClick={() => setTableFilter('all')}>All notes</button>
            <button className={tableFilter === 'misfits' ? 'active' : ''} type="button" onClick={() => setTableFilter('misfits')}>Misfits</button>
          </div>
        </div>
        <div className="table-scroll">
          <table data-testid="note-table">
            <thead>
              <tr>
                <th>#</th><th>Note</th><th>Hand</th><th>Onset</th><th>Duration</th>
                <th>Onset error</th><th>Duration error</th><th>Velocity</th><th>Gate</th>
              </tr>
            </thead>
            <tbody>
              {tableNotes.map((note, index) => (
                <tr key={note.id} className={!note.onsetFit || !note.durationFit ? 'misfit-row' : ''}>
                  <td className="mono">{index + 1}</td>
                  <td><b>{note.spelled.name}</b><small>MIDI {note.pitch}</small></td>
                  <td>{note.staff === 1 ? 'Treble' : 'Bass'}</td>
                  <td className="mono">{formatNumber(note.onsetBeats, 3)} b</td>
                  <td className="mono">{formatNumber(note.durationBeats, 3)} b</td>
                  <td className="mono">{formatSigned(note.onsetErrorBeats)} b</td>
                  <td className="mono">{formatSigned(note.durationErrorBeats)} b</td>
                  <td className="mono">{note.velocity}</td>
                  <td><FitBadge note={note} /></td>
                </tr>
              ))}
              {tableNotes.length === 0 && (
                <tr><td className="table-empty" colSpan={9}>No notes match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filteredNotes.length > 500 && <p className="table-limit">Showing the first 500 rows. Export CSV for the complete audit.</p>}
      </div>
    </section>
  );
}

function PianoRoll({ notes, meter }: { notes: QuantizedNote[]; meter: { numerator: number; denominator: number } }) {
  const width = 1120;
  const height = 350;
  const left = 62;
  const right = 18;
  const top = 20;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxBeat = Math.max(4, ...notes.map((note) => note.onsetBeats + note.durationBeats));
  const minNote = notes.length ? Math.min(...notes.map((note) => note.pitch)) : 48;
  const maxNote = notes.length ? Math.max(...notes.map((note) => note.pitch)) : 72;
  const pitchMin = Math.max(21, minNote - 2);
  const pitchMax = Math.min(108, Math.max(pitchMin + 12, maxNote + 2));
  const pitchSpan = pitchMax - pitchMin + 1;
  const beatStep = maxBeat > 96 ? Math.ceil(maxBeat / 32) : maxBeat > 48 ? 2 : 1;
  const beatLines = Math.ceil(maxBeat / beatStep) + 1;
  const measureBeats = Math.max(0.25, meter.numerator * (4 / meter.denominator));
  const visibleNotes = notes.slice(0, 3000);

  return (
    <div className="piano-roll-card" data-testid="piano-roll">
      <div className="roll-topline">
        <div><span>{formatNumber(maxBeat, 2)} beats</span><b>Quantized timeline</b></div>
        <div><span>{pitchName(pitchMin)}–{pitchName(pitchMax)}</span><b>{notes.length.toLocaleString()} notes</b></div>
      </div>
      <div className="roll-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Piano roll showing ${notes.length} quantized notes`}>
          <rect className="roll-background" x="0" y="0" width={width} height={height} rx="12" />
          {Array.from({ length: pitchSpan }, (_, index) => {
            const pitch = pitchMin + index;
            const y = top + (pitchMax - pitch) * (plotHeight / pitchSpan);
            const rowHeight = plotHeight / pitchSpan;
            return (
              <g key={`pitch-${pitch}`}>
                <rect
                  className={isBlackPitch(pitch) ? 'pitch-row black-row' : 'pitch-row'}
                  x={left}
                  y={y}
                  width={plotWidth}
                  height={rowHeight}
                />
                {pitch % 12 === 0 && (
                  <text className="pitch-label" x={left - 9} y={y + rowHeight * 0.74} textAnchor="end">{pitchName(pitch)}</text>
                )}
              </g>
            );
          })}
          {Array.from({ length: beatLines }, (_, index) => {
            const beat = index * beatStep;
            const x = left + (beat / maxBeat) * plotWidth;
            const isMeasure = nearlyWhole(beat / measureBeats);
            return (
              <g key={`beat-${beat}`}>
                <line className={isMeasure ? 'measure-line' : 'beat-line'} x1={x} x2={x} y1={top} y2={top + plotHeight} />
                <text className="beat-label" x={x + 4} y={height - 10}>{formatNumber(beat, 0)}</text>
              </g>
            );
          })}
          {visibleNotes.map((note) => {
            const x = left + (note.onsetBeats / maxBeat) * plotWidth;
            const y = top + (pitchMax - note.pitch) * (plotHeight / pitchSpan) + 1;
            const rectWidth = Math.max(3, (note.durationBeats / maxBeat) * plotWidth - 1);
            const rectHeight = Math.max(3, plotHeight / pitchSpan - 2);
            const fits = note.onsetFit && note.durationFit;
            return (
              <rect
                key={note.id}
                className={`roll-note ${fits ? (note.staff === 1 ? 'treble-note' : 'bass-note') : 'misfit-note'}`}
                x={x}
                y={y}
                width={rectWidth}
                height={rectHeight}
                rx="2"
              >
                <title>{note.spelled.name} · beat {formatNumber(note.onsetBeats, 3)} · {fits ? 'fits' : 'outside tolerance'}</title>
              </rect>
            );
          })}
          <line className="roll-axis" x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} />
        </svg>
      </div>
      {notes.length > visibleNotes.length && <p className="roll-limit">Previewing the first {visibleNotes.length.toLocaleString()} notes for rendering performance.</p>}
    </div>
  );
}

function FitBadge({ note }: { note: QuantizedNote }) {
  if (note.onsetFit && note.durationFit) return <span className="fit-badge pass"><CheckIcon /> Fit</span>;
  if (!note.onsetFit && !note.durationFit) return <span className="fit-badge fail">Both</span>;
  return <span className="fit-badge fail">{note.onsetFit ? 'Duration' : 'Onset'}</span>;
}

function hasExplicitLiveTiming(config: Configuration): boolean {
  const bpm = Number(config.tempoBpm);
  return Boolean(config.tempoBpm.trim()) && Number.isFinite(bpm) && bpm > 0 && config.meterOverride;
}

function midiStateLabel(state: MidiSupportState, inputCount: number): string {
  if (state === 'ready') return inputCount === 1 ? '1 MIDI input available' : `${inputCount} MIDI inputs available`;
  if (state === 'requesting') return 'Requesting browser permission';
  if (state === 'unsupported') return 'Web MIDI unavailable';
  if (state === 'denied') return 'MIDI access blocked';
  return 'MIDI access not enabled';
}

function filenameBase(filename: string): string {
  return filename.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '') || 'exactkeys';
}

function safeFilename(filename: string): string {
  return filename.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'exactkeys';
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(value >= 0.99995 ? 0 : 2)}%`;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits).replace(/\.0+$/, '') : '—';
}

function formatSigned(value: number): string {
  return value < 0.0005 ? '0' : value.toFixed(3);
}

function formatElapsed(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function sourceLabel(source: string): string {
  return source.replace('midi-meta', 'MIDI meta').replace('default-120', 'default').replace('assumed-4/4', 'assumed').replace('-', ' ');
}

function pitchName(midi: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function isBlackPitch(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

function nearlyWhole(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-6;
}

function csvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(filename: string, contents: BlobPart, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBytes(filename: string, bytes: Uint8Array, type: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  downloadBlob(filename, copy.buffer, type);
}

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>;
}

function UploadIcon() {
  return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 19V5m0 0-5 5m5-5 5 5M5 18v5h18v-5" /></svg>;
}

function FileIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h7l4 4v12H5zM12 2v5h4M8 11h5M8 14h5" /></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><path d="m3.5 9 3.2 3.2L14.5 5" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="4" y="8" width="10" height="8" rx="2" /><path d="M6.5 8V5.5a2.5 2.5 0 0 1 5 0V8" /></svg>;
}

function AlertIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2zM10 7v4.5M10 14.5v.2" /></svg>;
}

function ShieldCheckIcon() {
  return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2.8 24 6v7c0 6-4.2 10.2-10 12.2C8.2 23.2 4 19 4 13V6z" /><path d="m9 13.5 3.2 3.2 6.8-7" /></svg>;
}

function ShieldXIcon() {
  return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2.8 24 6v7c0 6-4.2 10.2-10 12.2C8.2 23.2 4 19 4 13V6z" /><path d="m10 10 8 8m0-8-8 8" /></svg>;
}

function MidiPortIcon() {
  return <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="25" /><circle cx="20" cy="29" r="2.5" /><circle cx="27" cy="20" r="2.5" /><circle cx="37" cy="20" r="2.5" /><circle cx="44" cy="29" r="2.5" /><circle cx="32" cy="39" r="2.5" /><path d="M18 47c3.5-8 8-12 14-12s10.5 4 14 12" /></svg>;
}

function DownloadIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9m0 0 4-4m-4 4L6 8M4 15v2h12v-2" /></svg>;
}

function PlayIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6z" /></svg>;
}

function StopIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1" /></svg>;
}

export default App;
