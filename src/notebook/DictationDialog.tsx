import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, LoaderCircle, Mic, Square, X } from 'lucide-react'
import { Modal } from './Modal'
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
  WHISTLE_LANGUAGES,
  WHISTLE_MAX_TEXT,
  type WhistleLanguage,
} from '../services/whistle-model'
import './whistle.css'

export interface DictationDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  onInsert(text: string): void
}

export function DictationDialog({
  open,
  onOpenChange,
  onInsert,
}: DictationDialogProps) {
  const model = useSyncExternalStore(
    subscribeWhistleState,
    getWhistleState,
    getWhistleState
  )
  const [phase, setPhase] = useState<
    'idle' | 'starting' | 'recording' | 'transcribing' | 'preview'
  >('idle')
  const [language, setLanguage] = useState<WhistleLanguage>('')
  const [seconds, setSeconds] = useState(0)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const recording = useRef<WhistleRecording | null>(null)
  const pendingInsert = useRef<string | null>(null)
  const mounted = useRef(true)
  const openRef = useRef(open)
  openRef.current = open
  const busy =
    phase === 'starting' || phase === 'recording' || phase === 'transcribing'
  const cancel = (unload = true) => {
    request.current?.abort()
    request.current = null
    recording.current?.cancel()
    recording.current = null
    if (unload) unloadWhistleModel()
  }
  useEffect(() => {
    if (open) void checkWhistleCache()
    else {
      cancel()
      setPhase('idle')
      setText('')
      setSeconds(0)
      setError('')
    }
    return () => cancel()
  }, [open])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancel()
    }
  }, [])
  const record = async () => {
    if (busy || !model.cached) return
    cancel(false)
    const controller = new AbortController()
    request.current = controller
    setPhase('starting')
    setText('')
    setError('')
    setSeconds(0)
    const current = () =>
      mounted.current &&
      openRef.current &&
      request.current === controller &&
      !controller.signal.aborted
    let audio: Float32Array | null = null
    let capture: WhistleRecording | null = null
    try {
      capture = await startWhistleRecording({
        signal: controller.signal,
        onDuration: value => {
          if (current()) setSeconds(value)
        },
      })
      if (!current()) {
        void capture.finished.catch(() => undefined)
        capture.cancel()
        return
      }
      recording.current = capture
      setPhase('recording')
      audio = await capture.finished
      recording.current = null
      if (!current()) return
      setPhase('transcribing')
      const transcript = await transcribeWhistle(audio, {
        language,
        signal: controller.signal,
      })
      if (!current()) return
      setText(transcript.text)
      setPhase('preview')
      if (!transcript.text)
        setError(
          'No words were heard. Move closer to the microphone and record again.'
        )
    } catch (failure) {
      if (!current()) return
      setPhase('idle')
      setError(
        failure instanceof Error
          ? failure.message
          : 'Dictation could not finish. Record again.'
      )
    } finally {
      audio?.fill(0)
      if (request.current === controller) request.current = null
      if (capture && recording.current === capture) {
        capture.cancel()
        recording.current = null
      }
    }
  }
  const close = (next: boolean) => {
    if (!next) {
      pendingInsert.current = null
      cancel()
    }
    onOpenChange(next)
  }
  const insert = () => {
    if (!text.trim() || busy) return
    pendingInsert.current = text
    cancel()
    onOpenChange(false)
  }
  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Dictate a thought"
      description="Speak for up to 30 seconds, then review your words before adding them to the note."
      className="dictation-dialog"
      onCloseAutoFocus={event => {
        const transcript = pendingInsert.current
        if (transcript === null) return
        pendingInsert.current = null
        event.preventDefault()
        try {
          onInsert(transcript)
        } catch (failure) {
          setText(transcript)
          setPhase('preview')
          setError(
            failure instanceof Error
              ? failure.message
              : 'The transcript could not be inserted.'
          )
          onOpenChange(true)
        }
      }}
    >
      <details
        className="dictation-model-details"
        hidden={busy}
        open={model.status !== 'ready' && phase !== 'preview'}
      >
        <summary>
          {model.status === 'ready' || phase === 'preview'
            ? 'Model details'
            : 'Model setup'}
        </summary>
        <WhistleModelPanel />
      </details>
      <div className="dictation-controls">
        <div>
          <label className="field-label" htmlFor="dictation-language">
            Language
          </label>
          <select
            id="dictation-language"
            value={language}
            disabled={busy}
            onChange={event =>
              setLanguage(event.target.value as WhistleLanguage)
            }
          >
            {WHISTLE_LANGUAGES.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <span
          className={`dictation-time ${phase === 'recording' ? 'is-recording' : ''}`}
          aria-hidden="true"
        >
          {Math.floor(seconds)} / 30 sec
        </span>
      </div>
      <div className="dictation-action-row">
        {phase === 'recording' ? (
          <button
            className="button primary"
            onClick={() => recording.current?.stop()}
          >
            <Square size={14} /> Stop & transcribe
          </button>
        ) : phase === 'starting' || phase === 'transcribing' ? (
          <button
            className="button secondary"
            onClick={() => {
              cancel()
              setPhase('idle')
            }}
          >
            <X size={14} /> Cancel dictation
          </button>
        ) : (
          <button
            className="button primary"
            disabled={
              !model.cached ||
              ['checking', 'downloading', 'loading', 'unavailable'].includes(
                model.status
              )
            }
            onClick={() => {
              void record()
            }}
          >
            <Mic size={15} />
            {phase === 'preview' ? 'Record again' : 'Record'}
          </button>
        )}
        <span className="dictation-status" role="status">
          {phase === 'starting' || phase === 'transcribing' ? (
            <LoaderCircle size={13} className="spin" />
          ) : null}
          {phase === 'starting'
            ? 'Opening microphone…'
            : phase === 'recording'
              ? 'Recording on this device'
              : phase === 'transcribing'
                ? 'Transcribing on this device…'
                : phase === 'preview'
                  ? 'Review your words'
                  : 'Microphone is off'}
        </span>
      </div>
      {phase === 'preview' && (
        <div className="dictation-preview">
          <label className="field-label" htmlFor="dictation-transcript">
            Your transcript
          </label>
          <textarea
            id="dictation-transcript"
            rows={6}
            value={text}
            maxLength={WHISTLE_MAX_TEXT}
            onChange={event => setText(event.target.value)}
            autoFocus
          />
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p className="dictation-privacy">
        Audio stays on your device and is discarded after transcription. Whistle
        supports English, German, French, Spanish, Italian, Dutch and Polish.
      </p>
      <div className="dialog-footer">
        <button className="button subtle" onClick={() => close(false)}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={phase !== 'preview' || !text.trim()}
          onClick={insert}
        >
          <Check size={15} /> Insert transcript
        </button>
      </div>
    </Modal>
  )
}
