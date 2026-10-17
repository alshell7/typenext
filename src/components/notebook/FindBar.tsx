import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronRight,
  Regex,
  Search,
  WholeWord,
  X,
} from 'lucide-react'
import type { FindQuery } from './find'

export interface FindInfo {
  /** The selected match, from 0, or -1. */
  index: number
  total: number
  truncated?: boolean
  error?: string
}

export interface FindControls {
  setQuery(query: FindQuery | null, reveal: boolean): void
  next(direction: 1 | -1): void
  replace(text: string): void
  replaceAll(text: string): number
  close(): void
}

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent)

/**
 * A small floating bar at the top of the page. It stays out of the writing:
 * no toolbar row, nothing until ⌘ F, gone with Escape. Matches are found as
 * you type; Enter moves on, Shift Enter moves back.
 */
export function FindBar({
  mode,
  initial,
  focusToken,
  info,
  controls,
}: {
  mode: 'find' | 'replace'
  /** Text to search for when the bar opens. */
  initial: string
  /** Changes each time ⌘ F is pressed, to focus the field again. */
  focusToken: number
  info: FindInfo
  controls: FindControls
}) {
  const [search, setSearch] = useState(initial)
  const [replacement, setReplacement] = useState('')
  const [replacing, setReplacing] = useState(mode === 'replace')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [message, setMessage] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const replaceField = useRef<HTMLInputElement>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  // A new ⌘ F (or ⌘ ⌥ F) focuses the field, with any newly selected text.
  useLayoutEffect(() => {
    if (initial) setSearch(initial)
    if (mode === 'replace') setReplacing(true)
    const target =
      mode === 'replace' && initial ? replaceField.current : field.current
    ;(target ?? field.current)?.focus()
    if (target === field.current) field.current?.select()
    // Only for a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken])

  const first = useRef(true)
  useEffect(() => {
    // The first query only highlights; typing then moves to the nearest match.
    controlsRef.current.setQuery(
      { search, caseSensitive, wholeWord, regex },
      !first.current
    )
    first.current = false
    setMessage('')
  }, [search, caseSensitive, wholeWord, regex])

  useEffect(() => () => controlsRef.current.setQuery(null, false), [])

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      controls.close()
    } else if (event.altKey && !event.metaKey && !event.ctrlKey) {
      const key = event.code
      if (key === 'KeyC') setCaseSensitive(value => !value)
      else if (key === 'KeyW') setWholeWord(value => !value)
      else if (key === 'KeyR') setRegex(value => !value)
      else return
      event.preventDefault()
    }
  }

  const status = info.error
    ? 'Pattern not valid'
    : !search
      ? ''
      : info.total
        ? `${info.index >= 0 ? info.index + 1 : '–'} of ${info.total}${info.truncated ? '+' : ''}`
        : 'No results'
  const toggle = (
    label: string,
    keys: string,
    on: boolean,
    set: (value: boolean) => void,
    Icon: typeof Search
  ) => (
    <button
      type="button"
      className="find-toggle"
      aria-label={label}
      title={`${label} (${isMac ? '⌥' : 'Alt'} ${keys})`}
      aria-pressed={on}
      onMouseDown={event => event.preventDefault()}
      onClick={() => set(!on)}
    >
      <Icon size={15} />
    </button>
  )

  return (
    <div className="find-anchor">
      <div
        className={`find-bar${replacing ? ' is-replacing' : ''}${search && !info.total ? ' is-empty' : ''}`}
        role="search"
        aria-label="Find in note"
        onKeyDown={onKey}
      >
        <div className="find-row">
          <button
            type="button"
            className="find-expand"
            aria-label={replacing ? 'Hide replace' : 'Replace'}
            title={
              replacing
                ? 'Hide replace'
                : `Replace (${isMac ? '⌘ ⌥ F' : 'Ctrl Alt F'})`
            }
            aria-expanded={replacing}
            onClick={() => {
              setReplacing(value => !value)
              requestAnimationFrame(() =>
                (replacing ? field : replaceField).current?.focus()
              )
            }}
          >
            <ChevronRight size={14} />
          </button>
          <label className="find-field">
            <Search size={14} aria-hidden="true" />
            <input
              ref={field}
              aria-label="Find in note"
              placeholder="Find"
              value={search}
              spellCheck={false}
              autoComplete="off"
              maxLength={500}
              onChange={event => setSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  controls.next(event.shiftKey ? -1 : 1)
                }
              }}
            />
            <span className="find-count" role="status" aria-live="polite">
              {status}
            </span>
          </label>
          {toggle(
            'Match case',
            'C',
            caseSensitive,
            setCaseSensitive,
            CaseSensitive
          )}
          {toggle('Whole word', 'W', wholeWord, setWholeWord, WholeWord)}
          {toggle('Pattern', 'R', regex, setRegex, Regex)}
          <span className="find-divider" aria-hidden="true" />
          <button
            type="button"
            className="find-toggle"
            aria-label="Previous match"
            title="Previous (Shift Enter)"
            disabled={!info.total}
            onMouseDown={event => event.preventDefault()}
            onClick={() => controls.next(-1)}
          >
            <ArrowUp size={15} />
          </button>
          <button
            type="button"
            className="find-toggle"
            aria-label="Next match"
            title="Next (Enter)"
            disabled={!info.total}
            onMouseDown={event => event.preventDefault()}
            onClick={() => controls.next(1)}
          >
            <ArrowDown size={15} />
          </button>
          <button
            type="button"
            className="find-toggle"
            aria-label="Close find"
            title="Close (Esc)"
            onClick={() => controls.close()}
          >
            <X size={15} />
          </button>
        </div>
        {replacing && (
          <div className="find-row find-replace-row">
            <label className="find-field">
              <input
                ref={replaceField}
                aria-label="Replace with"
                placeholder="Replace"
                value={replacement}
                spellCheck={false}
                autoComplete="off"
                maxLength={2000}
                onChange={event => setReplacement(event.target.value)}
                onKeyDown={event => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  if (event.metaKey || event.ctrlKey || event.altKey) {
                    const count = controls.replaceAll(replacement)
                    setMessage(count ? `Replaced ${count}` : '')
                  } else controls.replace(replacement)
                }}
              />
              {message && <span className="find-count is-done">{message}</span>}
            </label>
            <button
              type="button"
              className="find-action"
              disabled={!info.total}
              title="Replace (Enter)"
              onMouseDown={event => event.preventDefault()}
              onClick={() => controls.replace(replacement)}
            >
              Replace
            </button>
            <button
              type="button"
              className="find-action"
              disabled={!info.total}
              title={`Replace all (${isMac ? '⌘' : 'Ctrl'} Enter)`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                const count = controls.replaceAll(replacement)
                setMessage(count ? `Replaced ${count}` : '')
              }}
            >
              All
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
