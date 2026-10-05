import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ContextPackage,
  ContextSource,
  Note,
  NotebookSettings,
  ProviderId,
  SuggestionRequestOptions,
} from '../types/notebook'
import { defaultSettings, emptyWorkspace, newNote } from '../notebook/model'
import {
  addDemoWorkspace,
  DEMO_NOTE_ID,
  DEMO_PACKAGE_IDS,
  DEMO_STARTER,
} from '../notebook/demo'
import { linkNoteSource, resolveNoteContext } from '../notebook/note-context'
import { retrieveContext } from './retrieval'
import { suggest } from './completion'
import { getSecret, requestJson } from './native'
import {
  generateBuiltinInsertion,
  getBuiltinState,
  loadBuiltinModel,
} from './builtin-engine'
import {
  boundBuiltinPrompt,
  prepareBuiltinInput,
  type BuiltinPrompt,
} from './builtin-model'

// Resolution, BM25, completion routing and the built-in prompt helpers are real.
// Only the inference/native transport boundaries are mocked. These tests prove
// which excerpts reach a model request, not that a model obeys those excerpts.
vi.mock('./native', () => ({ getSecret: vi.fn(), requestJson: vi.fn() }))
vi.mock('./builtin-engine', () => ({
  generateBuiltinInsertion: vi.fn(),
  getBuiltinState: vi.fn(),
  loadBuiltinModel: vi.fn(),
}))

const engines = [
  'embedded',
  'local chat',
  'local FIM',
  'openai',
  'openrouter',
  'anthropic',
  'custom',
] as const
type Engine = (typeof engines)[number]
type Reference = { name: string; text: string }
interface Fixture {
  draft: Note
  linked: Note
  notes: Note[]
  library: ContextSource[]
  packages: ContextPackage[]
}
interface ProviderPayload {
  model?: string
  messages?: { role: string; content: string }[]
  system?: string
  input_prefix?: string
  input_suffix?: string
  input_extra?: { filename: string; text: string }[]
  n?: number
  response_format?: unknown
}
interface WriterPayload {
  references: Reference[]
  beforeCursor: string
  afterCursor: string
}

const snippets = {
  rain: 'Garden rainfall fills the rain barrel overnight. RAIN_MEASUREMENT: the barrel holds forty litres.',
  soil: 'Garden soil keeps rainfall near the roots. SOIL_OBSERVATION: porous soil drains without standing water.',
  seeds:
    'Garden seeds need moist soil after rainfall. SEED_TIMING: soak the seeds before sowing.',
  light:
    'Garden sunlight warms the soil beside young seeds. LIGHT_OBSERVATION: this bed receives six hours of sunlight.',
  linked:
    'Garden rainfall observation details. LIVE_OBSERVATION_OLD: the rain gauge collected twelve millimetres.',
  edited:
    'Garden rainfall observation details. LIVE_OBSERVATION_NEW: the rain gauge collected nineteen millimetres.',
  unrelated:
    'UNRELATED_ARCHIVE: the violin recital uses two movements and a brass finale.',
  disabled:
    'Garden rainfall soil seeds sunlight. DISABLED_PRIVATE_TEXT: never send this attached but disabled reference.',
  unattached:
    'Garden rainfall garden soil garden seeds garden sunlight. UNATTACHED_PRIVATE_TEXT: never index the entire library.',
} as const
const plainInsertion = ' a patient routine possible.'
const optionInsertions = [
  plainInsertion,
  ' a steadier rhythm possible.',
  ' room for slow changes.',
]

function source(id: string, text: string, name = `${id}.md`): ContextSource {
  return {
    id,
    name,
    text,
    kind: 'markdown',
    enabled: true,
    addedAt: 0,
  }
}
function contextPackage(id: string, sourceIds: string[]): ContextPackage {
  return { id, name: id, sourceIds, createdAt: 0, updatedAt: 0 }
}
function fixture(): Fixture {
  const draft = newNote(
    'Garden field notes',
    'Use the garden measurements and observation notes.',
    'Garden rainfall, soil, seeds and sunlight make'
  )
  draft.objective = 'Explain garden rainfall, soil, seeds and sunlight.'
  draft.contextPackageIds = ['measurements', 'observations']
  // A note-level toggle is authoritative. Attaching a package enables its files;
  // this disabled reference is deliberately separate from package membership.
  draft.sources = [
    {
      ...source('disabled-reference', ''),
      libraryId: 'disabled',
      enabled: false,
    },
  ]
  const linked = newNote('Rain gauge log', '', snippets.linked)
  const liveSource = {
    ...linkNoteSource(linked),
    text: 'STALE_LIBRARY_SNAPSHOT: do not use cached linked-note text.',
  }
  return {
    draft,
    linked,
    notes: [draft, linked],
    library: [
      source('rain', snippets.rain),
      source('soil', snippets.soil),
      source('seeds', snippets.seeds),
      source('light', snippets.light),
      source('unrelated', snippets.unrelated),
      source('disabled', snippets.disabled),
      source('unattached', snippets.unattached),
      liveSource,
    ],
    packages: [
      contextPackage('measurements', ['rain', 'soil', 'unrelated']),
      contextPackage('observations', ['rain', 'seeds', 'light', liveSource.id]),
      contextPackage('not-attached', ['unattached']),
    ],
  }
}
function resolve(data: Fixture): Note {
  return resolveNoteContext(data.draft, data.notes, data.library, data.packages)
}
function query(draft: Note): string {
  return `${draft.content.slice(-900)}  ${draft.objective.slice(0, 800)} ${draft.context.slice(0, 400)} ${draft.title.slice(0, 160)}`
}
function cursorQuery(draft: Note): string {
  return `${draft.content.slice(draft.content.lastIndexOf('\n') + 1).slice(-250)} `
}
function config(engine: Engine): NotebookSettings {
  const settings = defaultSettings()
  settings.localEngine = engine === 'embedded' ? 'embedded' : 'server'
  settings.profiles.local.model = 'synthetic-local-writer'
  settings.profiles.local.protocol = engine === 'local FIM' ? 'fim' : 'chat'
  settings.profiles.custom.endpoint = 'https://custom.example/v1'
  for (const provider of [
    'openai',
    'openrouter',
    'anthropic',
    'custom',
  ] as const)
    settings.profiles[provider].model = 'synthetic-external-writer'
  const provider: ProviderId =
    engine === 'embedded' || engine.startsWith('local')
      ? 'local'
      : (engine as ProviderId)
  settings.provider = provider
  settings.externalAutoEnabled = provider !== 'local'
  return settings
}
function callCount(engine: Engine): number {
  return engine === 'embedded'
    ? vi.mocked(generateBuiltinInsertion).mock.calls.length
    : vi.mocked(requestJson).mock.calls.length
}
function outgoing(engine: Engine): WriterPayload {
  if (engine === 'embedded') {
    const prompt = vi.mocked(generateBuiltinInsertion).mock.calls.at(-1)?.[0]
    if (!prompt) throw new Error('No built-in inference request was captured.')
    return prompt
  }
  const body = vi.mocked(requestJson).mock.calls.at(-1)?.[1]
    ?.body as ProviderPayload
  if (engine === 'local FIM') {
    return {
      beforeCursor: body.input_prefix ?? '',
      afterCursor: body.input_suffix ?? '',
      references: (body.input_extra ?? []).slice(1).map(item => ({
        name: item.filename,
        text: item.text.replace(/^Quoted reference material:\n/u, ''),
      })),
    }
  }
  return JSON.parse(
    body.messages?.find(message => message.role === 'user')?.content ?? '{}'
  ) as WriterPayload
}
async function request(
  engine: Engine,
  data: Fixture,
  options?: SuggestionRequestOptions
) {
  const draft = resolve(data)
  return suggest(
    draft,
    { text: draft.content, cursor: draft.content.length, selectionEmpty: true },
    config(engine),
    undefined,
    options
  )
}
function expectPrivateExclusions(references: Reference[]) {
  const text = JSON.stringify(references)
  for (const marker of [
    'UNRELATED_ARCHIVE',
    'DISABLED_PRIVATE_TEXT',
    'UNATTACHED_PRIVATE_TEXT',
    'STALE_LIBRARY_SNAPSHOT',
  ])
    expect(text).not.toContain(marker)
}
function serializeBuiltin(
  messages: ReturnType<typeof import('./builtin-model').builtinMessages>
) {
  return (
    messages.map(message => `${message.role}:\n${message.content}`).join('\n') +
    '\nassistant:\n'
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSecret).mockResolvedValue('synthetic-test-key-only')
  vi.mocked(getBuiltinState).mockReturnValue({
    status: 'ready',
    cached: true,
    progress: 100,
    downloadedBytes: 1,
    totalBytes: 1,
    backend: 'wasm',
    identity: 'synthetic-retrieval-worker',
  })
  vi.mocked(loadBuiltinModel).mockResolvedValue(undefined)
  vi.mocked(generateBuiltinInsertion).mockResolvedValue(plainInsertion)
  vi.mocked(requestJson).mockImplementation(async (url, options) => {
    const body = options?.body as ProviderPayload
    if (url.endsWith('/infill')) return { content: plainInsertion }
    const system =
      body.system ??
      body.messages?.find(message => message.role === 'system')?.content ??
      ''
    const text = system.includes('"insertions"')
      ? JSON.stringify({ insertions: optionInsertions })
      : plainInsertion
    return url.endsWith('/messages')
      ? { content: [{ type: 'text', text }] }
      : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
  })
})

describe('actual context resolution and BM25 to inference', () => {
  it('resolves multiple packages once, ranks matching passages, and excludes disabled or unattached material', () => {
    const data = fixture()
    const draft = resolve(data)
    expect(
      draft.sources.filter(item => item.libraryId === 'rain')
    ).toHaveLength(1)
    expect(
      draft.sources.find(item => item.libraryId === 'disabled')?.enabled
    ).toBe(false)
    expect(draft.sources.some(item => item.libraryId === 'unattached')).toBe(
      false
    )
    const live = draft.sources.find(
      item => item.linkedNoteId === data.linked.id
    )
    expect(live?.text).toBe(data.linked.content)
    const ranked = retrieveContext(draft, query(draft), 8)
    expect(ranked).toHaveLength(5)
    expect(ranked.every(item => item.score > 0)).toBe(true)
    expect(ranked.map(item => item.sourceId)).toEqual(
      expect.arrayContaining([
        'rain',
        'soil',
        'seeds',
        'light',
        `note-${data.linked.id}`,
      ])
    )
    expectPrivateExclusions(
      ranked.map(item => ({ name: item.sourceName, text: item.text }))
    )
    expect(requestJson).not.toHaveBeenCalled()
    expect(generateBuiltinInsertion).not.toHaveBeenCalled()
  })

  for (const purpose of ['automatic inline', 'manual alternatives'] as const) {
    it.each(engines)(
      `feeds real ranked package passages to %s for ${purpose}`,
      async engine => {
        const data = fixture()
        const draft = resolve(data)
        const ranked = retrieveContext(
          draft,
          query(draft),
          4,
          cursorQuery(draft)
        )
        expect(ranked).toHaveLength(4)
        const options =
          purpose === 'manual alternatives'
            ? { purpose: 'alternatives' as const }
            : undefined
        const result = await request(engine, data, options)
        const payload = outgoing(engine)
        expect(payload.references).toEqual(
          ranked.map(item => ({ name: item.sourceName, text: item.text }))
        )
        expect(payload.beforeCursor).toBe(draft.content)
        expect(payload.afterCursor).toBe('')
        expectPrivateExclusions(payload.references)
        expect(result.mode).toBe('model')
        expect(result.sources).toEqual([
          ...new Set(ranked.map(item => item.sourceName)),
        ])
        expect(callCount(engine)).toBe(1)
        if (engine === 'embedded') {
          expect(getSecret).not.toHaveBeenCalled()
          expect(requestJson).not.toHaveBeenCalled()
          const bounded = boundBuiltinPrompt(
            vi.mocked(generateBuiltinInsertion).mock.calls[0]![0]
          )
          expect(bounded.references).toEqual(payload.references.slice(0, 2))
          const prepared = prepareBuiltinInput(
            bounded,
            serializeBuiltin,
            () => 200
          )
          for (const reference of bounded.references)
            expect(prepared).toContain(reference.text)
        } else {
          expect(generateBuiltinInsertion).not.toHaveBeenCalled()
          const body = vi.mocked(requestJson).mock.calls[0]?.[1]
            ?.body as ProviderPayload
          const endpoint = vi.mocked(requestJson).mock.calls[0]?.[0]
          expect(endpoint).toBe(
            engine === 'local FIM'
              ? 'http://localhost:1234/infill'
              : engine === 'local chat'
                ? 'http://localhost:1234/v1/chat/completions'
                : engine === 'anthropic'
                  ? 'https://api.anthropic.com/v1/messages'
                  : engine === 'custom'
                    ? 'https://custom.example/v1/chat/completions'
                    : config(engine).profiles[engine].endpoint +
                      '/chat/completions'
          )
          expect(body.n).toBeUndefined()
          expect(body.response_format).toBeUndefined()
          const freshOptions =
            purpose === 'manual alternatives' && !engine.startsWith('local')
          expect(result.alternatives?.length ?? 0).toBe(freshOptions ? 2 : 0)
        }
      }
    )
  }

  it.each(engines)(
    'updates the actual %s request after linked-note editing and package detachment despite cached prior inference',
    async engine => {
      const data = fixture()
      data.draft.title = 'Garden observations'
      data.draft.content = 'Garden rainfall observation details'
      data.draft.objective = 'Use the live garden rainfall observation details.'
      data.draft.context = ''
      data.draft.contextPackageIds = ['live', 'other']
      data.packages = [
        contextPackage('live', [`note-${data.linked.id}`]),
        contextPackage('other', ['unrelated']),
      ]
      await request(engine, data)
      expect(outgoing(engine).references).toEqual([
        { name: data.linked.title, text: snippets.linked },
      ])
      await request(engine, data)
      expect(callCount(engine)).toBe(1)

      data.linked = {
        ...data.linked,
        title: 'Edited rain gauge log',
        content: snippets.edited,
        updatedAt: data.linked.updatedAt + 1,
      }
      data.notes = [data.draft, data.linked]
      await request(engine, data)
      expect(callCount(engine)).toBe(2)
      expect(outgoing(engine).references).toEqual([
        { name: 'Edited rain gauge log', text: snippets.edited },
      ])
      expect(JSON.stringify(outgoing(engine))).not.toContain(
        'LIVE_OBSERVATION_OLD'
      )

      data.draft = { ...data.draft, contextPackageIds: ['other'] }
      data.notes = [data.draft, data.linked]
      await request(engine, data)
      expect(callCount(engine)).toBe(3)
      expect(outgoing(engine).references).toEqual([])
      expect(JSON.stringify(outgoing(engine))).not.toContain(
        'LIVE_OBSERVATION_NEW'
      )
      expectPrivateExclusions(outgoing(engine).references)
    }
  )

  it.each(engines)(
    'bounds actual ranked reference payloads for %s rather than forwarding entire package files',
    async engine => {
      const data = fixture()
      data.packages = data.packages.map(item => ({
        ...item,
        sourceIds: item.sourceIds.filter(id => !id.startsWith('note-')),
      }))
      data.library = data.library.map(item =>
        ['rain', 'soil', 'seeds', 'light'].includes(item.id)
          ? {
              ...item,
              text:
                item.text + ' garden rainfall soil seeds sunlight'.repeat(26),
            }
          : item
      )
      const draft = resolve(data)
      const ranked = retrieveContext(draft, query(draft), 4, cursorQuery(draft))
      expect(ranked).toHaveLength(4)
      expect(
        ranked.reduce((sum, item) => sum + item.text.length, 0)
      ).toBeGreaterThan(3_600)
      await request(engine, data)
      const references = outgoing(engine).references
      expect(references).toHaveLength(4)
      expect(references.reduce((sum, item) => sum + item.text.length, 0)).toBe(
        3_600
      )
      references.forEach((reference, index) => {
        expect(reference.name).toBe(ranked[index]?.sourceName)
        expect(ranked[index]?.text.startsWith(reference.text)).toBe(true)
      })
      expectPrivateExclusions(references)
      if (engine === 'embedded') {
        const transferred = boundBuiltinPrompt(
          vi.mocked(generateBuiltinInsertion).mock.calls[0]![0]
        )
        expect(transferred.references).toHaveLength(2)
        expect(
          transferred.references.every(item => item.text.length === 320)
        ).toBe(true)
        transferred.references.forEach((reference, index) => {
          expect(reference.text).toBe(references[index]?.text.slice(0, 320))
        })
        const prepared = prepareBuiltinInput(
          transferred,
          serializeBuiltin,
          () => 200
        )
        for (const reference of transferred.references)
          expect(prepared).toContain(reference.text)
        expect(prepared).not.toContain(references[2]!.name)
      }
    }
  )

  it('keeps the cursor when the real built-in budget helper must omit otherwise relevant BM25 passages', async () => {
    const data = fixture()
    await request('embedded', data)
    const prompt: BuiltinPrompt = vi.mocked(generateBuiltinInsertion).mock
      .calls[0]![0]
    expect(prompt.references).toHaveLength(4)
    const countTokens = vi.fn((text: string) =>
      text.includes('Reference (') ? 769 : 200
    )
    const prepared = prepareBuiltinInput(prompt, serializeBuiltin, countTokens)
    expect(prepared).not.toBeNull()
    expect(countTokens).toHaveBeenCalledTimes(2)
    expect(prepared).not.toContain('Reference (')
    expect(prepared).toContain(data.draft.content)
    expect(prepared).toContain(data.draft.objective)
    expect(prepared?.endsWith(data.draft.content)).toBe(true)
    expect(requestJson).not.toHaveBeenCalled()
    expect(getSecret).not.toHaveBeenCalled()
  })

  it('invalidates real BM25 and model cache after equal-length library edits, then honors an explicit source disable', async () => {
    const data = fixture()
    data.draft.contextPackageIds = []
    data.draft.sources = [
      { ...source('rain-reference', ''), libraryId: 'rain' },
    ]
    await request('openrouter', data)
    expect(outgoing('openrouter').references[0]?.text).toContain(
      'RAIN_MEASUREMENT'
    )
    data.library = data.library.map(item =>
      item.id === 'rain'
        ? { ...item, text: item.text.replace('forty', 'sixty') }
        : item
    )
    await request('openrouter', data)
    expect(callCount('openrouter')).toBe(2)
    expect(outgoing('openrouter').references[0]?.text).toContain('sixty litres')
    expect(outgoing('openrouter').references[0]?.text).not.toContain(
      'forty litres'
    )
    data.draft = {
      ...data.draft,
      sources: data.draft.sources.map(item => ({ ...item, enabled: false })),
    }
    data.notes = [data.draft, data.linked]
    await request('openrouter', data)
    expect(callCount('openrouter')).toBe(3)
    expect(outgoing('openrouter').references).toEqual([])
  })

  it('does not send stale linked-note snapshots when their target has been removed', async () => {
    const data = fixture()
    data.draft.contextPackageIds = ['live']
    data.packages = [contextPackage('live', [`note-${data.linked.id}`])]
    await request('embedded', data)
    expect(outgoing('embedded').references[0]?.text).toContain(
      'LIVE_OBSERVATION_OLD'
    )
    data.notes = [data.draft]
    await request('embedded', data)
    expect(callCount('embedded')).toBe(2)
    expect(outgoing('embedded').references).toEqual([])
    expect(
      resolve(data).sources.find(item => item.kind === 'note')?.enabled
    ).toBe(false)
    expect(requestJson).not.toHaveBeenCalled()
  })

  for (const focused of [
    {
      line: 'The coastal walk starts',
      name: 'coastal-walk.md',
      fact: 'The coastal walk starts at the blue orchard gate',
    },
    {
      line: 'The Saturday writing session begins',
      name: 'weekend-plan.txt',
      fact: 'The Saturday writing session begins at 09:30',
    },
  ]) {
    it.each(engines)(
      `puts the sample's "${focused.line}" facts in the first two excerpts for %s despite a long earlier voice passage`,
      async engine => {
        const workspace = addDemoWorkspace(emptyWorkspace())
        const original = workspace.notes.find(item => item.id === DEMO_NOTE_ID)!
        const voice = (workspace.contextLibrary ?? []).find(
          item => item.name === 'welcome-voice.md'
        )!
        const draft = resolveNoteContext(
          {
            ...original,
            content: `${voice.text.repeat(10)}\n\n${focused.line}`,
          },
          workspace.notes,
          workspace.contextLibrary,
          workspace.contextPackages
        )
        // Ordinary library/background searches keep their previous semantics.
        const background = retrieveContext(draft, query(draft), 4)
        expect(background[0]?.sourceName).toBe('welcome-voice.md')
        const ranked = retrieveContext(
          draft,
          query(draft),
          4,
          cursorQuery(draft)
        )
        expect(ranked[0]?.sourceName).toBe(focused.name)
        expect(ranked[0]?.text).toContain(focused.fact)
        await suggest(
          draft,
          {
            text: draft.content,
            cursor: draft.content.length,
            selectionEmpty: true,
          },
          config(engine)
        )
        const payload = outgoing(engine)
        expect(payload.references[0]?.name).toBe(focused.name)
        expect(payload.references[0]?.text).toContain(focused.fact)
        expect(payload.beforeCursor.endsWith(`\n\n${focused.line}`)).toBe(true)
        expect(payload.beforeCursor.length).toBeLessThanOrEqual(5_000)
        expect(callCount(engine)).toBe(1)
        if (engine === 'embedded') {
          const transferred = boundBuiltinPrompt(
            vi.mocked(generateBuiltinInsertion).mock.calls[0]![0]
          )
          expect(transferred.references[0]?.name).toBe(focused.name)
          expect(transferred.references[0]?.text).toContain(focused.fact)
          expect(
            transferred.references.every(item => item.text.length <= 320)
          ).toBe(true)
          const prepared = prepareBuiltinInput(
            transferred,
            serializeBuiltin,
            () => 200
          )
          expect(prepared).toContain(focused.fact)
          expect(requestJson).not.toHaveBeenCalled()
          expect(getSecret).not.toHaveBeenCalled()
        }
      }
    )
  }

  it.each(['embedded', 'local FIM', 'openrouter'] as const)(
    'uses the same-line suffix as bounded retrieval focus for %s without altering it',
    async engine => {
      const workspace = addDemoWorkspace(emptyWorkspace())
      const original = workspace.notes.find(item => item.id === DEMO_NOTE_ID)!
      const prefix = 'I am considering '
      const suffix = 'the coastal walk route.\nThe guests will read quietly.'
      const draft = resolveNoteContext(
        { ...original, content: prefix + suffix },
        workspace.notes,
        workspace.contextLibrary,
        workspace.contextPackages
      )
      await suggest(
        draft,
        { text: draft.content, cursor: prefix.length, selectionEmpty: true },
        config(engine)
      )
      const payload = outgoing(engine)
      expect(payload.references[0]?.name).toBe('coastal-walk.md')
      expect(payload.beforeCursor).toBe(prefix)
      expect(payload.afterCursor).toBe(suffix)
      expect(callCount(engine)).toBe(1)
    }
  )

  it.each(['embedded', 'openrouter'] as const)(
    'falls back to actual objective and brief relevance for %s when the cursor has no reference matches',
    async engine => {
      const data = fixture()
      data.draft.content = 'A quasar drifts beyond Andromeda'
      const draft = resolve(data)
      const background = retrieveContext(draft, query(draft), 4)
      expect(background).toHaveLength(4)
      expect(
        retrieveContext(draft, query(draft), 4, cursorQuery(draft))
      ).toEqual(background)
      await request(engine, data)
      expect(outgoing(engine).references).toEqual(
        background.map(item => ({ name: item.sourceName, text: item.text }))
      )
      expectPrivateExclusions(outgoing(engine).references)
      expect(callCount(engine)).toBe(1)
    }
  )

  it.each(engines)(
    'feeds the actual optional Bramble House sample context to %s',
    async engine => {
      const workspace = addDemoWorkspace(emptyWorkspace())
      const original = workspace.notes.find(item => item.id === DEMO_NOTE_ID)!
      expect(original.contextPackageIds).toEqual(DEMO_PACKAGE_IDS)
      expect(original.content.endsWith(DEMO_STARTER)).toBe(true)
      const draft = resolveNoteContext(
        original,
        workspace.notes,
        workspace.contextLibrary,
        workspace.contextPackages
      )
      const ranked = retrieveContext(draft, query(draft), 4, cursorQuery(draft))
      expect(ranked.map(item => item.sourceName)).toEqual(
        expect.arrayContaining(['house.md', 'welcome-voice.md'])
      )
      expect(ranked.some(item => item.text.includes('Friday at 16:00'))).toBe(
        true
      )
      const expected = ' on Friday at 16:00.'
      vi.mocked(generateBuiltinInsertion).mockResolvedValue(expected)
      vi.mocked(requestJson).mockImplementation(async url => {
        if (url.endsWith('/infill')) return { content: expected }
        return url.endsWith('/messages')
          ? { content: [{ type: 'text', text: expected }] }
          : {
              choices: [
                { message: { content: expected }, finish_reason: 'stop' },
              ],
            }
      })
      const result = await suggest(
        draft,
        {
          text: draft.content,
          cursor: draft.content.length,
          selectionEmpty: true,
        },
        config(engine)
      )
      expect(outgoing(engine).references).toEqual(
        ranked.map(item => ({ name: item.sourceName, text: item.text }))
      )
      expect(outgoing(engine).beforeCursor).toBe(original.content)
      expect(result.text).toBe(expected)
      expect(result.mode).toBe('model')
      expect(result.sources).toContain('house.md')
      expect(callCount(engine)).toBe(1)
      if (engine === 'embedded') {
        const transferred = boundBuiltinPrompt(
          vi.mocked(generateBuiltinInsertion).mock.calls[0]![0]
        )
        expect(transferred.references).toHaveLength(2)
        expect(
          transferred.references.some(item =>
            item.text.includes('Friday at 16:00')
          )
        ).toBe(true)
        expect(requestJson).not.toHaveBeenCalled()
      }
    }
  )

  it('recalls the sample arrival fact without weaker Bramble House fragments as alternatives', async () => {
    const workspace = addDemoWorkspace(emptyWorkspace())
    const original = workspace.notes.find(item => item.id === DEMO_NOTE_ID)!
    const draft = resolveNoteContext(
      original,
      workspace.notes,
      workspace.contextLibrary,
      workspace.contextPackages
    )
    const settings = { ...config('embedded'), localEngine: 'recall' as const }
    const result = await suggest(
      draft,
      {
        text: draft.content,
        cursor: draft.content.length,
        selectionEmpty: true,
      },
      settings
    )
    const candidates = [result, ...(result.alternatives ?? [])]
    expect(candidates.filter(item => item.mode === 'recall')).toEqual([
      { text: ' on Friday at 16:00.', sources: ['house.md'], mode: 'recall' },
    ])
    expect(
      candidates.some(
        item =>
          item.text === ' welcome note.' ||
          item.text.includes('has six bedrooms')
      )
    ).toBe(false)
    expect(requestJson).not.toHaveBeenCalled()
    expect(getSecret).not.toHaveBeenCalled()
    expect(generateBuiltinInsertion).not.toHaveBeenCalled()
  })
})
