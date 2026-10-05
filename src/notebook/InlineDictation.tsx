import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { ChevronDown, LoaderCircle, Mic, Square, X } from 'lucide-react'
import { WhistleModelPanel } from './WhistleModelPanel'
import {
  checkWhistleCache,
  getWhistleState,
  subscribeWhistleState,
  transcribeWhistle,
  unloadWhistleModel,
} from '../services/whistle'
import {
  startWhistleRecording,
  type WhistleRecording,
} from '../services/whistle-recorder'
import {
  listWhistleMicrophones,
  subscribeWhistleMicrophoneChanges,
  type WhistleMicrophone,
} from '../services/whistle-microphones'
import {
  WHISTLE_LANGUAGES,
  WHISTLE_MAX_TEXT,
  type WhistleLanguage,
} from '../services/whistle-model'
import type { DictationCapture } from '../components/notebook/dictation-anchor'
import './inline-dictation.css'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing'
const PREFERENCE_KEY = 'typenext:dictation-input:v1'
function preference(): { deviceId: string; language: WhistleLanguage } {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? '{}')
    return {
      deviceId:
        typeof value.deviceId === 'string' ? value.deviceId.slice(0, 512) : '',
      language: WHISTLE_LANGUAGES.some(item => item.id === value.language)
        ? value.language
        : '',
    }
  } catch {
    return { deviceId: '', language: '' }
  }
}
export interface InlineDictationHandle {
  toggle(): void
  cancel(): void
}
interface Props {
  onCapture(): DictationCapture
  onRecoverInsert(text: string): void
  onActiveChange?(active: boolean): void
  /** Parent-owned recovery survives note switches while recording stays keyed. */
  recoveryText?: string | null
  onRecoveryTextChange?(text: string | null): void
}
export const InlineDictation = forwardRef<InlineDictationHandle, Props>(
  function InlineDictation(
    {
      onCapture,
      onRecoverInsert,
      onActiveChange,
      recoveryText,
      onRecoveryTextChange,
    },
    ref
  ) {
    const model = useSyncExternalStore(
      subscribeWhistleState,
      getWhistleState,
      getWhistleState
    )
    const [expanded, setExpanded] = useState(recoveryText != null)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [phase, setPhaseState] = useState<Phase>('idle')
    const phaseRef = useRef<Phase>('idle')
    const [seconds, setSeconds] = useState(0)
    const [level, setLevel] = useState(0)
    const [input, setInput] = useState(preference)
    const [devices, setDevices] = useState<WhistleMicrophone[]>([
      { deviceId: '', label: 'System default' },
    ])
    const [deviceBusy, setDeviceBusy] = useState(false)
    const [error, setError] = useState('')
    const [message, setMessage] = useState('')
    const [internalRecoveryText, setInternalRecoveryText] = useState<
      string | null
    >(null)
    const pendingText =
      recoveryText === undefined ? internalRecoveryText : recoveryText
    const request = useRef<AbortController | null>(null)
    const deviceRequest = useRef<AbortController | null>(null)
    const recording = useRef<WhistleRecording | null>(null)
    const capture = useRef<DictationCapture | null>(null)
    const mounted = useRef(true)
    const actions = useRef({ toggle: () => {}, cancel: () => {} })
    const callbacks = useRef({
      onCapture,
      onRecoverInsert,
      onActiveChange,
      onRecoveryTextChange,
    })
    callbacks.current = {
      onCapture,
      onRecoverInsert,
      onActiveChange,
      onRecoveryTextChange,
    }
    const setPendingText = (text: string | null) => {
      if (recoveryText === undefined) setInternalRecoveryText(text)
      callbacks.current.onRecoveryTextChange?.(text)
    }
    const hasRecovery = pendingText !== null
    useEffect(() => {
      if (hasRecovery) setExpanded(true)
    }, [hasRecovery])
    const setPhase = (next: Phase) => {
      phaseRef.current = next
      setPhaseState(next)
      callbacks.current.onActiveChange?.(next !== 'idle')
    }
    const cancel = () => {
      request.current?.abort()
      request.current = null
      recording.current?.cancel()
      recording.current = null
      capture.current?.cancel()
      capture.current = null
      unloadWhistleModel()
      if (mounted.current) {
        setPhase('idle')
        setLevel(0)
        setMessage('Dictation cancelled. Your writing is unchanged.')
      }
    }
    const refreshDevices = async (permission = false) => {
      deviceRequest.current?.abort()
      const controller = new AbortController()
      deviceRequest.current = controller
      setDeviceBusy(true)
      try {
        const choices = await listWhistleMicrophones({
          signal: controller.signal,
          requestPermission: permission,
        })
        if (
          mounted.current &&
          deviceRequest.current === controller &&
          !controller.signal.aborted
        ) {
          setDevices(choices)
          if (permission) setError('')
        }
      } catch (failure) {
        if (
          mounted.current &&
          deviceRequest.current === controller &&
          !controller.signal.aborted
        )
          setError(
            failure instanceof Error
              ? failure.message
              : 'Microphones could not be listed.'
          )
      } finally {
        if (mounted.current && deviceRequest.current === controller)
          setDeviceBusy(false)
      }
    }
    useEffect(() => {
      mounted.current = true
      void checkWhistleCache()
      return () => {
        mounted.current = false
        request.current?.abort()
        recording.current?.cancel()
        capture.current?.cancel()
        deviceRequest.current?.abort()
        unloadWhistleModel()
        callbacks.current.onActiveChange?.(false)
      }
    }, [])
    useEffect(() => {
      if (!expanded || !settingsOpen) return
      void refreshDevices()
      const unsubscribe = subscribeWhistleMicrophoneChanges(() => {
        void refreshDevices()
      })
      return () => {
        unsubscribe()
        deviceRequest.current?.abort()
        deviceRequest.current = null
      }
    }, [expanded, settingsOpen])
    useEffect(() => {
      try {
        localStorage.setItem(PREFERENCE_KEY, JSON.stringify(input))
      } catch {
        /* Optional device preference; writing persistence is independent. */
      }
    }, [input])
    const record = async () => {
      if (phaseRef.current !== 'idle') return
      setExpanded(true)
      if (
        [
          'checking',
          'downloading',
          'loading',
          'unavailable',
          'transcribing',
        ].includes(model.status)
      ) {
        setSettingsOpen(true)
        setMessage('Finish Whistle setup before recording.')
        return
      }
      if (!model.cached) {
        setSettingsOpen(true)
        setMessage('Download Whistle once to dictate on this device.')
        return
      }
      // A microphone-list permission prompt belongs to its setup panel, not
      // to the new recording. Its late grant must not keep a second input open.
      deviceRequest.current?.abort()
      deviceRequest.current = null
      setDeviceBusy(false)
      const controller = new AbortController()
      request.current = controller
      setError('')
      setMessage('')
      setPendingText(null)
      setSeconds(0)
      setLevel(0)
      setSettingsOpen(false)
      setPhase('starting')
      let pcm: Float32Array | null = null
      let transcript = ''
      const current = () =>
        mounted.current &&
        request.current === controller &&
        !controller.signal.aborted
      try {
        capture.current = callbacks.current.onCapture()
        const session = await startWhistleRecording({
          signal: controller.signal,
          deviceId: input.deviceId,
          onDuration: value => {
            if (current()) setSeconds(value)
          },
          onLevel: value => {
            if (current()) setLevel(value)
          },
        })
        if (!current()) {
          void session.finished.catch(() => undefined)
          session.cancel()
          return
        }
        recording.current = session
        setPhase('recording')
        pcm = await session.finished
        if (recording.current === session) recording.current = null
        if (!current()) return
        capture.current?.transcribing()
        setPhase('transcribing')
        setLevel(0)
        const result = await transcribeWhistle(pcm, {
          language: input.language,
          signal: controller.signal,
        })
        if (!current()) return
        transcript = result.text.trim()
        if (!transcript)
          throw new Error(
            'No words were heard. Check your microphone and try again.'
          )
        if (!capture.current)
          throw new Error('Place the cursor and insert your transcript below.')
        capture.current.commit(transcript)
        capture.current = null
        setMessage('Added to your note. Undo with Ctrl / ⌘ Z.')
        setPhase('idle')
      } catch (failure) {
        if (!current()) return
        capture.current?.cancel()
        capture.current = null
        setPendingText(transcript || null)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Dictation could not finish. Try again.'
        )
        setPhase('idle')
        setLevel(0)
      } finally {
        pcm?.fill(0)
        if (request.current === controller) {
          request.current = null
          recording.current?.cancel()
          recording.current = null
        }
      }
    }
    const toggle = () => {
      if (phaseRef.current === 'recording') {
        recording.current?.stop()
        return
      }
      if (phaseRef.current !== 'idle') {
        cancel()
        return
      }
      if (pendingText !== null) {
        setExpanded(true)
        return
      }
      void record()
    }
    actions.current = { toggle, cancel }
    useImperativeHandle(
      ref,
      () => ({
        toggle: () => actions.current.toggle(),
        cancel: () => actions.current.cancel(),
      }),
      []
    )
    useEffect(() => {
      const key = (event: KeyboardEvent) => {
        if (document.querySelector('[role="dialog"]')) return
        if (
          (event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          !event.altKey &&
          event.code === 'KeyD'
        ) {
          event.preventDefault()
          event.stopPropagation()
          if (!event.repeat) actions.current.toggle()
        } else if (event.key === 'Escape' && phaseRef.current !== 'idle') {
          event.preventDefault()
          event.stopPropagation()
          actions.current.cancel()
        }
      }
      const hide = () => {
        if (
          document.visibilityState === 'hidden' &&
          phaseRef.current !== 'idle'
        )
          actions.current.cancel()
      }
      window.addEventListener('keydown', key, true)
      document.addEventListener('visibilitychange', hide)
      return () => {
        window.removeEventListener('keydown', key, true)
        document.removeEventListener('visibilitychange', hide)
      }
    }, [])
    if (!expanded) return null
    const busy = phase !== 'idle'
    return (
      <section
        className={`inline-dictation ${busy ? 'is-active' : ''}`}
        aria-label="Inline dictation"
      >
        <div className="dictation-strip">
          <div className="dictation-feedback" role="status" aria-live="polite">
            {phase === 'recording' ? (
              <span
                className="dictation-meter"
                aria-hidden="true"
                style={{ '--voice-level': level } as CSSProperties}
              >
                {[0, 1, 2, 3, 4].map(i => (
                  <i key={i} />
                ))}
              </span>
            ) : phase === 'starting' || phase === 'transcribing' ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Mic size={16} />
            )}
            <span>
              {phase === 'recording'
                ? 'Listening'
                : phase === 'starting'
                  ? 'Opening microphone…'
                  : phase === 'transcribing'
                    ? 'Transcribing on this device…'
                    : message
                      ? 'Ready for your next thought'
                      : 'Dictate into your note'}
            </span>
            {phase === 'recording' && (
              <span className="dictation-elapsed">
                {Math.floor(seconds)} / 30 s
              </span>
            )}
          </div>
          {phase === 'recording' ? (
            <button
              className="button primary"
              onMouseDown={event => event.preventDefault()}
              onClick={() => recording.current?.stop()}
            >
              <Square size={12} />
              Stop
            </button>
          ) : phase === 'idle' && pendingText === null ? (
            <button
              className="button secondary"
              disabled={
                !model.cached ||
                ['checking', 'downloading', 'loading', 'unavailable'].includes(
                  model.status
                )
              }
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                void record()
              }}
            >
              <Mic size={14} />
              Dictate
            </button>
          ) : null}
          {busy ? (
            <button
              className="icon-button"
              aria-label="Cancel dictation"
              title="Cancel dictation (Escape)"
              onMouseDown={event => event.preventDefault()}
              onClick={cancel}
            >
              <X size={16} />
            </button>
          ) : (
            <>
              <button
                className="dictation-input-button"
                aria-label="Choose microphone"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(value => !value)}
              >
                <span>Microphone</span>
                <ChevronDown size={13} />
              </button>
              <button
                className="icon-button"
                aria-label="Hide dictation controls"
                onClick={() => {
                  setExpanded(false)
                  setSettingsOpen(false)
                }}
              >
                <X size={15} />
              </button>
            </>
          )}
        </div>
        {settingsOpen && !busy && (
          <div className="dictation-input-panel">
            <div className="dictation-input-fields">
              <label>
                Microphone
                <select
                  aria-label="Microphone"
                  value={input.deviceId}
                  onChange={event =>
                    setInput(value => ({
                      ...value,
                      deviceId: event.target.value,
                    }))
                  }
                >
                  {!devices.some(
                    device => device.deviceId === input.deviceId
                  ) && (
                    <option value={input.deviceId}>
                      Previously selected microphone · unavailable
                    </option>
                  )}
                  {devices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Language
                <select
                  aria-label="Dictation language"
                  value={input.language}
                  onChange={event =>
                    setInput(value => ({
                      ...value,
                      language: event.target.value as WhistleLanguage,
                    }))
                  }
                >
                  {WHISTLE_LANGUAGES.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="button subtle"
              disabled={deviceBusy}
              onClick={() => {
                void refreshDevices(true)
              }}
            >
              {deviceBusy
                ? 'Finding microphones…'
                : 'Allow and refresh microphones'}
            </button>
            <p className="field-help">
              Ctrl / ⌘ Shift D starts and stops. Escape cancels. Speech stays on
              this device and enters your note when you stop. You can keep
              typing.
            </p>
            <WhistleModelPanel />
          </div>
        )}
        {error && (
          <p className="dictation-inline-error" role="alert">
            {error}
          </p>
        )}
        {pendingText !== null && (
          <div className="dictation-recovery">
            <label htmlFor="recovered-transcript">Your transcript</label>
            <textarea
              id="recovered-transcript"
              value={pendingText}
              maxLength={WHISTLE_MAX_TEXT}
              rows={3}
              onChange={event => setPendingText(event.target.value)}
            />
            <button
              className="button secondary"
              disabled={!pendingText.trim()}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                try {
                  callbacks.current.onRecoverInsert(pendingText)
                  setPendingText(null)
                  setError('')
                  setMessage('Transcript inserted.')
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : 'The transcript could not be inserted.'
                  )
                }
              }}
            >
              Insert at cursor
            </button>
            <button
              className="button subtle"
              onClick={() => {
                setPendingText(null)
                setError('')
                setMessage('Transcript discarded. Ready to dictate again.')
              }}
            >
              Discard transcript
            </button>
          </div>
        )}
        {!busy && !error && message && (
          <p className="dictation-inline-hint">{message}</p>
        )}
      </section>
    )
  }
)
