import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ReplayIcon } from '../components/Icons'
import { useInView } from '../hooks/useInView'
import { useReducedMotion } from '../hooks/useMediaQuery'
import {
  NOTES,
  SCRIPT,
  choiceText,
  ghostText,
  initialState,
  insertMatches,
  linkMatches,
  plainText,
  reducer,
  type Action,
  type Part,
  type State,
} from './model'
import './demo.css'

const TYPE_DELAY = 36

/** Keeps an absolutely positioned popup inside the editor horizontally. */
function useKeepInside(popup: React.RefObject<HTMLElement | null>, bounds: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = popup.current
    const box = bounds.current
    if (!el || !box) return
    el.style.translate = '0 0'
    const r = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    let dx = 0
    if (r.right > b.right - 8) dx = b.right - 8 - r.right
    if (r.left + dx < b.left + 8) dx = b.left + 8 - r.left
    el.style.translate = `${Math.round(dx)}px 0`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

function NoteCard({ title, missing, id }: { title: string; missing?: boolean; id: string }) {
  const note = NOTES.find(n => n.title === title)
  return (
    <span className="demo-card" role="tooltip" id={id}>
      <span className="demo-card-title">{title}</span>
      {note && !missing ? (
        <>
          <span className="demo-card-text">{note.excerpt}</span>
          <span className="demo-card-meta">
            {note.edited} · linked from {note.links} {note.links === 1 ? 'note' : 'notes'}
          </span>
          <span className="demo-card-action">Open note</span>
        </>
      ) : (
        <>
          <span className="demo-card-text">Not written yet.</span>
          <span className="demo-card-action">Create “{title}”</span>
        </>
      )}
    </span>
  )
}

function NoteLink({ title, missing, bounds }: { title: string; missing?: boolean; bounds: React.RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false)
  const timer = useRef(0)
  const id = useId()
  const card = useRef<HTMLSpanElement>(null)
  useKeepInside(card, bounds, [open])
  const show = () => {
    window.clearTimeout(timer.current)
    setOpen(true)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(false), 120)
  }
  return (
    <span className="demo-link-wrap" onPointerEnter={show} onPointerLeave={hide}>
      <button
        type="button"
        className={`demo-link${missing ? ' is-missing' : ''}`}
        aria-describedby={open ? id : undefined}
        onFocus={show}
        onBlur={hide}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <span className="demo-link-mark" aria-hidden="true">
          [[
        </span>
        {title}
        <span className="demo-link-mark" aria-hidden="true">
          ]]
        </span>
      </button>
      {open && (
        <span ref={card} className="demo-card-anchor">
          <NoteCard id={id} title={title} missing={missing} />
        </span>
      )}
    </span>
  )
}

function Popup({
  state,
  listId,
  dispatch,
  bounds,
}: {
  state: State
  listId: string
  dispatch: (action: Action) => void
  bounds: React.RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const menu = state.menu
  useKeepInside(ref, bounds, [menu?.kind, menu && 'query' in menu ? menu.query : ''])
  if (!menu) return null

  let label = ''
  let rows: { key: string; main: ReactNode; side?: ReactNode; section?: string }[] = []
  if (menu.kind === 'choices') {
    label = 'Suggestions'
    rows = state.choices.map((choice, index) => ({
      key: choice.text,
      main: choiceText(state, index).trim(),
      side: choice.source,
    }))
  } else if (menu.kind === 'insert') {
    label = 'Insert'
    rows = insertMatches(menu.query).map(item => ({ key: item.id, main: item.label, section: item.section }))
  } else {
    label = 'Link a note'
    rows = linkMatches(menu.query).map(option => ({
      key: option.title + option.missing,
      main: option.missing ? `New link · ${option.title}` : option.title,
      side: option.missing ? 'create the note later' : NOTES.find(n => n.title === option.title)?.edited,
    }))
  }

  return (
    <span ref={ref} className={`demo-popup demo-popup-${menu.kind}`}>
      <span className="demo-popup-label" aria-hidden="true">
        {label}
        {menu.kind !== 'choices' && <span className="demo-popup-query">{menu.query || 'type to filter'}</span>}
      </span>
      <span role="listbox" id={listId} aria-label={label} className="demo-popup-list">
        {rows.length === 0 && <span className="demo-popup-empty">No match. Escape keeps what you typed.</span>}
        {rows.map((row, index) => {
          const showSection = row.section && (index === 0 || rows[index - 1].section !== row.section)
          return (
            <span key={row.key} className="demo-popup-group">
              {showSection && (
                <span className="demo-popup-section" aria-hidden="true">
                  {row.section}
                </span>
              )}
              <span
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === menu.index}
                className="demo-option"
                onPointerDown={event => event.preventDefault()}
                onPointerEnter={() => {
                  if (index !== menu.index) dispatch({ type: 'menuMove', delta: index - menu.index })
                }}
                onClick={() => dispatch({ type: 'menuApply', index })}
              >
                <span className="demo-option-main">{row.main}</span>
                {row.side && <span className="demo-option-side">{row.side}</span>}
              </span>
            </span>
          )
        })}
      </span>
      <span className="demo-popup-foot" aria-hidden="true">
        ↑↓ preview · Enter accept · Esc close
      </span>
    </span>
  )
}

function renderPart(part: Part, bounds: React.RefObject<HTMLElement | null>) {
  if (part.kind === 'link') return <NoteLink key={part.id} title={part.title} missing={part.missing} bounds={bounds} />
  return (
    <span key={part.id} className={part.fresh ? 'demo-fresh' : undefined}>
      {part.text}
    </span>
  )
}

const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0)

const STATIC_WORDS = wordCount(
  'A morning at Bramble House The house wakes slowly. Tea first, then the shutters, then a look at the Guest list. Air the garden room Bake the bread'
)

export default function LiveDemo() {
  const reduced = useReducedMotion()
  const [state, dispatch] = useReducer(reducer, reduced, initialState)
  const [rootRef, inView] = useInView<HTMLDivElement>('0px 0px -20% 0px')
  const editorRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  const [tasks, setTasks] = useState([true, false])
  const listId = useId()
  const helpId = useId()
  const ghost = ghostText(state)
  const menu = state.menu
  const text = plainText(state.parts)

  // Start typing when the demo scrolls into view.
  useEffect(() => {
    if (inView && state.phase === 'waiting') {
      if (reduced) dispatch({ type: 'finishScript' })
      else dispatch({ type: 'start' })
    }
  }, [inView, reduced, state.phase])

  useEffect(() => {
    if (state.phase !== 'typing') return
    const char = SCRIPT[state.typed]
    const pause = char === ',' || char === ' ' ? TYPE_DELAY * 1.8 : TYPE_DELAY + Math.random() * 30
    const timer = window.setTimeout(() => dispatch({ type: 'tick' }), pause)
    return () => window.clearTimeout(timer)
  }, [state.phase, state.typed])

  // Offer a suggestion after a pause, as TypeNext does after you stop typing.
  useEffect(() => {
    if (state.phase !== 'ready' || state.ghost || menu || state.quiet) return
    const wait = state.offeredScript ? 1200 : reduced ? 0 : 550
    const timer = window.setTimeout(() => dispatch({ type: 'suggest' }), wait)
    return () => window.clearTimeout(timer)
  }, [state.phase, state.ghost, menu, state.quiet, state.offeredScript, state.edits, reduced])

  const focusEditor = useCallback(() => editorRef.current?.focus({ preventScroll: true }), [])

  const run = useCallback(
    (action: Action) => {
      dispatch(action)
      focusEditor()
    },
    [focusEditor]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Links and task boxes inside the note keep their own keys.
    if (event.target !== event.currentTarget) return
    const mod = event.ctrlKey || event.metaKey
    const key = event.key
    if (mod && (key === ' ' || event.code === 'Space')) {
      event.preventDefault()
      dispatch({ type: 'openChoices' })
      return
    }
    if (menu) {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        dispatch({ type: 'menuMove', delta: key === 'ArrowDown' ? 1 : -1 })
        return
      }
      if (key === 'Enter' || key === 'Tab') {
        event.preventDefault()
        dispatch({ type: 'menuApply' })
        return
      }
      if (key === 'Escape') {
        event.preventDefault()
        dispatch({ type: 'menuClose' })
        return
      }
    }
    if (key === 'Tab' && !event.shiftKey && ghost) {
      event.preventDefault()
      dispatch({ type: 'accept' })
      return
    }
    if (mod && key === 'ArrowRight' && ghost) {
      event.preventDefault()
      dispatch({ type: 'accept', word: true })
      return
    }
    if (key === 'Escape' && ghost) {
      event.preventDefault()
      dispatch({ type: 'dismiss' })
      return
    }
    if (key === 'Backspace') {
      event.preventDefault()
      dispatch({ type: 'backspace' })
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      return
    }
    if (key.length === 1 && !mod && !event.altKey) {
      event.preventDefault()
      dispatch({ type: 'type', char: key })
    }
  }

  const typing = state.phase === 'typing' || state.phase === 'waiting'
  const activeOption = menu ? `${listId}-${menu.index}` : undefined
  const words = STATIC_WORDS + wordCount(text || SCRIPT.slice(0, state.typed))

  return (
    <div className="demo" ref={rootRef}>
      <div className="demo-window">
        <div className="demo-titlebar" aria-hidden="true">
          <span className="demo-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="demo-tabs">
            <span className="demo-tab is-active">A morning at Bramble House</span>
            <span className="demo-tab">Guest list</span>
            <span className="demo-tab-plus">+</span>
          </span>
          <span className="demo-tools">
            <span>Context</span>
          </span>
        </div>
        <div className="demo-body">
          <div className="demo-sidebar" aria-hidden="true">
            <span className="demo-side-new">New note</span>
            <span className="demo-side-search">Find a note</span>
            <span className="demo-side-label">Your notes</span>
            <span className="demo-side-note is-active">
              A morning at Bramble House<small>Today</small>
            </span>
            {NOTES.map(note => (
              <span key={note.title} className="demo-side-note">
                {note.title}
                <small>{note.edited.replace('Edited on ', '').replace('Edited ', '').replace(/^./, c => c.toUpperCase())}</small>
              </span>
            ))}
          </div>
          <div className="demo-page" ref={pageRef}>
            <p className="demo-title">A morning at Bramble House</p>
            <p className="demo-objective">
              <span>Objective</span> A calm guide for the morning shift
            </p>
            <div
              ref={editorRef}
              className={`demo-editor${focused ? ' is-focused' : ''}`}
              role="textbox"
              aria-multiline="true"
              aria-label="Demo note"
              aria-describedby={helpId}
              aria-haspopup="listbox"
              aria-controls={menu ? listId : undefined}
              aria-activedescendant={activeOption}
              tabIndex={0}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onClick={event => {
                if (event.target === event.currentTarget || (event.target as HTMLElement).closest('.demo-line'))
                  focusEditor()
              }}
            >
              <p className="demo-line">
                The house wakes slowly. Tea first, then the shutters, then a look at the{' '}
                <NoteLink title="Guest list" bounds={pageRef} />.
              </p>
              <ul className="demo-tasks">
                {['Air the garden room', 'Bake the bread'].map((task, index) => (
                  <li key={task} className={tasks[index] ? 'is-done' : undefined}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={tasks[index]}
                      className="demo-check"
                      onClick={() => setTasks(list => list.map((done, i) => (i === index ? !done : done)))}
                    >
                      <span className="sr-only">{task}</span>
                    </button>
                    <span aria-hidden="true">{task}</span>
                  </li>
                ))}
              </ul>
              <p className="demo-line demo-active">
                {typing ? <span>{SCRIPT.slice(0, state.typed)}</span> : state.parts.map(part => renderPart(part, pageRef))}
                {menu?.kind === 'insert' && <span className="demo-trigger">/{menu.query}</span>}
                {menu?.kind === 'link' && <span className="demo-trigger">[[{menu.query}</span>}
                <span className="demo-caret-anchor">
                  <span className={`demo-caret${typing && state.phase === 'typing' ? ' is-typing' : ''}`} aria-hidden="true" />
                  {menu && <Popup state={state} listId={listId} dispatch={run} bounds={pageRef} />}
                </span>
                {ghost && (
                  <span className="demo-ghost" aria-hidden="true">
                    {ghost}
                  </span>
                )}
                {ghost && !menu && (
                  <button
                    type="button"
                    className="demo-tab-badge"
                    tabIndex={-1}
                    aria-label="Accept the suggestion"
                    onPointerDown={event => event.preventDefault()}
                    onClick={() => run({ type: 'accept' })}
                  >
                    Tab
                  </button>
                )}
              </p>
            </div>
            <p id={helpId} className="sr-only">
              A demonstration editor. Type to write. When a grey suggestion shows, press Tab to accept it, Control
              plus Right Arrow to accept one word, or Escape to dismiss it. Control plus Space shows three choices.
              Type a slash for the insert menu, or two opening brackets to link a note.
            </p>
          </div>
        </div>
        <div className="demo-status">
          <span className="demo-engine">
            <span className="demo-engine-dot" aria-hidden="true" />
            Writing starters &amp; recall
            <span className="demo-engine-where">On this device</span>
          </span>
          <span className="demo-count">
            {words} words
          </span>
        </div>
      </div>

      <div className="demo-hints" role="toolbar" aria-label="Try the demo">
        <button type="button" className="hint" disabled={!ghost || Boolean(menu)} onClick={() => run({ type: 'accept' })}>
          <kbd>Tab</kbd>
          <span>Accept</span>
        </button>
        <button type="button" className="hint" onClick={() => run({ type: 'openChoices' })}>
          <kbd>Ctrl</kbd>
          <kbd>Space</kbd>
          <span>{menu?.kind === 'choices' ? 'Next choice' : 'Choices'}</span>
        </button>
        <button type="button" className="hint" onClick={() => run({ type: 'openInsert' })}>
          <kbd>/</kbd>
          <span>Insert</span>
        </button>
        <button type="button" className="hint" onClick={() => run({ type: 'openLink' })}>
          <kbd>[[</kbd>
          <span>Link a note</span>
        </button>
        <button
          type="button"
          className="hint hint-replay"
          onClick={() => {
            setTasks([true, false])
            dispatch({ type: 'replay', skipTyping: reduced })
            if (!reduced) window.setTimeout(() => dispatch({ type: 'start' }), 60)
          }}
        >
          <ReplayIcon size={15} />
          <span>Replay</span>
        </button>
      </div>
      <p className="demo-note">
        Click the note and type. Suggestions here are scripted; in TypeNext they come from your writing, your
        contexts and the engine you choose.
      </p>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {state.announcement}
      </div>
    </div>
  )
}
