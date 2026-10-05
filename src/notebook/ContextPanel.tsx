import { useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  FileText,
  Globe,
  Link,
  LoaderCircle,
  LibraryBig,
  Notebook,
  Paperclip,
  ShieldCheck,
  Search,
  Upload,
  X,
} from 'lucide-react'
import type { ContextSource, Note, RetrievedChunk } from '../types/notebook'
import { retrieveContext } from '../services/retrieval'
import { relativeDate, wordCount } from './model'
import { Modal } from './Modal'
import { resolveNoteContext } from './note-context'
import './ContextLibrary.css'

const EMPTY_LIBRARY: ContextSource[] = []

function WordTotal({ text }: { text: string }) {
  const count = useMemo(() => wordCount(text), [text])
  return <>{count.toLocaleString()} words</>
}

export function ContextPanel({
  note,
  notes,
  library = EMPTY_LIBRARY,
  importing,
  onUpdate,
  onClose,
  onFiles,
  onWebsite,
  onUseNote,
  onLibrary,
}: {
  note: Note
  notes: Note[]
  library?: ContextSource[]
  importing: boolean
  onUpdate(patch: Partial<Note>): void
  onClose(): void
  onFiles(files: FileList | null): Promise<void>
  onWebsite(): void
  onUseNote(id: string): void
  onLibrary?(): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [choosingNote, setChoosingNote] = useState(false)
  const [noteQuery, setNoteQuery] = useState('')
  const [contextQuery, setContextQuery] = useState('')
  const [retrieval, setRetrieval] = useState<{
    snapshot: (string | boolean)[]
    results: RetrievedChunk[]
  } | null>(null)
  const libraryIds = useMemo(
    () => new Set(library.map(item => item.id)),
    [library]
  )
  const noteIds = useMemo(() => new Set(notes.map(item => item.id)), [notes])
  function sourceIsAvailable(item: ContextSource) {
    return (
      (!item.libraryId || libraryIds.has(item.libraryId)) &&
      (item.kind !== 'note' || noteIds.has(item.linkedNoteId ?? ''))
    )
  }
  const resolved = useMemo(
    () => resolveNoteContext(note, notes, library),
    [note, notes, library]
  )
  const retrievalSnapshot = [
    note.id,
    ...resolved.sources.flatMap(source => [
      source.id,
      source.name,
      source.text,
      source.enabled,
    ]),
  ]
  const retrievalCurrent =
    retrieval &&
    retrieval.snapshot.length === retrievalSnapshot.length &&
    retrieval.snapshot.every(
      (value, index) => value === retrievalSnapshot[index]
    )
  const source = resolved.sources.find(item => item.id === previewId)
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
        onDragLeave={() => {
          dragDepth.current--
          if (dragDepth.current <= 0) {
            dragDepth.current = 0
            setDragging(false)
          }
        }}
        onDrop={event => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          if (!importing) void onFiles(event.dataTransfer.files)
        }}
      >
        {dragging && (
          <div className="context-drop-overlay">
            <Upload size={28} strokeWidth={1.4} />
            <strong>Drop your references here</strong>
            <span>Text, Markdown, PDF, or Word</span>
          </div>
        )}
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
          The intention and details behind your words.
        </p>
        <label className="field-label" htmlFor="note-objective">
          Objective
        </label>
        <textarea
          id="note-objective"
          rows={2}
          placeholder="What do you want to say?"
          value={note.objective}
          onChange={event => onUpdate({ objective: event.target.value })}
        />
        <p className="field-help">
          Leave this empty to use the first line of your note.
        </p>
        <label className="field-label" htmlFor="note-context">
          Background & voice
        </label>
        <textarea
          id="note-context"
          rows={4}
          placeholder="Audience, tone, and anything worth knowing."
          value={note.context}
          onChange={event => onUpdate({ context: event.target.value })}
        />
        <div className="sources-heading">
          <h3>References</h3>
          <span>
            {note.sources.length
              ? `${enabled} of ${note.sources.length} included`
              : 'None yet'}
          </span>
        </div>
        <div className="source-list">
          {resolved.sources.map(item => (
            <div
              className={`source-item ${item.enabled ? '' : 'disabled'}`}
              key={item.id}
            >
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={!sourceIsAvailable(item)}
                aria-label={`Use ${item.name} as context`}
                onChange={event =>
                  onUpdate({
                    sources: note.sources.map(candidate =>
                      candidate.id === item.id
                        ? { ...candidate, enabled: event.target.checked }
                        : candidate
                    ),
                  })
                }
              />
              <button
                className="source-preview-button"
                aria-label={`Preview ${item.name}`}
                onClick={() => setPreviewId(item.id)}
              >
                {item.kind === 'website' ? (
                  <Globe size={15} />
                ) : item.kind === 'note' ? (
                  <Notebook size={15} />
                ) : (
                  <FileText size={15} />
                )}
                <span>
                  <strong title={item.name}>{item.name}</strong>
                  <small>
                    {item.kind === 'note'
                      ? sourceIsAvailable(item)
                        ? 'Linked note · Live context'
                        : 'Linked note · Unavailable'
                      : item.kind === 'website'
                        ? 'Website'
                        : item.kind === 'markdown'
                          ? 'Markdown'
                          : item.kind === 'text'
                            ? 'Text'
                            : item.kind.toUpperCase()}{' '}
                    · <WordTotal text={item.text} />
                    {item.libraryId &&
                      !libraryIds.has(item.libraryId) &&
                      ' · Unavailable'}
                    {!item.enabled && ' · Left out'}
                  </small>
                </span>
              </button>
              <button
                className="icon-button"
                aria-label={`Remove ${item.name}`}
                onClick={() =>
                  onUpdate({
                    sources: note.sources.filter(
                      candidate => candidate.id !== item.id
                    ),
                  })
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        {!note.sources.length && (
          <button
            className="context-empty drop-zone"
            onClick={() => input.current?.click()}
            disabled={importing}
          >
            <Paperclip size={25} strokeWidth={1.3} />
            <span>
              <strong>Bring the details that matter.</strong>
              <small>Drop files here, or browse to attach.</small>
            </span>
          </button>
        )}
        {note.sources.length > 0 && (
          <p className="field-help source-inclusion-help">
            Click a reference to preview its text. Uncheck it to leave it out of
            suggestions.
          </p>
        )}
        <input
          ref={input}
          type="file"
          disabled={importing}
          multiple
          accept=".txt,.md,.markdown,.pdf,.docx"
          className="visually-hidden"
          aria-label="Attach reference files"
          onChange={event => {
            const files = event.target.files
            void onFiles(files).finally(() => {
              if (input.current) input.current.value = ''
            })
          }}
        />
        <div className="source-actions">
          {onLibrary && (
            <button className="button secondary" onClick={onLibrary}>
              <LibraryBig size={15} /> Choose from library
            </button>
          )}
          <button
            className="button secondary"
            disabled={importing}
            onClick={() => input.current?.click()}
          >
            {importing ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Upload size={15} />
            )}
            {importing ? 'Reading references…' : 'Attach files'}
          </button>
          <button
            className="button subtle"
            disabled={importing}
            onClick={onWebsite}
          >
            <Link size={15} />
            Add a website
          </button>
          <button
            className="button subtle"
            disabled={importing}
            onClick={() => {
              setNoteQuery('')
              setChoosingNote(true)
            }}
          >
            <Notebook size={15} />
            Use a note
          </button>
        </div>
        <details className="context-attached-search">
          <summary>
            <Search size={14} /> Find in attached context
          </summary>
          <p>
            BM25 finds relevant passages on this device; model receives only
            matching excerpts.
          </p>
          <form
            onSubmit={event => {
              event.preventDefault()
              if (!contextQuery.trim() || !enabled) return
              setRetrieval({
                snapshot: retrievalSnapshot,
                results: retrieveContext(resolved, contextQuery, 4),
              })
            }}
          >
            <label className="field-label" htmlFor="attached-context-search">
              Search attached references
            </label>
            <input
              id="attached-context-search"
              type="search"
              value={contextQuery}
              placeholder="A detail, phrase, or topic"
              maxLength={4000}
              onChange={event => {
                setContextQuery(event.target.value)
                setRetrieval(null)
              }}
            />
            <button
              type="submit"
              className="button secondary"
              disabled={!contextQuery.trim() || !enabled}
            >
              Find passages
            </button>
          </form>
          {!enabled && (
            <p className="context-attached-empty">
              Include a reference above to search its text.
            </p>
          )}
          {retrievalCurrent && (
            <div
              className="context-attached-results"
              aria-label="Matching context passages"
            >
              <p role="status">
                {retrieval.results.length
                  ? `${retrieval.results.length} matching ${retrieval.results.length === 1 ? 'passage' : 'passages'}`
                  : 'No matching passages. Try another phrase.'}
              </p>
              {retrieval.results.map((passage, index) => (
                <article key={`${passage.sourceId}-${index}`}>
                  <h4>{passage.sourceName}</h4>
                  <p>{passage.text}</p>
                </article>
              ))}
            </div>
          )}
          {retrieval && !retrievalCurrent && (
            <p role="status" className="context-attached-empty">
              References changed. Search again for current passages.
            </p>
          )}
        </details>
        <p className="context-privacy">
          <ShieldCheck size={14} />
          <span>
            Files stay on this device. Only the references you include inform
            suggestions.
          </span>
        </p>
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
            <div className="source-preview-meta">
              <span>
                {source.kind === 'note' ? (
                  sourceAvailable ? (
                    'Linked note · Live context'
                  ) : (
                    'Linked note · Unavailable'
                  )
                ) : (
                  <>
                    <WordTotal text={source.text} /> · Cached locally
                  </>
                )}
              </span>
              {source.origin && source.kind !== 'note' && (
                <a href={source.origin} target="_blank" rel="noreferrer">
                  View original
                  <ArrowUpRight size={12} />
                </a>
              )}
            </div>
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
                  onChange={event =>
                    onUpdate({
                      sources: note.sources.map(item =>
                        item.id === source.id
                          ? { ...item, enabled: event.target.checked }
                          : item
                      ),
                    })
                  }
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
    </>
  )
}
