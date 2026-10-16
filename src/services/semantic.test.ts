import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkEmbeddingServer,
  decodeVector,
  documentPrompt,
  dot,
  embedMedia,
  embedTexts,
  encodeVector,
  queryPrompt,
  resetEmbeddingClientForTests,
  truncateVector,
} from './embedding-client'
import {
  fuseRetrieval,
  getSemanticIndexStatus,
  focusSemanticStatus,
  prepareSemanticIndex,
  rankSemantic,
  resetSemanticRetrievalForTests,
  retrieveHybrid,
  semanticNextLines,
  semanticSearch,
} from './semantic-retrieval'
import { resetVectorStoreForTests, textHash } from './vector-store'
import { defaultSettings } from '../notebook/model'
import type { Note, NotebookSettings, RetrievedChunk } from '../types/notebook'

vi.mock('./native', () => ({
  isDesktop: () => false,
  getSecret: vi.fn(async () => ''),
  requestJson: vi.fn(),
  requestText: vi.fn(),
}))

const ENDPOINT = { endpoint: 'http://127.0.0.1:8080', media: true }

/** A deterministic bag-of-concepts vector, so related texts have close vectors. */
const CONCEPTS: [RegExp, number][] = [
  [/guest|arriv|check-in|visitor/iu, 0],
  [/bramble|house|retreat|lodge/iu, 1],
  [/cat|mat|kitten/iu, 2],
  [/stock|market|price/iu, 3],
  [/garden|rose|soil/iu, 4],
  [/friday|afternoon|4pm|weekend/iu, 5],
]
function conceptVector(text: string): number[] {
  const vector: number[] = Array.from({ length: 768 }, (_, index) =>
    index === 100 ? 0.15 : 0
  )
  for (const [pattern, index] of CONCEPTS)
    if (pattern.test(text)) vector[index] = 1
  return vector
}

let fetchCalls: { url: string; body: unknown }[] = []
function mockServer(options: { fail?: boolean; delayMs?: number } = {}) {
  fetchCalls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      fetchCalls.push({ url, body })
      if (options.delayMs)
        await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (options.fail) throw new TypeError('connection refused')
      if (url.endsWith('/props'))
        return new Response(
          JSON.stringify({
            media_marker: '<__media_test__>',
            modalities: { vision: true, audio: true, video: true },
            build_info: 'b11696',
          })
        )
      if (url.endsWith('/v1/embeddings')) {
        const input = (body as { input: string[] }).input
        return new Response(
          JSON.stringify({
            data: input.map((text, index) => ({
              index,
              embedding: conceptVector(text),
            })),
          })
        )
      }
      if (url.endsWith('/embeddings'))
        return new Response(
          JSON.stringify([
            {
              index: 0,
              embedding: [conceptVector('a photo of bramble house guests')],
            },
          ])
        )
      return new Response('{}', { status: 404 })
    })
  )
}

function settings(
  patch: Partial<NotebookSettings['semantic']> = {}
): NotebookSettings {
  const base = defaultSettings()
  return {
    ...base,
    semantic: {
      ...base.semantic,
      enabled: true,
      runtime: 'server',
      endpoint: 'http://127.0.0.1:8080',
      dimensions: 256,
      ...patch,
    },
  }
}

function note(sources: { name: string; text: string }[], content = ''): Note {
  return {
    id: 'note-1',
    title: 'Retreat',
    objective: '',
    context: '',
    content,
    sources: sources.map((source, index) => ({
      id: `s${index}`,
      name: source.name,
      kind: 'text',
      text: source.text,
      enabled: true,
      addedAt: 0,
    })),
    createdAt: 0,
    updatedAt: 0,
  }
}

beforeEach(() => {
  resetEmbeddingClientForTests()
  resetSemanticRetrievalForTests()
  resetVectorStoreForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('embedding client', () => {
  it('uses EmbeddingGemma task prefixes', () => {
    expect(queryPrompt('  when do\nguests arrive ')).toBe(
      'task: search result | query: when do guests arrive'
    )
    expect(documentPrompt('Plan | v2', 'Text')).toBe(
      'title: Plan v2 | text: Text'
    )
    expect(documentPrompt('', 'Text')).toBe('title: none | text: Text')
  })

  it('truncates Matryoshka vectors and re-normalizes them', () => {
    const vector = truncateVector([3, 4, 12, 99], 2)
    expect(Array.from(vector)).toEqual([0.6000000238418579, 0.800000011920929])
    expect(() => truncateVector([0, 0], 2)).toThrow(/invalid vector/u)
  })

  it('round-trips vectors through base64', () => {
    const vector = truncateVector(conceptVector('guest bramble'), 768)
    const decoded = decodeVector(encodeVector(vector))
    expect(decoded.length).toBe(768)
    expect(dot(decoded, vector)).toBeCloseTo(1, 5)
  })

  it('batches text requests at 16 inputs and keeps order', async () => {
    mockServer()
    const prompts = Array.from(
      { length: 35 },
      (_, index) => `title: none | text: ${index % 2 ? 'cat' : 'stock'}`
    )
    const vectors = await embedTexts(ENDPOINT, prompts, 128)
    expect(vectors).toHaveLength(35)
    expect(
      fetchCalls.filter(call => call.url.endsWith('/v1/embeddings'))
    ).toHaveLength(3)
    expect(vectors[1]![2]).toBeGreaterThan(0.9)
    expect(vectors[0]![3]).toBeGreaterThan(0.9)
  })

  it('rejects vectors of the wrong width', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] })
          )
      )
    )
    await expect(embedTexts(ENDPOINT, ['x'], 128)).rejects.toThrow(
      /unexpected vector/u
    )
  })

  it('reports an unreachable server in plain words', async () => {
    mockServer({ fail: true })
    await expect(embedTexts(ENDPOINT, ['x'], 128)).rejects.toThrow(
      /could not reach the embedding server/u
    )
  })

  it('sends media with the server marker and an API key', async () => {
    mockServer()
    const vector = await embedMedia(
      { ...ENDPOINT, apiKey: 'secret' },
      { kind: 'image', base64: 'AAAA' }
    )
    expect(vector.length).toBe(768)
    const call = fetchCalls.find(
      item => item.url.endsWith('/embeddings') && !item.url.includes('/v1/')
    )!
    expect(call.body).toEqual({
      content: { prompt_string: '<__media_test__>', multimodal_data: ['AAAA'] },
    })
    const init = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url]) =>
          String(url).endsWith('/embeddings') && !String(url).includes('/v1/')
      )![1]!
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret'
    )
  })

  it('refuses media when the server has no encoder for it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              modalities: { vision: false, audio: false, video: false },
            })
          )
      )
    )
    await expect(
      embedMedia(ENDPOINT, { kind: 'audio', base64: 'AAAA' })
    ).rejects.toThrow(/cannot read audio/u)
  })

  it('checks a connection and reports modalities', async () => {
    mockServer()
    const result = await checkEmbeddingServer(ENDPOINT)
    expect(result.modalities).toEqual({
      vision: true,
      audio: true,
      video: true,
    })
    expect(result.build).toBe('b11696')
  })

  it('lets interactive queries run before queued background indexing', async () => {
    mockServer({ delayMs: 5 })
    const order: string[] = []
    const background = embedTexts(
      ENDPOINT,
      Array.from({ length: 48 }, () => 'title: none | text: cat'),
      128,
      { priority: 'background' }
    ).then(() => order.push('background'))
    const query = embedTexts(
      ENDPOINT,
      ['task: search result | query: cat'],
      128
    ).then(() => order.push('query'))
    await Promise.all([background, query])
    expect(order).toEqual(['query', 'background'])
  })
})

describe('semantic ranking and fusion', () => {
  const vector = (values: number[]) =>
    truncateVector([...values, ...Array(768 - values.length).fill(0)], 768)

  it('drops unrelated hits and diversifies near duplicates', () => {
    const query = vector([1, 0, 0])
    const chunks = [
      { vector: vector([1, 0.05, 0]) },
      { vector: vector([1, 0.06, 0]) },
      { vector: vector([1, 0.48, 0]) },
      { vector: vector([0, 0, 1]) },
    ]
    const ranked = rankSemantic(query, chunks, 3, 0.3)
    expect(ranked.map(item => item.index)).not.toContain(3)
    expect(ranked[0]!.index).toBe(0)
    // MMR prefers the different direction over the near duplicate.
    expect(ranked[1]!.index).toBe(2)
  })

  it('fuses lexical and semantic hits and labels both', () => {
    const chunk = (sourceId: string, text: string): RetrievedChunk => ({
      sourceId,
      sourceName: sourceId,
      text,
      score: 1,
    })
    const shared =
      'Guests arrive at Bramble House on Friday afternoon, after the long drive through the hills and the village of Elm.'
    const fused = fuseRetrieval(
      [chunk('a', shared), chunk('b', 'Lexical only passage about prices')],
      [
        chunk('a', `Intro. ${shared} More text follows here.`),
        chunk('c', 'Semantic only passage about visitors'),
      ],
      4
    )
    expect(fused[0]).toMatchObject({ sourceId: 'a', match: 'hybrid' })
    expect(fused.map(item => item.match)).toEqual([
      'hybrid',
      'semantic',
      'lexical',
    ])
  })

  it('caps passages per source and total characters', () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      sourceId: 'a',
      sourceName: 'a',
      text: `${index} ${'x'.repeat(2_000)}`,
      score: 1,
    }))
    const fused = fuseRetrieval(many, [], 6, 3_000)
    expect(fused).toHaveLength(2)
    expect(
      fused.reduce((total, item) => total + item.text.length, 0)
    ).toBeLessThanOrEqual(3_000)
  })
})

describe('hybrid retrieval', () => {
  const sources = [
    {
      name: 'Arrival',
      text: 'Check-in opens late on the first day. Visitors collect keys from the lodge office.',
    },
    { name: 'Pets', text: 'The kitten sleeps on the mat by the stove.' },
    { name: 'Finance', text: 'Stock prices moved sharply this quarter.' },
  ]

  it('returns BM25 results alone when semantic search is off', async () => {
    const base = defaultSettings()
    const results = await retrieveHybrid(note(sources), 'kitten stove', base)
    expect(results[0]).toMatchObject({ sourceName: 'Pets', match: 'lexical' })
  })

  it('finds passages by meaning that share no words with the query', async () => {
    mockServer()
    const current = note(sources)
    await prepareSemanticIndex(current, settings())
    await vi.waitFor(() =>
      expect(getSemanticIndexStatus()).toMatchObject({
        state: 'ready',
        indexed: 3,
        total: 3,
      })
    )
    const results = await semanticSearch(
      current,
      'When do guests arrive?',
      settings()
    )
    expect(results[0]).toMatchObject({
      sourceName: 'Arrival',
      match: 'semantic',
    })
    expect(results.map(result => result.sourceName)).not.toContain('Finance')
    const hybrid = await retrieveHybrid(
      current,
      'When do guests arrive?',
      settings(),
      { budgetMs: 2_000 }
    )
    expect(hybrid[0]?.sourceName).toBe('Arrival')
  })

  it('reuses cached vectors instead of embedding unchanged passages again', async () => {
    mockServer()
    const current = note(sources)
    await prepareSemanticIndex(current, settings())
    await vi.waitFor(() => expect(getSemanticIndexStatus().state).toBe('ready'))
    const first = fetchCalls.filter(call =>
      call.url.endsWith('/v1/embeddings')
    ).length
    resetSemanticRetrievalForTests()
    await prepareSemanticIndex(
      { ...current, content: 'edited writing' },
      settings()
    )
    await vi.waitFor(() => expect(getSemanticIndexStatus().state).toBe('ready'))
    expect(
      fetchCalls.filter(call => call.url.endsWith('/v1/embeddings')).length
    ).toBe(first)
  })

  it('keeps suggestions fast when the embedding server is slow', async () => {
    mockServer({ delayMs: 400 })
    const started = performance.now()
    const results = await retrieveHybrid(note(sources), 'kitten', settings(), {
      budgetMs: 50,
    })
    expect(performance.now() - started).toBeLessThan(300)
    expect(results[0]).toMatchObject({ sourceName: 'Pets', match: 'lexical' })
  })

  it('falls back to BM25 when the server is down', async () => {
    mockServer({ fail: true })
    const results = await retrieveHybrid(note(sources), 'kitten', settings(), {
      budgetMs: 500,
    })
    expect(results[0]?.sourceName).toBe('Pets')
  })

  it('reports an unavailable index with the reason', async () => {
    focusSemanticStatus('note-1')
    await prepareSemanticIndex(
      note(sources),
      settings({ runtime: 'server', endpoint: 'https://example.com' })
    )
    expect(getSemanticIndexStatus()).toMatchObject({
      state: 'unavailable',
      error: expect.stringMatching(/localhost/u),
    })
  })

  it('indexes media vectors with their captions', async () => {
    mockServer()
    const mediaVector = encodeVector(
      truncateVector(
        conceptVector('photo of guests arriving at the lodge'),
        768
      )
    )
    const current: Note = {
      ...note([]),
      sources: [
        {
          id: 'img',
          name: 'arrival.jpg',
          kind: 'image',
          text: 'Front porch',
          enabled: true,
          addedAt: 0,
          media: { mime: 'image/jpeg', bytes: 10, vector: mediaVector },
        },
      ],
    }
    await prepareSemanticIndex(current, settings())
    await vi.waitFor(() => expect(getSemanticIndexStatus().state).toBe('ready'))
    const results = await semanticSearch(current, 'guest arrival', settings())
    expect(results[0]).toMatchObject({
      sourceName: 'arrival.jpg',
      mediaKind: 'image',
    })
    expect(results[0]!.text).toMatch(/^Image “arrival.jpg”/u)
  })

  it('suggests a next line from related passages, skipping text already written', async () => {
    mockServer()
    const writing =
      'Our retreat starts soon. Visitors collect keys from the lodge office. '
    const current = note(sources, writing)
    await prepareSemanticIndex(current, settings())
    await vi.waitFor(() => expect(getSemanticIndexStatus().state).toBe('ready'))
    const lines = await semanticNextLines(
      current,
      { text: writing, cursor: writing.length, selectionEmpty: true },
      settings(),
      undefined,
      2_000
    )
    expect(lines[0]).toEqual({
      text: 'Check-in opens late on the first day.',
      source: 'Arrival',
    })
    expect(lines.map(line => line.text)).not.toContain(
      'Visitors collect keys from the lodge office.'
    )
  })

  it('does not offer next lines in the middle of a sentence', async () => {
    mockServer()
    const writing = 'Guests arrive at the'
    const lines = await semanticNextLines(
      note(sources, writing),
      { text: writing, cursor: writing.length, selectionEmpty: true },
      settings()
    )
    expect(lines).toEqual([])
  })

  it('hashes text stably', () => {
    expect(textHash('abc')).toBe(textHash('abc'))
    expect(textHash('abc')).not.toBe(textHash('abd'))
  })
})
