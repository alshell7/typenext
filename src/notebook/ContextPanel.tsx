import { useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  FileText,
  Globe,
  Link,
  LoaderCircle,
  Notebook,
  Paperclip,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import type { Note } from '../types/notebook'
import { relativeDate, wordCount } from './model'
import { Modal } from './Modal'
import { resolveNoteContext } from './note-context'

function WordTotal({ text }: { text: string }) {
  const count = useMemo(() => wordCount(text), [text])
  return <>{count.toLocaleString()} words</>
}

export function ContextPanel({
  note,
  notes,
  importing,
  onUpdate,
  onClose,
  onFiles,
  onWebsite,
  onUseNote,
}: {
  note: Note
  notes: Note[]
  importing: boolean
  onUpdate(patch: Partial<Note>): void
  onClose(): void
  onFiles(files: FileList | null): Promise<void>
  onWebsite(): void
  onUseNote(id: string): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [choosingNote, setChoosingNote] = useState(false)
  const [noteQuery, setNoteQuery] = useState('')
  const resolved = useMemo(() => resolveNoteContext(note, notes), [note, notes])
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
  const sourceAvailable =
    !source ||
    source.kind !== 'note' ||
    notes.some(candidate => candidate.id === source.linkedNoteId)

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
                disabled={
                  item.kind === 'note' &&
                  !notes.some(candidate => candidate.id === item.linkedNoteId)
                }
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
                      ? notes.some(
                          candidate => candidate.id === item.linkedNoteId
                        )
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
                (source.kind === 'note'
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
