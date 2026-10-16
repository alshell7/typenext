import { useEffect, useState } from 'react'
import { Check, Eye, EyeOff, LoaderCircle, X } from 'lucide-react'
import { getSecret, isDesktop, setSecret } from '../../services/native'
import { StatusLine, errorText, type Tone } from './controls'

/**
 * An API key with show/hide, save and clear. Keys live in memory unless the
 * writer chooses the device credential vault on desktop.
 */
export function KeyField({
  id,
  label = 'API key',
  placeholder = 'Paste your key',
  onSaved,
}: {
  id: string
  label?: string
  placeholder?: string
  onSaved?(present: boolean): void
}) {
  const inputId = `key-${id}`
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')
  const [remember, setRemember] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ tone: Tone; text: string }>({
    tone: 'neutral',
    text: '',
  })
  useEffect(() => {
    let active = true
    void getSecret(id)
      .then(secret => {
        if (!active) return
        setValue(secret)
        setSaved(secret)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [id])
  const save = async (next: string) => {
    const trimmed = next.trim()
    setSaving(true)
    try {
      await setSecret(id, trimmed, remember)
      setSaved(trimmed)
      setValue(trimmed)
      setMessage({
        tone: 'ok',
        text: trimmed
          ? remember && isDesktop()
            ? 'Saved in your device credential vault.'
            : 'Ready for this session.'
          : 'Key removed.',
      })
      onSaved?.(Boolean(trimmed))
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'The key could not be saved.'),
      })
    } finally {
      setSaving(false)
    }
  }
  const dirty = value.trim() !== saved
  return (
    <div className="pref-key">
      <label className="pref-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="pref-key-row">
        <input
          id={inputId}
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={event => {
            setValue(event.target.value)
            setMessage({ tone: 'neutral', text: '' })
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void save(value)
            }
          }}
        />
        <button
          type="button"
          className="pref-icon-button"
          aria-label={reveal ? 'Hide key' : 'Show key'}
          aria-pressed={reveal}
          aria-controls={inputId}
          onClick={() => setReveal(current => !current)}
        >
          {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        <button
          type="button"
          className={`button ${dirty && value.trim() ? 'primary' : 'secondary'} is-compact`}
          disabled={saving}
          onClick={() => {
            void save(value)
          }}
        >
          {saving ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}
          Save key
        </button>
        {saved && (
          <button
            type="button"
            className="button subtle is-compact"
            disabled={saving}
            onClick={() => {
              void save('')
            }}
          >
            <X size={14} /> Clear
          </button>
        )}
      </div>
      {isDesktop() && (
        <label className="pref-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={event => {
              setRemember(event.target.checked)
              if (saved) setMessage({ tone: 'neutral', text: '' })
            }}
          />
          Remember in the device credential vault
        </label>
      )}
      <StatusLine tone={message.tone}>
        {message.text ||
          (saved
            ? 'A key is ready.'
            : 'Keys stay in memory unless you choose to remember them on desktop.')}
      </StatusLine>
    </div>
  )
}
