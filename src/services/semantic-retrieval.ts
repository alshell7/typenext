import type {
  ContextSource,
  CursorContext,
  MediaKind,
  Note,
  NotebookSettings,
  RetrievedChunk,
  SemanticSettings,
} from '../types/notebook'
import {
  decodeVector,
  documentPrompt,
  dot,
  embedTexts,
  EMBEDDING_MODEL,
  queryPrompt,
  truncateVector,
} from './embedding-client'
import {
  EMBEDDING_RUNTIME,
  resolveEmbeddingEndpoint,
  type EmbeddingEndpoint,
} from './embedding-runtime'
import { chunkText, retrieveContext, tokenize } from './retrieval'
import { getVectors, putVectors, textHash } from './vector-store'

const SEMANTIC_CHUNK = 900
const SEMANTIC_OVERLAP = 140
const MAX_SEMANTIC_CHUNKS = 3_000
const MAX_SOURCE_CHARACTERS = 300_000
const MAX_RETRIEVED_CHARACTERS = 6_000
const MAX_CACHED_INDEXES = 8
const MAX_QUERY_CACHE = 256
const INDEX_BATCH = 16
/** Cosine floor below which a semantic hit is treated as unrelated. */
const MIN_SIMILARITY = 0.58
/** Keep hits close to the best one; distant tails are mostly noise. */
const RELATIVE_WINDOW = 0.12
const RRF_K = 60

export interface SemanticIndexStatus {
  state: 'off' | 'unavailable' | 'indexing' | 'ready' | 'error'
  indexed: number
  total: number
  error?: string
}

interface SemanticChunk {
  sourceId: string
  sourceName: string
  text: string
  key: string
  mediaKind?: MediaKind
  vector?: Float32Array
}

interface SemanticIndex {
  signature: string
  chunks: SemanticChunk[]
  indexed: number
  building: Promise<void> | null
  controller: AbortController | null
  error?: string
}

interface SemanticHit {
  chunk: SemanticChunk
  similarity: number
}

const indexes = new Map<string, SemanticIndex>()
const queryCache = new Map<string, Float32Array>()
const listeners = new Set<() => void>()
let status: SemanticIndexStatus = { state: 'off', indexed: 0, total: 0 }
let statusNoteId: string | null = null

function publish(noteId: string, next: SemanticIndexStatus) {
  if (statusNoteId !== null && statusNoteId !== noteId) return
  status = next
  listeners.forEach(listener => listener())
}

export function getSemanticIndexStatus(): SemanticIndexStatus {
  return status
}

export function subscribeSemanticIndex(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The status shown in the interface follows the note being written. */
export function focusSemanticStatus(noteId: string | null) {
  statusNoteId = noteId
  const index = noteId ? indexes.get(noteId) : undefined
  status = index ? statusFor(index) : { state: 'off', indexed: 0, total: 0 }
  listeners.forEach(listener => listener())
}

function statusFor(index: SemanticIndex): SemanticIndexStatus {
  if (index.error)
    return {
      state: 'error',
      indexed: index.indexed,
      total: index.chunks.length,
      error: index.error,
    }
  return {
    state: index.indexed >= index.chunks.length ? 'ready' : 'indexing',
    indexed: index.indexed,
    total: index.chunks.length,
  }
}

export function modelIdentity(settings: SemanticSettings): string {
  // The pinned revision is part of the key: new weights never reuse old vectors.
  return settings.runtime === 'managed'
    ? `${EMBEDDING_MODEL}@${EMBEDDING_RUNTIME.modelRevision.slice(0, 12)}:${settings.quantization}`
    : `${EMBEDDING_MODEL}:server:${settings.endpoint.trim()}`
}

function sourceSignature(source: ContextSource): string {
  const text = source.text
  const sample =
    text.length > 8_000 ? text.slice(0, 4_000) + text.slice(-4_000) : text
  return `${source.id}:${source.name.length}:${text.length}:${textHash(sample)}:${source.media?.vector?.length ?? 0}`
}

function indexSignature(note: Note, settings: SemanticSettings): string {
  return [
    modelIdentity(settings),
    settings.dimensions,
    ...note.sources
      .filter(source => source.enabled && (source.text || source.media?.vector))
      .map(sourceSignature),
  ].join('|')
}

function buildChunks(note: Note, settings: SemanticSettings): SemanticChunk[] {
  const chunks: SemanticChunk[] = []
  const model = `${modelIdentity(settings)}:${settings.dimensions}`
  for (const source of note.sources) {
    if (!source.enabled || chunks.length >= MAX_SEMANTIC_CHUNKS) continue
    const name = source.name.slice(0, 200)
    const mediaKind =
      source.kind === 'image' ||
      source.kind === 'audio' ||
      source.kind === 'video'
        ? source.kind
        : undefined
    if (mediaKind && source.media?.vector) {
      // Media vectors were made at import. They share the text vector space.
      chunks.push({
        sourceId: source.id,
        sourceName: name,
        text: source.text,
        key: `media:${source.id}`,
        mediaKind,
        vector: truncateVector(
          decodeVector(source.media.vector),
          settings.dimensions
        ),
      })
    }
    const text = source.text.slice(0, MAX_SOURCE_CHARACTERS)
    if (!text.trim()) continue
    for (const part of chunkText(text, SEMANTIC_CHUNK, SEMANTIC_OVERLAP)) {
      if (chunks.length >= MAX_SEMANTIC_CHUNKS) break
      chunks.push({
        sourceId: source.id,
        sourceName: name,
        text: part,
        key: `${model}:${textHash(`${name}\u0000${part}`)}`,
        ...(mediaKind ? { mediaKind } : {}),
      })
    }
  }
  return chunks
}

function getIndex(note: Note, settings: SemanticSettings): SemanticIndex {
  const signature = indexSignature(note, settings)
  const previous = indexes.get(note.id)
  if (previous && previous.signature === signature) {
    indexes.delete(note.id)
    indexes.set(note.id, previous)
    return previous
  }
  previous?.controller?.abort()
  const chunks = buildChunks(note, settings)
  const index: SemanticIndex = {
    signature,
    chunks,
    indexed: chunks.filter(chunk => chunk.vector).length,
    building: null,
    controller: null,
  }
  indexes.delete(note.id)
  indexes.set(note.id, index)
  while (indexes.size > MAX_CACHED_INDEXES) {
    const oldest = indexes.keys().next().value
    if (oldest === undefined) break
    indexes.get(oldest)?.controller?.abort()
    indexes.delete(oldest)
  }
  return index
}

/** Embed passages that are not cached yet, in the background, in small batches. */
function buildIndex(
  noteId: string,
  index: SemanticIndex,
  endpoint: EmbeddingEndpoint,
  settings: SemanticSettings
): Promise<void> {
  if (index.building) return index.building
  if (index.indexed >= index.chunks.length) {
    publish(noteId, statusFor(index))
    return Promise.resolve()
  }
  const controller = new AbortController()
  index.controller = controller
  index.error = undefined
  index.building = (async () => {
    try {
      const pending = index.chunks.filter(chunk => !chunk.vector)
      const cached = await getVectors(pending.map(chunk => chunk.key))
      for (const chunk of pending) {
        const vector = cached.get(chunk.key)
        if (vector && vector.length === settings.dimensions)
          chunk.vector = vector
      }
      index.indexed = index.chunks.filter(chunk => chunk.vector).length
      publish(noteId, statusFor(index))
      const missing = index.chunks.filter(chunk => !chunk.vector)
      for (let offset = 0; offset < missing.length; offset += INDEX_BATCH) {
        if (controller.signal.aborted) return
        const batch = missing.slice(offset, offset + INDEX_BATCH)
        const vectors = await embedTexts(
          endpoint,
          batch.map(chunk => documentPrompt(chunk.sourceName, chunk.text)),
          settings.dimensions,
          { signal: controller.signal, priority: 'background' }
        )
        const entries: [string, Float32Array][] = []
        batch.forEach((chunk, position) => {
          const vector = vectors[position]
          if (!vector) return
          chunk.vector = vector
          entries.push([chunk.key, vector])
        })
        await putVectors(entries)
        index.indexed = index.chunks.filter(chunk => chunk.vector).length
        publish(noteId, statusFor(index))
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        index.error = error instanceof Error ? error.message : String(error)
        publish(noteId, statusFor(index))
      }
    } finally {
      index.building = null
      if (index.controller === controller) index.controller = null
    }
  })()
  return index.building
}

async function queryVector(
  endpoint: EmbeddingEndpoint,
  query: string,
  settings: SemanticSettings,
  signal?: AbortSignal
): Promise<Float32Array> {
  const key = `${modelIdentity(settings)}:${settings.dimensions}:${textHash(query)}`
  const cached = queryCache.get(key)
  if (cached) {
    queryCache.delete(key)
    queryCache.set(key, cached)
    return cached
  }
  const [vector] = await embedTexts(
    endpoint,
    [queryPrompt(query)],
    settings.dimensions,
    {
      signal,
    }
  )
  if (!vector) throw new Error('The embedding server returned no query vector.')
  queryCache.set(key, vector)
  while (queryCache.size > MAX_QUERY_CACHE) {
    const oldest = queryCache.keys().next().value
    if (oldest === undefined) break
    queryCache.delete(oldest)
  }
  return vector
}

/** Rank indexed passages, then keep a diverse set (maximal marginal relevance). */
export function rankSemantic(
  query: Float32Array,
  chunks: { vector?: Float32Array }[],
  limit: number,
  lambda = 0.75
): { index: number; similarity: number }[] {
  const scored: { index: number; similarity: number }[] = []
  chunks.forEach((chunk, index) => {
    if (chunk.vector)
      scored.push({ index, similarity: dot(query, chunk.vector) })
  })
  scored.sort((a, b) => b.similarity - a.similarity)
  const best = scored[0]?.similarity ?? 0
  const floor = Math.max(MIN_SIMILARITY, best - RELATIVE_WINDOW)
  const candidates = scored
    .filter(item => item.similarity >= floor)
    .slice(0, 64)
  const chosen: { index: number; similarity: number }[] = []
  while (chosen.length < limit && candidates.length) {
    let bestIndex = 0
    let bestScore = -Infinity
    candidates.forEach((candidate, position) => {
      const vector = chunks[candidate.index]!.vector!
      const redundancy = chosen.reduce(
        (maximum, item) =>
          Math.max(maximum, dot(vector, chunks[item.index]!.vector!)),
        0
      )
      const score = lambda * candidate.similarity - (1 - lambda) * redundancy
      if (score > bestScore) {
        bestScore = score
        bestIndex = position
      }
    })
    chosen.push(candidates.splice(bestIndex, 1)[0]!)
  }
  return chosen
}

/** Reciprocal rank fusion of lexical and semantic results. */
export function fuseRetrieval(
  lexical: RetrievedChunk[],
  semantic: RetrievedChunk[],
  limit: number,
  maxCharacters = MAX_RETRIEVED_CHARACTERS
): RetrievedChunk[] {
  const scores = new Map<
    string,
    {
      chunk: RetrievedChunk
      score: number
      lexical: boolean
      semantic: boolean
    }
  >()
  const normalized = (text: string) => text.replace(/\s+/gu, ' ').toLowerCase()
  // Chunks from the two indexes have different sizes. A passage counts once
  // when one chunk contains a distinctive window of the other.
  const probe = (text: string) =>
    text.length > 100 ? text.slice(30, 90) : text
  const add = (
    list: RetrievedChunk[],
    kind: 'lexical' | 'semantic',
    weight: number
  ) =>
    list.forEach((chunk, rank) => {
      const key = `${chunk.sourceId}\u0000${normalized(chunk.text)}`
      let entry = scores.get(key)
      if (!entry)
        for (const [other, value] of scores) {
          // Only a passage found by the other index can be the same passage.
          if (value.chunk.sourceId !== chunk.sourceId || value[kind]) continue
          const otherText = other.slice(other.indexOf('\u0000') + 1)
          const text = key.slice(key.indexOf('\u0000') + 1)
          if (
            otherText.includes(probe(text)) ||
            text.includes(probe(otherText))
          ) {
            entry = value
            break
          }
        }
      if (!entry) {
        entry = { chunk, score: 0, lexical: false, semantic: false }
        scores.set(key, entry)
      }
      entry.score += weight / (RRF_K + rank + 1)
      entry[kind] = true
    })
  add(lexical, 'lexical', 1)
  add(semantic, 'semantic', 1.1)
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score)
  const results: RetrievedChunk[] = []
  const perSource = new Map<string, number>()
  let remaining = maxCharacters
  for (const entry of ranked) {
    if (results.length >= limit || remaining <= 0) break
    const count = perSource.get(entry.chunk.sourceId) ?? 0
    if (count >= 2) continue
    perSource.set(entry.chunk.sourceId, count + 1)
    const text = entry.chunk.text.slice(0, remaining)
    remaining -= text.length
    results.push({
      ...entry.chunk,
      text,
      score: entry.score,
      match:
        entry.lexical && entry.semantic
          ? 'hybrid'
          : entry.lexical
            ? 'lexical'
            : 'semantic',
    })
  }
  return results
}

function semanticEnabled(settings: NotebookSettings) {
  return settings.semantic?.enabled === true
}

function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  if (!Number.isFinite(budgetMs)) return work
  return Promise.race([
    work,
    new Promise<null>(resolve => setTimeout(() => resolve(null), budgetMs)),
  ])
}

/** Start indexing a note's sources when semantic search is on. */
export async function prepareSemanticIndex(
  note: Note,
  settings: NotebookSettings
): Promise<void> {
  if (!semanticEnabled(settings)) {
    publish(note.id, { state: 'off', indexed: 0, total: 0 })
    return
  }
  const index = getIndex(note, settings.semantic)
  if (!index.chunks.length) {
    publish(note.id, { state: 'ready', indexed: 0, total: 0 })
    return
  }
  try {
    const endpoint = await resolveEmbeddingEndpoint(settings.semantic)
    void buildIndex(note.id, index, endpoint, settings.semantic)
  } catch (error) {
    publish(note.id, {
      state: 'unavailable',
      indexed: index.indexed,
      total: index.chunks.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Semantic passages only. Returns [] when the index or server is not ready. */
export async function semanticSearch(
  note: Note,
  query: string,
  settings: NotebookSettings,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<RetrievedChunk[]> {
  if (!semanticEnabled(settings) || !query.trim()) return []
  const index = getIndex(note, settings.semantic)
  if (!index.chunks.length) return []
  const endpoint = await resolveEmbeddingEndpoint(settings.semantic)
  void buildIndex(note.id, index, endpoint, settings.semantic)
  if (!index.chunks.some(chunk => chunk.vector)) return []
  const vector = await queryVector(
    endpoint,
    query,
    settings.semantic,
    options.signal
  )
  const hits: SemanticHit[] = rankSemantic(
    vector,
    index.chunks,
    options.limit ?? 6
  ).map(item => ({
    chunk: index.chunks[item.index]!,
    similarity: item.similarity,
  }))
  return hits.map(hit => ({
    sourceId: hit.chunk.sourceId,
    sourceName: hit.chunk.sourceName,
    text: hit.chunk.mediaKind
      ? `${hit.chunk.mediaKind === 'image' ? 'Image' : hit.chunk.mediaKind === 'audio' ? 'Audio' : 'Video'} “${hit.chunk.sourceName}”: ${hit.chunk.text}`
      : hit.chunk.text,
    score: hit.similarity,
    match: 'semantic' as const,
    ...(hit.chunk.mediaKind ? { mediaKind: hit.chunk.mediaKind } : {}),
  }))
}

/**
 * Lexical BM25 always runs. When semantic search is on, its passages are fused
 * with reciprocal rank fusion inside a latency budget; a slow embedding server
 * never delays a suggestion beyond that budget.
 */
export async function retrieveHybrid(
  note: Note,
  query: string,
  settings: NotebookSettings,
  options: {
    limit?: number
    focusedQuery?: string
    semanticQuery?: string
    signal?: AbortSignal
    budgetMs?: number
  } = {}
): Promise<RetrievedChunk[]> {
  const limit = options.limit ?? 4
  const lexical = retrieveContext(
    note,
    query,
    8,
    options.focusedQuery ?? ''
  ).map(chunk => ({ ...chunk, match: 'lexical' as const }))
  if (!semanticEnabled(settings)) return lexical.slice(0, limit)
  let semantic: RetrievedChunk[] | null = null
  try {
    semantic = await withBudget(
      semanticSearch(note, options.semanticQuery ?? query, settings, {
        limit: 6,
        signal: options.signal,
      }),
      options.budgetMs ?? 900
    )
  } catch (error) {
    if (options.signal?.aborted) throw error
    semantic = null
  }
  if (!semantic?.length) return lexical.slice(0, limit)
  return fuseRetrieval(lexical, semantic, limit)
}

function sentences(text: string): string[] {
  const parts =
    typeof Intl.Segmenter === 'undefined'
      ? text.split(/(?<=[.!?。！？])\s+/u)
      : [
          ...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(
            text
          ),
        ].map(part => part.segment)
  return parts
    .flatMap(part => part.split(/\n+/u))
    .map(part =>
      part.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/u, '').trim()
    )
    .filter(part => part.length >= 12 && part.length <= 280)
}

/**
 * Next-line recall: when the cursor starts a new sentence or line, propose
 * sentences from the most related passages that the note does not contain yet.
 */
export async function semanticNextLines(
  note: Note,
  context: CursorContext,
  settings: NotebookSettings,
  signal?: AbortSignal,
  budgetMs = 700
): Promise<{ text: string; source: string }[]> {
  if (!semanticEnabled(settings) || !context.selectionEmpty || context.inCode)
    return []
  const before = context.text.slice(
    Math.max(0, context.cursor - 1_200),
    context.cursor
  )
  if (
    !/(?:^|[.!?。！？]["”’)\]]*[\t ]+|\n[\t ]*)$/u.test(before) &&
    before.trim()
  )
    return []
  const paragraph =
    before
      .split(/\n[\t ]*\n/u)
      .at(-1)
      ?.trim() ?? ''
  const query = [note.objective.slice(0, 300), paragraph.slice(-600)]
    .filter(Boolean)
    .join('\n')
  if (query.trim().length < 8) return []
  let hits: RetrievedChunk[] | null
  try {
    hits = await withBudget(
      semanticSearch(note, query, settings, { limit: 3, signal }),
      budgetMs
    )
  } catch (error) {
    if (signal?.aborted) throw error
    return []
  }
  if (!hits?.length) return []
  const written = context.text.replace(/\s+/gu, ' ').toLowerCase()
  const queryTerms = new Set(tokenize(paragraph))
  const results: { text: string; source: string; score: number }[] = []
  hits.forEach((hit, rank) => {
    if (hit.mediaKind) return
    for (const sentence of sentences(hit.text)) {
      const normalized = sentence.replace(/\s+/gu, ' ').toLowerCase()
      if (written.includes(normalized.slice(0, 80))) continue
      const terms = tokenize(sentence)
      const overlap = terms.filter(term => queryTerms.has(term)).length
      // Prefer sentences that share terms with the paragraph, then rank order.
      results.push({
        text: sentence,
        source: hit.sourceName,
        score: overlap / Math.max(4, terms.length) + (3 - rank) * 0.05,
      })
    }
  })
  results.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  return results
    .filter(item => {
      const key = item.text.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 2)
    .map(({ text, source }) => ({ text, source }))
}

export function resetSemanticRetrievalForTests() {
  for (const index of indexes.values()) index.controller?.abort()
  indexes.clear()
  queryCache.clear()
  listeners.clear()
  status = { state: 'off', indexed: 0, total: 0 }
  statusNoteId = null
}
