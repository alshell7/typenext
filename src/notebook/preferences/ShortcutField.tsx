import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ShortcutSettings } from '../../types/notebook'
import { DEFAULT_SHORTCUTS } from '../model'
import {
  bindingFromEvent,
  shortcutKeys,
  shortcutProblem,
  shortcutSpeech,
  SHORTCUT_LABELS,
} from '../shortcuts'

/**
 * A key recorder. Click, press the new keys, done. Escape cancels; a key the
 * app or another action already uses is refused with the reason.
 */
export function ShortcutField({
  name,
  shortcuts,
  onChange,
}: {
  name: keyof ShortcutSettings
  shortcuts: ShortcutSettings
  onChange(binding: string): void
}) {
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState('')
  const [held, setHeld] = useState<string[]>([])
  const button = useRef<HTMLButtonElement>(null)
  const value = shortcuts[name]
  const isDefault = value === DEFAULT_SHORTCUTS[name]

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey) {
        setRecording(false)
        setHeld([])
        return
      }
      const binding = bindingFromEvent(event)
      if (!binding) {
        // Show the modifiers as they are held.
        const modifiers = [
          event.metaKey && 'Meta',
          event.ctrlKey && 'Ctrl',
          event.altKey && 'Alt',
          event.shiftKey && 'Shift',
        ].filter(Boolean) as string[]
        setHeld(
          modifiers.length
            ? shortcutKeys(`${modifiers.join('-')}-x`).slice(0, -1)
            : []
        )
        return
      }
      const reason = shortcutProblem(binding, name, shortcuts)
      setRecording(false)
      setHeld([])
      if (reason) {
        setProblem(`${shortcutKeys(binding).join(' ')}: ${reason}`)
        return
      }
      setProblem('')
      onChange(binding)
    }
    const onUp = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
        setHeld([])
    }
    // Capture, so the editor and app shortcuts never see the press.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onUp, true)
    const stop = (event: PointerEvent) => {
      if (event.target !== button.current) setRecording(false)
    }
    document.addEventListener('pointerdown', stop, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onUp, true)
      document.removeEventListener('pointerdown', stop, true)
    }
  }, [recording, name, shortcuts, onChange])

  return (
    <div
      className="pref-shortcut-field"
      data-escape-local={recording || undefined}
    >
      <span className="pref-row-text">
        <span className="pref-row-label">{SHORTCUT_LABELS[name]}</span>
        {problem ? (
          <small className="pref-shortcut-problem" role="alert">
            {problem}
          </small>
        ) : (
          <small>
            {recording
              ? 'Press the new keys. Esc cancels.'
              : isDefault
                ? 'Default'
                : `Default ${shortcutKeys(DEFAULT_SHORTCUTS[name]).join(' ')}`}
          </small>
        )}
      </span>
      <span className="pref-shortcut-controls">
        <button
          ref={button}
          type="button"
          className={`pref-shortcut-button${recording ? ' is-recording' : ''}`}
          aria-label={`${SHORTCUT_LABELS[name]}: ${shortcutSpeech(value)}. Press to change`}
          aria-pressed={recording}
          onClick={() => {
            setProblem('')
            setRecording(value => !value)
          }}
        >
          {recording ? (
            held.length ? (
              held.map((key, index) => <kbd key={index}>{key}</kbd>)
            ) : (
              <span className="pref-shortcut-listening">
                <span aria-hidden="true" />
                Listening…
              </span>
            )
          ) : (
            shortcutKeys(value).map((key, index) => (
              <kbd key={index}>{key}</kbd>
            ))
          )}
        </button>
        <button
          type="button"
          className="pref-icon-button"
          aria-label={`Reset ${SHORTCUT_LABELS[name].toLocaleLowerCase()} to the default`}
          title="Reset to the default"
          disabled={isDefault}
          onClick={() => {
            setProblem('')
            onChange(DEFAULT_SHORTCUTS[name])
          }}
        >
          <RotateCcw size={14} />
        </button>
      </span>
    </div>
  )
}
