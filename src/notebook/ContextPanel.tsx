import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Link,
  LoaderCircle,
  Notebook,
  ShieldCheck,
  Upload,
  X,
  Folder,
} from 'lucide-react'
import type {
  ContextPackage,
  ContextSource,
  Note,
  NoteFolder,
  NotebookSettings,
} from '../types/notebook'
import { folderContextNotes, MAX_FOLDER_CONTEXT_NOTES } from './note-context'
import { folderPath } from './organize/organize'
import { relativeDate } from './model'
import { Modal } from './Modal'
import { resolveNoteContext } from './note-context'
import { MAX_CONTEXT_PACKAGES_PER_NOTE } from './context-library'
import { AttachedSearch } from './context/AttachedSearch'
import { ConnectionBoard, type BoardPackage } from './context/ConnectionBoard'
import { IntentSection } from './context/IntentSection'
import { MediaHint } from './context/MediaHint'
import { ReferenceList, WordTotal } from './context/ReferenceList'
import {
  hasMediaFiles,
  mediaNeedsSetup,
  SOURCE_ACCEPT,
  SOURCE_FORMATS_HELP,
  SOURCE_FORMATS_SHORT,
} from './context/media'
import {
  formatBytes,
  isMediaSource,
  mediaDetail,
  safeThumbnail,
  sourceKindName,
} from './context/source-kinds'
import './context/context-panel.css'

const EMPTY_LIBRARY: ContextSource[] = []
const EMPTY_PACKAGES: ContextPackage[] = []
const EMPTY_NOTE_IDS = new Set<string>()
const EMPTY_FOLDERS: NoteFolder[] = []

export interface ContextPanelProps {
  note: Note
  notes: Note[]
  library?: ContextSource[]
  packages?: ContextPackage[]
  importing: boolean
  onUpdate(patch: Partial<Note>): void
  onClose(): void
  /** Without a package id the files attach directly to this note. */
  onFiles(files: FileList | null, packageId?: string): Promise<void>
  onWebsite(): void
  onUseNote(id: string): void
  /** Notebook folders, for live folder context. */
  folders?: NoteFolder[]
  onAttachFolder?(id: string): void
  onDetachFolder?(id: string): void
  onLibrary?(packageId?: string): void
  onDetachPackage?(id: string): void
  /** Attach a named context. Falls back to updating the note directly. */
  onAttachPackage?(id: string): void
  /** Create a named context from the quick field; returns its id or null. */
  onCreatePackage?(name: string): string | null
  /** Enables meaning search, index progress and the media setup hint. */
  settings?: NotebookSettings
  onOpenKnowledgeSettings?(): void
}

export function ContextPanel({
  note,
  notes,
  library = EMPTY_LIBRARY,
  packages = EMPTY_PACKAGES,
  importing,
  onUpdate,
  onClose,
  onFiles,
  onWebsite,
  onUseNote,
  folders = EMPTY_FOLDERS,
  onAttachFolder,
  onDetachFolder,
  onLibrary,
  onDetachPackage,
  onAttachPackage,
  onCreatePackage,
  settings,
  onOpenKnowledgeSettings,
}: ContextPanelProps) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [choosingNote, setChoosingNote] = useState(false)
  const [choosingFolder, setChoosingFolder] = useState(false)
  const [noteQuery, setNoteQuery] = useState('')
  const [mediaHint, setMediaHint] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const announce = useCallback((message: string) => {
    // Re-announce identical messages by clearing first.
    setAnnouncement('')
    window.requestAnimationFrame(() => setAnnouncement(message))
  }, [])
  const libraryIds = useMemo(
    () => new Set(library.map(item => item.id)),
    [library]
  )
  const noteIds = useMemo(
    () =>
      note.sources.some(source => source.kind === 'note')
        ? new Set(notes.map(item => item.id))
        : EMPTY_NOTE_IDS,
    [note.sources, notes]
  )
  function sourceIsAvailable(item: ContextSource) {
    return (
      (!item.libraryId || libraryIds.has(item.libraryId)) &&
      (item.kind !== 'note' ||
        (item.linkedNoteId !== note.id && noteIds.has(item.linkedNoteId ?? '')))
    )
  }
  const resolved = useMemo(
    () => resolveNoteContext(note, notes, library, packages, folders),
    [note, notes, library, packages, folders]
  )
  const attachedFolders = useMemo(
    () =>
      (note.contextFolderIds ?? [])
        .map(id => folders.find(folder => folder.id === id))
        .filter((folder): folder is NoteFolder => Boolean(folder))
        .map(folder => ({
          folder,
          path: folderPath(folders, folder.id)
            .map(item => item.name)
            .join(' › '),
          count: folderContextNotes(folder.id, notes, folders, note.id).length,
        })),
    [note.contextFolderIds, note.id, folders, notes]
  )
  const directSources = useMemo(() => {
    if (!note.sources.length) return EMPTY_LIBRARY
    const direct = resolveNoteContext(
      { ...note, contextPackageIds: [] },
      notes,
      library
    )
    const byId = new Map(direct.sources.map(source => [source.id, source]))
    return note.sources.map(
      source => byId.get(source.id) ?? { ...source, text: '', enabled: false }
    )
  }, [note, notes, library])
  const attachedPackages = useMemo<BoardPackage[]>(() => {
    if (!note.contextPackageIds?.length) return []
    const byId = new Map(packages.map(context => [context.id, context]))
    return note.contextPackageIds.map(id => {
      const context = byId.get(id)
      return context
        ? { context, available: true }
        : {
            context: {
              id,
              name: 'Unavailable context',
              sourceIds: [],
              createdAt: 0,
              updatedAt: 0,
            },
            available: false,
          }
    })
  }, [note.contextPackageIds, packages])
  const source = directSources.find(item => item.id === previewId)
  const enabled = resolved.sources.filter(item => item.enabled).length
  const availableNotes = useMemo(() => {
    if (!choosingNote) return []
    const linkedIds = new Set(
      note.sources
        .filter(item => item.kind === 'note')
        .map(item => item.linkedNoteId)
    )
    return notes
      .filter(
        candidate => candidate.id !== note.id && !linkedIds.has(candidate.id)
      )
      .sort((first, second) => second.updatedAt - first.updatedAt)
  }, [note.id, note.sources, notes, choosingNote])
  const matchingNotes = useMemo(() => {
    const query = noteQuery.trim().toLocaleLowerCase()
    return availableNotes.filter(candidate =>
      candidate.title.toLocaleLowerCase().includes(query)
    )
  }, [availableNotes, noteQuery])
  const sourceAvailable = !source || sourceIsAvailable(source)
  const includedDirect = directSources.filter(item => item.enabled).length

  function sendFiles(files: FileList | null, packageId?: string) {
    if (!files?.length) return Promise.resolve()
    if (hasMediaFiles(files) && mediaNeedsSetup(settings)) setMediaHint(true)
    return packageId ? onFiles(files, packageId) : onFiles(files)
  }
  function toggleSource(item: ContextSource, value: boolean) {
    onUpdate({
      sources: note.sources.map(candidate =>
        candidate.id === item.id ? { ...candidate, enabled: value } : candidate
      ),
    })
    announce(`${item.name} ${value ? 'included' : 'left out'}`)
  }
  function attachPackage(id: string) {
    if (onAttachPackage) onAttachPackage(id)
    else
      onUpdate({
        contextPackageIds: [...(note.contextPackageIds ?? []), id],
      })
  }
  function detachPackage(id: string) {
    if (onDetachPackage) onDetachPackage(id)
    else
      onUpdate({
        contextPackageIds: note.contextPackageIds?.filter(key => key !== id),
      })
  }
  function resetDrag() {
    dragDepth.current = 0
    setDragging(false)
  }

  return (
    <>
      <aside
        className={`context-panel ${dragging ? 'drop-active' : ''}`}
        aria-label="Note context"
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
          dragDepth.current--
          if (dragDepth.current <= 0) resetDrag()
        }}
        onDrop={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          resetDrag()
          // A context card already routed these files into its package.
          if (
            event.target instanceof Element &&
            event.target.closest('[data-file-target]')
          )
            return
          if (!importing) {
            const count = event.dataTransfer.files.length
            if (count)
              announce(
                `Attaching ${count} ${count === 1 ? 'file' : 'files'} to this note`
              )
            void sendFiles(event.dataTransfer.files)
          }
        }}
      >
        {dragging && (
          <div className="context-drop-overlay" aria-hidden="true">
            <span className="context-drop-icon">
              <Upload size={20} strokeWidth={1.6} />
            </span>
            <strong>Drop your references here</strong>
            <span>
              Release anywhere to attach to this note, or over a context to add
              them there.
            </span>
            <small>{SOURCE_FORMATS_SHORT}</small>
          </div>
        )}
        <div className="context-panel-scroll">
          <div className="context-heading">
            <h2>Context</h2>
            <button
              className="icon-button"
              aria-label="Close context panel"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          <p className="panel-description">
            The intention and the details behind your words.
          </p>

          <IntentSection note={note} onUpdate={onUpdate} />

          <ConnectionBoard
            noteTitle={note.title.trim() || 'Untitled note'}
            reach={enabled}
            attached={attachedPackages}
            packages={packages}
            library={library}
            importing={importing}
            canAttach={
              (note.contextPackageIds?.length ?? 0) <
              MAX_CONTEXT_PACKAGES_PER_NOTE
            }
            onAttach={attachPackage}
            onDetach={detachPackage}
            onManage={onLibrary ? id => onLibrary(id) : undefined}
            onLibrary={onLibrary ? () => onLibrary() : undefined}
            onCreate={onCreatePackage}
            onPackageFiles={(files, id) => void sendFiles(files, id)}
            announce={announce}
          />

          <section
            className="context-references"
            aria-labelledby="direct-references-heading"
          >
            <div className="context-section-heading">
              <h3 id="direct-references-heading">Direct references</h3>
              <span>
                {note.sources.length
                  ? `${includedDirect} of ${note.sources.length} included`
                  : 'Just for this note'}
              </span>
            </div>
            {attachedFolders.length > 0 && (
              <ul className="context-folders" aria-label="Attached folders">
                {attachedFolders.map(({ folder, path, count }) => (
                  <li
                    key={folder.id}
                    className={`context-folder org-${folder.color ?? 'slate'}`}
                  >
                    <Folder
                      size={15}
                      className="org-folder-icon"
                      aria-hidden="true"
                    />
                    <span className="context-folder-copy">
                      <strong title={path}>{folder.name}</strong>
                      <small>
                        {count
                          ? `${count}${count === MAX_FOLDER_CONTEXT_NOTES ? ' newest' : ''} ${count === 1 ? 'note' : 'notes'} · stays up to date`
                          : 'No notes yet · new notes join automatically'}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Detach folder ${folder.name}`}
                      onClick={() => {
                        onDetachFolder?.(folder.id)
                        announce(`${folder.name} detached`)
                      }}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {note.sources.length > 0 && (
              <ReferenceList
                sources={directSources}
                isAvailable={sourceIsAvailable}
                onToggle={toggleSource}
                onPreview={item => setPreviewId(item.id)}
                onRemove={item => {
                  onUpdate({
                    sources: note.sources.filter(
                      candidate => candidate.id !== item.id
                    ),
                  })
                  announce(`${item.name} removed`)
                }}
              />
            )}
            <div
              className="context-reference-actions"
              role="group"
              aria-label="Add a direct reference"
            >
              <button
                className="context-action"
                disabled={importing}
                onClick={() => input.current?.click()}
              >
                {importing ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Upload size={14} />
                )}
                <span>
                  {importing ? 'Reading references…' : 'Attach files'}
                </span>
              </button>
              <button
                className="context-action"
                disabled={importing}
                onClick={onWebsite}
              >
                <Link size={14} />
                <span>Add a website</span>
              </button>
              <button
                className="context-action"
                disabled={importing}
                onClick={() => {
                  setNoteQuery('')
                  setChoosingNote(true)
                }}
              >
                <Notebook size={14} />
                <span>Use a note</span>
              </button>
              {onAttachFolder && folders.length > 0 && (
                <button
                  className="context-action"
                  disabled={importing}
                  onClick={() => setChoosingFolder(true)}
                >
                  <Folder size={14} />
                  <span>Use a folder</span>
                </button>
              )}
            </div>
            <p className="field-help context-formats">
              {note.sources.length
                ? 'Click a reference to preview it. Switch it off to leave it out of suggestions. '
                : 'Keep a single file, site or note just for this draft. '}
              {SOURCE_FORMATS_HELP}
            </p>
            {mediaHint && (
              <MediaHint
                onOpenSettings={onOpenKnowledgeSettings}
                onDismiss={() => setMediaHint(false)}
              />
            )}
            <input
              ref={input}
              type="file"
              disabled={importing}
              multiple
              accept={SOURCE_ACCEPT}
              className="visually-hidden"
              aria-label="Attach reference files"
              onChange={event => {
                const files = event.target.files
                void sendFiles(files).finally(() => {
                  if (input.current) input.current.value = ''
                })
              }}
            />
          </section>

          <AttachedSearch
            resolved={resolved}
            enabled={enabled}
            settings={settings}
          />

          <p className="context-privacy">
            <ShieldCheck size={14} />
            <span>
              Files stay on this device. Only the references you include inform
              suggestions.
            </span>
          </p>
          <p className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </aside>
      <Modal
        open={Boolean(source)}
        onOpenChange={open => {
          if (!open) setPreviewId(null)
        }}
        title={source?.name ?? 'Reference'}
        description={`This is the text available to suggestions. ${source?.enabled ? 'Included in this note.' : 'Currently left out of this note.'}`}
        className="source-preview-dialog"
      >
        {source && (
          <>
            {isMediaSource(source) && safeThumbnail(source) && (
              <figure className="source-preview-media">
                <img
                  src={safeThumbnail(source)}
                  alt={`${sourceKindName(source)} preview of ${source.name}`}
                />
              </figure>
            )}
            <div className="source-preview-meta">
              <span>
                {source.kind === 'note' ? (
                  sourceAvailable ? (
                    'Linked note · Live context'
                  ) : (
                    'Linked note · Unavailable'
                  )
                ) : isMediaSource(source) ? (
                  [
                    sourceKindName(source),
                    mediaDetail(source),
                    formatBytes(source.media?.bytes),
                    'Embedded on this device',
                  ]
                    .filter(Boolean)
                    .join(' · ')
                ) : (
                  <>
                    <WordTotal text={source.text} /> · Cached locally
                  </>
                )}
              </span>
              {source.origin &&
                source.kind !== 'note' &&
                /^https?:\/\//iu.test(source.origin) && (
                  <a href={source.origin} target="_blank" rel="noreferrer">
                    View original
                    <ArrowUpRight size={12} />
                  </a>
                )}
            </div>
            {isMediaSource(source) && (
              <p className="source-preview-caption-label">
                Caption used for search and suggestions
              </p>
            )}
            <div className="source-preview-text" tabIndex={0}>
              {source.text ||
                (!sourceAvailable && source.libraryId && source.kind !== 'note'
                  ? 'This reference is no longer in your library. Remove it from this note or choose another reference.'
                  : source.kind === 'note'
                    ? sourceAvailable
                      ? 'This note is empty. Its writing will appear here as you add it.'
                      : 'This note is no longer in your notebook. Remove this reference or link another note.'
                    : '')}
            </div>
            <div className="dialog-footer">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  disabled={!sourceAvailable}
                  onChange={event => toggleSource(source, event.target.checked)}
                />
                Include in suggestions
              </label>
              <button
                className="button primary"
                onClick={() => setPreviewId(null)}
              >
                Done
              </button>
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={choosingNote}
        onOpenChange={open => {
          setChoosingNote(open)
          if (!open) setNoteQuery('')
        }}
        title="Use a note as context"
        description="Use another note’s writing as a live reference. Its edits are included automatically."
        className="note-context-picker"
      >
        <label className="field-label" htmlFor="note-context-search">
          Search notes
        </label>
        <input
          id="note-context-search"
          type="search"
          autoFocus
          value={noteQuery}
          placeholder="Find a note by title"
          onChange={event => setNoteQuery(event.target.value)}
        />
        <ul className="note-context-list" aria-label="Available notes">
          {matchingNotes.map(candidate => (
            <li key={candidate.id}>
              <button
                type="button"
                className="note-context-option"
                aria-label={`Use ${candidate.title} as context`}
                onClick={() => {
                  onUseNote(candidate.id)
                  setChoosingNote(false)
                  setNoteQuery('')
                  announce(`${candidate.title} linked`)
                }}
              >
                <Notebook size={18} strokeWidth={1.5} />
                <span className="note-context-option-copy">
                  <strong>{candidate.title}</strong>
                  <small>
                    <WordTotal text={candidate.content} /> ·{' '}
                    {relativeDate(candidate.updatedAt)}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </button>
            </li>
          ))}
        </ul>
        {!matchingNotes.length && (
          <p className="note-context-empty" role="status">
            {availableNotes.length
              ? 'No notes match your search.'
              : notes.length > 1
                ? 'Your other notes are already attached.'
                : 'Create another note to use its writing as context.'}
          </p>
        )}
      </Modal>
      <Modal
        open={choosingFolder}
        onOpenChange={setChoosingFolder}
        title="Use a folder as context"
        description="Every note in the folder and its subfolders becomes a live reference, including notes you add later."
        className="note-context-picker"
      >
        <ul className="note-context-list" aria-label="Folders">
          {folders
            .filter(folder => !note.contextFolderIds?.includes(folder.id))
            .map(folder => ({
              folder,
              path: folderPath(folders, folder.id),
              count: folderContextNotes(folder.id, notes, folders, note.id)
                .length,
            }))
            .sort((left, right) =>
              left.path
                .map(item => item.name)
                .join('/')
                .localeCompare(right.path.map(item => item.name).join('/'))
            )
            .map(({ folder, path, count }) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className={`note-context-option org-${folder.color ?? 'slate'}`}
                  aria-label={`Use folder ${folder.name} as context`}
                  onClick={() => {
                    onAttachFolder?.(folder.id)
                    setChoosingFolder(false)
                    announce(`${folder.name} linked`)
                  }}
                >
                  <Folder
                    size={18}
                    strokeWidth={1.5}
                    className="org-folder-icon"
                  />
                  <span className="note-context-option-copy">
                    <strong>{path.map(item => item.name).join(' › ')}</strong>
                    <small>
                      {count} {count === 1 ? 'note' : 'notes'}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              </li>
            ))}
        </ul>
        {folders.every(folder =>
          note.contextFolderIds?.includes(folder.id)
        ) && (
          <p className="note-context-empty" role="status">
            Every folder is already attached.
          </p>
        )}
      </Modal>
    </>
  )
}
