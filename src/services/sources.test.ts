import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotebookSettings } from '../types/notebook'
import { defaultSettings } from '../notebook/model'
import { getSecret, requestJson, requestText } from './native'
import {
  importContextFile,
  importWebsite,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_CHARACTERS,
} from './sources'

const extractors = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(),
  cleanup: vi.fn(),
  cancel: vi.fn(),
  extractRawText: vi.fn(),
  workerOptions: { workerSrc: '' },
}))

vi.mock('./native', () => ({
  getSecret: vi.fn(),
  requestJson: vi.fn(),
  requestText: vi.fn(),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: extractors.getDocument,
  GlobalWorkerOptions: extractors.workerOptions,
}))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/test-pdf-worker.mjs',
}))
vi.mock('mammoth', () => ({ extractRawText: extractors.extractRawText }))

function settings(): NotebookSettings {
  const profile = {
    endpoint: 'http://localhost:1234/v1',
    model: '',
    protocol: 'chat' as const,
  }
  return {
    externalAutoEnabled: false,
    suggestionInstructions: '',
    localEngine: 'recall',
    theme: 'light',
    palette: defaultSettings().palette,
    fontFamily: 'Segoe UI',
    fontSize: 18,
    autoSave: true,
    suggestionsEnabled: true,
    autoSuggest: true,
    temperature: 0.35,
    suggestionDelay: 700,
    maxTokens: 64,
    suggestionLength: 'adaptive',
    provider: 'local',
    externalProvider: 'openrouter',
    websiteImporter: 'direct',
    profiles: {
      local: profile,
      custom: profile,
      openai: profile,
      openrouter: profile,
      anthropic: profile,
    },
  }
}

function file(name: string, text: string): File {
  const result = new File([text], name)
  Object.defineProperty(result, 'arrayBuffer', {
    configurable: true,
    value: async () => new TextEncoder().encode(text).buffer,
  })
  return result
}

function wordFile(
  name: string,
  data: Uint8Array,
  declaredSize = data.length,
  method = 0
): File {
  const fileName = new TextEncoder().encode('word/document.xml')
  const localLength = 30 + fileName.length + data.length
  const centralLength = 46 + fileName.length
  const bytes = new Uint8Array(localLength + centralLength + 22)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(8, method, true)
  view.setUint32(18, data.length, true)
  view.setUint32(22, declaredSize, true)
  view.setUint16(26, fileName.length, true)
  bytes.set(fileName, 30)
  bytes.set(data, 30 + fileName.length)
  view.setUint32(localLength, 0x02014b50, true)
  view.setUint16(localLength + 10, method, true)
  view.setUint32(localLength + 20, data.length, true)
  view.setUint32(localLength + 24, declaredSize, true)
  view.setUint16(localLength + 28, fileName.length, true)
  bytes.set(fileName, localLength + 46)
  const end = localLength + centralLength
  view.setUint32(end, 0x06054b50, true)
  view.setUint16(end + 8, 1, true)
  view.setUint16(end + 10, 1, true)
  view.setUint32(end + 12, centralLength, true)
  view.setUint32(end + 16, localLength, true)
  const result = new File([bytes], name)
  Object.defineProperty(result, 'arrayBuffer', {
    value: async () => bytes.buffer,
  })
  return result
}

function docxFile(name: string, declaredSize?: number): File {
  const data = new TextEncoder().encode('<document>Word fixture</document>')
  return wordFile(name, data, declaredSize)
}

function textStream(text = 'A local PDF passage.'): ReadableStream<{
  items: { str: string; hasEOL: boolean }[]
}> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ items: [{ str: text, hasEOL: true }] })
      controller.close()
    },
    cancel: extractors.cancel,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  extractors.workerOptions.workerSrc = ''
  vi.mocked(getSecret).mockResolvedValue('')
  extractors.destroy.mockResolvedValue(undefined)
  extractors.extractRawText.mockResolvedValue({
    value: 'A locally extracted Word paragraph.\n\nAnother paragraph.',
    messages: [],
  })
  extractors.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        streamTextContent: () => textStream(),
        cleanup: extractors.cleanup,
      }),
    }),
    destroy: extractors.destroy,
  })
})

describe('local context file import', () => {
  it('imports Unicode Markdown and normalizes line endings without using a network', async () => {
    const source = await importContextFile(
      file('Thoughts.MD', '# Evening\r\n\r\nहिंदी and 星空.')
    )
    expect(source.kind).toBe('markdown')
    expect(source.text).toBe('# Evening\n\nहिंदी and 星空.')
    expect(source.enabled).toBe(true)
    expect(requestJson).not.toHaveBeenCalled()
    expect(requestText).not.toHaveBeenCalled()
    expect(getSecret).not.toHaveBeenCalled()
    expect(extractors.workerOptions.workerSrc).toBe('')
    expect(extractors.getDocument).not.toHaveBeenCalled()
  })

  it('rejects oversized, empty and unsupported files with useful messages', async () => {
    const large = file('large.txt', 'text')
    Object.defineProperty(large, 'size', { value: MAX_CONTEXT_FILE_BYTES + 1 })
    await expect(importContextFile(large)).rejects.toThrow('12 MiB')
    await expect(importContextFile(file('empty.txt', '  \n'))).rejects.toThrow(
      'no readable text'
    )
    await expect(
      importContextFile(file('old.doc', 'document'))
    ).rejects.toThrow('Save this file as .docx')
    await expect(importContextFile(file('photo.png', 'image'))).rejects.toThrow(
      'text, Markdown, PDF or .docx'
    )
  })

  it('does not silently replace invalid UTF-8 bytes', async () => {
    const invalid = file('invalid.txt', 'placeholder')
    Object.defineProperty(invalid, 'arrayBuffer', {
      configurable: true,
      value: async () => new Uint8Array([0xff, 0xfe]).buffer,
    })
    await expect(importContextFile(invalid)).rejects.toThrow('not UTF-8')
  })

  it('extracts PDF text with page markers and destroys the parser afterward', async () => {
    const source = await importContextFile(file('reference.pdf', 'PDF fixture'))
    expect(source.kind).toBe('pdf')
    expect(source.text).toBe('[Page 1]\nA local PDF passage.')
    expect(extractors.destroy).toHaveBeenCalledOnce()
    expect(extractors.cleanup).toHaveBeenCalledOnce()
    expect(extractors.workerOptions.workerSrc).toBe(
      '/assets/test-pdf-worker.mjs'
    )
    expect(extractors.getDocument).toHaveBeenCalledWith({
      data: expect.any(Uint8Array),
      useWorkerFetch: false,
      disableFontFace: true,
      useWasm: false,
    })
    expect(requestJson).not.toHaveBeenCalled()
    expect(requestText).not.toHaveBeenCalled()
    expect(getSecret).not.toHaveBeenCalled()
  })

  it('reports scanned PDFs honestly and still releases the parser', async () => {
    extractors.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          streamTextContent: () => textStream(''),
          cleanup: extractors.cleanup,
        }),
      }),
      destroy: extractors.destroy,
    })
    await expect(
      importContextFile(file('scan.pdf', 'PDF fixture'))
    ).rejects.toThrow('Run OCR first')
    expect(extractors.destroy).toHaveBeenCalledOnce()
    expect(getSecret).not.toHaveBeenCalled()
  })

  it('extracts DOCX as plain text and handles a corrupt document', async () => {
    expect(
      (await importContextFile(docxFile('reference.docx'))).text
    ).toContain('locally extracted Word paragraph')
    extractors.extractRawText.mockRejectedValue(new Error('Invalid archive'))
    await expect(importContextFile(docxFile('corrupt.docx'))).rejects.toThrow(
      'fresh .docx copy'
    )
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('rejects an oversized plaintext file before reading or allocating decoded text', async () => {
    const large = file('large.txt', 'fixture')
    const read = vi.fn()
    Object.defineProperty(large, 'size', {
      value: MAX_CONTEXT_CHARACTERS * 4 + 1,
    })
    Object.defineProperty(large, 'arrayBuffer', {
      configurable: true,
      value: read,
    })
    await expect(importContextFile(large)).rejects.toThrow('300,000 characters')
    expect(read).not.toHaveBeenCalled()
    expect(extractors.getDocument).not.toHaveBeenCalled()
    expect(extractors.extractRawText).not.toHaveBeenCalled()
  })

  it('accepts a valid UTF-8 source at the character limit', async () => {
    const content = '星'.repeat(MAX_CONTEXT_CHARACTERS)
    expect((await importContextFile(file('unicode.txt', content))).text).toBe(
      content
    )
  })

  it('rejects Word archive expansion before starting the document parser', async () => {
    await expect(
      importContextFile(docxFile('expands.docx', 40 * 1024 * 1024))
    ).rejects.toThrow('expands to too much')
    expect(extractors.extractRawText).not.toHaveBeenCalled()
    expect(requestJson).not.toHaveBeenCalled()
    expect(requestText).not.toHaveBeenCalled()
  })

  it('rejects forged small Word sizes after checking actual high-ratio inflation', async () => {
    const { deflateSync } = await import('fflate')
    const compressed = deflateSync(
      new TextEncoder().encode('a'.repeat(5 * 1024 * 1024))
    )
    await expect(
      importContextFile(wordFile('forged.docx', compressed, 10, 8))
    ).rejects.toThrow('expands to too much')
    expect(extractors.extractRawText).not.toHaveBeenCalled()
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('rejects incorrect expanded sizes even when actual output is below the limit', async () => {
    const { deflateSync } = await import('fflate')
    const compressed = deflateSync(
      new TextEncoder().encode('A small Word document.')
    )
    await expect(
      importContextFile(wordFile('mismatch.docx', compressed, 1, 8))
    ).rejects.toThrow('fresh .docx copy')
    expect(extractors.extractRawText).not.toHaveBeenCalled()
  })

  it('reports a broken compressed Word entry without starting its parser', async () => {
    await expect(
      importContextFile(
        wordFile('broken.docx', new Uint8Array([255, 255, 255]), 1, 8)
      )
    ).rejects.toThrow('fresh .docx copy')
    expect(extractors.extractRawText).not.toHaveBeenCalled()
  })

  it('can cancel compressed Word validation before the document parser starts', async () => {
    const { deflateSync } = await import('fflate')
    const text = 'A bounded synthetic Word reference paragraph. '.repeat(20_000)
    const compressed = deflateSync(new TextEncoder().encode(text))
    const controller = new AbortController()
    let elapsed = 0
    const now = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => (elapsed += 16))
    const timer = setTimeout(() => controller.abort(), 0)
    try {
      await expect(
        importContextFile(
          wordFile('cancelled.docx', compressed, text.length, 8),
          controller.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(extractors.extractRawText).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timer)
      now.mockRestore()
    }
  })

  it('releases PDF page and document resources when text extraction fails', async () => {
    extractors.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          streamTextContent: () =>
            new ReadableStream({
              start(controller) {
                controller.error(new Error('Broken page'))
              },
            }),
          cleanup: extractors.cleanup,
        }),
      }),
      destroy: extractors.destroy,
    })
    await expect(
      importContextFile(file('broken.pdf', 'fixture'))
    ).rejects.toThrow('Broken page')
    expect(extractors.cleanup).toHaveBeenCalledOnce()
    expect(extractors.destroy).toHaveBeenCalledOnce()
  })

  it('stops streaming an overlong PDF before retaining subsequent chunks', async () => {
    extractors.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          streamTextContent: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({
                  items: [
                    {
                      str: 'x'.repeat(MAX_CONTEXT_CHARACTERS + 1),
                      hasEOL: false,
                    },
                  ],
                })
              },
              cancel: extractors.cancel,
            }),
          cleanup: extractors.cleanup,
        }),
      }),
      destroy: extractors.destroy,
    })
    await expect(
      importContextFile(file('long.pdf', 'fixture'))
    ).rejects.toThrow('300,000 extracted characters')
    expect(extractors.cancel).toHaveBeenCalledOnce()
    expect(extractors.cleanup).toHaveBeenCalledOnce()
    expect(extractors.destroy).toHaveBeenCalledOnce()
  })

  it('cancels PDF extraction and destroys its worker only once', async () => {
    const controller = new AbortController()
    extractors.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          streamTextContent: () =>
            new ReadableStream({
              start(stream) {
                controller.abort()
                stream.enqueue({ items: [] })
              },
              cancel: extractors.cancel,
            }),
          cleanup: extractors.cleanup,
        }),
      }),
      destroy: extractors.destroy,
    })
    await expect(
      importContextFile(file('cancelled.pdf', 'fixture'), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(extractors.cancel).toHaveBeenCalledOnce()
    expect(extractors.cleanup).toHaveBeenCalledOnce()
    expect(extractors.destroy).toHaveBeenCalledOnce()
  })

  it('rejects a cancelled file before reading and discards bytes that finish after cancellation', async () => {
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    const unread = file('cancelled.docx', 'fixture')
    const read = vi.fn()
    Object.defineProperty(unread, 'arrayBuffer', {
      configurable: true,
      value: read,
    })
    await expect(
      importContextFile(unread, alreadyCancelled.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
    const during = new AbortController()
    const pending = file('pending.docx', 'fixture')
    Object.defineProperty(pending, 'arrayBuffer', {
      configurable: true,
      value: async () => {
        during.abort()
        return new TextEncoder().encode('fixture').buffer
      },
    })
    await expect(
      importContextFile(pending, during.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(extractors.extractRawText).not.toHaveBeenCalled()
  })

  it('permits only one active context import without retaining a waiting queue', async () => {
    let finishRead: (bytes: ArrayBuffer) => void = () => {}
    let readStarted: () => void = () => {}
    const reading = new Promise<void>(resolve => {
      readStarted = resolve
    })
    const pending = file('first.txt', 'First context')
    Object.defineProperty(pending, 'arrayBuffer', {
      configurable: true,
      value: () => {
        readStarted()
        return new Promise<ArrayBuffer>(resolve => {
          finishRead = resolve
        })
      },
    })
    const first = importContextFile(pending)
    await reading
    await expect(
      importContextFile(file('second.txt', 'Second context'))
    ).rejects.toThrow('Another context source is still importing')
    finishRead(new TextEncoder().encode('First context').buffer)
    expect((await first).text).toBe('First context')
    expect(
      (await importContextFile(file('retry.txt', 'Retry context'))).text
    ).toBe('Retry context')
  })
})

describe('deliberate website context import', () => {
  it('extracts readable article text and excludes scripts and navigation', async () => {
    vi.mocked(requestText).mockResolvedValue(
      '<!doctype html><html><head><title>The river essay</title></head><body><nav>Navigation menu</nav><article><h1>The river essay</h1><p>The river is quiet in the morning, when mist covers the water and only the birds are awake.</p><p>I return here to gather my thoughts and remember the sound of the water.</p></article><script>stealSecrets()</script></body></html>'
    )
    const source = await importWebsite(
      'https://example.com/river#paragraph',
      settings()
    )
    expect(source.kind).toBe('website')
    expect(source.text).toContain('The river is quiet')
    expect(source.text).not.toContain('stealSecrets')
    expect(source.text).not.toContain('Navigation menu')
    expect(source.origin).toBe('https://example.com/river')
    expect(vi.mocked(requestText).mock.calls[0]?.[1]?.publicOnly).toBe(true)
    expect(getSecret).not.toHaveBeenCalled()
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('accepts a public plain-text source and preserves paragraphs', async () => {
    vi.mocked(requestText).mockResolvedValue(
      'A public text reference.\n\nThe second paragraph remains distinct.'
    )
    expect(
      (await importWebsite('https://example.com/reference.txt', settings()))
        .text
    ).toBe('A public text reference.\n\nThe second paragraph remains distinct.')
  })

  it.each([
    'file:///C:/private.txt',
    'http://127.0.0.1:1234',
    'http://10.0.0.1',
    'http://[::1]/',
    'https://user:secret@example.com/',
  ])('rejects unsupported website URLs before a request: %s', async url => {
    await expect(importWebsite(url, settings())).rejects.toThrow()
    expect(requestText).not.toHaveBeenCalled()
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('uses Firecrawl only when deliberately selected and keeps its key out of source data', async () => {
    const config = settings()
    config.websiteImporter = 'firecrawl'
    vi.mocked(getSecret).mockResolvedValue('firecrawl-test-key')
    vi.mocked(requestJson).mockResolvedValue({
      success: true,
      data: {
        markdown: '# Reference\n\nA scraped river reference.',
        metadata: { title: 'Reference' },
      },
    })
    const source = await importWebsite('https://example.com/reference', config)
    expect(source.name).toBe('Reference')
    expect(source.text).toContain('scraped river reference')
    expect(JSON.stringify(source)).not.toContain('firecrawl-test-key')
    expect(getSecret).toHaveBeenCalledExactlyOnceWith('firecrawl')
    expect(requestText).not.toHaveBeenCalled()
    expect(vi.mocked(requestJson).mock.calls[0]?.[1]?.body).toEqual({
      url: 'https://example.com/reference',
      formats: ['markdown'],
      onlyMainContent: true,
    })
  })

  it('does not silently change import providers when the Firecrawl key is missing', async () => {
    const config = settings()
    config.websiteImporter = 'firecrawl'
    await expect(importWebsite('https://example.com', config)).rejects.toThrow(
      'Add a Firecrawl key'
    )
    expect(requestJson).not.toHaveBeenCalled()
    expect(requestText).not.toHaveBeenCalled()
  })

  it('does not attach a response after the import was cancelled', async () => {
    const controller = new AbortController()
    vi.mocked(requestText).mockImplementation(async () => {
      controller.abort()
      return 'Text that arrived after cancellation.'
    })
    await expect(
      importWebsite('https://example.com', settings(), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects excessive HTML element counts before materializing a DOM', async () => {
    vi.mocked(requestText).mockResolvedValue(
      '<html><body>' + '<div>text</div>'.repeat(20_001) + '</body></html>'
    )
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    try {
      await expect(
        importWebsite('https://example.com', settings())
      ).rejects.toThrow('too many elements')
      expect(parse).not.toHaveBeenCalled()
      expect(requestJson).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })
})
