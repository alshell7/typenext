/**
 * Opt-in quality checks with real providers. Keys come from the environment
 * and are kept in this test process only.
 *
 *   set -a; . ./.env; set +a
 *   TYPENEXT_LIVE_SUGGEST=1 [TYPENEXT_EMBEDDING_URL=http://127.0.0.1:8080] \
 *     npx vitest run src/services/suggest-live.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { setSecret } from './native'
import { suggest } from './completion'
import { searchWebFacts } from './web-facts'
import {
  getSemanticIndexStatus,
  prepareSemanticIndex,
} from './semantic-retrieval'
import { defaultSettings } from '../notebook/model'
import { MODEL_CATALOG } from '../notebook/provider-catalog'
import type {
  CursorContext,
  Note,
  NotebookSettings,
  ProviderId,
} from '../types/notebook'

const enabled = process.env.TYPENEXT_LIVE_SUGGEST === '1'
const openAiKey =
  process.env.OPEN_AI_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
const openRouterKey = process.env.OPENROUTER_API_KEY ?? ''
const embeddingUrl = process.env.TYPENEXT_EMBEDDING_URL ?? ''

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

function note(content: string): Note {
  return {
    id: `live-${content.length}`,
    title: 'Welcome letter for the retreat',
    objective: 'Tell guests the practical details of the weekend',
    context: 'Warm, brief, practical.',
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

function at(
  text: string,
  marker = '‸'
): { text: string; context: CursorContext } {
  const cursor = text.indexOf(marker)
  const clean = text.replace(marker, '')
  return { text: clean, context: { text: clean, cursor, selectionEmpty: true } }
}

function settings(
  provider: ProviderId,
  model: string,
  semantic = false
): NotebookSettings {
  const base = defaultSettings()
  return {
    ...base,
    provider,
    externalAutoEnabled: true,
    temperature: 0.2,
    profiles: {
      ...base.profiles,
      [provider]: { ...base.profiles[provider], model },
    },
    semantic: {
      ...base.semantic,
      enabled: semantic,
      runtime: 'server',
      endpoint: embeddingUrl,
      dimensions: 512,
    },
  }
}

const providers: [ProviderId, string, string][] = [
  ...(openAiKey
    ? ([['openai', 'gpt-5.4-mini', openAiKey]] as [
        ProviderId,
        string,
        string,
      ][])
    : []),
  ...(openRouterKey
    ? ([['openrouter', 'openrouter/free', openRouterKey]] as [
        ProviderId,
        string,
        string,
      ][])
    : []),
]

const live = enabled && providers.length ? describe : describe.skip

live('suggestions with real models (live)', () => {
  beforeAll(async () => {
    for (const [provider, , key] of providers)
      await setSecret(`provider:${provider}`, key)
  })

  for (const [provider, model] of providers) {
    describe(`${provider} · ${model}`, () => {
      it('completes a fact from an attached reference and keeps the text after the cursor', async () => {
        const { text, context } = at(
          'The key box code is‸ and parking is behind the barn.'
        )
        const result = await suggest(
          note(text),
          context,
          settings(provider, model)
        )
        expect(result.text).toMatch(/2719/u)
        expect(result.text).not.toMatch(/parking is behind the barn/iu)
      }, 90_000)

      it('fills a word fragment without repeating it', async () => {
        const { text, context } = at(
          'On Saturday we walk to the old m‸ at nine.'
        )
        const result = await suggest(
          note(text),
          context,
          settings(provider, model)
        )
        expect(result.text.trim().toLowerCase()).toMatch(/^ill/u)
      }, 90_000)

      it('returns three distinct fresh choices in one request', async () => {
        const { text, context } = at(
          'Dear friends,\n\nWe are so glad you are joining us. ‸'
        )
        const result = await suggest(
          note(text),
          context,
          settings(provider, model),
          undefined,
          { purpose: 'alternatives' }
        )
        const choices = [result, ...(result.alternatives ?? [])].map(choice =>
          choice.text.trim()
        )
        expect(new Set(choices).size).toBe(choices.length)
        expect(choices.length).toBeGreaterThanOrEqual(2)
      }, 90_000)

      const semantic = embeddingUrl ? it : it.skip
      semantic(
        'uses meaning-based retrieval when the wording differs from the source',
        async () => {
          const writing = at(
            'When can people show up, and where do they leave the car? You can‸'
          )
          const current = note(writing.text)
          const config = settings(provider, model, true)
          await prepareSemanticIndex(current, config)
          await expect
            .poll(() => getSemanticIndexStatus().state, { timeout: 30_000 })
            .toBe('ready')
          const result = await suggest(current, writing.context, config)
          expect(result.text).toMatch(/4|four|Friday|barn/iu)
          expect(result.sources).toContain('House guide')
          expect(result.sources).not.toContain('Unrelated')
        },
        90_000
      )
    })
  }

  const facts = openAiKey ? it : it.skip
  facts(
    'pulls cited facts from the web for a selection',
    async () => {
      const result = await searchWebFacts(
        {
          selection: 'The James Webb Space Telescope launched',
          beforeCursor: 'The James Webb Space Telescope launched',
          afterCursor: '',
          noteTitle: 'Space notes',
          objective: '',
        },
        { enabled: true, model: 'gpt-5.4-mini', withSuggestions: false }
      )
      expect(result.length).toBeGreaterThan(0)
      expect(result.map(fact => fact.text).join(' ')).toMatch(/2021/u)
      expect(result[0]?.citations?.[0]?.url).toMatch(/^https:\/\//u)
      expect(result[0]?.text.startsWith(' ')).toBe(true)
    },
    120_000
  )

  const catalog = openAiKey ? it : it.skip
  catalog(
    'every shipped OpenAI model returns a usable continuation',
    async () => {
      const failures: string[] = []
      for (const model of MODEL_CATALOG.openai ?? []) {
        const { text, context } = at(
          'The key box code is‸ and parking is behind the barn.'
        )
        try {
          const result = await suggest(
            { ...note(text), id: `catalog-${model.id}` },
            context,
            settings('openai', model.id)
          )
          if (!/2719/u.test(result.text))
            failures.push(`${model.id}: ${JSON.stringify(result.text)}`)
        } catch (error) {
          failures.push(
            `${model.id}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      expect(failures).toEqual([])
    },
    300_000
  )
})
