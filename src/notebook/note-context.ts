import type { ContextSource, Note } from '../types/notebook'

const EMPTY_LIBRARY: ContextSource[] = []
// Workspace updates replace library arrays. Weak keys let old snapshots and
// their indexes be collected, without keeping any additional note bodies.
const libraryIndexes = new WeakMap<
  ContextSource[],
  Map<string, ContextSource>
>()

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
export function resolveNoteContext(
  note: Note,
  notes: Note[],
  library: ContextSource[] = EMPTY_LIBRARY
): Note {
  if (!note.sources.length) return note
  let byId: Map<string, Note> | undefined
  let libraryById: Map<string, ContextSource> | undefined
  let sources: ContextSource[] | undefined

  for (let index = 0; index < note.sources.length; index++) {
    const reference = note.sources[index]!
    let source = reference
    if (reference.libraryId) {
      if (!libraryById) {
        libraryById = libraryIndexes.get(library)
        if (!libraryById) {
          libraryById = new Map(library.map(item => [item.id, item]))
          libraryIndexes.set(library, libraryById)
        }
      }
      const canonical = libraryById.get(reference.libraryId)
      source = canonical
        ? {
            ...canonical,
            id: reference.id,
            libraryId: canonical.id,
            enabled: reference.enabled,
          }
        : { ...reference, text: '', enabled: false }
      if (!canonical) {
        sources ??= note.sources.slice()
        sources[index] = source
        continue
      }
    }

    if (source.kind === 'note') {
      if (source.linkedNoteId && !byId)
        byId = new Map(notes.map(candidate => [candidate.id, candidate]))
      const target = source.linkedNoteId
        ? byId?.get(source.linkedNoteId)
        : undefined
      if (target)
        source = { ...source, name: target.title, text: target.content }
      else {
        const name = source.name || 'Linked note'
        source = {
          ...source,
          name: name.endsWith(' (unavailable)')
            ? name
            : `${name} (unavailable)`,
          text: '',
          enabled: false,
        }
      }
    }

    if (source !== reference) {
      sources ??= note.sources.slice()
      sources[index] = source
    }
  }
  return sources ? { ...note, sources } : note
}

/** Remove derived text from snapshots to keep every note's writing in one place. */
export function stripLinkedText(sources: ContextSource[]): ContextSource[] {
  return sources.map(source =>
    source.kind === 'note' || source.libraryId
      ? { ...source, text: '' }
      : source
  )
}
