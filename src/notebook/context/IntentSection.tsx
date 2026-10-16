import { useId, useState } from 'react'
import { ChevronDown, Target } from 'lucide-react'
import type { Note } from '../../types/notebook'

function firstLine(text: string) {
  return text
    .split('\n')
    .map(line => line.replace(/^#{1,6}\s+/u, '').trim())
    .find(Boolean)
}

/** Objective and background, set after a note exists; collapses to one line. */
export function IntentSection({
  note,
  onUpdate,
}: {
  note: Note
  onUpdate(patch: Partial<Note>): void
}) {
  const id = useId()
  const [open, setOpen] = useState(
    () => !note.objective.trim() && !note.context.trim()
  )
  const objective = note.objective.trim()
  const fallback = objective ? '' : firstLine(note.content)
  const summary = objective
    ? objective.replace(/\s+/gu, ' ')
    : note.context.trim()
      ? 'Background set · objective follows your first line'
      : fallback
        ? `From your first line: ${fallback}`
        : 'What this note is for, and how it should sound'

  return (
    <section
      className={`context-intent ${open ? 'is-open' : ''}`}
      aria-labelledby={`${id}-toggle`}
    >
      <button
        id={`${id}-toggle`}
        type="button"
        className="context-intent-toggle"
        aria-expanded={open}
        aria-controls={`${id}-fields`}
        aria-label="Intent"
        aria-describedby={`${id}-summary`}
        onClick={() => setOpen(value => !value)}
      >
        <span className="context-intent-icon" aria-hidden="true">
          <Target size={14} strokeWidth={1.7} />
        </span>
        <span className="context-intent-copy">
          <strong>Intent</strong>
          <small
            id={`${id}-summary`}
            className={objective || note.context.trim() ? '' : 'is-placeholder'}
            title={open ? undefined : summary}
          >
            {open ? 'The objective and voice behind your words' : summary}
          </small>
        </span>
        <ChevronDown
          size={15}
          className="context-intent-chevron"
          aria-hidden="true"
        />
      </button>
      <div className="context-intent-body" id={`${id}-fields`}>
        <div className="context-intent-fields">
          <label className="field-label" htmlFor="note-objective">
            Objective
          </label>
          <textarea
            id="note-objective"
            rows={2}
            placeholder="What should this note achieve? For example, convince a new reader the garden is worth a visit."
            value={note.objective}
            tabIndex={open ? undefined : -1}
            onChange={event => onUpdate({ objective: event.target.value })}
          />
          <p className="field-help">
            {fallback && !objective
              ? `Empty for now, so suggestions follow “${fallback.length > 60 ? `${fallback.slice(0, 60)}…` : fallback}”.`
              : 'Leave this empty to use the first line of your note.'}
          </p>
          <label className="field-label" htmlFor="note-context">
            Background & voice
          </label>
          <textarea
            id="note-context"
            rows={3}
            placeholder="Who is reading, the tone you want, and anything worth knowing. Warm, plain, first person…"
            value={note.context}
            tabIndex={open ? undefined : -1}
            onChange={event => onUpdate({ context: event.target.value })}
          />
        </div>
      </div>
    </section>
  )
}
