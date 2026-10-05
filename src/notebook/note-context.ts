import type { ContextPackage, ContextSource, Note } from '../types/notebook'

const EMPTY_LIBRARY: ContextSource[] = []
const EMPTY_PACKAGES: ContextPackage[] = []
// Workspace updates replace library arrays. Weak keys let old snapshots and
// their indexes be collected, without keeping any additional note bodies.
const libraryIndexes = new WeakMap<
  ContextSource[],
  Map<string, ContextSource>
>()
const packageIndexes = new WeakMap<
  ContextPackage[],
  Map<string, ContextPackage>
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
  library: ContextSource[] = EMPTY_LIBRARY,
  packages: ContextPackage[] = EMPTY_PACKAGES
): Note {
  const hasPackages = !!note.contextPackageIds?.length
  if (
    !hasPackages &&
    !note.sources.some(source => source.kind === 'note' || source.libraryId)
  )
    return note
  let byId: Map<string, Note> | undefined
  let libraryById: Map<string, ContextSource> | undefined
  const sources: ContextSource[] = []
  const positions = new Map<string, number>()

  function canonicalSource(id: string) {
    if (!libraryById) {
      libraryById = libraryIndexes.get(library)
      if (!libraryById) {
        libraryById = new Map(library.map(item => [item.id, item]))
        libraryIndexes.set(library, libraryById)
      }
    }
    return libraryById.get(id)
  }

  function resolveSource(reference: ContextSource): ContextSource | null {
    let source = reference
    if (reference.libraryId) {
      const canonical = canonicalSource(reference.libraryId)
      source = canonical
        ? {
            ...canonical,
            id: reference.id,
            libraryId: canonical.id,
            enabled: reference.enabled,
          }
        : { ...reference, text: '', enabled: false }
      if (!canonical) return source
    }

    if (source.kind === 'note') {
      if (source.linkedNoteId === note.id) return null
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

    return source
  }

  function include(source: ContextSource | null) {
    if (!source) return
    const key =
      source.kind === 'note' && source.linkedNoteId
        ? `note:${source.linkedNoteId}`
        : source.libraryId
          ? `library:${source.libraryId}`
          : `source:${source.id}`
    const previous = positions.get(key)
    if (previous !== undefined) {
      if (source.enabled && !sources[previous]!.enabled)
        sources[previous] = source
      return
    }
    positions.set(key, sources.length)
    sources.push(source)
  }

  for (const reference of note.sources) include(resolveSource(reference))

  if (hasPackages && packages.length) {
    let byPackageId = packageIndexes.get(packages)
    if (!byPackageId) {
      byPackageId = new Map(packages.map(context => [context.id, context]))
      packageIndexes.set(packages, byPackageId)
    }
    const includedIds = new Set<string>()
    for (const packageId of new Set(note.contextPackageIds)) {
      const context = byPackageId.get(packageId)
      if (!context) continue
      for (const sourceId of context.sourceIds) {
        if (includedIds.has(sourceId)) continue
        includedIds.add(sourceId)
        const canonical = canonicalSource(sourceId)
        if (!canonical) continue
        include(
          resolveSource({
            ...canonical,
            libraryId: canonical.id,
            enabled: true,
          })
        )
      }
    }
  }
  return { ...note, sources }
}

/** Prospective attachment/import guard; never materializes full prompt text. */
export function resolvedContextBudget(
  note: Note,
  notes: Note[],
  library: ContextSource[] = EMPTY_LIBRARY,
  packages: ContextPackage[] = EMPTY_PACKAGES
): { sources: number; characters: number } {
  const resolved = resolveNoteContext(note, notes, library, packages)
  return {
    sources: resolved.sources.length,
    characters: resolved.sources.reduce(
      (count, source) => count + (source.enabled ? source.text.length : 0),
      0
    ),
  }
}

/** Remove derived text from snapshots to keep every note's writing in one place. */
export function stripLinkedText(sources: ContextSource[]): ContextSource[] {
  return sources.map(source =>
    source.kind === 'note' || source.libraryId
      ? { ...source, text: '' }
      : source
  )
}
