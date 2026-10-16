import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkMediaDuration,
  checkMediaFile,
  mediaKind,
  MEDIA_LIMITS,
  importMediaFile,
} from './media-sources'
import {
  parseFacts,
  researchFocus,
  resetWebFactsForTests,
  searchWebFacts,
} from './web-facts'
import { linkHost, parsePreview } from './link-preview'
import { validateWorkspace } from './storage'
import {
  defaultSettings,
  emptyWorkspace,
  newNote,
  titleFromContent,
  UNTITLED,
} from '../notebook/model'
import { getSecret, requestJson } from './native'

vi.mock('./native', () => ({
  isDesktop: () => false,
  asError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  getSecret: vi.fn(async () => 'sk-test'),
  requestJson: vi.fn(),
  requestText: vi.fn(),
}))

describe('media limits', () => {
  const file = (name: string, type: string, size: number) => ({
    name,
    type,
    size,
  })

  it('detects kinds from MIME types and extensions', () => {
    expect(mediaKind(file('a.bin', 'image/png', 1))).toBe('image')
    expect(mediaKind(file('voice.m4a', '', 1))).toBe('audio')
    expect(mediaKind(file('clip.MOV', '', 1))).toBe('video')
    expect(mediaKind(file('notes.md', 'text/markdown', 1))).toBeNull()
  })

  it('rejects files above the size limit for each modality', () => {
    expect(() =>
      checkMediaFile(file('big.png', 'image/png', MEDIA_LIMITS.image.bytes + 1))
    ).toThrow(/up to 20 MB/u)
    expect(() =>
      checkMediaFile(file('big.wav', 'audio/wav', MEDIA_LIMITS.audio.bytes + 1))
    ).toThrow(/30 MB and 3 minutes/u)
    expect(() =>
      checkMediaFile(file('big.mp4', 'video/mp4', MEDIA_LIMITS.video.bytes + 1))
    ).toThrow(/50 MB and 45 seconds/u)
    expect(() => checkMediaFile(file('empty.png', 'image/png', 0))).toThrow(
      /empty/u
    )
    expect(checkMediaFile(file('ok.mp4', 'video/mp4', 1024))).toBe('video')
  })

  it('rejects clips that are too long or unreadable', () => {
    expect(() => checkMediaDuration('audio', 181, 'talk.mp3')).toThrow(
      /181 seconds long/u
    )
    expect(() => checkMediaDuration('video', 46, 'clip.mp4')).toThrow(
      /up to 45 seconds/u
    )
    expect(() => checkMediaDuration('video', Number.NaN, 'clip.mp4')).toThrow(
      /could not read the length/u
    )
    expect(() => checkMediaDuration('audio', 179, 'ok.mp3')).not.toThrow()
  })

  it('asks for semantic search with media before importing', async () => {
    const image = new File([new Uint8Array([1, 2, 3])], 'photo.png', {
      type: 'image/png',
    })
    await expect(
      importMediaFile(image, defaultSettings().semantic)
    ).rejects.toThrow(/Preferences → Knowledge/u)
  })
})

describe('web facts', () => {
  beforeEach(() => {
    resetWebFactsForTests()
    vi.mocked(requestJson).mockReset()
    vi.mocked(getSecret).mockResolvedValue('sk-test')
  })

  const reply = (facts: unknown) => ({
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({ facts }) }],
      },
    ],
  })

  it('parses cited facts, adds a separating space and drops unsafe links', () => {
    const facts = parseFacts(
      JSON.stringify({
        facts: [
          {
            insertion: 'on December 25, 2021.',
            sources: [
              { title: 'NASA', url: 'https://science.nasa.gov/webb' },
              { title: 'x', url: 'javascript:alert(1)' },
            ],
          },
          { insertion: 'on December 25, 2021.', sources: [] },
          { insertion: 'x'.repeat(400), sources: [] },
          { insertion: '', sources: [] },
        ],
      }),
      'The telescope launched'
    )
    expect(facts).toEqual([
      {
        text: ' on December 25, 2021.',
        sources: ['NASA'],
        mode: 'web',
        citations: [{ title: 'NASA', url: 'https://science.nasa.gov/webb' }],
      },
    ])
  })

  it('uses the selection, else the last sentence, as the research focus', () => {
    expect(
      researchFocus({
        selection: ' Webb ',
        beforeCursor: 'x',
        afterCursor: '',
        noteTitle: '',
        objective: '',
      })
    ).toBe('Webb')
    expect(
      researchFocus({
        selection: '',
        beforeCursor: 'First idea. The Webb telescope launched',
        afterCursor: '',
        noteTitle: '',
        objective: '',
      })
    ).toBe('The Webb telescope launched')
  })

  it('calls the Responses API with web search and a strict schema', async () => {
    vi.mocked(requestJson).mockResolvedValue(
      reply([
        {
          insertion: 'in 2021.',
          sources: [{ title: 'ESA', url: 'https://esa.int' }],
        },
      ])
    )
    const facts = await searchWebFacts(
      {
        selection: 'Webb',
        beforeCursor: 'Webb launched ',
        afterCursor: '',
        noteTitle: 'Space',
        objective: 'Explain',
      },
      { enabled: true, model: 'gpt-5.4-mini', withSuggestions: false }
    )
    expect(facts[0]?.citations?.[0]?.url).toBe('https://esa.int/')
    const [url, options] = vi.mocked(requestJson).mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = options!.body as Record<string, unknown>
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect((body.text as { format: { strict: boolean } }).format.strict).toBe(
      true
    )
    expect(options!.headers!.Authorization).toBe('Bearer sk-test')
    // A repeated request is served from the cache.
    await searchWebFacts(
      {
        selection: 'Webb',
        beforeCursor: 'Webb launched ',
        afterCursor: '',
        noteTitle: 'Space',
        objective: 'Explain',
      },
      { enabled: true, model: 'gpt-5.4-mini', withSuggestions: false }
    )
    expect(requestJson).toHaveBeenCalledTimes(1)
  })

  it('explains missing keys, disabled settings and API errors', async () => {
    const request = {
      selection: 'x',
      beforeCursor: '',
      afterCursor: '',
      noteTitle: '',
      objective: '',
    }
    await expect(
      searchWebFacts(request, {
        enabled: false,
        model: 'm',
        withSuggestions: false,
      })
    ).rejects.toThrow(/Turn on web facts/u)
    vi.mocked(getSecret).mockResolvedValue('')
    await expect(
      searchWebFacts(request, {
        enabled: true,
        model: 'm',
        withSuggestions: false,
      })
    ).rejects.toThrow(/OpenAI API key/u)
    vi.mocked(getSecret).mockResolvedValue('sk')
    vi.mocked(requestJson).mockResolvedValue({
      error: { message: 'Model not found' },
    })
    await expect(
      searchWebFacts(
        { ...request, selection: 'y' },
        { enabled: true, model: 'm', withSuggestions: false }
      )
    ).rejects.toThrow('Model not found')
  })
})

describe('link previews', () => {
  it('reads Open Graph and title tags without running scripts', () => {
    const preview = parsePreview(
      'https://www.example.com/a',
      '<html><head><title>Fallback</title><meta property="og:title" content="Rock &amp; Roll"><meta name="description" content="A &quot;quiet&quot; page"><meta property="og:site_name" content="Example"><script>alert(1)</script></head></html>'
    )
    expect(preview).toEqual({
      url: 'https://www.example.com/a',
      host: 'example.com',
      title: 'Rock & Roll',
      description: 'A "quiet" page',
      siteName: 'Example',
    })
    expect(
      parsePreview('https://a.dev', '<title>Only title</title>').title
    ).toBe('Only title')
    expect(linkHost('not a url')).toBe('not a url')
  })
})

describe('notes without a title', () => {
  it('creates untitled notes that follow their first line', () => {
    const note = newNote('')
    expect(note.title).toBe(UNTITLED)
    expect(note.autoTitle).toBe(true)
    expect(newNote('Named').autoTitle).toBeUndefined()
  })

  it('derives a clean title from Markdown', () => {
    expect(titleFromContent('\n\n# A **bold** start\nBody')).toBe(
      'A bold start'
    )
    expect(
      titleFromContent('- [ ] Buy [[Garden plan|seeds]] and [milk](https://x)')
    ).toBe('Buy seeds and milk')
    expect(titleFromContent('| --- | --- |\n> Quoted idea')).toBe('Quoted idea')
    expect(titleFromContent('word '.repeat(40)).length).toBeLessThanOrEqual(81)
    expect(titleFromContent('   ')).toBe('')
  })
})

describe('stored settings', () => {
  it('loads an older notebook without the new settings', () => {
    const workspace = JSON.parse(JSON.stringify(emptyWorkspace()))
    delete workspace.settings.semantic
    delete workspace.settings.webFacts
    delete workspace.settings.zenLevel
    delete workspace.settings.editor
    const loaded = validateWorkspace(workspace)
    expect(loaded.settings.semantic).toEqual(defaultSettings().semantic)
    expect(loaded.settings.editor.slashTrigger).toBe('/')
    expect(loaded.settings.zenLevel).toBe('chrome')
  })

  it('round-trips the new settings and media sources', () => {
    const workspace = emptyWorkspace()
    workspace.settings.semantic = {
      ...workspace.settings.semantic,
      enabled: true,
      dimensions: 256,
      media: true,
    }
    workspace.settings.editor.customCommands = [
      { id: 'sig', name: 'Signature', template: '— {date}' },
    ]
    workspace.contextLibrary = [
      {
        id: 'img',
        name: 'a.png',
        kind: 'image',
        text: 'Porch',
        enabled: true,
        addedAt: 1,
        media: {
          mime: 'image/png',
          bytes: 3,
          width: 2,
          height: 2,
          thumbnail: 'data:image/jpeg;base64,AAAA',
          vector: 'AAAA',
          vectorModel: 'google/embeddinggemma-2:UD-Q4_K_XL',
        },
      },
    ]
    const note = { ...newNote(''), content: 'Hello' }
    workspace.notes = [note]
    const loaded = validateWorkspace(JSON.parse(JSON.stringify(workspace)))
    expect(loaded.settings.semantic.dimensions).toBe(256)
    expect(loaded.settings.editor.customCommands[0]?.name).toBe('Signature')
    expect(loaded.contextLibrary?.[0]?.media?.thumbnail).toBe(
      'data:image/jpeg;base64,AAAA'
    )
    expect(loaded.notes[0]?.autoTitle).toBe(true)
  })

  it('rejects invalid values instead of loading them', () => {
    const bad = (
      patch: (workspace: ReturnType<typeof emptyWorkspace>) => void
    ) => {
      const workspace = emptyWorkspace()
      patch(workspace)
      return () => validateWorkspace(JSON.parse(JSON.stringify(workspace)))
    }
    expect(
      bad(workspace => (workspace.settings.editor.slashTrigger = 'a'))
    ).toThrow()
    expect(
      bad(workspace => (workspace.settings.editor.slashTrigger = '//'))
    ).toThrow()
    expect(
      bad(
        workspace =>
          ((workspace.settings.semantic as { dimensions: number }).dimensions =
            300)
      )
    ).toThrow()
    expect(
      bad(workspace => {
        workspace.contextLibrary = [
          {
            id: 'x',
            name: 'x',
            kind: 'image',
            text: '',
            enabled: true,
            addedAt: 0,
            media: {
              mime: 'image/png',
              bytes: 1,
              thumbnail: 'javascript:alert(1)',
            },
          },
        ]
      })
    ).toThrow()
  })
})

afterEach(() => {
  vi.clearAllMocks()
})
