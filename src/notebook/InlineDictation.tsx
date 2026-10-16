import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Download, LoaderCircle, Mic, Settings2, X } from 'lucide-react'
import {
  checkWhistleCache,
  downloadWhistleModel,
  getWhistleState,
  subscribeWhistleState,
} from '../services/whistle'
import { startDictationRecording } from '../services/whistle-recorder'
import { WHISTLE_MAX_TEXT } from '../services/whistle-model'
import {
  getSpeechRuntimeStatus,
  refreshSpeechRuntime,
  subscribeSpeechRuntime,
} from '../services/speech-runtime'
import {
  chooseDictationEngine,
  fluidReadiness,
  whistleEngine,
  whistleReadiness,
  type DictationEngine,
  type DictationReadiness,
} from '../services/dictation-engine'
import { downloadFluidSpeech } from '../services/fluid-speech'
import {
  getDictationChipHost,
  subscribeDictationChipHost,
  type DictationCapture,
} from '../components/notebook/dictation-anchor'
import type { DictationSettings } from '../types/notebook'
import { defaultSettings } from './model'
import { DictationChip, DICTATION_SHORTCUT } from './dictation/DictationChip'
import { getDictationInput } from './dictation/input-preference'
import {
  DictationSession,
  type DictationSnapshot,
  type SessionEnd,
} from './dictation/session'
import './inline-dictation.css'

const DEFAULT_DICTATION: DictationSettings = defaultSettings().dictation

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
  /** `settings.dictation`. Defaults apply when absent. */
  settings?: DictationSettings
  /** Open Preferences → Dictation. Without it, setup happens inline. */
  onOpenSettings?(): void
}

type Setup = { engine: DictationEngine['id'] } | null

function readinessOf(engine: DictationEngine): DictationReadiness {
  return engine.id === 'fluid'
    ? fluidReadiness(getSpeechRuntimeStatus())
    : whistleReadiness(getWhistleState())
}

export const InlineDictation = forwardRef<InlineDictationHandle, Props>(
  function InlineDictation(
    {
      onCapture,
      onRecoverInsert,
      onActiveChange,
      recoveryText,
      onRecoveryTextChange,
      settings = DEFAULT_DICTATION,
      onOpenSettings,
    },
    ref
  ) {
    const whistle = useSyncExternalStore(
      subscribeWhistleState,
      getWhistleState,
      getWhistleState
    )
    const speech = useSyncExternalStore(
      subscribeSpeechRuntime,
      getSpeechRuntimeStatus,
      getSpeechRuntimeStatus
    )
    const host = useSyncExternalStore(
      subscribeDictationChipHost,
      getDictationChipHost,
      getDictationChipHost
    )
    const [snapshot, setSnapshot] = useState<DictationSnapshot | null>(null)
    const [engineLabel, setEngineLabel] = useState('')
    const [setup, setSetup] = useState<Setup>(null)
    const [expanded, setExpanded] = useState(recoveryText != null)
    const [error, setError] = useState('')
    const [announcement, setAnnouncement] = useState('')
    const [fallbackAccepted, setFallbackAccepted] = useState(false)
    const [internalRecoveryText, setInternalRecoveryText] = useState<
      string | null
    >(null)
    const pendingText =
      recoveryText === undefined ? internalRecoveryText : recoveryText
    const session = useRef<DictationSession | null>(null)
    const opening = useRef(false)
    const mounted = useRef(true)
    const latest = useRef({
      onCapture,
      onRecoverInsert,
      onActiveChange,
      onRecoveryTextChange,
      settings,
      recoveryText,
      fallbackAccepted,
      pendingText,
    })
    latest.current = {
      onCapture,
      onRecoverInsert,
      onActiveChange,
      onRecoveryTextChange,
      settings,
      recoveryText,
      fallbackAccepted,
      pendingText,
    }
    const setPendingText = useCallback((text: string | null) => {
      if (latest.current.recoveryText === undefined)
        setInternalRecoveryText(text)
      latest.current.onRecoveryTextChange?.(text)
    }, [])
    const announce = useCallback((text: string) => {
      // A trailing no-break space makes a repeated message a new one.
      if (mounted.current)
        setAnnouncement(value =>
          value.replace(/\u00a0$/u, '') === text ? `${value}\u00a0` : text
        )
    }, [])
    const hasRecovery = pendingText !== null
    useEffect(() => {
      if (hasRecovery) setExpanded(true)
    }, [hasRecovery])

    useEffect(() => {
      mounted.current = true
      void checkWhistleCache()
      return () => {
        mounted.current = false
        session.current?.cancel()
        session.current = null
        latest.current.onActiveChange?.(false)
      }
    }, [])
    // Fluid's install state lives in the desktop app; read it once so the
    // first shortcut already knows whether it can record.
    useEffect(() => {
      if (settings.engine === 'fluid')
        void refreshSpeechRuntime().catch(() => undefined)
    }, [settings.engine])

    const ended = useCallback(
      (end: SessionEnd) => {
        session.current = null
        if (!mounted.current) return
        setSnapshot(null)
        latest.current.onActiveChange?.(false)
        if (end.recovery) {
          const previous = latest.current.pendingText
          setPendingText(
            previous ? `${previous} ${end.recovery}` : end.recovery
          )
        }
        if (end.reason === 'cancelled') {
          setError('')
          announce(
            end.words
              ? 'Dictation cancelled. Phrases already inserted stay; undo with Ctrl / ⌘ Z.'
              : 'Dictation cancelled. Your writing is unchanged.'
          )
          return
        }
        if (end.error) {
          setExpanded(true)
          setError(end.error)
        } else setError('')
        if (end.words)
          announce(
            `Dictation finished. Inserted ${end.words} word${end.words === 1 ? '' : 's'}. Undo with Ctrl / ⌘ Z.`
          )
      },
      [announce, setPendingText]
    )

    const record = useCallback(async () => {
      if (session.current || opening.current) return
      const current = latest.current
      if (
        current.settings.engine === 'fluid' &&
        !getSpeechRuntimeStatus().installed.model
      ) {
        // A second shortcut while the desktop app answers must not open a
        // second session.
        opening.current = true
        await refreshSpeechRuntime().catch(() => undefined)
        opening.current = false
      }
      if (!mounted.current || session.current) return
      const choice = chooseDictationEngine(
        current.settings.engine,
        current.fallbackAccepted,
        readinessOf
      )
      if (!choice.engine) {
        setExpanded(true)
        setSetup({ engine: choice.preferred.id })
        announce(
          choice.readiness.state === 'setup'
            ? `Dictation needs ${choice.preferred.name}. ${choice.readiness.action}.`
            : choice.readiness.state === 'busy'
              ? `${choice.readiness.message}. Dictation starts when it is ready.`
              : choice.readiness.state === 'unavailable'
                ? choice.readiness.message
                : 'Set up dictation first.'
        )
        return
      }
      const engine = choice.engine
      setSetup(null)
      setError('')
      setPendingText(null)
      let capture: DictationCapture
      try {
        capture = current.onCapture()
      } catch (failure) {
        setExpanded(true)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Place the cursor where you want to dictate.'
        )
        return
      }
      const input = getDictationInput()
      const next = new DictationSession({
        engine,
        fallback:
          engine.id === 'fluid' && readinessOf(whistleEngine).state === 'ready'
            ? whistleEngine
            : null,
        capture,
        settings: current.settings,
        language: engine.id === 'fluid' ? 'en' : input.language,
        deviceId: input.deviceId,
        record: startDictationRecording,
        onUpdate: value => {
          if (mounted.current && session.current === next) setSnapshot(value)
        },
        onAnnounce: announce,
        onEnd: end => {
          if (session.current === next || session.current === null) ended(end)
        },
      })
      session.current = next
      setEngineLabel(choice.fallback ? engine.name : '')
      current.onActiveChange?.(true)
      await next.start()
    }, [announce, ended, setPendingText])

    const cancel = useCallback(() => {
      session.current?.cancel()
    }, [])
    const toggle = useCallback(() => {
      const active = session.current
      if (active) {
        if (active.state === 'listening') void active.finish()
        else if (active.state === 'starting') active.cancel()
        return
      }
      if (latest.current.pendingText !== null) {
        setExpanded(true)
        return
      }
      void record()
    }, [record])
    const actions = useRef({ toggle, cancel })
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
        } else if (event.key === 'Escape' && session.current) {
          event.preventDefault()
          event.stopPropagation()
          actions.current.cancel()
        }
      }
      const hide = () => {
        if (document.visibilityState === 'hidden') session.current?.cancel()
      }
      window.addEventListener('keydown', key, true)
      document.addEventListener('visibilitychange', hide)
      return () => {
        window.removeEventListener('keydown', key, true)
        document.removeEventListener('visibilitychange', hide)
      }
    }, [])

    const [busyAction, setBusyAction] = useState('')
    const downloadWhistle = async () => {
      setBusyAction('whistle')
      try {
        await downloadWhistleModel()
      } catch {
        // The panel shows Whistle's own error and the token guide.
      } finally {
        if (mounted.current) setBusyAction('')
      }
    }
    const downloadFluid = async () => {
      if (onOpenSettings) {
        onOpenSettings()
        return
      }
      setBusyAction('fluid')
      const result = await downloadFluidSpeech()
      if (!mounted.current) return
      setBusyAction('')
      if (result.error) setError(result.error)
    }

    const live = snapshot !== null
    // The anchor shows its plain marker until the chip is rendered into it.
    useEffect(() => {
      const marker = host?.parentElement
      if (!marker || !live) return
      marker.dataset.live = 'true'
      return () => {
        delete marker.dataset.live
      }
    }, [host, live])
    const chip = snapshot && (
      <DictationChip
        snapshot={snapshot}
        engineName={engineLabel}
        placement={host ? 'inline' : 'strip'}
        onFinish={() => actions.current.toggle()}
        onCancel={() => actions.current.cancel()}
      />
    )
    const liveRegion = (
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    )
    const setupView = setup && !live && (
      <SetupStrip
        engine={setup.engine}
        whistle={whistleReadiness(whistle)}
        fluid={fluidReadiness(speech)}
        busy={busyAction}
        onDownloadWhistle={() => {
          void downloadWhistle()
        }}
        onDownloadFluid={() => {
          void downloadFluid()
        }}
        onUseWhistle={() => {
          setFallbackAccepted(true)
          latest.current.fallbackAccepted = true
          setSetup(null)
          void record()
        }}
        onStart={() => {
          setSetup(null)
          void record()
        }}
        onOpenSettings={onOpenSettings}
      />
    )
    const showStrip =
      (live && !host) ||
      !!setupView ||
      (expanded && (!!error || pendingText !== null))
    return (
      <>
        {liveRegion}
        {chip && host && createPortal(chip, host)}
        {showStrip && (
          <section
            className={`inline-dictation ${live ? 'is-active' : ''}`}
            aria-label="Inline dictation"
          >
            {live && !host && <div className="dictation-strip">{chip}</div>}
            {setupView}
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
                  maxLength={WHISTLE_MAX_TEXT * 5}
                  rows={3}
                  onChange={event => setPendingText(event.target.value)}
                />
                <div className="dictation-recovery-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!pendingText.trim()}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => {
                      try {
                        latest.current.onRecoverInsert(pendingText)
                        setPendingText(null)
                        setError('')
                        announce('Transcript inserted.')
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
                    type="button"
                    className="button subtle"
                    onClick={() => {
                      setPendingText(null)
                      setError('')
                      announce('Transcript discarded.')
                    }}
                  >
                    Discard transcript
                  </button>
                </div>
              </div>
            )}
            {!live && (
              <button
                type="button"
                className="icon-button dictation-close"
                aria-label="Hide dictation controls"
                onClick={() => {
                  setExpanded(false)
                  setError('')
                  setSetup(null)
                }}
              >
                <X size={15} />
              </button>
            )}
          </section>
        )}
      </>
    )
  }
)

/** One clear next step when the chosen engine cannot record yet. */
function SetupStrip({
  engine,
  whistle,
  fluid,
  busy,
  onDownloadWhistle,
  onDownloadFluid,
  onUseWhistle,
  onStart,
  onOpenSettings,
}: {
  engine: DictationEngine['id']
  whistle: DictationReadiness
  fluid: DictationReadiness
  busy: string
  onDownloadWhistle(): void
  onDownloadFluid(): void
  onUseWhistle(): void
  onStart(): void
  onOpenSettings?(): void
}) {
  const wanted = engine === 'fluid' ? fluid : whistle
  const name = engine === 'fluid' ? 'Fluid Speech Mini' : 'Whistle'
  const percent = (value?: number) =>
    value === undefined ? '' : ` · ${Math.floor(value * 100)}%`
  let text: string
  let primary: ReactNode = null
  if (wanted.state === 'ready') {
    text = `${name} is ready.`
    primary = (
      <button type="button" className="button primary" onClick={onStart}>
        <Mic size={14} /> Start dictating
      </button>
    )
  } else if (wanted.state === 'busy') {
    text = `${wanted.message}${percent(wanted.progress)}. Dictation can start when it is ready.`
  } else if (wanted.state === 'unavailable') {
    text = wanted.message
  } else if (engine === 'fluid') {
    text =
      'Fluid Speech Mini is not downloaded yet. It is the most accurate choice for long dictation in English.'
    primary = (
      <button
        type="button"
        className="button primary"
        disabled={busy === 'fluid'}
        onClick={onDownloadFluid}
      >
        {busy === 'fluid' ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Download size={14} />
        )}
        {wanted.action}
      </button>
    )
  } else {
    text =
      'Whistle turns speech into text on this device after a one-time download.'
    primary = (
      <button
        type="button"
        className="button primary"
        disabled={busy === 'whistle'}
        onClick={onDownloadWhistle}
      >
        {busy === 'whistle' ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <Download size={14} />
        )}
        {wanted.action}
      </button>
    )
  }
  const offerWhistle = engine === 'fluid' && wanted.state !== 'ready'
  return (
    <div className="dictation-setup" role="group" aria-label="Set up dictation">
      <p className="dictation-setup-text">
        <Mic size={15} aria-hidden="true" />
        <span>{text}</span>
      </p>
      <div className="dictation-setup-actions">
        {primary}
        {offerWhistle &&
          (whistle.state === 'ready' ? (
            <button
              type="button"
              className="button secondary"
              onClick={onUseWhistle}
            >
              Use Whistle now
            </button>
          ) : whistle.state === 'setup' ? (
            <button
              type="button"
              className="button secondary"
              disabled={busy === 'whistle'}
              onClick={onDownloadWhistle}
            >
              {busy === 'whistle' && (
                <LoaderCircle size={14} className="spin" />
              )}
              Use Whistle instead · 17 MB
            </button>
          ) : whistle.state === 'busy' ? (
            <span className="dictation-setup-progress">
              <LoaderCircle size={13} className="spin" />
              {whistle.message}
              {percent(whistle.progress)}
            </span>
          ) : null)}
        {onOpenSettings && (
          <button
            type="button"
            className="button subtle"
            onClick={onOpenSettings}
          >
            <Settings2 size={14} /> Dictation settings
          </button>
        )}
      </div>
      <p className="dictation-setup-hint">
        {DICTATION_SHORTCUT} starts and finishes · Esc cancels
      </p>
    </div>
  )
}
