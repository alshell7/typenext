import * as Dialog from '@radix-ui/react-dialog'
import {
  ChevronRight,
  Command,
  FileText,
  Hash,
  Plus,
  Search,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { Note } from '../types/notebook'
import {
  buildPalette,
  flattenGroups,
  nextGroupStart,
  parseQuery,
  type MatchRange,
  type PaletteItem,
} from './command-palette'
import { relativeDate } from './model'
import './command-palette.css'

export interface PaletteAction {
  id: string
  /** "New note", "Zen mode: Hide toolbars" */
  title: string
  section: 'Actions' | 'Go to' | 'Preferences' | 'Insert'
  keywords?: string[]
  /** Display text, e.g. "⌘ N"; the caller passes the platform's text. */
  shortcut?: string
  icon?: ReactNode
  run(): void
  disabled?: boolean
}

export interface PaletteHeading {
  level: number
  text: string
  from: number
}

type Item = PaletteItem<PaletteAction, PaletteHeading>

export interface CommandPaletteProps {
  open: boolean
  onOpenChange(open: boolean): void
  notes: Note[]
  activeNoteId: string | null
  /** Headings of the active note, in document order. */
  headings: PaletteHeading[]
  actions: PaletteAction[]
  onOpenNote(id: string): void
  onCreateNote(title: string): void
  onJumpToHeading(heading: PaletteHeading): void
}

/** Wraps matched characters in <mark>; ranges are sorted and disjoint. */
function Highlight({
  text,
  ranges,
}: {
  text: string
  ranges: readonly MatchRange[]
}) {
  if (!ranges.length) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach(([start, end], index) => {
    const from = Math.max(cursor, Math.min(start, text.length))
    const to = Math.min(end, text.length)
    if (to <= from) return
    if (from > cursor) parts.push(text.slice(cursor, from))
    parts.push(<mark key={index}>{text.slice(from, to)}</mark>)
    cursor = to
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

const MODE_LABEL = { actions: 'Actions', headings: 'Headings' } as const

export function CommandPalette({
  open,
  onOpenChange,
  notes,
  activeNoteId,
  headings,
  actions,
  onOpenNote,
  onCreateNote,
  onJumpToHeading,
}: CommandPaletteProps) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const list = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  /** Runs after the palette has closed and handed focus back. */
  const pending = useRef<(() => void) | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  // Remember where focus was before opening, as Modal does: the editor
  // usually, so Escape puts the caret back exactly where it was.
  useEffect(() => {
    if (open) return
    const remember = () => {
      const element = document.activeElement
      if (
        element instanceof HTMLElement &&
        element !== document.body &&
        element !== document.documentElement &&
        !element.closest('[role="dialog"]')
      )
        returnFocus.current = element
    }
    remember()
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [open])

  // Each opening starts empty. The reset happens during render, so the
  // first frame and the first typed character never see an old query.
  const [shown, setShown] = useState(open)
  if (shown !== open) {
    setShown(open)
    if (open) {
      setQuery('')
      setHighlight(0)
    }
  }
  useEffect(() => {
    if (open) pending.current = null
  }, [open])
  const close = (next: boolean) => {
    if (!next) {
      setQuery('')
      setHighlight(0)
    }
    onOpenChange(next)
  }

  const { mode } = parseQuery(query)
  const groups = useMemo(
    () =>
      open
        ? buildPalette<PaletteAction, PaletteHeading>({
            query,
            notes,
            activeNoteId,
            headings,
            actions,
          })
        : [],
    [open, query, notes, activeNoteId, headings, actions]
  )
  const { starts, total } = useMemo(() => flattenGroups(groups), [groups])
  const current = Math.min(highlight, Math.max(0, total - 1))
  const selected = useMemo(() => {
    for (let index = groups.length - 1; index >= 0; index--)
      if (starts[index]! <= current)
        return groups[index]!.items[current - starts[index]!]
    return undefined
  }, [groups, starts, current])

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [current, groups])

  const choose = (item: Item | undefined) => {
    if (!item) return
    if (item.kind === 'action' && item.action.disabled) return
    pending.current =
      item.kind === 'note'
        ? () => onOpenNote(item.note.id)
        : item.kind === 'heading'
          ? () => onJumpToHeading(item.heading)
          : item.kind === 'action'
            ? () => item.action.run()
            : () => onCreateNote(item.title)
    close(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (total)
        setHighlight(
          (current + (event.key === 'ArrowDown' ? 1 : total - 1)) % total
        )
    } else if (event.key === 'Tab') {
      // Focus stays in the field; Tab steps between groups instead.
      event.preventDefault()
      if (total)
        setHighlight(nextGroupStart(starts, current, event.shiftKey ? -1 : 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(selected)
    }
  }

  /** The hint buttons toggle a prefix mode, keeping what was typed. */
  const toggleMode = (prefix: '>' | '#') => {
    const rest = query.trimStart().replace(/^[>#]\s*/u, '')
    const on = mode === (prefix === '>' ? 'actions' : 'headings')
    setQuery(on ? rest : `${prefix} ${rest}`)
    setHighlight(0)
    input.current?.focus()
  }

  const results = total - (groups.some(group => group.id === 'create') ? 1 : 0)
  const status = !query.trim()
    ? ''
    : results
      ? plural(results, 'result')
      : 'No matches'
  const enterLabel =
    selected?.kind === 'action'
      ? 'run'
      : selected?.kind === 'create'
        ? 'create'
        : selected?.kind === 'heading'
          ? 'jump'
          : 'open'

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay command-palette-overlay" />
        <Dialog.Content
          className="command-palette"
          onOpenAutoFocus={event => {
            event.preventDefault()
            input.current?.focus()
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            const run = pending.current
            pending.current = null
            if (
              returnFocus.current?.isConnected &&
              !document.querySelector('[role="dialog"]')
            )
              returnFocus.current.focus({ preventScroll: true })
            // The chosen command runs last so it may move focus itself
            // (into the editor, a title field or another dialog).
            run?.()
          }}
        >
          <Dialog.Title className="visually-hidden">
            Command palette
          </Dialog.Title>
          <Dialog.Description className="visually-hidden">
            Search notes, headings in this note and actions. Type &gt; for
            actions only or # for headings only.
          </Dialog.Description>
          <div className="cmd-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={input}
              type="text"
              role="combobox"
              aria-label="Search notes, headings and actions"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                selected ? `${id}-option-${current}` : undefined
              }
              placeholder={
                mode === 'actions'
                  ? 'Run an action…'
                  : mode === 'headings'
                    ? 'Jump to a heading…'
                    : 'Search notes, headings and actions…'
              }
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              value={query}
              onChange={event => {
                setQuery(event.target.value)
                setHighlight(0)
              }}
              onKeyDown={onKeyDown}
            />
            {mode !== 'all' && (
              <span className="cmd-mode" aria-hidden="true">
                {MODE_LABEL[mode]}
              </span>
            )}
          </div>
          <div
            className="cmd-list"
            role="listbox"
            id={`${id}-list`}
            aria-label="Results"
            ref={list}
          >
            {groups.map((group, groupIndex) => (
              <div
                role="group"
                key={group.id}
                aria-labelledby={`${id}-group-${groupIndex}`}
                className="cmd-group"
              >
                <div
                  className="cmd-group-label"
                  id={`${id}-group-${groupIndex}`}
                  role="presentation"
                >
                  {group.label}
                </div>
                {group.items.map((item, itemIndex) => {
                  const index = starts[groupIndex]! + itemIndex
                  return (
                    <Option
                      key={item.key}
                      id={`${id}-option-${index}`}
                      index={index}
                      item={item}
                      selected={index === current}
                      active={
                        item.kind === 'note' && item.note.id === activeNoteId
                      }
                      onHover={() => {
                        if (index !== current) setHighlight(index)
                      }}
                      onChoose={() => choose(item)}
                    />
                  )
                })}
              </div>
            ))}
            {!total && (
              <p className="cmd-empty">
                {mode === 'headings'
                  ? headings.length
                    ? 'No heading matches.'
                    : 'This note has no headings yet.'
                  : mode === 'actions'
                    ? 'No action matches.'
                    : 'Nothing here yet.'}
              </p>
            )}
          </div>
          <div className="cmd-hints">
            <span className="cmd-keys" aria-hidden="true">
              <kbd>↑</kbd>
              <kbd>↓</kbd> move <Sep /> <kbd>↵</kbd> {enterLabel} <Sep />
              <kbd>esc</kbd> close
            </span>
            <span className="cmd-prefixes">
              <button
                type="button"
                tabIndex={-1}
                className={mode === 'actions' ? 'is-on' : ''}
                aria-pressed={mode === 'actions'}
                onMouseDown={event => event.preventDefault()}
                onClick={() => toggleMode('>')}
              >
                <kbd>&gt;</kbd> actions
              </button>
              <button
                type="button"
                tabIndex={-1}
                className={mode === 'headings' ? 'is-on' : ''}
                aria-pressed={mode === 'headings'}
                onMouseDown={event => event.preventDefault()}
                onClick={() => toggleMode('#')}
              >
                <kbd>#</kbd> headings
              </button>
            </span>
          </div>
          <div className="visually-hidden" role="status" aria-live="polite">
            {status}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Sep() {
  return <span className="cmd-sep">·</span>
}

function Option({
  id,
  index,
  item,
  selected,
  active,
  onHover,
  onChoose,
}: {
  id: string
  index: number
  item: Item
  selected: boolean
  active: boolean
  onHover(): void
  onChoose(): void
}) {
  const disabled = item.kind === 'action' && Boolean(item.action.disabled)
  let icon: ReactNode
  let title: ReactNode
  let detail: ReactNode = null
  let end: ReactNode = null
  switch (item.kind) {
    case 'note':
      icon = <FileText size={15} />
      title = <Highlight text={item.title} ranges={item.ranges} />
      detail = (
        <>
          {active ? 'Open now · ' : ''}
          {relativeDate(item.note.updatedAt)}
          {item.snippet && (
            <>
              {' · '}
              <span className="cmd-snippet">
                <Highlight
                  text={item.snippet.text}
                  ranges={item.snippet.ranges}
                />
              </span>
            </>
          )}
        </>
      )
      end = selected ? <ChevronRight size={14} /> : null
      break
    case 'heading':
      icon = <Hash size={14} />
      title = (
        <Highlight text={item.heading.text || 'Heading'} ranges={item.ranges} />
      )
      end = <span className="cmd-level">H{item.heading.level}</span>
      break
    case 'action':
      icon = item.action.icon ?? <Command size={14} />
      title = <Highlight text={item.action.title} ranges={item.ranges} />
      end = item.action.shortcut ? (
        <kbd className="cmd-shortcut">{item.action.shortcut}</kbd>
      ) : null
      break
    case 'create':
      icon = <Plus size={15} />
      title = (
        <>
          Create note “<span className="cmd-create-title">{item.title}</span>”
        </>
      )
      break
  }
  return (
    <div
      id={id}
      data-index={index}
      data-kind={item.kind}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      className={`cmd-option${active ? ' is-active' : ''}`}
      style={
        item.kind === 'heading'
          ? ({
              '--cmd-indent': `${Math.min(Math.max(item.heading.level - 1, 0), 4) * 12}px`,
            } as CSSProperties)
          : undefined
      }
      onMouseMove={onHover}
      onMouseDown={event => event.preventDefault()}
      onClick={onChoose}
    >
      <span className="cmd-option-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="cmd-option-text">
        <span className="cmd-option-title">{title}</span>
        {detail && <small className="cmd-option-detail">{detail}</small>}
      </span>
      {end && (
        <span className="cmd-option-end" aria-hidden="true">
          {end}
        </span>
      )}
    </div>
  )
}
