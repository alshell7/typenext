import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  Bookmark,
  BookmarkCheck,
  Check,
  Clock,
  History,
  LifeBuoy,
  PenLine,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { Note } from '../../types/notebook'
import { textHash } from '../../services/vector-store'
import { Modal } from '../Modal'
import { lineDiff, revertHunks, wordDiff, type Hunk } from './diff'
import {
  deleteRevision,
  listRevisions,
  revisionText,
  subscribeRevisions,
  updateRevision,
  type RevisionMeta,
} from './store'
import './revisions.css'

type View = 'since' | 'within' | 'read'

const KIND: Record<
  RevisionMeta['kind'],
  { label: string; icon: typeof Clock }
> = {
  auto: { label: 'Automatic', icon: Clock },
  manual: { label: 'Saved', icon: Save },
  safety: { label: 'Safety copy', icon: LifeBuoy },
  restore: { label: 'Restored', icon: RotateCcw },
  merge: { label: 'Merged', icon: Sparkles },
}

function time(value: number) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function dayLabel(value: number) {
  const date = new Date(value)
  const today = new Date()
  const start = (day: Date) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const days = Math.round((start(today) - start(date)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    weekday: days < 7 ? 'long' : undefined,
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

function titleOf(revision: RevisionMeta) {
  return revision.label ?? revision.reason ?? revision.summary
}

/** A hunk shown with its neighbouring lines, changes marked word by word. */
function HunkView({
  hunk,
  newer,
  chosen,
  onToggle,
  onRestore,
  interactive,
}: {
  hunk: Hunk
  newer: string[]
  chosen: boolean
  onToggle(): void
  onRestore(): void
  interactive: boolean
}) {
  const before = newer.slice(Math.max(0, hunk.newStart - 2), hunk.newStart)
  const after = newer.slice(
    hunk.newStart + hunk.newLines.length,
    hunk.newStart + hunk.newLines.length + 2
  )
  const segments = wordDiff(hunk.oldLines.join('\n'), hunk.newLines.join('\n'))
  const kind = !hunk.oldLines.length
    ? 'Added'
    : !hunk.newLines.length
      ? 'Removed'
      : 'Changed'
  return (
    <article
      className={`history-hunk${chosen ? ' is-chosen' : ''}`}
      aria-label={`${kind} at line ${hunk.newStart + 1}`}
    >
      <header className="history-hunk-head">
        {interactive ? (
          <label className="history-hunk-choose">
            <input type="checkbox" checked={chosen} onChange={onToggle} />
            <span>
              {kind} · line {hunk.newStart + 1}
            </span>
          </label>
        ) : (
          <span className="history-hunk-kind">
            {kind} · line {hunk.newStart + 1}
          </span>
        )}
        {interactive && (
          <button
            type="button"
            className="history-link-button"
            onClick={onRestore}
          >
            <Undo2 size={13} aria-hidden="true" /> Bring back this part
          </button>
        )}
      </header>
      <div className="history-hunk-body">
        {before.map((line, index) => (
          <div className="history-context" key={`b${index}`}>
            {line || ' '}
          </div>
        ))}
        <div className="history-change">
          {segments.map((segment, index) =>
            segment.op === 'equal' ? (
              <span key={index}>{segment.text}</span>
            ) : segment.op === 'delete' ? (
              <del key={index}>{segment.text}</del>
            ) : (
              <ins key={index}>{segment.text}</ins>
            )
          )}
          {!segments.length && ' '}
        </div>
        {after.map((line, index) => (
          <div className="history-context" key={`a${index}`}>
            {line || ' '}
          </div>
        ))}
      </div>
    </article>
  )
}

export function RevisionHistory({
  open,
  onOpenChange,
  note,
  enabled,
  onSaveRevision,
  onReplace,
  onOpenSettings,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  note: Note | undefined
  enabled: boolean
  onSaveRevision(label?: string): Promise<unknown>
  /** Replace the note's text: a whole revision or a merge of parts. */
  onReplace(
    text: string,
    how: { kind: 'restore' | 'merge'; revision: RevisionMeta }
  ): Promise<void>
  onOpenSettings(): void
}) {
  const noteId = note?.id
  const current = note?.content ?? ''
  const [revisions, setRevisions] = useState<RevisionMeta[]>([])
  const [loaded, setLoaded] = useState(false)
  // null: the current note. Otherwise a revision id.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [view, setView] = useState<View>('since')
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const list = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    if (!noteId) return
    const next = await listRevisions(noteId).catch(() => [])
    setRevisions(next)
    setLoaded(true)
  }, [noteId])

  useEffect(() => {
    if (!open || !noteId) return
    setLoaded(false)
    setSelectedId(null)
    setMessage('')
    void refresh()
    return subscribeRevisions(changed => {
      if (changed === noteId || changed === '*') void refresh()
    })
  }, [open, noteId, refresh])

  // Choose the newest revision once the list arrives.
  useEffect(() => {
    if (open && loaded && selectedId === null && revisions[0])
      setSelectedId(revisions[0].id)
    // Only when the list first loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded])

  const index = revisions.findIndex(item => item.id === selectedId)
  const selected = index >= 0 ? revisions[index] : undefined
  const previous = index >= 0 ? revisions[index + 1] : undefined

  // Load the texts the comparison needs.
  useEffect(() => {
    const needed = [selected?.id, previous?.id].filter(
      (id): id is string => Boolean(id) && texts[id!] === undefined
    )
    if (!needed.length) return
    let live = true
    void Promise.all(
      needed.map(async id => [id, (await revisionText(id)) ?? ''] as const)
    ).then(entries => {
      if (live)
        setTexts(value => ({ ...value, ...Object.fromEntries(entries) }))
    })
    return () => {
      live = false
    }
  }, [selected?.id, previous?.id, texts])

  useEffect(() => {
    setChosen(new Set())
    setRenaming(false)
    setConfirmDelete(false)
  }, [selectedId, view])

  const selectedText = selected ? texts[selected.id] : current
  const previousText = previous ? texts[previous.id] : ''
  const currentHash = useMemo(() => textHash(current), [current])

  const comparison = useMemo(() => {
    if (!selected || selectedText === undefined) return null
    if (view === 'since') return lineDiff(selectedText, current)
    if (view === 'within')
      return previousText === undefined
        ? null
        : lineDiff(previous ? previousText : '', selectedText)
    return null
  }, [selected, selectedText, previous, previousText, view, current])

  const move = (step: number) => {
    const ids = [null, ...revisions.map(item => item.id)]
    const position = ids.indexOf(selectedId)
    const next = ids[Math.min(ids.length - 1, Math.max(0, position + step))]
    if (next !== undefined) setSelectedId(next)
  }

  const onListKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setSelectedId(null)
    } else if (event.key === 'End') {
      event.preventDefault()
      setSelectedId(revisions.at(-1)?.id ?? null)
    }
  }
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const replace = async (text: string, kind: 'restore' | 'merge') => {
    if (!selected) return
    setBusy(true)
    try {
      await onReplace(text, { kind, revision: selected })
      setChosen(new Set())
      setMessage(
        kind === 'restore'
          ? `Restored the version from ${time(selected.createdAt)}. Your previous text is kept as a safety copy.`
          : 'Brought back the chosen parts. Your previous text is kept as a safety copy.'
      )
    } finally {
      setBusy(false)
    }
  }

  const groups = useMemo(() => {
    const result: { day: string; items: RevisionMeta[] }[] = []
    for (const item of revisions) {
      const day = dayLabel(item.createdAt)
      const last = result.at(-1)
      if (last?.day === day) last.items.push(item)
      else result.push({ day, items: [item] })
    }
    return result
  }, [revisions])

  // Left is the oldest version, right is now, like a timeline.
  const scrub =
    selectedId === null ? revisions.length : revisions.length - 1 - index
  const interactive = view === 'since' && Boolean(comparison?.hunks.length)
  const KindIcon = selected ? KIND[selected.kind].icon : History

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="History"
      description={note ? `Every saved version of “${note.title}”` : ''}
      className="history-dialog"
      onEscapeKeyDown={event => {
        if (renaming || confirmDelete) {
          event.preventDefault()
          setRenaming(false)
          setConfirmDelete(false)
        }
      }}
    >
      <div
        className="history-timeline"
        role="listbox"
        aria-label="Versions"
        tabIndex={0}
        ref={list}
        onKeyDown={onListKey}
        aria-activedescendant={`history-${selectedId ?? 'current'}`}
      >
        <button
          type="button"
          id="history-current"
          role="option"
          aria-selected={selectedId === null}
          tabIndex={-1}
          className="history-item is-current"
          onClick={() => setSelectedId(null)}
        >
          <span className="history-dot" aria-hidden="true" />
          <span className="history-item-text">
            <strong>Current note</strong>
            <small>
              Now ·{' '}
              {current.trim()
                ? `${current.length.toLocaleString()} characters`
                : 'empty'}
            </small>
          </span>
        </button>
        {groups.map(group => (
          <Fragment key={group.day}>
            <h4 className="history-day">{group.day}</h4>
            {group.items.map(item => {
              const Icon = KIND[item.kind].icon
              return (
                <button
                  type="button"
                  key={item.id}
                  id={`history-${item.id}`}
                  role="option"
                  aria-selected={selectedId === item.id}
                  tabIndex={-1}
                  className={`history-item kind-${item.kind}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="history-dot" aria-hidden="true">
                    <Icon size={10} />
                  </span>
                  <span className="history-item-text">
                    <strong>{titleOf(item)}</strong>
                    <small>
                      {time(item.createdAt)}
                      {item.added > 0 && (
                        <span className="history-added">+{item.added}</span>
                      )}
                      {item.removed > 0 && (
                        <span className="history-removed">−{item.removed}</span>
                      )}
                      {item.hash === currentHash && (
                        <span className="history-badge">Current text</span>
                      )}
                    </small>
                  </span>
                  {item.pinned && (
                    <BookmarkCheck
                      size={13}
                      className="history-pin"
                      aria-label="Pinned"
                    />
                  )}
                </button>
              )
            })}
          </Fragment>
        ))}
        {!loaded && (
          <p className="history-loading" role="status">
            <History size={14} aria-hidden="true" /> Opening versions…
          </p>
        )}
        {loaded && !revisions.length && (
          <div className="history-empty">
            <History size={20} aria-hidden="true" />
            <p>
              {enabled
                ? 'No versions yet. TypeNext keeps one when you pause after a change, or save one now.'
                : 'Revisions are off. Turn them on to keep versions of every note.'}
            </p>
          </div>
        )}
        <div className="history-timeline-foot">
          <button
            type="button"
            className="button secondary is-compact"
            disabled={!note}
            onClick={() => {
              void onSaveRevision().then(() => {
                setMessage('Saved this version.')
              })
            }}
          >
            <Save size={14} /> Save this version
          </button>
          <button
            type="button"
            className="history-link-button"
            onClick={onOpenSettings}
          >
            Settings
          </button>
        </div>
      </div>
      <section className="history-main" aria-label="Compare">
        <div className="history-scrubber">
          <input
            type="range"
            min={0}
            max={revisions.length}
            value={scrub}
            disabled={!revisions.length}
            aria-label="Move through versions"
            aria-valuetext={
              selected
                ? `${dayLabel(selected.createdAt)} ${time(selected.createdAt)}`
                : 'Current note'
            }
            style={
              {
                '--scrub': revisions.length ? scrub / revisions.length : 1,
              } as React.CSSProperties
            }
            onChange={event => {
              const value = Number(event.target.value)
              setSelectedId(
                value >= revisions.length
                  ? null
                  : (revisions[revisions.length - 1 - value]?.id ?? null)
              )
            }}
          />
          <div className="history-scrub-labels" aria-hidden="true">
            <span>
              {revisions.at(-1)
                ? `${dayLabel(revisions.at(-1)!.createdAt)}, ${time(revisions.at(-1)!.createdAt)}`
                : ''}
            </span>
            <span>Now</span>
          </div>
        </div>
        {selected ? (
          <>
            <header className="history-head">
              <span className={`history-kind kind-${selected.kind}`}>
                <KindIcon size={13} aria-hidden="true" />
                {KIND[selected.kind].label}
              </span>
              {renaming ? (
                <form
                  className="history-rename"
                  onSubmit={event => {
                    event.preventDefault()
                    void updateRevision(selected.id, { label: name })
                    setRenaming(false)
                  }}
                >
                  <input
                    autoFocus
                    aria-label="Version name"
                    value={name}
                    maxLength={120}
                    placeholder="Name this version"
                    onChange={event => setName(event.target.value)}
                  />
                  <button type="submit" className="button primary is-compact">
                    <Check size={14} /> Save
                  </button>
                </form>
              ) : (
                <h3 className="history-title">{titleOf(selected)}</h3>
              )}
              <p className="history-subtitle">
                {dayLabel(selected.createdAt)} at {time(selected.createdAt)} ·{' '}
                {selected.words.toLocaleString()} words
                {selected.label && selected.summary
                  ? ` · ${selected.summary}`
                  : ''}
              </p>
              <div className="history-tools">
                <button
                  type="button"
                  className="pref-icon-button"
                  title="Name this version"
                  aria-label="Name this version"
                  onClick={() => {
                    setName(selected.label ?? '')
                    setRenaming(true)
                  }}
                >
                  <PenLine size={15} />
                </button>
                <button
                  type="button"
                  className="pref-icon-button"
                  title={
                    selected.pinned ? 'Unpin' : 'Pin, so it is always kept'
                  }
                  aria-label={selected.pinned ? 'Unpin version' : 'Pin version'}
                  aria-pressed={Boolean(selected.pinned)}
                  onClick={() =>
                    void updateRevision(selected.id, {
                      pinned: !selected.pinned,
                    })
                  }
                >
                  {selected.pinned ? (
                    <BookmarkCheck size={15} />
                  ) : (
                    <Bookmark size={15} />
                  )}
                </button>
                {confirmDelete ? (
                  <span className="history-confirm">
                    Delete this version?
                    <button
                      type="button"
                      className="button destructive is-compact"
                      onClick={() => {
                        const next =
                          revisions[index + 1] ?? revisions[index - 1]
                        void deleteRevision(selected.id)
                        setSelectedId(next?.id ?? null)
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="button subtle is-compact"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="pref-icon-button"
                    title="Delete this version"
                    aria-label="Delete this version"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </header>
            <div className="history-views" role="radiogroup" aria-label="Show">
              {(
                [
                  ['since', 'Changes since'],
                  ['within', 'What changed here'],
                  ['read', 'Read'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={view === value}
                  className={view === value ? 'is-active' : ''}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="history-body" key={`${selected.id}:${view}`}>
              {selectedText === undefined ? (
                <p className="history-quiet">Opening this version…</p>
              ) : view === 'read' ? (
                <div className="history-read">{selectedText || ' '}</div>
              ) : comparison === null ? (
                <p className="history-quiet">Comparing…</p>
              ) : !comparison.hunks.length ? (
                <p className="history-quiet">
                  {view === 'since'
                    ? 'This version is the same as your note now.'
                    : 'Nothing changed in this version.'}
                </p>
              ) : (
                <>
                  <p className="history-legend">
                    {view === 'since'
                      ? 'Since this version, your note '
                      : 'In this version, the note '}
                    <ins>gained {comparison.added.toLocaleString()} words</ins>{' '}
                    and <del>lost {comparison.removed.toLocaleString()}</del>.
                    {view === 'since' &&
                      ' Choose parts to bring back, or restore the whole version.'}
                  </p>
                  {comparison.hunks.map(hunk => (
                    <HunkView
                      key={hunk.id}
                      hunk={hunk}
                      newer={(view === 'since' ? current : selectedText).split(
                        '\n'
                      )}
                      chosen={chosen.has(hunk.id)}
                      interactive={view === 'since'}
                      onToggle={() =>
                        setChosen(value => {
                          const next = new Set(value)
                          if (next.has(hunk.id)) next.delete(hunk.id)
                          else next.add(hunk.id)
                          return next
                        })
                      }
                      onRestore={() =>
                        void replace(
                          revertHunks(
                            current,
                            comparison.hunks,
                            new Set([hunk.id])
                          ),
                          'merge'
                        )
                      }
                    />
                  ))}
                </>
              )}
            </div>
            <footer className="history-footer">
              <span className="history-message" role="status">
                {message}
              </span>
              {interactive && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={!chosen.size || busy}
                  onClick={() =>
                    void replace(
                      revertHunks(current, comparison!.hunks, chosen),
                      'merge'
                    )
                  }
                >
                  <Undo2 size={15} /> Bring back {chosen.size || ''}{' '}
                  {chosen.size === 1 ? 'part' : 'parts'}
                </button>
              )}
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  selectedText === undefined ||
                  selected.hash === currentHash
                }
                onClick={() => void replace(selectedText ?? '', 'restore')}
              >
                <RotateCcw size={15} /> Restore this version
              </button>
            </footer>
          </>
        ) : (
          <div className="history-current-view">
            <header className="history-head">
              <span className="history-kind kind-current">
                <span className="history-live-dot" aria-hidden="true" /> Now
              </span>
              <h3 className="history-title">Your note as it is</h3>
              <p className="history-subtitle">
                {revisions.length
                  ? `${revisions.length} saved ${revisions.length === 1 ? 'version' : 'versions'}. Choose one to compare, or drag the slider.`
                  : 'Versions you save appear on the left.'}
              </p>
            </header>
            <div className="history-body">
              <div className="history-read">{current || ' '}</div>
            </div>
            <footer className="history-footer">
              <span className="history-message" role="status">
                {message}
              </span>
            </footer>
          </div>
        )}
      </section>
    </Modal>
  )
}
