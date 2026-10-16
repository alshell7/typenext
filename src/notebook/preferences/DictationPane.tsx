import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import {
  AudioLines,
  Download,
  LoaderCircle,
  Mic,
  Play,
  Square,
  Trash2,
  Waves,
  X,
} from 'lucide-react'
import {
  SPEECH_RUNTIME,
  cancelSpeechInstall,
  getSpeechRuntimeStatus,
  refreshSpeechRuntime,
  removeSpeechRuntime,
  speechEndpoint,
  stopSpeechRuntime,
  subscribeSpeechRuntime,
  type SpeechRuntimeStatus,
} from '../../services/speech-runtime'
import { downloadFluidSpeech } from '../../services/fluid-speech'
import {
  listWhistleMicrophones,
  subscribeWhistleMicrophoneChanges,
  type WhistleMicrophone,
} from '../../services/whistle-microphones'
import {
  WHISTLE_LANGUAGES,
  WHISTLE_MODEL,
  type WhistleLanguage,
} from '../../services/whistle-model'
import { startDictationRecording } from '../../services/whistle-recorder'
import { VoiceActivityDetector } from '../../services/voice-activity'
import { VOICE_COMMANDS } from '../../services/voice-commands'
import type { DictationSettings, NotebookSettings } from '../../types/notebook'
import { WhistleModelPanel } from '../WhistleModelPanel'
import { DICTATION_SHORTCUT } from '../dictation/DictationChip'
import {
  setDictationInput,
  useDictationInput,
} from '../dictation/input-preference'
import {
  Group,
  Pill,
  Row,
  Section,
  StatusLine,
  SwitchRow,
  TileGroup,
  errorText,
  formatBytes,
  type Tone,
} from './controls'
import type { PaneProps } from './types'
import './DictationPane.css'

type Props = { settings: NotebookSettings } & Partial<
  Pick<PaneProps, 'update' | 'latest' | 'onPaneChange'>
> & {
    /** Alternative to `update`/`latest`: receives the merged settings. */
    onChange?(dictation: DictationSettings): void
  }

const WHISTLE_LANGUAGE_COUNT = WHISTLE_LANGUAGES.length - 1

function runtimePill(status: SpeechRuntimeStatus, installed: boolean) {
  switch (status.state) {
    case 'unsupported':
      return <Pill>Desktop app only</Pill>
    case 'downloading': {
      const progress = status.progress
      const percent =
        progress && progress.totalBytes > 0
          ? Math.floor((progress.downloadedBytes / progress.totalBytes) * 100)
          : null
      return (
        <Pill tone="busy">
          Downloading{percent === null ? '' : ` ${percent}%`}
        </Pill>
      )
    }
    case 'starting':
      return <Pill tone="busy">Starting</Pill>
    case 'running':
      return <Pill tone="ok">Running</Pill>
    case 'error':
      return <Pill tone="error">Needs attention</Pill>
    default:
      return installed ? (
        <Pill tone="ok">Installed</Pill>
      ) : (
        <Pill>Not installed</Pill>
      )
  }
}

function FluidRuntime() {
  const status = useSyncExternalStore(
    subscribeSpeechRuntime,
    getSpeechRuntimeStatus,
    getSpeechRuntimeStatus
  )
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void refreshSpeechRuntime().catch(error => {
      if (mounted.current)
        setFailure(
          errorText(error, 'The desktop speech runtime did not respond.')
        )
    })
    return () => {
      mounted.current = false
    }
  }, [])
  const run = async (name: string, action: () => Promise<unknown>) => {
    setPending(name)
    setFailure('')
    try {
      await action()
    } catch (error) {
      if (mounted.current)
        setFailure(errorText(error, 'Fluid Speech Mini did not respond.'))
    } finally {
      if (mounted.current) setPending(null)
    }
  }
  const installed = status.installed.runtime && status.installed.model
  const downloading = status.state === 'downloading'
  const progress = status.progress
  const fraction =
    progress && progress.totalBytes > 0
      ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
      : 0
  const message =
    failure ||
    status.error ||
    (status.state === 'unsupported'
      ? 'Fluid Speech Mini runs in the TypeNext desktop app. Whistle works here.'
      : status.state === 'running'
        ? 'Running privately on this device. It stops after 15 minutes without dictation.'
        : installed
          ? 'Installed. TypeNext starts it when you dictate.'
          : `Downloads parakeet.cpp ${SPEECH_RUNTIME.parakeetRelease} and the model from pinned, verified sources. Audio never leaves this device.`)
  const tone: Tone = failure || status.error ? 'error' : 'neutral'
  return (
    <div
      className="pref-card pref-runtime dictation-runtime"
      role="group"
      aria-label="Fluid Speech Mini runtime"
    >
      <div className="pref-card-heading">
        <div>
          <h4>{SPEECH_RUNTIME.model.name}</h4>
          <p className="pref-help">
            {SPEECH_RUNTIME.model.credit} · {SPEECH_RUNTIME.model.license} ·{' '}
            {formatBytes(SPEECH_RUNTIME.model.bytes)}
          </p>
        </div>
        {runtimePill(status, installed)}
      </div>
      {downloading && (
        <div className="pref-progress">
          <div className="pref-progress-label">
            <span>{progress?.file ?? 'Preparing download'}</span>
            <span>
              {progress
                ? `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)} · ${Math.floor(fraction * 100)}%`
                : 'Starting…'}
            </span>
          </div>
          <div
            className="pref-progress-track"
            role="progressbar"
            aria-label="Fluid Speech Mini download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(fraction * 100)}
          >
            <span
              className="pref-progress-fill"
              style={{ '--progress': fraction } as CSSProperties}
            />
          </div>
        </div>
      )}
      <div className="pref-actions">
        {downloading ? (
          <button
            type="button"
            className="button secondary is-compact"
            disabled={pending === 'cancel'}
            onClick={() => {
              void run('cancel', cancelSpeechInstall)
            }}
          >
            <X size={14} /> Cancel download
          </button>
        ) : !installed ? (
          <button
            type="button"
            className="button primary is-compact"
            disabled={pending !== null || status.state === 'unsupported'}
            onClick={() => {
              void run('install', async () => {
                const result = await downloadFluidSpeech()
                if (result.error) throw new Error(result.error)
              })
            }}
          >
            {pending === 'install' ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Download size={14} />
            )}
            Download {SPEECH_RUNTIME.model.name} (
            {formatBytes(SPEECH_RUNTIME.model.bytes)})
          </button>
        ) : status.state === 'running' ? (
          <button
            type="button"
            className="button secondary is-compact"
            disabled={pending !== null}
            onClick={() => {
              void run('stop', stopSpeechRuntime)
            }}
          >
            <Square size={13} /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="button secondary is-compact"
            disabled={pending !== null || status.state === 'starting'}
            onClick={() => {
              void run('start', speechEndpoint)
            }}
          >
            {pending === 'start' || status.state === 'starting' ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Play size={14} />
            )}
            Start
          </button>
        )}
        {(installed || status.diskBytes > 0) && !downloading && (
          <span className="pref-actions-end">
            {confirmRemove ? (
              <span
                className="pref-confirm"
                role="group"
                aria-label="Confirm removal"
              >
                <span>
                  Remove{' '}
                  {status.diskBytes
                    ? formatBytes(status.diskBytes)
                    : 'the files'}
                  ?
                </span>
                <button
                  type="button"
                  className="button subtle is-compact"
                  onClick={() => setConfirmRemove(false)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="button destructive is-compact"
                  disabled={pending !== null}
                  onClick={() => {
                    setConfirmRemove(false)
                    void run('remove', removeSpeechRuntime)
                  }}
                >
                  Remove
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="button subtle is-compact"
                disabled={pending !== null}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
          </span>
        )}
      </div>
      <StatusLine tone={tone}>{message}</StatusLine>
    </div>
  )
}

function useMicrophones() {
  const [devices, setDevices] = useState<WhistleMicrophone[]>([
    { deviceId: '', label: 'System default' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const refresh = async (permission = false) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    try {
      const choices = await listWhistleMicrophones({
        signal: controller.signal,
        requestPermission: permission,
      })
      if (request.current === controller && !controller.signal.aborted) {
        setDevices(choices)
        setError('')
      }
    } catch (failure) {
      if (request.current === controller && !controller.signal.aborted)
        setError(errorText(failure, 'Microphones could not be listed.'))
    } finally {
      if (request.current === controller) setBusy(false)
    }
  }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    void refreshRef.current()
    const unsubscribe = subscribeWhistleMicrophoneChanges(() => {
      void refreshRef.current()
    })
    return () => {
      unsubscribe()
      request.current?.abort()
      request.current = null
    }
  }, [])
  return { devices, busy, error, refresh }
}

type TestResult = { tone: Tone; text: string }

/** Five seconds of listening with the same detection dictation uses. */
function MicrophoneTest({ deviceId }: { deviceId: string }) {
  const [running, setRunning] = useState(false)
  const [level, setLevel] = useState(0)
  const [result, setResult] = useState<TestResult>({
    tone: 'neutral',
    text: '',
  })
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => stopRef.current?.(), [])
  const test = async () => {
    const controller = new AbortController()
    const vad = new VoiceActivityDetector({ quietAfterMs: 2_000 })
    stopRef.current = () => controller.abort()
    setRunning(true)
    setLevel(0)
    setResult({ tone: 'busy', text: 'Say a few words…' })
    try {
      const recording = await startDictationRecording({
        signal: controller.signal,
        deviceId,
        maxSeconds: 5,
        onChunk: samples => {
          vad.push(samples)
          setLevel(vad.snapshot().level)
        },
      })
      stopRef.current = () => {
        controller.abort()
        recording.cancel()
      }
      await recording.finished
      const heard = vad.snapshot()
      setResult(
        heard.heardSpeech
          ? {
              tone: 'ok',
              text: 'Speech heard clearly. This microphone is ready.',
            }
          : heard.quiet
            ? {
                tone: 'error',
                text: 'Very quiet. Move closer, raise the input volume, or choose another microphone.',
              }
            : {
                tone: 'neutral',
                text: 'Only background sound was heard. Speak while the test runs.',
              }
      )
    } catch (error) {
      if (!controller.signal.aborted)
        setResult({
          tone: 'error',
          text: errorText(error, 'The microphone could not be opened.'),
        })
      else setResult({ tone: 'neutral', text: '' })
    } finally {
      stopRef.current = null
      setRunning(false)
      setLevel(0)
    }
  }
  return (
    <div className="dictation-test">
      <button
        type="button"
        className="button secondary is-compact"
        onClick={() => {
          if (running) stopRef.current?.()
          else void test()
        }}
      >
        {running ? <Square size={13} /> : <AudioLines size={14} />}
        {running ? 'Stop test' : 'Test microphone'}
      </button>
      <span
        className="dictation-test-meter"
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        style={{ '--level': level } as CSSProperties}
      >
        <span />
      </span>
      <StatusLine tone={result.tone} reserve={false}>
        {result.text}
      </StatusLine>
    </div>
  )
}

export function DictationPane({ settings, update, latest, onChange }: Props) {
  const dictation = settings.dictation
  const patch = (next: Partial<DictationSettings>) => {
    const base = latest ? latest().dictation : dictation
    const merged = { ...base, ...next }
    if (onChange) onChange(merged)
    else update?.({ dictation: merged })
  }
  const input = useDictationInput()
  const microphones = useMicrophones()
  const silenceId = useId()
  const fluid = dictation.engine === 'fluid'
  return (
    <>
      <Section
        title="Speech engine"
        description={
          <>
            Press <kbd>{DICTATION_SHORTCUT}</kbd> or the microphone in the
            toolbar to dictate at the cursor. Esc cancels. Speech is transcribed
            on this device.
          </>
        }
      >
        <TileGroup
          label="Speech engine"
          value={dictation.engine}
          onChange={engine => patch({ engine })}
          className="dictation-engines"
          options={[
            {
              value: 'whistle',
              title: 'Whistle',
              icon: <Mic size={16} />,
              description: `Small and quick to set up. ${WHISTLE_LANGUAGE_COUNT} languages, clips up to 30 seconds.`,
              meta: `${formatBytes(WHISTLE_MODEL.bytes)} · runs in the app`,
            },
            {
              value: 'fluid',
              title: SPEECH_RUNTIME.model.name,
              icon: <Waves size={16} />,
              description:
                'Best accuracy and long dictation, robust to background voices. English.',
              meta: `${formatBytes(SPEECH_RUNTIME.model.bytes)} · desktop app`,
            },
          ]}
        />
        {fluid ? <FluidRuntime /> : <WhistleModelPanel />}
      </Section>
      <Section title="Microphone">
        <Group>
          <Row label="Input" htmlFor="dictation-microphone">
            <select
              id="dictation-microphone"
              value={input.deviceId}
              onChange={event =>
                setDictationInput({ deviceId: event.target.value })
              }
            >
              {!microphones.devices.some(
                device => device.deviceId === input.deviceId
              ) && (
                <option value={input.deviceId}>
                  Previously selected microphone · unavailable
                </option>
              )}
              {microphones.devices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </Row>
          {!fluid && (
            <Row label="Language" htmlFor="dictation-language">
              <select
                id="dictation-language"
                value={input.language}
                onChange={event =>
                  setDictationInput({
                    language: event.target.value as WhistleLanguage,
                  })
                }
              >
                {WHISTLE_LANGUAGES.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
        </Group>
        <div className="dictation-mic-actions">
          <button
            type="button"
            className="button subtle is-compact"
            disabled={microphones.busy}
            onClick={() => {
              void microphones.refresh(true)
            }}
          >
            {microphones.busy
              ? 'Finding microphones…'
              : 'Allow and refresh microphones'}
          </button>
        </div>
        {microphones.error && (
          <StatusLine tone="error" reserve={false}>
            {microphones.error}
          </StatusLine>
        )}
        <MicrophoneTest deviceId={input.deviceId} />
      </Section>
      <Section title="While you speak">
        <Group>
          <Row
            label="Stop after silence"
            htmlFor={silenceId}
            description="Dictation ends by itself after this pause, once you have spoken."
            stacked
          >
            <span className="pref-range">
              <input
                id={silenceId}
                type="range"
                min="0"
                max="15"
                step="1"
                value={dictation.silenceStopSeconds}
                aria-valuetext={
                  dictation.silenceStopSeconds
                    ? `${dictation.silenceStopSeconds} seconds`
                    : 'Off'
                }
                onChange={event =>
                  patch({ silenceStopSeconds: Number(event.target.value) })
                }
              />
              <output htmlFor={silenceId}>
                {dictation.silenceStopSeconds
                  ? `${dictation.silenceStopSeconds} s`
                  : 'Off'}
              </output>
            </span>
          </Row>
          <SwitchRow
            label="Insert phrases while speaking"
            description={
              fluid
                ? 'Each phrase appears at a natural pause, and the next one is previewed faintly.'
                : `Needs ${SPEECH_RUNTIME.model.name}. Whistle inserts everything when you finish.`
            }
            checked={dictation.livePhrases}
            disabled={!fluid}
            onChange={livePhrases => patch({ livePhrases })}
          />
          <SwitchRow
            label="Voice commands"
            description="Say a command on its own or at the end of a phrase."
            checked={dictation.voiceCommands}
            onChange={voiceCommands => patch({ voiceCommands })}
          />
        </Group>
        {dictation.voiceCommands && (
          <ul className="dictation-commands" aria-label="Voice commands">
            {VOICE_COMMANDS.map(item => (
              <li key={item.command}>
                <span className="dictation-command-say">“{item.say}”</span>
                <span className="dictation-command-does">{item.does}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}
