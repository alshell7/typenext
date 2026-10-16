/**
 * Pure ranking and grouping for the command palette.
 *
 * Every keystroke re-ranks the whole notebook, so the work is bounded:
 * lowercase titles and the first 20k characters of each note are cached per
 * note object (notes are replaced, never mutated, when they change), and a
 * snippet is cut only for the notes that are actually displayed.
 */
import type { Note } from '../types/notebook'
import { UNTITLED } from './model'

/** A highlighted run inside a displayed string: [start, end). */
export type MatchRange = readonly [number, number]

export interface TextMatch {
  score: number
  ranges: MatchRange[]
}

export type PaletteMode = 'all' | 'actions' | 'headings'

export type PaletteSection = 'Actions' | 'Go to' | 'Preferences' | 'Insert'

/** The fields the ranking needs; the component's PaletteAction extends it. */
export interface RankableAction {
  id: string
  title: string
  section: PaletteSection
  keywords?: string[]
  disabled?: boolean
}

export interface RankableHeading {
  level: number
  text: string
  from: number
}

export type PaletteItem<
  A extends RankableAction = RankableAction,
  H extends RankableHeading = RankableHeading,
> =
  | {
      kind: 'note'
      key: string
      note: Note
      title: string
      ranges: MatchRange[]
      snippet?: { text: string; ranges: MatchRange[] }
      score: number
    }
  | {
      kind: 'heading'
      key: string
      heading: H
      ranges: MatchRange[]
      score: number
    }
  | {
      kind: 'action'
      key: string
      action: A
      ranges: MatchRange[]
      score: number
    }
  | { kind: 'create'; key: string; title: string; score: number }

export interface PaletteGroup<
  A extends RankableAction = RankableAction,
  H extends RankableHeading = RankableHeading,
> {
  id: string
  label: string
  items: PaletteItem<A, H>[]
}

export interface PaletteInput<
  A extends RankableAction,
  H extends RankableHeading,
> {
  query: string
  notes: readonly Note[]
  activeNoteId: string | null
  headings: readonly H[]
  actions: readonly A[]
  /** Injected for tests; defaults to Date.now(). */
  now?: number
}

export const CONTENT_SCAN_LIMIT = 20_000
export const RECENT_LIMIT = 6
export const SUGGESTED_ACTION_LIMIT = 8
const NOTE_RESULT_LIMIT = 24
const HEADING_RESULT_LIMIT = 200
const ACTION_RESULT_LIMIT = 40
/** One letter matches nearly every note's body; only titles count then. */
const MIN_CONTENT_QUERY = 2
const SNIPPET_BEFORE = 28
const SNIPPET_AFTER = 72

/** Score tiers. A tier gap always outweighs every bonus inside a tier. */
const TIER = {
  prefix: 4000,
  wordPrefix: 3000,
  terms: 2400,
  substring: 2000,
  subsequence: 1000,
  content: 400,
} as const

const SECTION_ORDER: readonly PaletteSection[] = [
  'Actions',
  'Go to',
  'Insert',
  'Preferences',
]

export function parseQuery(raw: string): { mode: PaletteMode; text: string } {
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('>'))
    return { mode: 'actions', text: normalize(trimmed.slice(1)) }
  if (trimmed.startsWith('#'))
    return { mode: 'headings', text: normalize(trimmed.slice(1)) }
  return { mode: 'all', text: normalize(raw) }
}

function normalize(text: string) {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase()
}

const WORD_CHAR = /[\p{L}\p{N}]/u

function isBoundary(text: string, index: number) {
  if (index <= 0) return true
  const previous = text[index - 1]!
  if (!WORD_CHAR.test(previous)) return true
  // camelCase and digit boundaries: "noteGraph", "h2"
  const current = text[index]!
  return (
    previous === previous.toLowerCase() &&
    current !== current.toLowerCase() &&
    WORD_CHAR.test(current)
  )
}

/** The first occurrence of `needle` that starts a word, else the first at all. */
function bestOccurrence(lower: string, original: string, needle: string) {
  let index = lower.indexOf(needle)
  const first = index
  while (index > 0 && !isBoundary(original, index))
    index = lower.indexOf(needle, index + 1)
  return index === -1
    ? { index: first, boundary: first === 0 }
    : { index, boundary: true }
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [[sorted[0]![0], sorted[0]![1]]]
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/**
 * Ranks `query` (already normalized) against a display string.
 * exact prefix > word prefix > all words present > substring > subsequence.
 * `lower` may be passed when the caller has cached `original.toLowerCase()`.
 */
export function matchText(
  original: string,
  query: string,
  lower = original.toLowerCase()
): TextMatch | null {
  if (!query) return { score: 0, ranges: [] }
  const length = query.length
  // Shorter strings and earlier matches win within a tier.
  const tidy = (index: number) =>
    -Math.min(index, 60) * 2 - Math.min(original.length, 120) * 0.5

  const phrase = bestOccurrence(lower, original, query)
  if (phrase.index !== -1) {
    const exact = phrase.index === 0 && lower.length === length ? 300 : 0
    const tier =
      phrase.index === 0
        ? TIER.prefix
        : phrase.boundary
          ? TIER.wordPrefix
          : TIER.substring
    return {
      score: tier + exact + tidy(phrase.index),
      ranges: [[phrase.index, phrase.index + length]],
    }
  }

  const terms = query.split(' ')
  if (terms.length > 1) {
    const ranges: MatchRange[] = []
    let boundaries = 0
    let positions = 0
    for (const term of terms) {
      if (!term) continue
      const found = bestOccurrence(lower, original, term)
      if (found.index === -1) {
        ranges.length = 0
        break
      }
      if (found.boundary) boundaries++
      positions += found.index
      ranges.push([found.index, found.index + term.length])
    }
    if (ranges.length) {
      const allWords = boundaries === ranges.length
      return {
        score:
          (allWords ? TIER.terms : TIER.substring - 200) -
          Math.min(positions, 120) -
          Math.min(original.length, 120) * 0.5,
        ranges: mergeRanges(ranges),
      }
    }
  }

  // Subsequence: every query character in order, preferring word starts.
  const ranges: [number, number][] = []
  let cursor = 0
  let gaps = 0
  let starts = 0
  for (let index = 0; index < length; index++) {
    const char = query[index]!
    if (char === ' ') continue
    const found = lower.indexOf(char, cursor)
    if (found === -1) return null
    if (cursor && found > cursor) gaps += found - cursor
    if (isBoundary(original, found)) starts++
    const last = ranges[ranges.length - 1]
    if (last && last[1] === found) last[1] = found + 1
    else ranges.push([found, found + 1])
    cursor = found + 1
  }
  return {
    score:
      TIER.subsequence +
      starts * 40 -
      Math.min(gaps, 30) * 12 -
      ranges.length * 8 -
      Math.min(ranges[0]?.[0] ?? 0, 40) * 2,
    ranges,
  }
}

interface NoteIndexEntry {
  title: string
  titleLower: string
  contentLower: string
}

const noteIndex = new WeakMap<Note, NoteIndexEntry>()

function indexNote(note: Note): NoteIndexEntry {
  let entry = noteIndex.get(note)
  if (!entry) {
    const title = note.title.trim() || UNTITLED
    entry = {
      title,
      titleLower: title.toLowerCase(),
      contentLower: note.content.slice(0, CONTENT_SCAN_LIMIT).toLowerCase(),
    }
    noteIndex.set(note, entry)
  }
  return entry
}

/** Up to ~90 points for a note edited today, fading over a few weeks. */
function recencyBoost(updatedAt: number, now: number) {
  const days = Math.max(0, now - updatedAt) / 86_400_000
  return 90 / (1 + days / 3)
}

/** A short, single-line excerpt around a content match. */
export function makeSnippet(
  content: string,
  index: number,
  length: number,
  ranges: MatchRange[] = [[index, index + length]]
): { text: string; ranges: MatchRange[] } {
  let start = Math.max(0, index - SNIPPET_BEFORE)
  if (start > 0) {
    const space = content.indexOf(' ', start)
    if (space !== -1 && space < index) start = space + 1
  }
  let end = Math.min(content.length, index + length + SNIPPET_AFTER)
  if (end < content.length) {
    const space = content.lastIndexOf(' ', end)
    if (space > index + length) end = space
  }
  const lead = start > 0 ? '…' : ''
  const tail = end < content.length ? '…' : ''
  // Replace whitespace one-for-one so highlight offsets stay valid.
  const body = content.slice(start, end).replace(/\s/gu, ' ')
  const offset = lead.length - start
  return {
    text: `${lead}${body}${tail}`,
    ranges: ranges
      .filter(([from, to]) => from >= start && to <= end)
      .map(([from, to]) => [from + offset, to + offset] as const),
  }
}

/**
 * A content match: the whole phrase, else every word somewhere in the note.
 * A phrase implies all of its words, so a multi-word query checks its longest
 * word first and a miss costs a single pass over the note.
 */
function matchContent(contentLower: string, query: string) {
  if (query.length < MIN_CONTENT_QUERY) return null
  const terms = query.split(' ').filter(Boolean)
  let ranges: MatchRange[] | null = null
  if (terms.length > 1) {
    ranges = []
    const byLength = [...terms].sort((a, b) => b.length - a.length)
    for (const term of byLength) {
      const found = contentLower.indexOf(term)
      if (found === -1) return null
      ranges.push([found, found + term.length])
    }
  }
  const index = contentLower.indexOf(query)
  if (index !== -1)
    return {
      score:
        TIER.content +
        (isBoundary(contentLower, index) ? 120 : 0) -
        Math.min(index / 200, 60),
      ranges: [[index, index + query.length]] as MatchRange[],
    }
  return ranges
    ? { score: TIER.content - 100, ranges: mergeRanges(ranges) }
    : null
}

/**
 * Typing only narrows: every note matching "gard" also matched "gar" (phrase,
 * words and subsequence all shrink as the query grows). So a keystroke scans
 * the previous query's matches instead of the whole notebook. The cache is
 * dropped as soon as the notes array changes identity.
 */
const candidateCache: {
  notes: readonly Note[] | null
  byQuery: Map<string, Note[]>
} = { notes: null, byQuery: new Map() }
const CANDIDATE_CACHE_SIZE = 32

function candidatesFor(notes: readonly Note[], query: string): readonly Note[] {
  if (candidateCache.notes !== notes) {
    candidateCache.notes = notes
    candidateCache.byQuery.clear()
    return notes
  }
  // Content is ignored below MIN_CONTENT_QUERY, so shorter keys are not
  // complete candidate sets and are never cached.
  for (let end = query.length; end >= MIN_CONTENT_QUERY; end--) {
    const hit = candidateCache.byQuery.get(query.slice(0, end))
    if (hit) return hit
  }
  return notes
}

function rememberCandidates(query: string, matched: Note[]) {
  if (query.length < MIN_CONTENT_QUERY) return
  const cache = candidateCache.byQuery
  cache.delete(query)
  cache.set(query, matched)
  if (cache.size > CANDIDATE_CACHE_SIZE)
    cache.delete(cache.keys().next().value as string)
}

export function rankNotes(
  notes: readonly Note[],
  query: string,
  now = Date.now()
): Extract<PaletteItem, { kind: 'note' }>[] {
  const scored: {
    note: Note
    entry: NoteIndexEntry
    score: number
    ranges: MatchRange[]
    content: MatchRange[] | null
  }[] = []
  for (const note of candidatesFor(notes, query)) {
    const entry = indexNote(note)
    const title = matchText(entry.title, query, entry.titleLower)
    const boost = recencyBoost(note.updatedAt, now)
    if (title) {
      scored.push({
        note,
        entry,
        score: title.score + boost,
        ranges: title.ranges,
        content: null,
      })
      continue
    }
    const content = matchContent(entry.contentLower, query)
    if (content)
      scored.push({
        note,
        entry,
        score: content.score + boost,
        ranges: [],
        content: content.ranges,
      })
  }
  rememberCandidates(
    query,
    scored.map(item => item.note)
  )
  scored.sort(
    (a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt
  )
  return scored.slice(0, NOTE_RESULT_LIMIT).map(item => {
    const first = item.content?.[0]
    return {
      kind: 'note',
      key: `note:${item.note.id}`,
      note: item.note,
      title: item.entry.title,
      ranges: item.ranges,
      snippet:
        item.content && first
          ? makeSnippet(
              item.note.content,
              first[0],
              first[1] - first[0],
              item.content
            )
          : undefined,
      score: item.score,
    }
  })
}

export function recentNotes(
  notes: readonly Note[],
  activeNoteId: string | null,
  limit = RECENT_LIMIT
): Note[] {
  const top: Note[] = []
  for (const note of notes) {
    if (note.id === activeNoteId) continue
    // Insertion into a tiny sorted list beats sorting the whole notebook.
    let index = top.length
    while (index > 0 && top[index - 1]!.updatedAt < note.updatedAt) index--
    if (index < limit) {
      top.splice(index, 0, note)
      if (top.length > limit) top.pop()
    }
  }
  return top
}

export function rankActions<A extends RankableAction>(
  actions: readonly A[],
  query: string
): Extract<PaletteItem<A>, { kind: 'action' }>[] {
  const scored: {
    action: A
    score: number
    ranges: MatchRange[]
    order: number
  }[] = []
  actions.forEach((action, order) => {
    const title = matchText(action.title, query)
    let score = title?.score ?? -Infinity
    // Highlight the title only when the title itself decided the rank.
    let ranges = title?.ranges ?? []
    for (const keyword of action.keywords ?? []) {
      const match = matchText(keyword, query)
      // A keyword hit counts, but less than the same hit in the title.
      if (match && match.score - 600 > score) {
        score = match.score - 600
        ranges = []
      }
    }
    const section = matchText(action.section, query)
    if (section && section.score - 1200 > score) {
      score = section.score - 1200
      ranges = []
    }
    if (score === -Infinity) return
    // Disabled actions stay findable but sink below runnable ones.
    if (action.disabled) score -= 500
    scored.push({ action, score, ranges, order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.slice(0, ACTION_RESULT_LIMIT).map(item => ({
    kind: 'action',
    key: `action:${item.action.id}`,
    action: item.action,
    ranges: item.ranges,
    score: item.score,
  }))
}

export function rankHeadings<H extends RankableHeading>(
  headings: readonly H[],
  query: string
): Extract<PaletteItem<RankableAction, H>, { kind: 'heading' }>[] {
  const items: Extract<PaletteItem<RankableAction, H>, { kind: 'heading' }>[] =
    []
  headings.forEach((heading, order) => {
    const match = matchText(heading.text, query)
    if (!match) return
    items.push({
      kind: 'heading',
      key: `heading:${heading.from}:${order}`,
      heading,
      ranges: match.ranges,
      // Keep document order for an empty query and for ties.
      score: match.score - order * 0.001,
    })
  })
  if (query) items.sort((a, b) => b.score - a.score)
  return items.slice(0, HEADING_RESULT_LIMIT)
}

function actionsBySection<
  A extends RankableAction,
  H extends RankableHeading = RankableHeading,
>(
  items: Extract<PaletteItem<A>, { kind: 'action' }>[],
  ranked: boolean
): PaletteGroup<A, H>[] {
  const groups = new Map<PaletteSection, PaletteGroup<A, H>>()
  for (const item of items) {
    const section = item.action.section
    let group = groups.get(section)
    if (!group) {
      group = { id: `section:${section}`, label: section, items: [] }
      groups.set(section, group)
    }
    group.items.push(item)
  }
  const list = [...groups.values()]
  // Ranked results keep their best-first order (Map preserves insertion);
  // the browsable list follows a fixed, predictable section order.
  if (!ranked)
    list.sort(
      (a, b) =>
        SECTION_ORDER.indexOf(a.label as PaletteSection) -
        SECTION_ORDER.indexOf(b.label as PaletteSection)
    )
  return list
}

/** Builds the grouped result list for one keystroke. */
export function buildPalette<
  A extends RankableAction,
  H extends RankableHeading,
>(input: PaletteInput<A, H>): PaletteGroup<A, H>[] {
  const { mode, text } = parseQuery(input.query)
  const now = input.now ?? Date.now()

  if (mode === 'actions') {
    const ranked = text
      ? rankActions(input.actions, text)
      : input.actions.map((action, order) => ({
          kind: 'action' as const,
          key: `action:${action.id}`,
          action,
          ranges: [],
          score: -order,
        }))
    return actionsBySection<A, H>(ranked, Boolean(text))
  }

  if (mode === 'headings') {
    const items = rankHeadings(input.headings, text)
    return items.length
      ? [{ id: 'headings', label: 'Headings', items } as PaletteGroup<A, H>]
      : []
  }

  if (!text) {
    const groups: PaletteGroup<A, H>[] = []
    const recent = recentNotes(input.notes, input.activeNoteId)
    if (recent.length)
      groups.push({
        id: 'recent',
        label: 'Recent notes',
        items: recent.map(note => ({
          kind: 'note',
          key: `note:${note.id}`,
          note,
          title: indexNote(note).title,
          ranges: [],
          score: 0,
        })),
      })
    const suggested = input.actions
      .filter(action => !action.disabled)
      .slice(0, SUGGESTED_ACTION_LIMIT)
    if (suggested.length)
      groups.push({
        id: 'actions',
        label: 'Actions',
        items: suggested.map(action => ({
          kind: 'action',
          key: `action:${action.id}`,
          action,
          ranges: [],
          score: 0,
        })),
      })
    return groups
  }

  const ranked: PaletteGroup<A, H>[] = []
  const notes = rankNotes(input.notes, text, now)
  if (notes.length) ranked.push({ id: 'notes', label: 'Notes', items: notes })
  const headings = rankHeadings(input.headings, text)
  if (headings.length)
    ranked.push({
      id: 'headings',
      label: 'In this note',
      items: headings,
    } as PaletteGroup<A, H>)
  ranked.push(...actionsBySection<A, H>(rankActions(input.actions, text), true))
  // The strongest match leads: "new" puts New note above content mentions.
  // Stable sort keeps notes > headings > actions for equal scores.
  const best = (group: PaletteGroup<A, H>) => group.items[0]?.score ?? 0
  ranked.sort((a, b) => best(b) - best(a))

  const exists = notes.some(item => item.title.toLowerCase() === text)
  if (!exists) {
    const title = input.query.trim().replace(/\s+/gu, ' ')
    ranked.push({
      id: 'create',
      label: 'New',
      items: [{ kind: 'create', key: 'create', title, score: -Infinity }],
    })
  }
  return ranked
}

/** Flat order used by keyboard navigation and aria-activedescendant. */
export function flattenGroups<G extends { items: unknown[] }>(groups: G[]) {
  const starts: number[] = []
  let total = 0
  for (const group of groups) {
    starts.push(total)
    total += group.items.length
  }
  return { starts, total }
}

/** The first index of the next (or previous) group, wrapping around. */
export function nextGroupStart(
  starts: readonly number[],
  current: number,
  direction: 1 | -1
): number {
  if (!starts.length) return 0
  let group = 0
  for (let index = 0; index < starts.length; index++)
    if (starts[index]! <= current) group = index
  const target = (group + direction + starts.length) % starts.length
  return starts[target]!
}
