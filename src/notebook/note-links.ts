import type { ContextPackage, ContextSource, Note } from '../types/notebook'

/** A `[[Target]]`, `[[Target|Label]]` or `[[Target#Heading]]` link in Markdown. */
export interface WikiLink {
  from: number
  to: number
  target: string
  label?: string
  heading?: string
}

export type NoteEdgeKind = 'link' | 'context'

export interface NoteGraphNode {
  id: string
  title: string
  /** Unresolved link targets appear as faint placeholder nodes. */
  ghost?: boolean
  degree: number
  words: number
  updatedAt: number
}

export interface NoteGraphEdge {
  source: string
  target: string
  kind: NoteEdgeKind
  weight: number
}

export interface NoteGraph {
  nodes: NoteGraphNode[]
  edges: NoteGraphEdge[]
}

const MAX_LINKS_PER_NOTE = 2_000
const MAX_TARGET_LENGTH = 200
const linkCache = new Map<string, { content: string; links: WikiLink[] }>()
const MAX_CACHED_NOTES = 2_048

/** Normalize a title for link matching: case, width and spacing do not matter. */
export function noteKey(title: string): string {
  return title
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase()
}

/** Find wiki links outside fenced code blocks and inline code spans. */
export function parseWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = []
  let inFence: string | null = null
  let offset = 0
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence?.[1] && inFence === null) {
      // A backtick fence's info string cannot contain a backtick.
      if (fence[1][0] === '~' || !fence[2]?.includes('`')) inFence = fence[1]
    } else if (inFence !== null) {
      // Closing fences use the same character, are at least as long and
      // carry no info string.
      if (
        fence?.[1] &&
        fence[1][0] === inFence[0] &&
        fence[1].length >= inFence.length &&
        !fence[2]?.trim()
      )
        inFence = null
    } else if (line.includes('[[')) {
      // Mask inline code so `[[not a link]]` stays literal. A code span
      // closes only on a backtick run of the same length.
      const masked = line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/gu, match =>
        ' '.repeat(match.length)
      )
      for (const match of masked.matchAll(/\[\[([^[\]\n]{1,400})\]\]/gu)) {
        if (match.index === undefined || links.length >= MAX_LINKS_PER_NOTE)
          break
        const body = match[1] ?? ''
        const pipe = body.indexOf('|')
        const destination = (pipe < 0 ? body : body.slice(0, pipe)).trim()
        const label = pipe < 0 ? '' : body.slice(pipe + 1).trim()
        const hash = destination.indexOf('#')
        const target = (hash < 0 ? destination : destination.slice(0, hash))
          .trim()
          .slice(0, MAX_TARGET_LENGTH)
        const heading = hash < 0 ? '' : destination.slice(hash + 1).trim()
        if (!target) continue
        links.push({
          from: offset + match.index,
          to: offset + match.index + match[0].length,
          target,
          ...(label ? { label } : {}),
          ...(heading ? { heading } : {}),
        })
      }
    }
    offset += line.length + 1
  }
  return links
}

/** Parsed links for a note, reused until its writing changes. */
export function noteLinks(note: Pick<Note, 'id' | 'content'>): WikiLink[] {
  const cached = linkCache.get(note.id)
  if (cached && cached.content === note.content) return cached.links
  const links = parseWikiLinks(note.content)
  linkCache.delete(note.id)
  linkCache.set(note.id, { content: note.content, links })
  if (linkCache.size > MAX_CACHED_NOTES) {
    const oldest = linkCache.keys().next().value
    if (oldest !== undefined) linkCache.delete(oldest)
  }
  return links
}

const titleIndexes = new WeakMap<Note[], Map<string, Note>>()

/** Map normalized titles to notes. The most recently edited note wins a tie. */
export function titleIndex(notes: Note[]): Map<string, Note> {
  let index = titleIndexes.get(notes)
  if (!index) {
    index = new Map()
    for (const note of notes) {
      const key = noteKey(note.title)
      const existing = index.get(key)
      if (!existing || existing.updatedAt < note.updatedAt) index.set(key, note)
    }
    titleIndexes.set(notes, index)
  }
  return index
}

export function resolveNoteLink(
  target: string,
  notes: Note[]
): Note | undefined {
  return titleIndex(notes).get(noteKey(target))
}

/** Notes whose writing links to this note. */
export function backlinks(note: Note, notes: Note[]): Note[] {
  const key = noteKey(note.title)
  return notes.filter(
    candidate =>
      candidate.id !== note.id &&
      noteLinks(candidate).some(link => noteKey(link.target) === key)
  )
}

/** Escape characters that would end or split a wiki link. */
export function wikiLinkText(title: string): string {
  return `[[${title
    .replace(/[[\]|#\n]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()}]]`
}

function linkedNoteIds(
  note: Note,
  libraryById: Map<string, ContextSource>,
  packagesById: Map<string, ContextPackage>
): string[] {
  const ids = new Set<string>()
  for (const source of note.sources) {
    // A reference the writer switched off is not used as context.
    if (!source.enabled) continue
    const canonical = source.libraryId
      ? libraryById.get(source.libraryId)
      : source
    if (canonical?.kind === 'note' && canonical.linkedNoteId)
      ids.add(canonical.linkedNoteId)
  }
  for (const packageId of note.contextPackageIds ?? []) {
    for (const sourceId of packagesById.get(packageId)?.sourceIds ?? []) {
      const source = libraryById.get(sourceId)
      if (source?.kind === 'note' && source.linkedNoteId)
        ids.add(source.linkedNoteId)
    }
  }
  ids.delete(note.id)
  return [...ids]
}

/**
 * Build an undirected graph of notes. Wiki links make `link` edges; notes used
 * as live context make `context` edges. Unresolved link targets become ghosts.
 */
export function buildNoteGraph(
  notes: Note[],
  library: ContextSource[] = [],
  packages: ContextPackage[] = [],
  options: { ghosts?: boolean } = {}
): NoteGraph {
  const byTitle = titleIndex(notes)
  const known = new Set(notes.map(note => note.id))
  const libraryById = new Map(library.map(source => [source.id, source]))
  const packagesById = new Map(packages.map(context => [context.id, context]))
  const edges = new Map<string, NoteGraphEdge>()
  const ghosts = new Map<string, NoteGraphNode>()
  const addEdge = (a: string, b: string, kind: NoteEdgeKind) => {
    if (a === b) return
    const [source, target] = a < b ? [a, b] : [b, a]
    const key = `${source}\u0000${target}`
    const existing = edges.get(key)
    if (existing) {
      existing.weight += 1
      if (kind === 'link') existing.kind = 'link'
    } else edges.set(key, { source, target, kind, weight: 1 })
  }
  for (const note of notes) {
    for (const link of noteLinks(note)) {
      const target = byTitle.get(noteKey(link.target))
      if (target) addEdge(note.id, target.id, 'link')
      else if (options.ghosts !== false) {
        const id = `ghost:${noteKey(link.target)}`
        if (!ghosts.has(id))
          ghosts.set(id, {
            id,
            title: link.target,
            ghost: true,
            degree: 0,
            words: 0,
            updatedAt: 0,
          })
        addEdge(note.id, id, 'link')
      }
    }
    for (const id of linkedNoteIds(note, libraryById, packagesById))
      if (known.has(id)) addEdge(note.id, id, 'context')
  }
  const degree = new Map<string, number>()
  for (const edge of edges.values()) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  const nodes: NoteGraphNode[] = notes.map(note => ({
    id: note.id,
    title: note.title,
    degree: degree.get(note.id) ?? 0,
    words: approximateWords(note.content),
    updatedAt: note.updatedAt,
  }))
  for (const ghost of ghosts.values())
    nodes.push({ ...ghost, degree: degree.get(ghost.id) ?? 0 })
  return { nodes, edges: [...edges.values()] }
}

function approximateWords(text: string): number {
  // Word counts only size nodes; a bounded sample keeps large notes cheap.
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text
  const words = sample.match(/\S+/gu)?.length ?? 0
  return text.length > sample.length
    ? Math.round((words * text.length) / sample.length)
    : words
}

/** Note ids within `depth` steps of `center`, including `center`. */
export function neighborhood(
  graph: NoteGraph,
  center: string,
  depth = 1
): Set<string> {
  const adjacent = new Map<string, string[]>()
  const connect = (from: string, to: string) => {
    const list = adjacent.get(from)
    if (list) list.push(to)
    else adjacent.set(from, [to])
  }
  for (const edge of graph.edges) {
    connect(edge.source, edge.target)
    connect(edge.target, edge.source)
  }
  const seen = new Set([center])
  let frontier = [center]
  for (let step = 0; step < depth; step++) {
    const next: string[] = []
    for (const id of frontier)
      for (const neighbor of adjacent.get(id) ?? [])
        if (!seen.has(neighbor)) {
          seen.add(neighbor)
          next.push(neighbor)
        }
    frontier = next
  }
  return seen
}
