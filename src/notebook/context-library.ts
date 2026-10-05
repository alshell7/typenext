import type { ContextPackage, ContextSource, Note } from '../types/notebook'

export const MAX_CONTEXT_LIBRARY_ITEMS = 2048
export const MAX_CONTEXT_PACKAGES = 256
export const MAX_CONTEXT_PACKAGE_SOURCES = 256
export const MAX_CONTEXT_PACKAGES_PER_NOTE = 64
export const CONTEXT_PREVIEW_CHARACTERS = 40_000
const EMPTY_PACKAGES: ContextPackage[] = []

export function newContextPackage(name: string): ContextPackage {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled context',
    sourceIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** Older snapshots become packages without changing any note's attachments. */
export function migrateContextPackages(
  library: ContextSource[],
  packages?: ContextPackage[]
): ContextPackage[] {
  if (packages !== undefined) return packages
  if (!library.length) return EMPTY_PACKAGES
  const migrated: ContextPackage[] = []
  for (
    let offset = 0;
    offset < library.length;
    offset += MAX_CONTEXT_PACKAGE_SOURCES
  ) {
    const sources = library.slice(offset, offset + MAX_CONTEXT_PACKAGE_SOURCES)
    const index = migrated.length + 1
    migrated.push({
      id:
        index === 1
          ? 'context-saved-references'
          : `context-saved-references-${index}`,
      name: index === 1 ? 'Saved references' : `Saved references ${index}`,
      sourceIds: sources.map(source => source.id),
      createdAt: Math.min(...sources.map(source => source.addedAt)),
      updatedAt: Math.max(...sources.map(source => source.addedAt)),
    })
  }
  return migrated
}

/** Remove only snapshots no package or direct note reference can still use. */
export function pruneContextLibrary(
  library: ContextSource[],
  notes: Note[],
  packages: ContextPackage[]
): ContextSource[] {
  const used = new Set(packages.flatMap(context => context.sourceIds))
  for (const note of notes)
    for (const source of note.sources)
      if (source.libraryId) used.add(source.libraryId)
  const retained = library.filter(source => used.has(source.id))
  return retained.length === library.length ? library : retained
}

export function contextPackageUsage(notes: Note[]) {
  const counts = new Map<string, number>()
  for (const note of notes)
    for (const id of new Set(note.contextPackageIds ?? []))
      counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

/** A note keeps a small reference; the reusable snapshot lives in the library. */
export function libraryReference(
  source: ContextSource,
  enabled = true
): ContextSource {
  return { ...source, libraryId: source.id, text: '', enabled }
}

function sameSnapshot(first: ContextSource, second: ContextSource) {
  if (first.kind !== second.kind) return false
  if (first.kind === 'note')
    return !!first.linkedNoteId && first.linkedNoteId === second.linkedNoteId
  return (
    first.name === second.name &&
    first.origin === second.origin &&
    first.folder === second.folder &&
    first.text === second.text
  )
}

/** Find an exact reusable snapshot without treating changed source text as equal. */
export function findLibrarySource(
  library: ContextSource[],
  source: ContextSource
) {
  const sameId = library.find(candidate => candidate.id === source.id)
  if (sameId && sameSnapshot(sameId, source)) return sameId
  return library.find(candidate => sameSnapshot(candidate, source))
}

function canonicalSource(source: ContextSource, id: string): ContextSource {
  const result = { ...source, id, enabled: true }
  delete result.libraryId
  if (result.kind === 'note') result.text = ''
  return result
}

/**
 * Promote old per-note snapshots once. Existing library references and arrays
 * retain their identity; unmatched legacy sources remain intact at the limit.
 */
export function migrateContextLibrary(
  notes: Note[],
  library: ContextSource[] = [],
  limit = MAX_CONTEXT_LIBRARY_ITEMS
): { notes: Note[]; library: ContextSource[] } {
  if (!notes.some(note => note.sources.some(source => !source.libraryId)))
    return { notes, library }
  let nextLibrary = library
  let nextNotes = notes
  const ids = new Set(library.map(source => source.id))
  const byId = new Map(library.map(source => [source.id, source]))
  const fingerprints = new WeakMap<ContextSource, string>()
  let snapshotIndex: Map<string, ContextSource[]> | null = null
  function fingerprint(source: ContextSource) {
    const previous = fingerprints.get(source)
    if (previous !== undefined) return previous
    if (source.kind === 'note') return `note:${source.linkedNoteId ?? ''}`
    let first = 2166136261
    let second = 0x9e3779b9
    // Compact keys avoid retaining another copy of source bodies or long
    // website addresses. Full equality below still verifies every hash hit.
    for (const value of [
      source.name,
      source.origin ?? '',
      source.folder ?? '',
      source.text,
    ]) {
      first = Math.imul(first ^ value.length, 16777619)
      second = Math.imul(second ^ value.length, 0x85ebca6b)
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        first = Math.imul(first ^ code, 16777619)
        second = Math.imul(second ^ code, 0x85ebca6b)
      }
    }
    const result = `${source.kind}:${source.text.length}:${first >>> 0}:${second >>> 0}`
    fingerprints.set(source, result)
    return result
  }
  function indexSnapshot(source: ContextSource) {
    const key = fingerprint(source)
    const candidates = snapshotIndex!.get(key)
    if (candidates) candidates.push(source)
    else snapshotIndex!.set(key, [source])
  }
  function findSnapshot(source: ContextSource) {
    const sameId = byId.get(source.id)
    if (sameId && sameSnapshot(sameId, source)) return sameId
    if (!snapshotIndex) {
      snapshotIndex = new Map()
      for (const canonical of nextLibrary) indexSnapshot(canonical)
    }
    return snapshotIndex
      .get(fingerprint(source))
      ?.find(candidate => sameSnapshot(candidate, source))
  }
  for (let noteIndex = 0; noteIndex < notes.length; noteIndex++) {
    const note = notes[noteIndex]!
    let changed = false
    const seen = new Map<string, number>()
    const sources: ContextSource[] = []
    for (const source of note.sources) {
      let reference = source
      if (!source.libraryId) {
        let canonical = findSnapshot(source)
        if (!canonical && nextLibrary.length < Math.max(0, limit)) {
          let id = source.id
          let suffix = 2
          while (ids.has(id)) id = `${source.id.slice(0, 140)}-${suffix++}`
          canonical = canonicalSource(source, id)
          if (nextLibrary === library) nextLibrary = library.slice()
          nextLibrary.push(canonical)
          ids.add(id)
          byId.set(id, canonical)
          fingerprints.set(canonical, fingerprint(source))
          if (snapshotIndex) indexSnapshot(canonical)
        }
        if (canonical) {
          reference = libraryReference(canonical, source.enabled)
          changed = true
        }
      }
      const previousIndex = reference.libraryId
        ? seen.get(reference.libraryId)
        : undefined
      if (previousIndex !== undefined) {
        const previous = sources[previousIndex]!
        if (reference.enabled && !previous.enabled)
          sources[previousIndex] = { ...previous, enabled: true }
        changed = true
      } else {
        if (reference.libraryId) seen.set(reference.libraryId, sources.length)
        sources.push(reference)
      }
    }
    if (changed) {
      if (nextNotes === notes) nextNotes = notes.slice()
      nextNotes[noteIndex] = { ...note, sources }
    }
  }
  return { notes: nextNotes, library: nextLibrary }
}

/** Count affected notes, rather than duplicated or disabled links within a note. */
export function contextLibraryUsage(notes: Note[]) {
  const counts = new Map<string, number>()
  for (const note of notes) {
    const ids = new Set(
      note.sources.flatMap(source =>
        source.libraryId ? [source.libraryId] : []
      )
    )
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export function resolveLibrarySource(
  source: ContextSource,
  notes: Note[]
): ContextSource {
  if (source.kind !== 'note') return source
  const target = notes.find(note => note.id === source.linkedNoteId)
  return target
    ? { ...source, name: target.title, text: target.content }
    : { ...source, text: '', enabled: false }
}

/** Directory selection is a one-time snapshot, never a filesystem watcher. */
export function contextFolder(file: Pick<File, 'webkitRelativePath'>) {
  const path = file.webkitRelativePath.replace(/\\/g, '/')
  const pieces = path.split('/').slice(0, -1)
  if (
    !pieces.length ||
    pieces.some(piece => !piece || piece === '.' || piece === '..')
  )
    return undefined
  return pieces.join('/')
}

export function contextLibraryFolders(library: ContextSource[]) {
  const folders = new Map<string, number>()
  for (const source of library) {
    if (!source.folder) continue
    const pieces = source.folder.split('/')
    for (let index = 1; index <= pieces.length; index++) {
      const path = pieces.slice(0, index).join('/')
      folders.set(path, (folders.get(path) ?? 0) + 1)
    }
  }
  return [...folders.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([path, count]) => ({
      path,
      count,
      name: path.split('/').at(-1) ?? path,
      depth: path.split('/').length - 1,
    }))
}

export function filterContextLibrary(
  library: ContextSource[],
  notes: Note[],
  query: string,
  folder: string | null
) {
  const needle = query.trim().toLocaleLowerCase()
  const noteTitles = new Map(notes.map(note => [note.id, note.title]))
  return library.filter(source => {
    if (
      folder &&
      source.folder !== folder &&
      !source.folder?.startsWith(`${folder}/`)
    )
      return false
    if (!needle) return true
    const name =
      source.kind === 'note' && source.linkedNoteId
        ? (noteTitles.get(source.linkedNoteId) ?? source.name)
        : source.name
    return [name, source.origin ?? '', source.folder ?? ''].some(value =>
      value.toLocaleLowerCase().includes(needle)
    )
  })
}
