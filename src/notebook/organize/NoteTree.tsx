import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react'
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Trash2,
} from 'lucide-react'
import type { Note, NoteFolder, NoteTag } from '../../types/notebook'
import { relativeDate, UNTITLED } from '../model'
import { byName, folderPath, type Counts } from './organize'

/** Where a dragged note or folder can land: a folder, or the top level. */
export interface DropTarget {
  folderId?: string
}

export interface DragPayload {
  kind: 'note' | 'folder'
  id: string
}

const DRAG_TYPE = 'application/x-typenext-item'

type Row =
  | {
      type: 'folder'
      id: string
      name: string
      depth: number
      color: string
      count: number
      collapsed: boolean
    }
  | {
      type: 'note'
      id: string
      title: string
      detail: string
      depth: number
      tags: { name: string; color: string }[]
      more: number
    }

function noteDetail(note: Note, path?: string) {
  const sources = note.sources.length
    ? ` · ${note.sources.length} source${note.sources.length > 1 ? 's' : ''}`
    : ''
  return `${relativeDate(note.updatedAt)}${sources}${path ? ` · ${path}` : ''}`
}

function title(note: Note) {
  return note.title.trim() || UNTITLED
}

function readPayload(event: DragEvent): DragPayload | null {
  try {
    const value = JSON.parse(
      event.dataTransfer.getData(DRAG_TYPE)
    ) as DragPayload
    return value?.id ? value : null
  } catch {
    return null
  }
}

const FolderRow = memo(function FolderRow({
  row,
  renaming,
  dropping,
  onToggle,
  onAdd,
  onMenu,
  onRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  row: Extract<Row, { type: 'folder' }>
  renaming: boolean
  dropping: boolean
  onToggle(id: string): void
  onAdd(id: string): void
  onMenu(id: string, anchor: HTMLElement): void
  /** name null: cancelled; undefined: start renaming. */
  onRename(id: string, name: string | null | undefined): void
  onDragStart(event: DragEvent, payload: DragPayload): void
  onDragOver(event: DragEvent, id: string): void
  onDragLeave(id: string): void
  onDrop(event: DragEvent, target: DropTarget): void
}) {
  const more = useRef<HTMLButtonElement>(null)
  const Icon = row.collapsed ? Folder : FolderOpen
  return (
    <div
      className={`org-folder-row org-${row.color}${dropping ? ' is-drop-target' : ''}`}
      style={{ '--depth': row.depth } as React.CSSProperties}
      draggable={!renaming}
      onDragStart={event => onDragStart(event, { kind: 'folder', id: row.id })}
      onDragOver={event => onDragOver(event, row.id)}
      onDragLeave={() => onDragLeave(row.id)}
      onDrop={event => onDrop(event, { folderId: row.id })}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault()
        if (more.current) onMenu(row.id, more.current)
      }}
    >
      {renaming ? (
        <form
          className="org-folder-rename"
          onSubmit={event => {
            event.preventDefault()
            const input = event.currentTarget.elements.namedItem(
              'name'
            ) as HTMLInputElement
            onRename(row.id, input.value)
          }}
        >
          <Icon size={15} className="org-folder-icon" aria-hidden="true" />
          <input
            name="name"
            autoFocus
            defaultValue={row.name}
            aria-label="Folder name"
            maxLength={120}
            onFocus={event => event.currentTarget.select()}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onRename(row.id, null)
              }
            }}
            onBlur={event => onRename(row.id, event.currentTarget.value)}
          />
        </form>
      ) : (
        <button
          type="button"
          className="org-folder-toggle"
          aria-expanded={!row.collapsed}
          onClick={() => onToggle(row.id)}
          onDoubleClick={event => {
            event.preventDefault()
            onRename(row.id, undefined)
          }}
        >
          <ChevronRight size={13} className="org-chevron" aria-hidden="true" />
          <Icon size={15} className="org-folder-icon" aria-hidden="true" />
          <span className="org-folder-name">{row.name}</span>
          <span className="org-folder-count" aria-label={`${row.count} notes`}>
            {row.count || ''}
          </span>
        </button>
      )}
      {!renaming && (
        <span className="org-row-tools">
          <button
            type="button"
            className="icon-button"
            aria-label={`New note in ${row.name}`}
            title="New note here"
            onClick={() => onAdd(row.id)}
          >
            <Plus size={13} />
          </button>
          <button
            ref={more}
            type="button"
            className="icon-button"
            aria-label={`Actions for folder ${row.name}`}
            aria-haspopup="menu"
            onClick={event => onMenu(row.id, event.currentTarget)}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
      )}
    </div>
  )
})

const NoteRow = memo(function NoteRow({
  row,
  active,
  onSelect,
  onDelete,
  onMenu,
  onDragStart,
}: {
  row: Extract<Row, { type: 'note' }>
  active: boolean
  onSelect(id: string): void
  onDelete(id: string): void
  onMenu(id: string, anchor: HTMLElement): void
  onDragStart(event: DragEvent, payload: DragPayload): void
}) {
  const more = useRef<HTMLButtonElement>(null)
  return (
    <div
      className={`note-list-item${active ? ' active' : ''}`}
      style={{ '--depth': row.depth } as React.CSSProperties}
      draggable
      onDragStart={event => onDragStart(event, { kind: 'note', id: row.id })}
      onContextMenu={event => {
        event.preventDefault()
        if (more.current) onMenu(row.id, more.current)
      }}
    >
      <button
        className="note-select"
        onClick={() => onSelect(row.id)}
        aria-current={active ? 'page' : undefined}
      >
        <FileText size={16} />
        <span>
          <strong>{row.title}</strong>
          <small>
            <span className="note-detail">{row.detail}</span>
            {row.tags.map(tag => (
              <span key={tag.name} className={`org-mini-tag org-${tag.color}`}>
                {tag.name}
              </span>
            ))}
            {row.more > 0 && <span className="org-mini-more">+{row.more}</span>}
          </small>
        </span>
      </button>
      <span className="note-row-tools">
        <button
          ref={more}
          type="button"
          className="icon-button note-more"
          aria-label={`Actions for ${row.title}`}
          aria-haspopup="menu"
          onClick={event => onMenu(row.id, event.currentTarget)}
        >
          <MoreHorizontal size={14} />
        </button>
        <button
          className="icon-button note-delete"
          aria-label={`Delete ${row.title}`}
          onClick={() => onDelete(row.id)}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )
})

/**
 * The sidebar: folders with their notes, then notes at the top level. A
 * search or a tag filter shows a flat list of matches instead. Rows are
 * rebuilt only when something a row shows changes, never while typing.
 */
export function NoteTree({
  notes,
  folders,
  tags,
  counts,
  activeId,
  query,
  tagFilter,
  renamingFolder,
  empty,
  onSelect,
  onDelete,
  onNoteMenu,
  onFolderMenu,
  onToggleFolder,
  onNewNoteIn,
  onRenameFolder,
  onDrop,
}: {
  notes: Note[]
  folders: NoteFolder[]
  tags: NoteTag[]
  counts: Counts
  activeId: string | null
  query: string
  tagFilter: string | null
  renamingFolder: string | null
  empty: string
  onSelect(note: Note): void
  onDelete(id: string): void
  onNoteMenu(id: string, anchor: HTMLElement): void
  onFolderMenu(id: string, anchor: HTMLElement): void
  onToggleFolder(id: string): void
  onNewNoteIn(folderId: string): void
  /** name null: cancelled; undefined: start renaming. */
  onRenameFolder(id: string, name: string | null | undefined): void
  onDrop(target: DropTarget, payload: DragPayload): void
}) {
  const rows = useMemo<Row[]>(() => {
    const tagById = new Map(tags.map(tag => [tag.id, tag]))
    const noteRow = (note: Note, depth: number, path?: string): Row => {
      const noteTags = (note.tags ?? [])
        .map(id => tagById.get(id))
        .filter(Boolean) as NoteTag[]
      return {
        type: 'note',
        id: note.id,
        title: title(note),
        detail: noteDetail(note, path),
        depth,
        tags: noteTags
          .slice(0, 2)
          .map(tag => ({ name: tag.name, color: tag.color })),
        more: Math.max(0, noteTags.length - 2),
      }
    }
    const recent = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)
    const search = query.toLocaleLowerCase()
    if (search || tagFilter) {
      const names = new Map(
        folders.map(folder => [
          folder.id,
          folderPath(folders, folder.id)
            .map(item => item.name)
            .join(' › '),
        ])
      )
      return recent
        .filter(
          note =>
            (!tagFilter || note.tags?.includes(tagFilter)) &&
            (!search ||
              note.title.toLocaleLowerCase().includes(search) ||
              note.content.toLocaleLowerCase().includes(search) ||
              (note.tags ?? []).some(id =>
                tagById.get(id)?.name.toLocaleLowerCase().includes(search)
              ))
        )
        .map(note =>
          noteRow(note, 0, note.folderId ? names.get(note.folderId) : undefined)
        )
    }
    const known = new Set(folders.map(folder => folder.id))
    const byFolder = new Map<string | undefined, Note[]>()
    for (const note of recent) {
      const key =
        note.folderId && known.has(note.folderId) ? note.folderId : undefined
      const list = byFolder.get(key)
      if (list) list.push(note)
      else byFolder.set(key, [note])
    }
    const children = new Map<string | undefined, NoteFolder[]>()
    for (const folder of folders) {
      const key =
        folder.parentId && known.has(folder.parentId)
          ? folder.parentId
          : undefined
      const list = children.get(key)
      if (list) list.push(folder)
      else children.set(key, [folder])
    }
    const result: Row[] = []
    const seen = new Set<string>()
    const walk = (parentId: string | undefined, depth: number) => {
      for (const folder of [...(children.get(parentId) ?? [])].sort(byName)) {
        if (seen.has(folder.id)) continue
        seen.add(folder.id)
        result.push({
          type: 'folder',
          id: folder.id,
          name: folder.name,
          depth,
          color: folder.color ?? 'slate',
          count: counts.folders.get(folder.id) ?? 0,
          collapsed: Boolean(folder.collapsed),
        })
        if (!folder.collapsed) walk(folder.id, depth + 1)
      }
      for (const note of byFolder.get(parentId) ?? [])
        result.push(noteRow(note, depth))
    }
    walk(undefined, 0)
    return result
  }, [notes, folders, tags, counts, query, tagFilter])

  // Typing changes a note on every key but rarely a row. Keep the same rows
  // so the list does not re-render.
  const signature = JSON.stringify(rows)
  const stable = useRef({ signature: '', rows })
  if (stable.current.signature !== signature)
    stable.current = { signature, rows }
  const latest = useRef(notes)
  latest.current = notes

  const [dropping, setDropping] = useState<string | null>(null)
  const dragging = useRef<DragPayload | null>(null)

  const select = useCallback(
    (id: string) => {
      const note = latest.current.find(item => item.id === id)
      if (note) onSelect(note)
    },
    [onSelect]
  )
  const dragStart = useCallback((event: DragEvent, payload: DragPayload) => {
    dragging.current = payload
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))
    event.dataTransfer.setData('text/plain', payload.id)
  }, [])
  const dragOver = useCallback((event: DragEvent, id: string) => {
    const payload = dragging.current
    if (!payload || (payload.kind === 'folder' && payload.id === id)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropping(value => (value === id ? value : id))
  }, [])
  const dragLeave = useCallback((id: string) => {
    setDropping(value => (value === id ? null : value))
  }, [])
  const drop = useCallback(
    (event: DragEvent, target: DropTarget) => {
      event.preventDefault()
      event.stopPropagation()
      const payload = readPayload(event) ?? dragging.current
      dragging.current = null
      setDropping(null)
      if (payload) onDrop(target, payload)
    },
    [onDrop]
  )

  const flat = Boolean(query || tagFilter)
  return (
    <div
      className={`note-list org-tree${dropping === 'root' ? ' is-drop-root' : ''}`}
      aria-label={flat ? 'Matching notes' : 'Folders and notes'}
      onDragOver={event => {
        if (!dragging.current) return
        event.preventDefault()
        if (event.target === event.currentTarget) setDropping('root')
      }}
      onDragLeave={event => {
        if (event.target === event.currentTarget)
          setDropping(value => (value === 'root' ? null : value))
      }}
      onDrop={event => drop(event, {})}
      onDragEnd={() => {
        dragging.current = null
        setDropping(null)
      }}
    >
      {stable.current.rows.map(row =>
        row.type === 'folder' ? (
          <FolderRow
            key={`f:${row.id}`}
            row={row}
            renaming={renamingFolder === row.id}
            dropping={dropping === row.id}
            onToggle={onToggleFolder}
            onAdd={onNewNoteIn}
            onMenu={onFolderMenu}
            onRename={onRenameFolder}
            onDragStart={dragStart}
            onDragOver={dragOver}
            onDragLeave={dragLeave}
            onDrop={drop}
          />
        ) : (
          <NoteRow
            key={`n:${row.id}`}
            row={row}
            active={row.id === activeId}
            onSelect={select}
            onDelete={onDelete}
            onMenu={onNoteMenu}
            onDragStart={dragStart}
          />
        )
      )}
      {!stable.current.rows.length && <p className="sidebar-empty">{empty}</p>}
    </div>
  )
}
