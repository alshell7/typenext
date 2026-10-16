import type { CSSProperties } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import type { DictationSnapshot } from './session'

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent || '')
export const DICTATION_SHORTCUT = IS_MAC ? '⌘⇧D' : 'Ctrl+Shift+D'

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function chipLabel(snapshot: DictationSnapshot): string {
  if (snapshot.phase === 'starting') return 'Opening microphone…'
  if (snapshot.phase === 'finishing')
    return snapshot.pending ? 'Writing it down…' : 'Finishing…'
  if (snapshot.quiet) return 'Microphone is very quiet'
  if (snapshot.speech === 'waiting') return 'Waiting for speech…'
  if (snapshot.stopIn !== null) return `Stopping in ${snapshot.stopIn} s`
  if (snapshot.speech === 'pause' && snapshot.pending) return 'Transcribing…'
  return 'Listening'
}

export type ChipTone = 'listening' | 'waiting' | 'warn' | 'busy'

export function chipTone(snapshot: DictationSnapshot): ChipTone {
  if (snapshot.phase !== 'listening') return 'busy'
  if (snapshot.quiet || snapshot.warning) return 'warn'
  if (snapshot.speech === 'waiting') return 'waiting'
  return 'listening'
}

/**
 * The listening chip. In the editor it sits at the dictation position, after
 * the faint preview of the phrase in progress. It never takes focus: its
 * buttons are for the pointer, and the keyboard uses the shortcuts.
 */
export function DictationChip({
  snapshot,
  engineName,
  placement,
  onFinish,
  onCancel,
}: {
  snapshot: DictationSnapshot
  engineName?: string
  placement: 'inline' | 'strip'
  onFinish(): void
  onCancel(): void
}) {
  const tone = chipTone(snapshot)
  const busy = snapshot.phase !== 'listening'
  const limited = snapshot.maxSeconds <= 60
  const nearLimit = limited && snapshot.seconds >= snapshot.maxSeconds - 10
  return (
    <>
      {snapshot.preview && placement === 'inline' && (
        <span className="dictation-preview">{snapshot.preview}</span>
      )}
      <span
        className={`dictation-chip is-${placement}`}
        data-tone={tone}
        title={snapshot.warning || undefined}
      >
        {busy ? (
          <LoaderCircle
            size={12}
            className="spin dictation-chip-spinner"
            aria-hidden="true"
          />
        ) : (
          <span
            className="dictation-meter"
            aria-hidden="true"
            style={{ '--voice-level': snapshot.level } as CSSProperties}
          >
            {[0, 1, 2, 3, 4].map(index => (
              <i key={index} />
            ))}
          </span>
        )}
        <span className="dictation-chip-label">{chipLabel(snapshot)}</span>
        <span
          className={`dictation-chip-time ${nearLimit ? 'is-near-limit' : ''}`}
        >
          {clock(snapshot.seconds)}
          {limited && ` / ${clock(snapshot.maxSeconds)}`}
        </span>
        {engineName && (
          <span className="dictation-chip-engine">{engineName}</span>
        )}
        {!busy && (
          <span className="dictation-chip-hint">
            <kbd>Esc</kbd> cancel · <kbd>{DICTATION_SHORTCUT}</kbd> finish
          </span>
        )}
        {!busy && (
          <button
            type="button"
            className="dictation-chip-button"
            tabIndex={placement === 'inline' ? -1 : 0}
            aria-label="Finish dictation"
            title={`Finish (${DICTATION_SHORTCUT})`}
            onMouseDown={event => event.preventDefault()}
            onClick={onFinish}
          >
            <Check size={12} />
          </button>
        )}
        <button
          type="button"
          className="dictation-chip-button"
          tabIndex={placement === 'inline' ? -1 : 0}
          aria-label="Cancel dictation"
          title="Cancel (Esc)"
          onMouseDown={event => event.preventDefault()}
          onClick={onCancel}
        >
          <X size={12} />
        </button>
      </span>
      {snapshot.preview && placement === 'strip' && (
        <span className="dictation-preview is-strip">{snapshot.preview}</span>
      )}
    </>
  )
}
