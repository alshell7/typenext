import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import {
  CornerDownLeft,
  LibraryBig,
  Plus,
  Search,
  Upload,
  X,
} from 'lucide-react'
import type { ContextPackage, ContextSource } from '../../types/notebook'
import { fuzzyFilter } from './fuzzy'
import { countGroups, KindCluster, safeThumbnail } from './source-kinds'
import { usePresence } from './usePresence'

/** Internal drag payload. Files keep the platform's own 'Files' type. */
export const CONTEXT_DRAG_TYPE = 'application/x-typenext-context'
const TRAY_PREVIEW = 6

export interface BoardPackage {
  context: ContextPackage
  available: boolean
}

interface PackageSummary {
  counts: ReturnType<typeof countGroups>
  thumbnails: string[]
  sources: number
}

function hasType(event: DragEvent, type: string) {
  return Array.from(event.dataTransfer?.types ?? []).includes(type)
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function ThumbStack({
  summary,
  available = true,
}: {
  summary: PackageSummary | undefined
  available?: boolean
}) {
  const thumbnails = summary?.thumbnails ?? []
  if (!thumbnails.length || !available)
    return (
      <span className="context-card-icon" aria-hidden="true">
        <LibraryBig size={15} strokeWidth={1.6} />
      </span>
    )
  return (
    <span
      className={`context-card-stack is-${thumbnails.length}`}
      aria-hidden="true"
    >
      {thumbnails.map((thumbnail, index) => (
        <img key={index} src={thumbnail} alt="" draggable={false} />
      ))}
    </span>
  )
}

interface Line {
  key: string
  d: string
  state: string
}

/**
 * The note as a central card with its contexts connected beneath it, and a
 * tray of contexts that can be dragged, clicked or searched to attach.
 */
export function ConnectionBoard({
  noteTitle,
  reach,
  attached,
  packages,
  library,
  importing,
  canAttach,
  onAttach,
  onDetach,
  onManage,
  onLibrary,
  onCreate,
  onPackageFiles,
  announce,
}: {
  noteTitle: string
  reach: number
  attached: BoardPackage[]
  packages: ContextPackage[]
  library: ContextSource[]
  importing: boolean
  canAttach: boolean
  onAttach(id: string): void
  onDetach(id: string): void
  onManage?(id: string): void
  onLibrary?(): void
  onCreate?(name: string): string | null
  onPackageFiles?(files: FileList, id: string): void
  announce(message: string): void
}) {
  const trayId = useId()
  const board = useRef<HTMLDivElement>(null)
  const noteCard = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const items = useRef(new Map<string, HTMLLIElement>())
  const trayButtons = useRef(new Map<string, HTMLButtonElement>())
  const attachedButtons = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<
    { area: 'tray' | 'attached'; index: number } | 'search' | null
  >(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState<{
    kind: 'attach' | 'detach'
    id: string
  } | null>(null)
  const [over, setOver] = useState<'board' | 'tray' | null>(null)
  const [fileTarget, setFileTarget] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])

  const libraryIndex = useMemo(
    () => new Map(library.map(source => [source.id, source])),
    [library]
  )
  const summaries = useMemo(() => {
    const result = new Map<string, PackageSummary>()
    for (const context of packages) {
      const sources = context.sourceIds.flatMap(id => {
        const source = libraryIndex.get(id)
        return source ? [source] : []
      })
      const thumbnails: string[] = []
      for (const source of sources) {
        const thumbnail = safeThumbnail(source)
        if (thumbnail) thumbnails.push(thumbnail)
        if (thumbnails.length === 3) break
      }
      result.set(context.id, {
        counts: countGroups(sources),
        thumbnails,
        sources: context.sourceIds.length,
      })
    }
    return result
  }, [packages, libraryIndex])
  const attachedIds = useMemo(
    () => new Set(attached.map(item => item.context.id)),
    [attached]
  )
  const available = useMemo(
    () => packages.filter(context => !attachedIds.has(context.id)),
    [packages, attachedIds]
  )
  const matches = useMemo(
    () => fuzzyFilter(available, query, context => context.name),
    [available, query]
  )
  const trimmed = query.trim()
  const exact = packages.some(
    context =>
      context.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase()
  )
  const canCreate = !!onCreate && !!trimmed && !exact && !importing
  const shown =
    trimmed || expanded || matches.length <= TRAY_PREVIEW + 1
      ? matches
      : matches.slice(0, TRAY_PREVIEW)
  const presence = usePresence(attached, item => item.context.id)

  // Connector geometry follows the rendered cards; measurement is cheap and
  // only commits when a path actually changes.
  const measure = useCallback(() => {
    const root = board.current
    const note = noteCard.current
    if (!root || !note) return
    // Centre of the note card's dot: border, padding and half its width.
    const originX = note.offsetLeft + 24
    const originY = note.offsetTop + note.offsetHeight
    const next: Line[] = []
    for (const entry of presence) {
      const element = items.current.get(entry.key)
      if (!element) continue
      const y = element.offsetTop + element.offsetHeight / 2
      const x = element.offsetLeft
      const radius = Math.min(10, Math.max(0, (y - originY) / 2))
      next.push({
        key: entry.key,
        state: entry.state,
        d: `M ${originX} ${originY} V ${y - radius} Q ${originX} ${y} ${originX + radius} ${y} H ${x}`,
      })
    }
    setLines(previous =>
      previous.length === next.length &&
      previous.every(
        (line, index) =>
          line.key === next[index]!.key &&
          line.d === next[index]!.d &&
          line.state === next[index]!.state
      )
        ? previous
        : next
    )
  }, [presence])
  const latestMeasure = useRef(measure)
  useLayoutEffect(() => {
    latestMeasure.current = measure
    measure()
  })
  useEffect(() => {
    const root = board.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => latestMeasure.current())
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    if (target === 'search') {
      search.current?.focus()
      return
    }
    const list =
      target.area === 'tray'
        ? shown.map(context => trayButtons.current.get(context.id))
        : attached.map(item => attachedButtons.current.get(item.context.id))
    const element = list[Math.min(target.index, list.length - 1)]
    if (element) element.focus()
    else search.current?.focus()
  })

  function attach(context: ContextPackage, focus?: number | 'search') {
    if (!canAttach || importing) return
    onAttach(context.id)
    announce(`${context.name} attached`)
    if (focus !== undefined)
      pendingFocus.current =
        focus === 'search' ? 'search' : { area: 'tray', index: focus }
  }
  function detach(context: ContextPackage, focus?: number) {
    onDetach(context.id)
    announce(`${context.name} detached`)
    if (focus !== undefined)
      pendingFocus.current =
        attached.length > 1 ? { area: 'attached', index: focus } : 'search'
  }
  function create() {
    if (!onCreate || !canCreate) return
    const id = onCreate(trimmed)
    if (!id) return
    onAttach(id)
    announce(`${trimmed} created and attached`)
    setQuery('')
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = matches[0]
      if (first && trimmed) {
        attach(first, 'search')
        setQuery('')
      } else if (!first && canCreate) create()
    } else if (event.key === 'ArrowDown') {
      const first = shown[0]
      if (first) {
        event.preventDefault()
        trayButtons.current.get(first.id)?.focus()
      }
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
    }
  }
  function onTrayKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = index + (event.key === 'ArrowDown' ? 1 : -1)
    if (next < 0) search.current?.focus()
    else trayButtons.current.get(shown[next]?.id ?? '')?.focus()
  }
  function onAttachedKey(
    event: KeyboardEvent<HTMLButtonElement>,
    context: ContextPackage,
    index: number
  ) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      detach(context, index)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = attached[index + (event.key === 'ArrowDown' ? 1 : -1)]
      if (next) attachedButtons.current.get(next.context.id)?.focus()
    }
  }

  function startDrag(
    event: DragEvent<HTMLElement>,
    kind: 'attach' | 'detach',
    context: ContextPackage
  ) {
    event.dataTransfer.setData(CONTEXT_DRAG_TYPE, `${kind}:${context.id}`)
    event.dataTransfer.setData('text/plain', context.name)
    event.dataTransfer.effectAllowed = kind === 'attach' ? 'link' : 'move'
    setDragging({ kind, id: context.id })
  }
  function endDrag() {
    setDragging(null)
    setOver(null)
  }
  function payload(event: DragEvent) {
    const value = event.dataTransfer.getData(CONTEXT_DRAG_TYPE)
    const [kind, ...rest] = value.split(':')
    const id = rest.join(':')
    return kind === 'attach' || kind === 'detach' ? { kind, id } : null
  }
  function leaving(event: DragEvent<HTMLElement>) {
    const next = event.relatedTarget
    return !(next instanceof Node && event.currentTarget.contains(next))
  }

  function fileHandlers(context: ContextPackage) {
    if (!onPackageFiles) return {}
    return {
      'data-file-target': context.id,
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!hasType(event, 'Files') || importing) return
        event.preventDefault()
        setFileTarget(context.id)
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!hasType(event, 'Files') || importing) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        if (fileTarget !== context.id) setFileTarget(context.id)
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (leaving(event))
          setFileTarget(value => (value === context.id ? null : value))
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!hasType(event, 'Files')) return
        event.preventDefault()
        setFileTarget(null)
        const files = event.dataTransfer.files
        if (importing || !files?.length) return
        onPackageFiles(files, context.id)
        announce(`Adding ${plural(files.length, 'file')} to ${context.name}`)
      },
    }
  }

  const attachDrag = dragging?.kind === 'attach'
  const detachDrag = dragging?.kind === 'detach'

  return (
    <section className="context-connections" aria-label="Connections">
      <div className="context-section-heading">
        <h3>Connections</h3>
        <span>
          {attached.length ? `${attached.length} attached` : 'None yet'}
        </span>
      </div>
      <div
        ref={board}
        className={`connection-board ${attachDrag ? 'is-awaiting' : ''} ${over === 'board' ? 'is-over' : ''}`}
        onDragEnter={event => {
          if (!hasType(event, CONTEXT_DRAG_TYPE) || !attachDrag) return
          event.preventDefault()
          setOver('board')
        }}
        onDragOver={event => {
          if (!hasType(event, CONTEXT_DRAG_TYPE) || detachDrag) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'link'
          if (over !== 'board') setOver('board')
        }}
        onDragLeave={event => {
          if (leaving(event))
            setOver(value => (value === 'board' ? null : value))
        }}
        onDrop={event => {
          if (!hasType(event, CONTEXT_DRAG_TYPE)) return
          event.preventDefault()
          const data = payload(event)
          endDrag()
          if (data?.kind !== 'attach') return
          const context = available.find(item => item.id === data.id)
          if (context) attach(context)
        }}
      >
        <svg className="connection-lines" aria-hidden="true" focusable="false">
          {lines.map(line => (
            <path
              key={line.key}
              d={line.d}
              pathLength={1}
              className={`connection-line is-${line.state} ${highlight === line.key ? 'is-highlighted' : ''}`}
            />
          ))}
        </svg>
        <div
          ref={noteCard}
          className="connection-note"
          aria-label={`This note, ${noteTitle}`}
          role="group"
        >
          <span className="connection-note-dot" aria-hidden="true" />
          <span className="connection-note-copy">
            <strong title={noteTitle}>{noteTitle}</strong>
            <small>
              {over === 'board'
                ? 'Release to attach'
                : attachDrag
                  ? 'Drop here to attach'
                  : reach
                    ? `${plural(reach, 'source')} in reach`
                    : 'Nothing attached yet'}
            </small>
          </span>
        </div>
        <ul className="attached-context-list" aria-label="Attached contexts">
          {presence.map(entry => {
            const { context, available: ready } = entry.item
            const index = attached.findIndex(
              item => item.context.id === context.id
            )
            const summary = summaries.get(context.id)
            const gone = entry.state === 'leaving'
            return (
              <li
                key={entry.key}
                ref={element => {
                  if (element) items.current.set(entry.key, element)
                  else items.current.delete(entry.key)
                }}
                className={`attached-context-item is-${entry.state} ${ready ? '' : 'is-unavailable'} ${dragging?.id === context.id ? 'is-dragging' : ''} ${fileTarget === context.id ? 'is-file-over' : ''}`}
                aria-hidden={gone || undefined}
                draggable={!gone}
                onDragStart={event => startDrag(event, 'detach', context)}
                onDragEnd={endDrag}
                onPointerEnter={() => setHighlight(context.id)}
                onPointerLeave={() =>
                  setHighlight(value => (value === context.id ? null : value))
                }
                onFocus={() => setHighlight(context.id)}
                onBlur={() =>
                  setHighlight(value => (value === context.id ? null : value))
                }
                {...(gone || !ready ? {} : fileHandlers(context))}
              >
                <button
                  ref={element => {
                    if (element)
                      attachedButtons.current.set(context.id, element)
                    else attachedButtons.current.delete(context.id)
                  }}
                  type="button"
                  className="context-card-main"
                  aria-label={`Manage ${context.name}`}
                  aria-describedby={`attached-${context.id}-meta`}
                  tabIndex={gone ? -1 : undefined}
                  disabled={!onManage}
                  onClick={() => onManage?.(context.id)}
                  onKeyDown={event => onAttachedKey(event, context, index)}
                >
                  <ThumbStack summary={summary} available={ready} />
                  <span className="context-card-copy">
                    <strong title={context.name}>{context.name}</strong>
                    <small id={`attached-${context.id}-meta`}>
                      {fileTarget === context.id
                        ? `Add files to ${context.name}`
                        : ready
                          ? `${plural(context.sourceIds.length, 'source')} · Changes follow this note`
                          : 'Unavailable · Detach it or choose another context'}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button context-card-detach"
                  aria-label={`Detach ${context.name}`}
                  tabIndex={gone ? -1 : undefined}
                  onClick={() => detach(context, index)}
                >
                  <X size={13} />
                </button>
              </li>
            )
          })}
        </ul>
        {!attached.length && (
          <p className="connection-empty">
            {packages.length
              ? 'Drag a context onto your note, or choose one below.'
              : onCreate
                ? 'Contexts gather the files, sites and notes you return to. Name one below to connect it.'
                : 'Contexts gather the files, sites and notes you return to. Create one to connect it.'}
          </p>
        )}
      </div>

      <div
        className={`context-tray ${detachDrag ? 'is-awaiting' : ''} ${over === 'tray' ? 'is-over' : ''}`}
        onDragEnter={event => {
          if (!hasType(event, CONTEXT_DRAG_TYPE) || !detachDrag) return
          event.preventDefault()
          setOver('tray')
        }}
        onDragOver={event => {
          if (!hasType(event, CONTEXT_DRAG_TYPE) || attachDrag) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          if (over !== 'tray') setOver('tray')
        }}
        onDragLeave={event => {
          if (leaving(event))
            setOver(value => (value === 'tray' ? null : value))
        }}
        onDrop={event => {
          if (!hasType(event, CONTEXT_DRAG_TYPE)) return
          event.preventDefault()
          const data = payload(event)
          endDrag()
          if (data?.kind !== 'detach') return
          const item = attached.find(entry => entry.context.id === data.id)
          if (item) detach(item.context)
        }}
      >
        {detachDrag && (
          <p className="context-tray-hint" aria-hidden="true">
            Release to detach
          </p>
        )}
        {(packages.length > 0 || onCreate) && (
          <div className="context-quick">
            <Search size={14} aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-controls={trayId}
              aria-describedby={`${trayId}-hint`}
              aria-label="Attach a context"
              placeholder={
                packages.length ? 'Attach a context…' : 'Name a new context…'
              }
              value={query}
              maxLength={128}
              disabled={!canAttach && !onCreate}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
            />
            <span id={`${trayId}-hint`} className="visually-hidden">
              Type to filter. Enter attaches the first match.
            </span>
            {trimmed && (matches.length > 0 || canCreate) && (
              <kbd className="context-quick-enter" aria-hidden="true">
                <CornerDownLeft size={11} />
              </kbd>
            )}
          </div>
        )}
        {!canAttach && attached.length > 0 && (
          <p className="context-tray-note">
            This note has as many contexts as it can hold.
          </p>
        )}
        <ul
          id={trayId}
          className="context-tray-list"
          aria-label="Available contexts"
        >
          {shown.map((context, index) => {
            const summary = summaries.get(context.id)
            const top = !!trimmed && index === 0
            return (
              <li
                key={context.id}
                className={`context-tray-card ${top ? 'is-top' : ''} ${dragging?.id === context.id ? 'is-dragging' : ''} ${fileTarget === context.id ? 'is-file-over' : ''}`}
                draggable={canAttach && !importing}
                onDragStart={event => startDrag(event, 'attach', context)}
                onDragEnd={endDrag}
                {...fileHandlers(context)}
              >
                <button
                  ref={element => {
                    if (element) trayButtons.current.set(context.id, element)
                    else trayButtons.current.delete(context.id)
                  }}
                  type="button"
                  className="context-card-main"
                  aria-label={`Attach ${context.name}`}
                  aria-describedby={`tray-${context.id}-meta`}
                  disabled={!canAttach || importing}
                  onClick={() => attach(context, index)}
                  onKeyDown={event => onTrayKey(event, index)}
                >
                  <ThumbStack summary={summary} />
                  <span className="context-card-copy">
                    <strong title={context.name}>{context.name}</strong>
                    <small id={`tray-${context.id}-meta`}>
                      {fileTarget === context.id ? (
                        <>
                          <Upload size={11} aria-hidden="true" /> Add files to{' '}
                          {context.name}
                        </>
                      ) : summary?.sources ? (
                        <KindCluster counts={summary.counts} />
                      ) : (
                        'Empty · drop files here'
                      )}
                    </small>
                  </span>
                  <span className="context-card-add" aria-hidden="true">
                    {top ? <CornerDownLeft size={13} /> : <Plus size={14} />}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {!trimmed && matches.length > shown.length && (
          <button
            type="button"
            className="context-tray-more"
            onClick={() => setExpanded(true)}
          >
            Show all {matches.length} contexts
          </button>
        )}
        {trimmed && !matches.length && !canCreate && (
          <p className="context-tray-note" role="status">
            {available.length || !packages.length
              ? 'No contexts match.'
              : 'Every context is already attached.'}
          </p>
        )}
        {canCreate && (
          <button
            type="button"
            className={`context-tray-create ${matches.length ? '' : 'is-top'}`}
            onClick={create}
          >
            <Plus size={14} aria-hidden="true" />
            <span>
              Create <strong>{trimmed}</strong> and attach
            </span>
          </button>
        )}
        {!trimmed && !available.length && packages.length > 0 && (
          <p className="context-tray-note">Every context is attached.</p>
        )}
        {onLibrary && (
          <button
            type="button"
            className="button secondary manage-contexts"
            onClick={() => onLibrary()}
          >
            <LibraryBig size={15} /> Manage contexts
          </button>
        )}
      </div>
    </section>
  )
}
