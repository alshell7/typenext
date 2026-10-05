import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Link,
  LoaderCircle,
  Notebook,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { ContextSource, Note } from '../types/notebook'
import { Modal } from './Modal'
import {
  CONTEXT_PREVIEW_CHARACTERS,
  contextLibraryFolders,
  contextLibraryUsage,
  filterContextLibrary,
  resolveLibrarySource,
} from './context-library'
import './ContextLibrary.css'

const EMPTY_FOLDERS: ReturnType<typeof contextLibraryFolders> = []
const EMPTY_USAGE = new Map<string, number>()
const EMPTY_NOTE_INDEX = new Map<string, Note>()
const EMPTY_SOURCES: ContextSource[] = []
const EMPTY_ATTACHED = new Set<string>()
const EMPTY_NOTES: Note[] = []

export interface ContextLibraryProps {
  open: boolean
  onOpenChange(open: boolean): void
  library: ContextSource[]
  notes: Note[]
  activeNote: Note | null
  importing: boolean
  onAttach(id: string): void
  onDetach(id: string): void
  onRemove(id: string): void
  onFiles(files: FileList | null): Promise<void>
  onWebsite(): void
  onUseNote(id: string): void
}

function sourceKind(source: ContextSource) {
  if (source.kind === 'note') return 'Live note'
  if (source.kind === 'website') return 'Website snapshot'
  if (source.kind === 'markdown') return 'Markdown'
  if (source.kind === 'text') return 'Text'
  return source.kind.toUpperCase()
}

function SourceIcon({ source }: { source: ContextSource }) {
  return source.kind === 'note' ? (
    <Notebook size={16} strokeWidth={1.5} />
  ) : source.kind === 'website' ? (
    <Globe size={16} strokeWidth={1.5} />
  ) : (
    <FileText size={16} strokeWidth={1.5} />
  )
}

export function ContextLibrary({
  open,
  onOpenChange,
  library,
  notes,
  activeNote,
  importing,
  onAttach,
  onDetach,
  onRemove,
  onFiles,
  onWebsite,
  onUseNote,
}: ContextLibraryProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const cancelRemove = useRef<HTMLButtonElement>(null)
  const removeTrigger = useRef<HTMLButtonElement | null>(null)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewLength, setPreviewLength] = useState(CONTEXT_PREVIEW_CHARACTERS)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [choosingNote, setChoosingNote] = useState(false)
  const [noteQuery, setNoteQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const folders = useMemo(
    () => (open ? contextLibraryFolders(library) : EMPTY_FOLDERS),
    [library, open]
  )
  const usage = useMemo(
    () => (open ? contextLibraryUsage(notes) : EMPTY_USAGE),
    [notes, open]
  )
  const byNoteId = useMemo(
    () =>
      open ? new Map(notes.map(note => [note.id, note])) : EMPTY_NOTE_INDEX,
    [notes, open]
  )
  const matching = useMemo(
    () =>
      open
        ? filterContextLibrary(library, notes, query, folder)
        : EMPTY_SOURCES,
    [library, notes, query, folder, open]
  )
  const attached = useMemo(
    () =>
      open
        ? new Set(
            activeNote?.sources.flatMap(source =>
              source.libraryId && source.enabled ? [source.libraryId] : []
            ) ?? []
          )
        : EMPTY_ATTACHED,
    [activeNote, open]
  )
  const removing =
    open && removingId
      ? library.find(source => source.id === removingId)
      : undefined
  const removingCount = removing ? (usage.get(removing.id) ?? 0) : 0
  const availableNotes = useMemo(() => {
    if (!open || !choosingNote) return EMPTY_NOTES
    const linkedIds = new Set(
      library
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
  }, [library, notes, noteQuery, choosingNote, open])

  useEffect(() => {
    if (open && removingId) cancelRemove.current?.focus()
  }, [removingId, open])
  useEffect(() => {
    if (open && folder && !folders.some(candidate => candidate.path === folder))
      setFolder(null)
  }, [folder, folders, open])
  useEffect(() => {
    if (open) return
    setPreviewId(null)
    setRemovingId(null)
    setChoosingNote(false)
    setNoteQuery('')
    setDragging(false)
    dragDepth.current = 0
  }, [open])

  function closePreview() {
    setPreviewId(null)
    setPreviewLength(CONTEXT_PREVIEW_CHARACTERS)
  }

  function chooseFolder(path: string | null) {
    setFolder(path)
    closePreview()
    setChoosingNote(false)
  }

  function importFiles(files: FileList | null, input?: HTMLInputElement) {
    if (importing || !files?.length) return
    void onFiles(files).finally(() => {
      if (input) input.value = ''
    })
  }

  function dismissRemove() {
    setRemovingId(null)
    removeTrigger.current?.focus()
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Context library"
      description="Keep the references you return to. Choose any combination for each note."
      className="context-library-dialog"
      onEscapeKeyDown={event => {
        if (removingId) {
          event.preventDefault()
          dismissRemove()
        } else if (choosingNote) {
          event.preventDefault()
          setChoosingNote(false)
        } else if (previewId) {
          event.preventDefault()
          closePreview()
        }
      }}
    >
      <div className="context-library-actions">
        <button
          className="button secondary"
          disabled={importing}
          onClick={() => fileInput.current?.click()}
        >
          {importing ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Upload size={15} />
          )}
          {importing ? 'Reading references…' : 'Add files'}
        </button>
        <button
          className="button subtle"
          disabled={importing}
          onClick={() => folderInput.current?.click()}
        >
          <FolderOpen size={15} /> Add folder
        </button>
        <button
          className="button subtle"
          disabled={importing}
          onClick={onWebsite}
        >
          <Link size={15} /> Add a website
        </button>
        <button
          className="button subtle"
          disabled={importing || notes.length === 0}
          onClick={() => {
            setChoosingNote(true)
            setNoteQuery('')
            closePreview()
          }}
        >
          <Notebook size={15} /> Use a note
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".txt,.md,.markdown,.pdf,.docx"
        className="visually-hidden"
        aria-label="Add files to context library"
        disabled={importing}
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
        aria-label="Add folder to context library"
        disabled={importing}
        onChange={event => importFiles(event.target.files, event.currentTarget)}
      />
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
        onDragLeave={() => {
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
        <nav className="context-library-folders" aria-label="Library folders">
          <button
            className={folder === null ? 'is-selected' : ''}
            aria-current={folder === null ? 'page' : undefined}
            onClick={() => chooseFolder(null)}
          >
            <BookOpen size={15} />
            <span>All references</span>
            <small>{library.length}</small>
          </button>
          {folders.length > 0 && <h3>Folders</h3>}
          {folders.map(item => (
            <button
              key={item.path}
              className={folder === item.path ? 'is-selected' : ''}
              aria-current={folder === item.path ? 'page' : undefined}
              aria-label={`Folder ${item.path}`}
              title={item.path}
              style={{ paddingLeft: 10 + Math.min(item.depth, 3) * 12 }}
              onClick={() => chooseFolder(item.path)}
            >
              <Folder size={15} />
              <span>{item.name}</span>
              <small>{item.count}</small>
            </button>
          ))}
          <p>
            Folder imports are snapshots. Supported files are read once; later
            changes are not watched.
          </p>
        </nav>
        <section
          className="context-library-content"
          aria-label="Library references"
        >
          {choosingNote ? (
            <>
              <div className="context-library-note-heading">
                <button
                  className="button subtle"
                  onClick={() => setChoosingNote(false)}
                >
                  <ArrowLeft size={15} /> Back to references
                </button>
                <h3>Use a note as context</h3>
              </div>
              <p className="context-library-help">
                Linked writing stays current. A note only reads the other note’s
                own words, so links do not expand into chains.
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
              <ul className="context-library-list" aria-label="Available notes">
                {availableNotes.map(candidate => (
                  <li key={candidate.id}>
                    <button
                      className="context-library-note-option"
                      aria-label={`Add ${candidate.title} to context library`}
                      onClick={() => {
                        onUseNote(candidate.id)
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
                    : 'Your notes are already in the library.'}
                </p>
              )}
            </>
          ) : (
            <>
              <label className="field-label" htmlFor="library-search">
                Search references
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
                placeholder="Find a file, website, or note"
              />
              <p className="context-library-selection">
                {activeNote ? (
                  <>
                    References for{' '}
                    <strong title={activeNote.title}>{activeNote.title}</strong>
                    <span>{attached.size} selected</span>
                  </>
                ) : (
                  'Open a note to choose its references.'
                )}
              </p>
              <ul
                className="context-library-list"
                aria-label="Reusable references"
              >
                {matching.map(item => {
                  const linked =
                    item.kind === 'note'
                      ? byNoteId.get(item.linkedNoteId ?? '')
                      : undefined
                  const name = linked?.title ?? item.name
                  const available = item.kind !== 'note' || !!linked
                  const self =
                    !!activeNote &&
                    item.kind === 'note' &&
                    item.linkedNoteId === activeNote.id
                  const selected = attached.has(item.id)
                  const count = usage.get(item.id) ?? 0
                  const preview = previewId === item.id
                  const source = preview
                    ? resolveLibrarySource(item, notes)
                    : item
                  return (
                    <li className="context-library-item" key={item.id}>
                      <div className="context-library-row">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={
                            !activeNote || !available || (self && !selected)
                          }
                          aria-label={`Use ${name} in this note`}
                          onChange={event =>
                            event.target.checked
                              ? onAttach(item.id)
                              : onDetach(item.id)
                          }
                        />
                        <button
                          className="context-library-preview-button"
                          aria-label={`Preview ${name}`}
                          aria-expanded={preview}
                          onClick={() => {
                            setPreviewId(preview ? null : item.id)
                            setPreviewLength(CONTEXT_PREVIEW_CHARACTERS)
                          }}
                        >
                          <SourceIcon source={item} />
                          <span>
                            <strong title={name}>{name}</strong>
                            <small>
                              {available
                                ? sourceKind(item)
                                : 'Linked note · Unavailable'}
                              {self && ' · This note'}
                              {item.folder && ` · ${item.folder}`}
                              {count > 0 &&
                                ` · Used in ${count} ${count === 1 ? 'note' : 'notes'}`}
                            </small>
                          </span>
                        </button>
                        <button
                          className="icon-button context-library-remove"
                          aria-label={`Remove ${name} from library`}
                          onClick={event => {
                            removeTrigger.current = event.currentTarget
                            setRemovingId(item.id)
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {preview && (
                        <div className="context-library-preview">
                          <div className="context-library-preview-heading">
                            <span>
                              {item.kind === 'note'
                                ? 'Live writing'
                                : 'Cached on this device'}
                            </span>
                            {item.kind === 'website' &&
                              item.origin &&
                              /^https?:\/\//i.test(item.origin) && (
                                <a
                                  href={item.origin}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  View original <ArrowUpRight size={12} />
                                </a>
                              )}
                            <button
                              className="icon-button"
                              aria-label="Close reference preview"
                              onClick={closePreview}
                            >
                              <X size={13} />
                            </button>
                          </div>
                          <div
                            className="context-library-preview-text"
                            tabIndex={0}
                          >
                            {source.text.slice(0, previewLength) ||
                              (available
                                ? 'This reference is empty. Writing added to a linked note appears here automatically.'
                                : 'This note is no longer in your notebook. Remove this reference or choose another note.')}
                          </div>
                          {source.text.length > previewLength && (
                            <button
                              className="button subtle context-library-show-more"
                              onClick={() =>
                                setPreviewLength(
                                  length => length + CONTEXT_PREVIEW_CHARACTERS
                                )
                              }
                            >
                              Showing the first {previewLength.toLocaleString()}{' '}
                              characters. Show more
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              {!matching.length && (
                <div className="context-library-empty" role="status">
                  {library.length ? (
                    <>
                      <strong>No references match.</strong>
                      <span>Try another name or choose All references.</span>
                    </>
                  ) : (
                    <>
                      <FolderOpen size={26} strokeWidth={1.3} />
                      <strong>A place for the details you return to.</strong>
                      <span>
                        Add files, a folder, a website, or a note. They stay in
                        your library for the next piece of writing.
                      </span>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>
        {dragging && (
          <div className="context-library-drop">
            <Upload size={24} />
            <strong>Drop references into your library</strong>
            <span>Text, Markdown, PDF, or Word</span>
          </div>
        )}
      </div>
      {removing ? (
        <div
          className="context-library-confirm"
          role="group"
          aria-label="Confirm reference removal"
        >
          <p role="status">
            <strong>
              Remove{' '}
              {byNoteId.get(removing.linkedNoteId ?? '')?.title ??
                removing.name}
              ?
            </strong>
            <span>
              {removingCount
                ? `This detaches it from ${removingCount} ${removingCount === 1 ? 'note' : 'notes'}.`
                : 'This reference is not attached to any notes.'}
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
            className="button danger"
            onClick={() => {
              onRemove(removing.id)
              setRemovingId(null)
              if (previewId === removing.id) closePreview()
              searchInput.current?.focus()
            }}
          >
            Remove from library
          </button>
        </div>
      ) : (
        <div className="context-library-footer">
          <p>
            Files and website snapshots stay on this device. Linked notes follow
            your writing.
          </p>
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
