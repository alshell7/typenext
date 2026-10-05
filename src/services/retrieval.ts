import type { Note, RetrievedChunk } from '../types/notebook'

const CHUNK_SIZE = 1_400
const CHUNK_OVERLAP = 160
const MAX_SOURCE_CHARACTERS = 300_000
const MAX_INDEX_CHARACTERS = 1_000_000
const MAX_CACHED_INDEX_CHARACTERS = 2_000_000
const MAX_CACHED_NOTES = 12
const MAX_SOURCES = 256
const MAX_RETRIEVED_CHARACTERS = 6_000
const STOP_WORDS = new Set(
  'a an and are as at be been but by for from had has have he her his i if in is it its of on or our she that the their them they this to was we were will with you your'.split(
    ' '
  )
)

interface IndexedChunk extends RetrievedChunk {
  terms: Map<string, number>
  length: number
  nameTerms: Set<string>
}

interface SourceSnapshot {
  id: string
  name: string
  text: string
}

interface ContextIndex {
  sources: SourceSnapshot[]
  chunks: IndexedChunk[]
  documentFrequency: Map<string, number>
  averageLength: number
  characters: number
}

// Only extracted, enabled source text is indexed. No embedding model or network
// connection is needed, and note edits do not rebuild unchanged source indexes.
const indexes = new Map<string, ContextIndex>()
let cachedCharacters = 0

function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []
  const tokens: string[] = []
  for (const word of words) {
    if (
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word)
    ) {
      // Character bigrams also find phrases in languages without spaces. Keep
      // single characters so a short name can still match its surrounding text.
      const characters = Array.from(word)
      for (let i = 0; i < characters.length; i++) {
        const character = characters[i]
        if (character) tokens.push(character)
        const next = characters[i + 1]
        if (character && next) tokens.push(character + next)
      }
    } else if (!STOP_WORDS.has(word)) {
      tokens.push(word.slice(0, 80))
    }
  }
  return tokens
}

function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length)
    if (end < text.length) {
      const window = text.slice(start, end)
      const boundary = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf(' ')
      )
      if (boundary >= CHUNK_SIZE * 0.6) end = start + boundary + 1
      const lastCode = text.charCodeAt(end - 1)
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) end--
    }
    const chunk = text.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= text.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP)
    const firstCode = text.charCodeAt(start)
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) start++
  }
  return chunks
}

function sourceSnapshot(note: Note): SourceSnapshot[] {
  const sources: SourceSnapshot[] = []
  let remaining = MAX_INDEX_CHARACTERS
  for (const source of note.sources.slice(0, MAX_SOURCES)) {
    if (remaining <= 0) break
    if (!source.enabled || !source.text.length) continue
    const length = Math.min(
      MAX_SOURCE_CHARACTERS,
      remaining,
      source.text.length
    )
    // Copy truncated text once so a substring cannot retain a much larger
    // linked note or an attachment beyond the actual indexing budget.
    const text: string =
      length === source.text.length
        ? source.text
        : JSON.parse(JSON.stringify(source.text.slice(0, length)))
    sources.push({ id: source.id, name: source.name.slice(0, 200), text })
    remaining -= length
  }
  return sources
}

function unchangedSources(note: Note, previous: ContextIndex): boolean {
  let remaining = MAX_INDEX_CHARACTERS
  let position = 0
  for (const source of note.sources.slice(0, MAX_SOURCES)) {
    if (remaining <= 0) break
    if (!source.enabled || !source.text.length) continue
    const length = Math.min(
      MAX_SOURCE_CHARACTERS,
      remaining,
      source.text.length
    )
    const cached = previous.sources[position++]
    if (
      cached?.id !== source.id ||
      cached.name !== source.name.slice(0, 200) ||
      cached.text.length !== length ||
      cached.text !==
        (length === source.text.length
          ? source.text
          : source.text.slice(0, length))
    )
      return false
    remaining -= length
  }
  return position === previous.sources.length
}

function getIndex(note: Note): ContextIndex {
  const previous = indexes.get(note.id)
  if (previous && unchangedSources(note, previous)) {
    indexes.delete(note.id)
    indexes.set(note.id, previous)
    return previous
  }

  const sources = sourceSnapshot(note)
  const chunks: IndexedChunk[] = []
  const documentFrequency = new Map<string, number>()
  for (const source of sources) {
    const nameTerms = new Set(tokenize(source.name))
    for (const text of chunkText(source.text)) {
      const tokens = tokenize(text)
      if (!tokens.length) continue
      const terms = new Map<string, number>()
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1)
      for (const term of terms.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
      }
      chunks.push({
        sourceId: source.id,
        sourceName: source.name,
        text,
        score: 0,
        terms,
        length: tokens.length,
        nameTerms,
      })
    }
  }

  const index: ContextIndex = {
    sources,
    chunks,
    documentFrequency,
    averageLength:
      chunks.reduce((sum, chunk) => sum + chunk.length, 0) /
      (chunks.length || 1),
    characters: sources.reduce((sum, source) => sum + source.text.length, 0),
  }
  cachedCharacters -= previous?.characters ?? 0
  indexes.delete(note.id)
  indexes.set(note.id, index)
  cachedCharacters += index.characters
  while (
    indexes.size > MAX_CACHED_NOTES ||
    cachedCharacters > MAX_CACHED_INDEX_CHARACTERS
  ) {
    const oldest = indexes.keys().next().value
    if (oldest === undefined) break
    cachedCharacters -= indexes.get(oldest)?.characters ?? 0
    indexes.delete(oldest)
  }
  return index
}

/**
 * Retrieve bounded source passages with local BM25 scoring. Optional cursor
 * terms take priority over background-only matches; ordinary library queries
 * keep their original ranking, including when no cursor terms match.
 */
export function retrieveContext(
  note: Note,
  query: string,
  limit = 4,
  focusedQuery = ''
): RetrievedChunk[] {
  const focusedTerms = new Set(
    focusedQuery
      ? [...new Set(tokenize(focusedQuery.slice(0, 400)))].slice(0, 64)
      : []
  )
  const backgroundTerms = new Set(
    [...new Set(tokenize(query.slice(0, 4_000)))].slice(0, 128)
  )
  // Preserve the original background's complete 128-term budget even if none
  // of the cursor's <=64 extra terms match. The single scoring pass is bounded
  // to their union (at most 192 terms), without rescanning or rebuilding sources.
  const terms = [...new Set([...backgroundTerms, ...focusedTerms])]
  if (!terms.length || !Number.isFinite(limit) || limit <= 0) return []
  const count = Math.min(8, Math.floor(limit))
  if (!count) return []
  const index = getIndex(note)
  if (!index.chunks.length) return []
  const k1 = 1.5
  const b = 0.75
  let maximumScore = 0
  const ranked = index.chunks
    .map(chunk => {
      let score = 0
      let focusedScore = 0
      for (const term of terms) {
        const frequency = chunk.terms.get(term) ?? 0
        if (!frequency) continue
        const df = index.documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (index.chunks.length - df + 0.5) / (df + 0.5))
        let contribution =
          (idf * frequency * (k1 + 1)) /
          (frequency + k1 * (1 - b + (b * chunk.length) / index.averageLength))
        if (chunk.nameTerms.has(term)) contribution += idf * 0.2
        if (backgroundTerms.has(term)) score += contribution
        if (focusedTerms.has(term)) focusedScore += contribution
      }
      maximumScore = Math.max(maximumScore, score)
      return { chunk, score, focusedScore }
    })
    .filter(result => result.score > 0 || result.focusedScore > 0)
  // A fixed multiplier can still let a long, varied background query displace
  // the cursor's topic. The shared offset makes cursor hits win without another
  // index or a second retrieval pass; BM25 orders those hits and breaks ties.
  const priorityScore = (result: (typeof ranked)[number]) =>
    result.focusedScore > 0 ? maximumScore + result.focusedScore : result.score
  ranked.sort(
    (a, b) => priorityScore(b) - priorityScore(a) || b.score - a.score
  )

  const results: RetrievedChunk[] = []
  const seenText = new Set<string>()
  const perSource = new Map<string, number>()
  let remaining = MAX_RETRIEVED_CHARACTERS
  for (const result of ranked) {
    const { chunk } = result
    if (results.length >= count || remaining <= 0) break
    const normalized = chunk.text.replace(/\s+/gu, ' ').toLowerCase()
    if (seenText.has(normalized) || (perSource.get(chunk.sourceId) ?? 0) >= 2)
      continue
    const text = chunk.text.slice(0, remaining)
    seenText.add(normalized)
    perSource.set(chunk.sourceId, (perSource.get(chunk.sourceId) ?? 0) + 1)
    remaining -= text.length
    results.push({
      sourceId: chunk.sourceId,
      sourceName: chunk.sourceName,
      text,
      score: priorityScore(result),
    })
  }
  return results
}
