/**
 * Opt-in checks against a real EmbeddingGemma 2 llama.cpp server.
 *
 *   TYPENEXT_EMBEDDING_URL=http://127.0.0.1:8080 \
 *   TYPENEXT_MEDIA_DIR=/path/with/shot.jpg,speech.wav,clip.mp4 \
 *   npx vitest run src/services/semantic-live.test.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkEmbeddingServer,
  dot,
  embedMedia,
  resetEmbeddingClientForTests,
  embedTexts,
  queryPrompt,
} from './embedding-client'
import {
  getSemanticIndexStatus,
  prepareSemanticIndex,
  resetSemanticRetrievalForTests,
  retrieveHybrid,
  semanticNextLines,
} from './semantic-retrieval'
import { resetVectorStoreForTests } from './vector-store'
import { defaultSettings } from '../notebook/model'
import type { Note, NotebookSettings } from '../types/notebook'

const url = process.env.TYPENEXT_EMBEDDING_URL
const mediaDir = process.env.TYPENEXT_MEDIA_DIR
const live = url ? describe : describe.skip
const endpoint = { endpoint: url ?? '', media: true }

function settings(): NotebookSettings {
  const base = defaultSettings()
  return {
    ...base,
    semantic: {
      ...base.semantic,
      enabled: true,
      runtime: 'server',
      endpoint: url ?? '',
      dimensions: 512,
      media: true,
    },
  }
}

const SOURCES = [
  [
    'House guide',
    'Guests arrive at Bramble House on Friday from 4 pm. The key box code is 2719. Parking is behind the barn.',
  ],
  [
    'Weekend plan',
    'Saturday starts with a walk to the old mill at 9. Lunch is a picnic by the river. Evening: a long table supper.',
  ],
  [
    'Kitchen notes',
    'The stove needs a minute to warm. Fresh eggs come from the farm shop down the lane.',
  ],
  [
    'Unrelated',
    'Quarterly revenue grew eleven percent on strong subscription renewals.',
  ],
] as const

function note(content = ''): Note {
  return {
    id: 'live-note',
    title: 'Retreat welcome letter',
    objective: 'Welcome guests to the weekend retreat',
    context: '',
    content,
    sources: SOURCES.map(([name, text], index) => ({
      id: `s${index}`,
      name,
      kind: 'text',
      text,
      enabled: true,
      addedAt: 0,
    })),
    createdAt: 0,
    updatedAt: 0,
  }
}

live('EmbeddingGemma 2 server (live)', () => {
  beforeEach(() => {
    resetEmbeddingClientForTests()
    resetSemanticRetrievalForTests()
    resetVectorStoreForTests()
  })

  it('reports all modalities and embeds quickly', async () => {
    const info = await checkEmbeddingServer(endpoint)
    expect(info.modalities.vision).toBe(true)
    expect(info.latencyMs).toBeLessThan(5_000)
  })

  it('ranks paraphrases above unrelated passages at every Matryoshka width', async () => {
    for (const dimensions of [128, 256, 512, 768] as const) {
      const [query, related, unrelated] = await embedTexts(
        endpoint,
        [
          queryPrompt('When can visitors check in?'),
          `title: House guide | text: ${SOURCES[0][1]}`,
          `title: Unrelated | text: ${SOURCES[3][1]}`,
        ],
        dimensions
      )
      expect(dot(query!, related!)).toBeGreaterThan(
        dot(query!, unrelated!) + 0.05
      )
    }
  })

  it('retrieves by meaning when the words differ', async () => {
    const current = note()
    await prepareSemanticIndex(current, settings())
    await expect
      .poll(() => getSemanticIndexStatus().state, { timeout: 30_000 })
      .toBe('ready')
    const results = await retrieveHybrid(
      current,
      'what time can people show up and where do they leave the car',
      settings(),
      { budgetMs: 10_000 }
    )
    expect(results[0]?.sourceName).toBe('House guide')
    expect(results.some(result => result.match !== 'lexical')).toBe(true)
    expect(results.map(result => result.sourceName)).not.toContain('Unrelated')
  })

  it('proposes a relevant next line at a sentence boundary', async () => {
    const writing =
      'Dear friends, we are so glad you are coming to the retreat. '
    const current = note(writing)
    await prepareSemanticIndex(current, settings())
    await expect
      .poll(() => getSemanticIndexStatus().state, { timeout: 30_000 })
      .toBe('ready')
    const lines = await semanticNextLines(
      current,
      { text: writing, cursor: writing.length, selectionEmpty: true },
      settings(),
      undefined,
      10_000
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.source).not.toBe('Unrelated')
  })

  const media =
    mediaDir && existsSync(path.join(mediaDir, 'shot.jpg')) ? it : it.skip
  media(
    'matches an image, a spoken clip and a video to text queries',
    async () => {
      const read = (name: string) =>
        readFileSync(path.join(mediaDir!, name)).toString('base64')
      const [query, unrelated] = await embedTexts(
        endpoint,
        [
          queryPrompt('When do guests arrive at Bramble House?'),
          queryPrompt('stock market prices fell today'),
        ],
        768
      )
      for (const [kind, file] of [
        ['image', 'shot.jpg'],
        ['audio', 'speech.wav'],
        ['video', 'clip.mp4'],
      ] as const) {
        const vector = await embedMedia(endpoint, { kind, base64: read(file) })
        expect(
          dot(vector, query!),
          `${kind} should match the arrival question`
        ).toBeGreaterThan(dot(vector, unrelated!) + 0.1)
      }
    },
    120_000
  )
})
