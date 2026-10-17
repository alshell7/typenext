import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  FolderOpen,
  Link,
  LoaderCircle,
  Notebook,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type {
  ContextPackage,
  ContextSource,
  Note,
  NoteSpace,
  NotebookSettings,
} from '../types/notebook'
import { Modal } from './Modal'
import { MediaHint } from './context/MediaHint'
import {
  hasMediaFiles,
  mediaNeedsSetup,
  SOURCE_ACCEPT,
  SOURCE_FORMATS_HELP,
  SOURCE_FORMATS_SHORT,
} from './context/media'
import { prefersReducedMotion } from './context/usePresence'
import {
  countGroups,
  isMediaSource,
  KindCluster,
  mediaDetail,
  safeThumbnail,
  SourceThumb,
} from './context/source-kinds'
import {
  CONTEXT_PREVIEW_CHARACTERS,
  contextLibraryFolders,
  contextPackageUsage,
  filterContextLibrary,
  MAX_CONTEXT_PACKAGES,
  MAX_CONTEXT_PACKAGE_SOURCES,
  resolveLibrarySource,
} from './context-library'
import './context/context-panel.css'
import './ContextLibrary.css'

const EMPTY_SOURCES: ContextSource[] = []
const EMPTY_NOTES: Note[] = []
const EMPTY_PACKAGES: ContextPackage[] = []
const EMPTY_FOLDERS: ReturnType<typeof contextLibraryFolders> = []
const EMPTY_USAGE = new Map<string, number>()
const EMPTY_NOTE_INDEX = new Map<string, Note>()
const EMPTY_SOURCE_INDEX = new Map<string, ContextSource>()
const EMPTY_ATTACHED = new Set<string>()

export interface ContextLibraryProps {
  open: boolean
  onOpenChange(open: boolean): void
  library: ContextSource[]
  packages: ContextPackage[]
  notes: Note[]
  activeNote: Note | null
  initialPackageId?: string | null
  importing: boolean
  demoInstalled?: boolean
  onDemo?(): void
  demoDownloadHref?: string
  onCloseAutoFocus?(event: Event): void
  onCreatePackage(name: string): string | null
  onRenamePackage(id: string, name: string): void
  onRemovePackage(id: string): void
  onAttachPackage(id: string): void
  onDetachPackage(id: string): void
  onRemoveSource(packageId: string, sourceId: string): void
  onFiles(files: FileList | null, packageId: string): Promise<void>
  onWebsite(packageId: string): void
  onUseNote(noteId: string, packageId: string): void
  /** Enables the media setup hint when semantic media search is off. */
  settings?: NotebookSettings
  onOpenKnowledgeSettings?(): void
  /** With more than one workspace: where each context is available. */
  spaces?: NoteSpace[]
  onShareSpaces?(packageId: string, spaceIds: string[]): void
}

const NO_SPACES: NoteSpace[] = []

function sourceKind(source: ContextSource) {
  if (source.kind === 'note') return 'Live note'
  if (source.kind === 'website') return 'Website snapshot'
  if (source.kind === 'markdown') return 'Markdown'
  if (source.kind === 'text') return 'Text'
  if (isMediaSource(source)) {
    const detail = mediaDetail(source)
    const name = source.kind[0]!.toUpperCase() + source.kind.slice(1)
    return detail ? `${name} · ${detail}` : name
  }
  return source.kind.toUpperCase()
}

export function ContextLibrary({
  open,
  onOpenChange,
  library,
  packages,
  notes,
  activeNote,
  initialPackageId,
  importing,
  demoInstalled = false,
  onDemo,
  demoDownloadHref,
  onCloseAutoFocus,
  onCreatePackage,
  onRenamePackage,
  onRemovePackage,
  onAttachPackage,
  onDetachPackage,
  onRemoveSource,
  onFiles,
  onWebsite,
  onUseNote,
  settings,
  onOpenKnowledgeSettings,
  spaces = NO_SPACES,
  onShareSpaces,
}: ContextLibraryProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const cancelRemove = useRef<HTMLButtonElement>(null)
  const removeTrigger = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(false)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialPackageId ?? packages[0]?.id ?? null
  )
  const [editing, setEditing] = useState<'create' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [packageQuery, setPackageQuery] = useState('')
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewLength, setPreviewLength] = useState(CONTEXT_PREVIEW_CHARACTERS)
  const [removing, setRemoving] = useState<{
    kind: 'package' | 'source'
    id: string
  } | null>(null)
  const [choosingNote, setChoosingNote] = useState(false)
  const [noteQuery, setNoteQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [mediaHint, setMediaHint] = useState(false)
  const dragDepth = useRef(0)
  const previewPanel = useRef<HTMLDivElement>(null)
  const selected =
    open && selectedId
      ? packages.find(context => context.id === selectedId)
      : undefined
  const matchingPackages = useMemo(() => {
    if (!open) return EMPTY_PACKAGES
    const needle = packageQuery.trim().toLocaleLowerCase()
    return needle
      ? packages.filter(context =>
          context.name.toLocaleLowerCase().includes(needle)
        )
      : packages
  }, [packages, packageQuery, open])
  const sourceIndex = useMemo(
    () =>
      open
        ? new Map(library.map(source => [source.id, source]))
        : EMPTY_SOURCE_INDEX,
    [library, open]
  )
  const sources = useMemo(() => {
    if (!open || !selected) return EMPTY_SOURCES
    return selected.sourceIds.map(
      id =>
        sourceIndex.get(id) ?? {
          id,
          name: 'Unavailable reference',
          kind: 'text' as const,
          text: '',
          enabled: false,
          addedAt: 0,
        }
    )
  }, [open, selected, sourceIndex])
  const folders = useMemo(
    () => (open ? contextLibraryFolders(sources) : EMPTY_FOLDERS),
    [sources, open]
  )
  const usage = useMemo(
    () => (open ? contextPackageUsage(notes) : EMPTY_USAGE),
    [notes, open]
  )
  const byNoteId = useMemo(
    () =>
      open && sources.some(source => source.kind === 'note')
        ? new Map(notes.map(note => [note.id, note]))
        : EMPTY_NOTE_INDEX,
    [notes, sources, open]
  )
  const matching = useMemo(
    () =>
      open
        ? filterContextLibrary(sources, notes, query, folder)
        : EMPTY_SOURCES,
    [sources, notes, query, folder, open]
  )
  const attached = useMemo(
    () =>
      open ? new Set(activeNote?.contextPackageIds ?? []) : EMPTY_ATTACHED,
    [activeNote?.contextPackageIds, open]
  )
  const availableNotes = useMemo(() => {
    if (!open || !choosingNote || !selected) return EMPTY_NOTES
    const linkedIds = new Set(
      sources
        .filter(source => source.kind === 'note')
        .map(source => source.linkedNoteId)
    )
    const needle = noteQuery.trim().toLocaleLowerCase()
    return notes
      .filter(
        note =>
          !linkedIds.has(note.id) &&
          (!needle || note.title.toLocaleLowerCase().includes(needle))
      )
      .sort((first, second) => second.updatedAt - first.updatedAt)
  }, [sources, notes, noteQuery, choosingNote, open, selected])
  const removingSource =
    removing?.kind === 'source'
      ? sources.find(source => source.id === removing.id)
      : undefined
  const removeName =
    removing?.kind === 'package'
      ? selected?.name
      : removingSource?.kind === 'note'
        ? (byNoteId.get(removingSource.linkedNoteId ?? '')?.title ??
          removingSource.name)
        : removingSource?.name
  const selectedUsage = selected ? (usage.get(selected.id) ?? 0) : 0
  const selectedCounts = useMemo(
    () => countGroups(sources.filter(source => sourceIndex.has(source.id))),
    [sources, sourceIndex]
  )
  const previewItem = previewId
    ? matching.find(item => item.id === previewId)
    : undefined

  useEffect(() => {
    const opening = !wasOpen.current
    if (open)
      setSelectedId(current => {
        if (
          opening &&
          initialPackageId &&
          packages.some(context => context.id === initialPackageId)
        )
          return initialPackageId
        return packages.some(context => context.id === current)
          ? current
          : (packages[0]?.id ?? null)
      })
    wasOpen.current = open
  }, [open, packages, initialPackageId])
  useEffect(() => {
    if (open && removing) cancelRemove.current?.focus()
  }, [removing, open])
  useEffect(() => {
    if (open && folder && !folders.some(candidate => candidate.path === folder))
      setFolder(null)
  }, [folder, folders, open])
  useEffect(() => {
    if (open) return
    setPreviewId(null)
    setRemoving(null)
    setChoosingNote(false)
    setEditing(null)
    setMessage('')
    setDragging(false)
    setMediaHint(false)
    dragDepth.current = 0
  }, [open])
  useEffect(() => {
    if (!open || !previewId) return
    previewPanel.current?.scrollIntoView?.({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [open, previewId])

  function closePreview() {
    setPreviewId(null)
    setPreviewLength(CONTEXT_PREVIEW_CHARACTERS)
  }
  function chooseContext(id: string) {
    setSelectedId(id)
    setEditing(null)
    setRemoving(null)
    setChoosingNote(false)
    setQuery('')
    setFolder(null)
    setMessage('')
    closePreview()
  }
  function startCreating() {
    setName('')
    setEditing('create')
    setRemoving(null)
    setChoosingNote(false)
    setMessage('')
    closePreview()
  }
  function importFiles(files: FileList | null, input?: HTMLInputElement) {
    if (importing || !files?.length) return
    if (!selected) {
      setMessage('Create or choose a context before adding sources.')
      return
    }
    if (hasMediaFiles(files) && mediaNeedsSetup(settings)) setMediaHint(true)
    void onFiles(files, selected.id).finally(() => {
      if (input) input.value = ''
    })
  }
  function dismissRemove() {
    setRemoving(null)
    removeTrigger.current?.focus()
  }

  function renderPreview(item: ContextSource) {
    const linked =
      item.kind === 'note' ? byNoteId.get(item.linkedNoteId ?? '') : undefined
    const displayName = linked?.title ?? item.name
    const available =
      sourceIndex.has(item.id) && (item.kind !== 'note' || !!linked)
    const source = resolveLibrarySource(item, notes)
    const thumbnail = isMediaSource(item) ? safeThumbnail(item) : undefined
    return (
      <div
        ref={previewPanel}
        className="context-library-preview"
        role="region"
        aria-label={`Preview of ${displayName}`}
      >
        <div className="context-library-preview-heading">
          <strong title={displayName}>{displayName}</strong>
          <span>
            {item.kind === 'note'
              ? 'Live writing'
              : isMediaSource(item)
                ? 'Embedded on this device'
                : 'Cached on this device'}
          </span>
          {item.kind === 'website' &&
            item.origin &&
            /^https?:\/\//i.test(item.origin) && (
              <a href={item.origin} target="_blank" rel="noreferrer">
                View original <ArrowUpRight size={12} />
              </a>
            )}
          <button
            className="icon-button"
            aria-label="Close source preview"
            onClick={closePreview}
          >
            <X size={13} />
          </button>
        </div>
        {thumbnail && (
          <img
            className="context-library-preview-media"
            src={thumbnail}
            alt={`Preview of ${displayName}`}
          />
        )}
        <div className="context-library-preview-text" tabIndex={0}>
          {source.text.slice(0, previewLength) ||
            (available
              ? 'This source is empty. Writing added to a linked note appears here automatically.'
              : 'This source is unavailable. Remove it from this context or add it again.')}
        </div>
        {source.text.length > previewLength && (
          <button
            className="button subtle context-library-show-more"
            onClick={() =>
              setPreviewLength(length => length + CONTEXT_PREVIEW_CHARACTERS)
            }
          >
            Showing the first {previewLength.toLocaleString()} characters. Show
            more
          </button>
        )}
      </div>
    )
  }

  const full = sources.length >= MAX_CONTEXT_PACKAGE_SOURCES

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Contexts"
      description="Gather sources into reusable contexts. Choose several for each note."
      className="context-library-dialog"
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={event => {
        if (removing) {
          event.preventDefault()
          dismissRemove()
        } else if (editing) {
          event.preventDefault()
          setEditing(null)
          setMessage('')
        } else if (choosingNote) {
          event.preventDefault()
          setChoosingNote(false)
        } else if (previewId) {
          event.preventDefault()
          closePreview()
        }
      }}
    >
      <div
        className={`context-library-body ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={event => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            dragDepth.current++
            setDragging(true)
          }
        }}
        onDragOver={event => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDragLeave={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          if (--dragDepth.current <= 0) {
            dragDepth.current = 0
            setDragging(false)
          }
        }}
        onDrop={event => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          importFiles(event.dataTransfer.files)
        }}
      >
        <nav
          className="context-library-packages"
          aria-label="Reusable contexts"
        >
          <div className="context-library-packages-top">
            <button
              className="button secondary context-package-create"
              disabled={importing || packages.length >= MAX_CONTEXT_PACKAGES}
              onClick={startCreating}
            >
              <Plus size={15} /> New context
            </button>
            {packages.length > 0 && (
              <div className="context-package-search-field">
                <Search size={13} aria-hidden="true" />
                <label
                  className="visually-hidden"
                  htmlFor="context-package-search"
                >
                  Find a context
                </label>
                <input
                  id="context-package-search"
                  className="context-package-search"
                  type="search"
                  value={packageQuery}
                  placeholder="Find a context"
                  onChange={event => setPackageQuery(event.target.value)}
                />
              </div>
            )}
          </div>
          <div className="context-package-list">
            {matchingPackages.map(context => {
              const isSelected = context.id === selectedId && !editing
              const isAttached = attached.has(context.id)
              return (
                <div
                  className={`context-package-row ${isSelected ? 'is-selected' : ''} ${isAttached ? 'is-attached' : ''}`}
                  key={context.id}
                >
                  <button
                    className="context-package-select"
                    aria-label={`Open ${context.name} context`}
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => chooseContext(context.id)}
                  >
                    <span className="context-package-mark" aria-hidden="true" />
                    <span className="context-package-name" title={context.name}>
                      {context.name}
                    </span>
                    <small>{context.sourceIds.length}</small>
                  </button>
                  <label
                    className="context-switch"
                    title={
                      activeNote
                        ? `${isAttached ? 'Used in' : 'Use in'} ${activeNote.title}`
                        : 'Open a note to use this context'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={isAttached}
                      disabled={!activeNote || importing}
                      aria-label={`Use ${context.name} in this note`}
                      onChange={event =>
                        event.target.checked
                          ? onAttachPackage(context.id)
                          : onDetachPackage(context.id)
                      }
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              )
            })}
          </div>
          {packageQuery && !matchingPackages.length && (
            <p role="status">No contexts match.</p>
          )}
          <p className="context-library-packages-note">
            {activeNote ? (
              <>
                Contexts for <strong>{activeNote.title}</strong>. Switch on any
                combination.
              </>
            ) : (
              'Open a note to choose its contexts.'
            )}
          </p>
        </nav>
        <section
          className="context-library-content"
          aria-label="Context sources"
        >
          {editing ? (
            <form
              className="context-package-form"
              onSubmit={event => {
                event.preventDefault()
                if (!name.trim()) return
                if (editing === 'create') {
                  const id = onCreatePackage(name.trim())
                  if (!id) {
                    setMessage(
                      'This context could not be created. Check the notebook message and try again.'
                    )
                    return
                  }
                  chooseContext(id)
                } else if (selected) {
                  onRenamePackage(selected.id, name.trim())
                  setEditing(null)
                }
              }}
            >
              <h3>{editing === 'create' ? 'New context' : 'Rename context'}</h3>
              <p>
                A collection of files, folders, websites, media, or live notes
                you can use across drafts.
              </p>
              <label className="field-label" htmlFor="context-package-name">
                Context name
              </label>
              <input
                id="context-package-name"
                value={name}
                maxLength={128}
                autoFocus
                placeholder="For example, Field research"
                onChange={event => setName(event.target.value)}
              />
              {message && (
                <p className="field-error" role="alert">
                  {message}
                </p>
              )}
              <div className="context-package-form-actions">
                <button
                  type="button"
                  className="button subtle"
                  onClick={() => {
                    setEditing(null)
                    setMessage('')
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!name.trim()}
                >
                  {editing === 'create' ? 'Create context' : 'Save name'}
                </button>
              </div>
            </form>
          ) : selected ? (
            <>
              <div className="context-package-heading">
                <span
                  className="context-package-heading-icon"
                  aria-hidden="true"
                >
                  <BookOpen size={16} strokeWidth={1.6} />
                </span>
                <h3 title={selected.name}>{selected.name}</h3>
                {attached.has(selected.id) && (
                  <span className="context-package-badge">In this note</span>
                )}
                <button
                  className="icon-button"
                  aria-label={`Rename ${selected.name}`}
                  disabled={importing}
                  onClick={() => {
                    setName(selected.name)
                    setEditing('rename')
                    setMessage('')
                    closePreview()
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove ${selected.name} context`}
                  disabled={importing}
                  onClick={event => {
                    removeTrigger.current = event.currentTarget
                    setRemoving({ kind: 'package', id: selected.id })
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {spaces.length > 1 && onShareSpaces && (
                <div
                  className="context-spaces"
                  role="group"
                  aria-label="Workspaces that can use this context"
                >
                  <span>Available in</span>
                  {spaces.map(space => {
                    const on =
                      !selected.spaceIds?.length ||
                      selected.spaceIds.includes(space.id)
                    return (
                      <button
                        key={space.id}
                        type="button"
                        className={`context-space-chip org-${space.color}`}
                        aria-pressed={on}
                        onClick={() => {
                          const current = selected.spaceIds?.length
                            ? selected.spaceIds
                            : spaces.map(item => item.id)
                          const next = on
                            ? current.filter(id => id !== space.id)
                            : [...current, space.id]
                          // A context is always available somewhere.
                          if (next.length) onShareSpaces(selected.id, next)
                        }}
                      >
                        <span className="org-dot" aria-hidden="true" />
                        {space.name}
                      </button>
                    )
                  })}
                </div>
              )}
              <p className="context-library-help">
                {selectedUsage
                  ? `Used in ${selectedUsage} ${selectedUsage === 1 ? 'note' : 'notes'}. Changes to this context follow every attached note.`
                  : 'Add sources, then switch this context on beside any note that needs it.'}
              </p>
              <div
                className="context-library-actions"
                role="group"
                aria-label="Add sources"
              >
                <button
                  className="context-library-action"
                  disabled={importing || full}
                  onClick={() => fileInput.current?.click()}
                >
                  {importing ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Upload size={15} />
                  )}
                  {importing ? 'Reading sources…' : 'Add files'}
                </button>
                <button
                  className="context-library-action"
                  disabled={importing || full}
                  onClick={() => folderInput.current?.click()}
                >
                  <FolderOpen size={15} /> Add folder
                </button>
                <button
                  className="context-library-action"
                  disabled={importing || full}
                  onClick={() => onWebsite(selected.id)}
                >
                  <Link size={15} /> Add a website
                </button>
                <button
                  className="context-library-action"
                  disabled={importing || !notes.length || full}
                  onClick={() => {
                    setChoosingNote(true)
                    setNoteQuery('')
                    closePreview()
                  }}
                >
                  <Notebook size={15} /> Use a note
                </button>
              </div>
              {mediaHint && (
                <MediaHint
                  onOpenSettings={
                    onOpenKnowledgeSettings
                      ? () => {
                          onOpenChange(false)
                          onOpenKnowledgeSettings()
                        }
                      : undefined
                  }
                  onDismiss={() => setMediaHint(false)}
                />
              )}
              {message && (
                <p className="field-error" role="alert">
                  {message}
                </p>
              )}
              {choosingNote ? (
                <>
                  <div className="context-library-note-heading">
                    <button
                      className="button subtle"
                      onClick={() => setChoosingNote(false)}
                    >
                      <ArrowLeft size={15} /> Back to sources
                    </button>
                    <h3>Use a note in this context</h3>
                  </div>
                  <p className="context-library-help">
                    Linked writing stays current. A note reads another note’s
                    own words; links do not expand into chains.
                  </p>
                  <label className="field-label" htmlFor="library-note-search">
                    Search notes
                  </label>
                  <input
                    id="library-note-search"
                    type="search"
                    autoFocus
                    value={noteQuery}
                    onChange={event => setNoteQuery(event.target.value)}
                    placeholder="Find a note by title"
                  />
                  <ul
                    className="context-library-list"
                    aria-label="Available notes"
                  >
                    {availableNotes.map(candidate => (
                      <li key={candidate.id}>
                        <button
                          className="context-library-note-option"
                          aria-label={`Add ${candidate.title} to ${selected.name}`}
                          onClick={() => {
                            onUseNote(candidate.id, selected.id)
                            setChoosingNote(false)
                            setFolder(null)
                            setQuery('')
                          }}
                        >
                          <Notebook size={16} />
                          <span>{candidate.title}</span>
                          <Plus size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!availableNotes.length && (
                    <p className="context-library-empty" role="status">
                      {noteQuery
                        ? 'No notes match your search.'
                        : 'Your notes are already in this context.'}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="context-package-filters">
                    <div className="context-filter-search">
                      <label className="field-label" htmlFor="library-search">
                        Find a source
                      </label>
                      <input
                        ref={searchInput}
                        id="library-search"
                        type="search"
                        autoFocus
                        value={query}
                        onChange={event => {
                          setQuery(event.target.value)
                          closePreview()
                        }}
                        placeholder="File, website, media, or note"
                      />
                    </div>
                    {folders.length > 0 && (
                      <div>
                        <label
                          className="field-label"
                          htmlFor="context-package-folder"
                        >
                          Folder
                        </label>
                        <select
                          id="context-package-folder"
                          value={folder ?? ''}
                          onChange={event => {
                            setFolder(event.target.value || null)
                            closePreview()
                          }}
                        >
                          <option value="">All folders</option>
                          {folders.map(item => (
                            <option value={item.path} key={item.path}>
                              {item.path} ({item.count})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="context-library-selection">
                    <span>
                      {sources.length}{' '}
                      {sources.length === 1 ? 'source' : 'sources'}
                    </span>
                    <KindCluster counts={selectedCounts} />
                    {folders.length > 0 && (
                      <small>Folder imports are snapshots.</small>
                    )}
                  </div>
                  {previewItem && renderPreview(previewItem)}
                  {matching.length > 0 && (
                    <ul
                      className="context-library-list context-source-grid"
                      aria-label="Sources in this context"
                    >
                      {matching.map(item => {
                        const linked =
                          item.kind === 'note'
                            ? byNoteId.get(item.linkedNoteId ?? '')
                            : undefined
                        const displayName = linked?.title ?? item.name
                        const available =
                          sourceIndex.has(item.id) &&
                          (item.kind !== 'note' || !!linked)
                        const self =
                          item.kind === 'note' &&
                          item.linkedNoteId === activeNote?.id
                        const preview = previewId === item.id
                        return (
                          <li
                            className={`context-library-item context-source-card ${preview ? 'is-previewing' : ''} ${available ? '' : 'is-unavailable'}`}
                            key={item.id}
                          >
                            <button
                              className="context-library-preview-button"
                              aria-label={`Preview ${displayName}`}
                              aria-expanded={preview}
                              onClick={() => {
                                setPreviewId(preview ? null : item.id)
                                setPreviewLength(CONTEXT_PREVIEW_CHARACTERS)
                              }}
                            >
                              <SourceThumb source={item} size="card" />
                              <span className="context-source-copy">
                                <strong title={displayName}>
                                  {displayName}
                                </strong>
                                <small>
                                  {available
                                    ? sourceKind(item)
                                    : 'Unavailable reference'}
                                  {item.folder && ` · ${item.folder}`}
                                  {self && ' · Left out for its own note'}
                                </small>
                              </span>
                            </button>
                            <button
                              className="icon-button context-library-remove"
                              aria-label={`Remove ${displayName} from ${selected.name}`}
                              disabled={importing}
                              onClick={event => {
                                removeTrigger.current = event.currentTarget
                                setRemoving({ kind: 'source', id: item.id })
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        )
                      })}
                      {!query && !folder && !full && (
                        <li className="context-source-drop">
                          <button
                            disabled={importing}
                            onClick={() => fileInput.current?.click()}
                          >
                            <Upload size={15} aria-hidden="true" />
                            <span>Drop files here, or browse</span>
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                  {!matching.length && (
                    <div
                      className={`context-library-empty ${sources.length ? '' : 'is-drop'}`}
                      role="status"
                    >
                      <FolderOpen size={26} strokeWidth={1.3} />
                      <strong>
                        {sources.length
                          ? 'No sources match.'
                          : 'Bring this context to life.'}
                      </strong>
                      <span>
                        {sources.length
                          ? 'Try another name or choose All folders.'
                          : 'Drop files here, or add a folder snapshot, a website, or a note. The same context can support several drafts.'}
                      </span>
                      {!sources.length && <small>{SOURCE_FORMATS_HELP}</small>}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="context-library-empty" role="status">
              <BookOpen size={26} strokeWidth={1.3} />
              <strong>A place for the details you return to.</strong>
              <span>
                Create a context, give it a name, and gather its sources. Each
                note can draw from several contexts.
              </span>
              <button className="button secondary" onClick={startCreating}>
                <Plus size={15} /> Create your first context
              </button>
            </div>
          )}
        </section>
        {dragging && (
          <div className="context-library-drop" aria-hidden="true">
            <span className="context-drop-icon">
              <Upload size={20} strokeWidth={1.6} />
            </span>
            <strong>Drop sources into {selected?.name ?? 'a context'}</strong>
            <span>{SOURCE_FORMATS_SHORT}</span>
          </div>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={SOURCE_ACCEPT}
        className="visually-hidden"
        aria-label="Add files to this context"
        disabled={importing || !selected}
        onChange={event => importFiles(event.target.files, event.currentTarget)}
      />
      <input
        ref={element => {
          folderInput.current = element
          if (element) {
            element.webkitdirectory = true
            element.setAttribute('webkitdirectory', '')
          }
        }}
        type="file"
        multiple
        className="visually-hidden"
        aria-label="Add folder to this context"
        disabled={importing || !selected}
        onChange={event => importFiles(event.target.files, event.currentTarget)}
      />
      {removing && selected ? (
        <div
          className="context-library-confirm"
          role="group"
          aria-label="Confirm context removal"
        >
          <p role="status">
            <strong>Remove {removeName}?</strong>
            <span>
              {removing.kind === 'package'
                ? selectedUsage
                  ? `This detaches it from ${selectedUsage} ${selectedUsage === 1 ? 'note' : 'notes'}. Sources used elsewhere stay available.`
                  : 'Sources used by another context or note stay available.'
                : `This removes it from ${selected.name}.${selectedUsage ? ` ${selectedUsage} ${selectedUsage === 1 ? 'note uses' : 'notes use'} this context.` : ''} Other contexts keep sources they share.`}
            </span>
          </p>
          <button
            ref={cancelRemove}
            className="button secondary"
            onClick={dismissRemove}
          >
            Cancel
          </button>
          <button
            className="button destructive"
            onClick={() => {
              if (removing.kind === 'package') onRemovePackage(selected.id)
              else onRemoveSource(selected.id, removing.id)
              setRemoving(null)
              if (previewId === removing.id) closePreview()
              searchInput.current?.focus()
            }}
          >
            {removing.kind === 'package' ? 'Remove context' : 'Remove source'}
          </button>
        </div>
      ) : (
        <div className="context-library-footer">
          <div className="context-library-footer-copy">
            <p>
              Files and websites are snapshots on this device. Linked notes
              follow your writing.
            </p>
            {onDemo && (
              <div className="context-library-demo">
                <button onClick={onDemo} disabled={importing}>
                  {demoInstalled ? 'Open sample' : 'Try a sample'}
                </button>
                {demoDownloadHref && (
                  <a href={demoDownloadHref} download="typenext-sample.zip">
                    Download sample files
                  </a>
                )}
              </div>
            )}
          </div>
          <button
            className="button primary"
            onClick={() => onOpenChange(false)}
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  )
}
