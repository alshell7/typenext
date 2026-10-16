import { memo, useState } from 'react'
import { CornerDownRight } from 'lucide-react'
import type { Note } from '../types/notebook'
import './writing-aids.css'

export interface OutlineHeading {
  level: number
  text: string
  from: number
}

/** Headings outside fenced code, with their document offsets. */
export function outlineOf(content: string, limit = 200): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  let fence: string | null = null
  let offset = 0
  for (const line of content.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker[0]!
      else if (marker[0] === fence) fence = null
    } else if (fence === null) {
      const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
      if (match) {
        headings.push({
          level: match[1]!.length,
          text: match[2]!.replace(/[*_`~]|\[\[|\]\]/gu, '').slice(0, 120),
          from: offset,
        })
        if (headings.length >= limit) break
      }
    }
    offset += line.length + 1
  }
  return headings
}

/** The index of the heading that contains `cursor`, or -1. */
export function activeHeading(headings: OutlineHeading[], cursor: number) {
  let active = -1
  for (let index = 0; index < headings.length; index++)
    if (headings[index]!.from <= cursor) active = index
    else break
  return active
}

/**
 * A quiet outline in the margin. Short marks show the shape of the note;
 * pointing at them opens the heading names.
 */
export const NoteOutline = memo(function NoteOutline({
  headings,
  active,
  onJump,
}: {
  headings: OutlineHeading[]
  active: number
  onJump(heading: OutlineHeading): void
}) {
  const [open, setOpen] = useState(false)
  if (headings.length < 2) return null
  const top = Math.min(...headings.map(heading => heading.level))
  return (
    <nav
      className={`note-outline ${open ? 'is-open' : ''}`}
      aria-label="Outline"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <ol>
        {headings.map((heading, index) => (
          <li key={`${heading.from}-${index}`} style={{ '--depth': heading.level - top } as React.CSSProperties}>
            <button
              type="button"
              className={index === active ? 'is-active' : ''}
              aria-current={index === active ? 'location' : undefined}
              onClick={() => onJump(heading)}
            >
              <span className="note-outline-mark" aria-hidden="true" />
              <span className="note-outline-text">{heading.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
})

/** Notes that link here, below the writing. */
export const LinkedFrom = memo(function LinkedFrom({
  notes,
  onOpen,
}: {
  notes: Pick<Note, 'id' | 'title'>[]
  onOpen(id: string): void
}) {
  if (!notes.length) return null
  return (
    <section className="linked-from" aria-label="Linked from">
      <h2>
        <CornerDownRight size={13} aria-hidden="true" /> Linked from {notes.length}{' '}
        {notes.length === 1 ? 'note' : 'notes'}
      </h2>
      <div>
        {notes.slice(0, 24).map(item => (
          <button key={item.id} type="button" onClick={() => onOpen(item.id)}>
            {item.title.trim() || 'Untitled'}
          </button>
        ))}
      </div>
    </section>
  )
})

const TODAY_KEY = () => `typenext.words.${new Date().toISOString().slice(0, 10)}`

export function wordsToday(): number {
  try {
    return Number(localStorage.getItem(TODAY_KEY())) || 0
  } catch {
    return 0
  }
}

/** Count new words written today. A very large paste counts only in part. */
export function addWordsToday(delta: number): number {
  const added = Math.max(0, Math.min(delta, 2_000))
  const total = wordsToday() + added
  if (added)
    try {
      localStorage.setItem(TODAY_KEY(), String(total))
    } catch {
      // A full store only loses the daily count.
    }
  return total
}

export function readingMinutes(words: number) {
  return Math.max(1, Math.round(words / 230))
}

/** Word count, reading time and an optional daily goal ring. */
export const WritingStats = memo(function WritingStats({
  words,
  today,
  goal,
}: {
  words: number
  today: number
  goal: number
}) {
  const progress = goal > 0 ? Math.min(1, today / goal) : 0
  const done = goal > 0 && today >= goal
  return (
    <span className="writing-stats">
      {goal > 0 && (
        <svg
          className={`goal-ring ${done ? 'is-done' : ''}`}
          viewBox="0 0 20 20"
          width="14"
          height="14"
          role="img"
          aria-label={`${today.toLocaleString()} of ${goal.toLocaleString()} words today`}
        >
          <circle cx="10" cy="10" r="8" className="goal-ring-track" />
          <circle
            cx="10"
            cy="10"
            r="8"
            className="goal-ring-value"
            strokeDasharray={`${(progress * 50.27).toFixed(2)} 50.27`}
          />
        </svg>
      )}
      <span>
        {words.toLocaleString()} word{words !== 1 ? 's' : ''}
      </span>
      {words > 0 && (
        <>
          <span className="footer-divider">·</span>
          <span>{readingMinutes(words)} min read</span>
        </>
      )}
      {today > 0 && (
        <>
          <span className="footer-divider">·</span>
          <span title="Words you wrote today, in all notes">
            {goal > 0 ? `${today.toLocaleString()} / ${goal.toLocaleString()} today` : `+${today.toLocaleString()} today`}
          </span>
        </>
      )}
    </span>
  )
})
