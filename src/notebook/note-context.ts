import type { ContextSource, Note } from '../types/notebook'

/** A link stores identity and metadata; writing is read from the note later. */
export function linkNoteSource(note: Note): ContextSource {
  return {
    id: `note-${note.id}`,
    name: note.title,
    kind: 'note',
    linkedNoteId: note.id,
    text: '',
    enabled: true,
    addedAt: note.updatedAt,
  }
}

/** Resolve exactly one level so mutual links and cycles remain bounded. */
export function resolveNoteContext(note: Note, notes: Note[]): Note {
  const byId = new Map(notes.map(candidate => [candidate.id, candidate]))
  return {
    ...note,
    sources: note.sources.map(source => {
      if (source.kind !== 'note') return source
      const target = source.linkedNoteId
        ? byId.get(source.linkedNoteId)
        : undefined
      if (target) return { ...source, name: target.title, text: target.content }
      const name = source.name || 'Linked note'
      return {
        ...source,
        name: name.endsWith(' (unavailable)') ? name : `${name} (unavailable)`,
        text: '',
        enabled: false,
      }
    }),
  }
}

/** Remove derived text from snapshots to keep every note's writing in one place. */
export function stripLinkedText(sources: ContextSource[]): ContextSource[] {
  return sources.map(source =>
    source.kind === 'note' ? { ...source, text: '' } : source
  )
}
