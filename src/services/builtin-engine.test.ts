import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { BuiltinPrompt } from './builtin-model'

const files = [
  { name: 'config.json', body: '{}' },
  { name: 'onnx/model_quantized.onnx', body: 'small' },
]
const bodyHashes = await Promise.all(
  files.map(async file => ({
    name: file.name,
    bytes: file.body.length,
    sha256: Array.from(
      new Uint8Array(
        await webcrypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(file.body)
        )
      ),
      value => value.toString(16).padStart(2, '0')
    ).join(''),
  }))
)
const responses = new Map<string, Response>()
const workers: FakeWorker[] = []
const fetchMock = vi.fn()
let autoReply = true
let failAutomaticLoad = false
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  messages: {
    type: string
    id: number
    maxTokens?: number
    prompt?: BuiltinPrompt
    backend?: string
  }[] = []
  terminated = false
  constructor() {
    workers.push(this)
  }
  postMessage(message: (typeof this.messages)[number]) {
    this.messages.push(message)
    if (
      message.type === 'load' &&
      message.backend === 'auto' &&
      failAutomaticLoad
    ) {
      queueMicrotask(() =>
        this.onmessage?.({
          data: { type: 'error', id: message.id, error: 'GPU unavailable.' },
        } as MessageEvent)
      )
      return
    }
    if (message.type === 'load' || autoReply)
      queueMicrotask(() =>
        this.reply(
          message.id,
          message.type === 'generate' ? ' held the scent of rain.' : ''
        )
      )
  }
  reply(id: number, text = '') {
    this.onmessage?.({
      data: { type: 'done', id, text, backend: 'wasm' },
    } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}
let engine: typeof import('./builtin-engine')
const prompt: BuiltinPrompt = {
  noteTitle: 'Garden',
  objective: '',
  writingBrief: '',
  references: [],
  beforeCursor: 'At dawn, the garden',
  afterCursor: '',
}

async function seedCache() {
  const model = await import('./builtin-model')
  for (let index = 0; index < files.length; index++) {
    const file = bodyHashes[index]!
    responses.set(
      model.builtinFileUrl(file.name),
      new Response(files[index]!.body, {
        headers: {
          'content-length': String(file.bytes),
          'x-typenext-sha256': file.sha256,
        },
      })
    )
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.doMock('./builtin-model', async () => {
    const actual =
      await vi.importActual<typeof import('./builtin-model')>('./builtin-model')
    return {
      ...actual,
      BUILTIN_MODEL: { ...actual.BUILTIN_MODEL, files: bodyHashes },
      BUILTIN_DOWNLOAD_BYTES: 7,
    }
  })
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('caches', {
    open: vi.fn(async () => ({
      match: async (url: string) => responses.get(url)?.clone(),
      put: async (url: string, response: Response) => {
        responses.set(url, response.clone())
      },
    })),
    delete: vi.fn(async () => {
      responses.clear()
      return true
    }),
  })
  responses.clear()
  workers.length = 0
  fetchMock.mockReset()
  autoReply = true
  failAutomaticLoad = false
  fetchMock.mockImplementation(
    async (url: string) =>
      new Response(files.find(file => url.endsWith(file.name))!.body)
  )
  engine = await import('./builtin-engine')
})
afterEach(() => {
  engine.unloadBuiltinModel()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('./builtin-model')
})

describe('explicit offline model lifecycle', () => {
  it('defaults to CPU and remembers it across idle unload/reload', async () => {
    await seedCache()
    expect(engine.getBuiltinBackendPreference()).toBe('wasm')
    await engine.loadBuiltinModel({ backend: 'wasm' })
    engine.unloadBuiltinModel()
    await engine.loadBuiltinModel()
    expect(workers[1]?.messages[0]).toMatchObject({
      type: 'load',
      backend: 'wasm',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('automatic GPU failure retries CPU in a fresh worker with no download', async () => {
    await seedCache()
    failAutomaticLoad = true
    await engine.loadBuiltinModel({ backend: 'auto' })
    expect(workers).toHaveLength(2)
    expect(workers[0]?.terminated).toBe(true)
    expect(workers[1]?.messages[0]).toMatchObject({
      type: 'load',
      backend: 'wasm',
    })
    expect(engine.getBuiltinState()).toMatchObject({
      status: 'ready',
      backend: 'wasm',
      cached: true,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('cache checks and missing-cache reload never download or start a model', async () => {
    expect(await engine.checkBuiltinCache()).toBe(false)
    await expect(engine.loadBuiltinModel()).rejects.toThrow(
      'Download the offline model first'
    )
    await expect(
      engine.generateBuiltinInsertion(prompt, { maxTokens: 12, temperature: 0 })
    ).rejects.toThrow('Load the downloaded')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
  })
  it('explicit download verifies files, then cached loading and generation make no downloads', async () => {
    await engine.downloadBuiltinModel({ backend: 'wasm' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(engine.getBuiltinState()).toMatchObject({
      status: 'ready',
      cached: true,
      progress: 100,
      backend: 'wasm',
    })
    engine.unloadBuiltinModel()
    await engine.loadBuiltinModel({ backend: 'wasm' })
    expect(
      await engine.generateBuiltinInsertion(prompt, {
        maxTokens: 12,
        temperature: 0,
      })
    ).toBe(' held the scent of rain.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(workers).toHaveLength(2)
  })
  it('rejects altered and oversized model bytes before caching/loading', async () => {
    fetchMock.mockResolvedValue(new Response('xx'))
    await expect(engine.downloadBuiltinModel()).rejects.toThrow('integrity')
    expect(responses.size).toBe(0)
    expect(workers).toHaveLength(0)
    fetchMock.mockResolvedValue(new Response('way too much data'))
    await expect(engine.downloadBuiltinModel()).rejects.toThrow('exceeded')
    expect(responses.size).toBe(0)
    expect(workers).toHaveLength(0)
  })
  it('bounds a single active inference and rejects genuine overlapping callers', async () => {
    await seedCache()
    await engine.loadBuiltinModel()
    autoReply = false
    const task = engine.generateBuiltinInsertion(
      { ...prompt, beforeCursor: 'x'.repeat(2_000_000) },
      { maxTokens: 10_000, temperature: 20 }
    )
    await expect(
      engine.generateBuiltinInsertion(prompt, { maxTokens: 12, temperature: 0 })
    ).rejects.toThrow('already busy')
    const message = workers[0]!.messages.at(-1)!
    expect(message.maxTokens).toBe(48)
    expect(message.prompt?.beforeCursor).toHaveLength(900)
    workers[0]!.reply(message.id, 'continuation')
    await task
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('waits only for an aborted previous inference and accepts its acknowledgement without stale text', async () => {
    await seedCache()
    await engine.loadBuiltinModel()
    autoReply = false
    const controller = new AbortController()
    const first = engine.generateBuiltinInsertion(prompt, {
      maxTokens: 12,
      temperature: 0,
      signal: controller.signal,
    })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    const second = engine.generateBuiltinInsertion(prompt, {
      maxTokens: 12,
      temperature: 0,
    })
    const firstId = workers[0]!.messages.find(
      message => message.type === 'generate'
    )!.id
    workers[0]!.reply(firstId, 'stale text')
    await Promise.resolve()
    await Promise.resolve()
    const secondId = workers[0]!.messages
      .filter(message => message.type === 'generate')
      .at(-1)!.id
    expect(secondId).not.toBe(firstId)
    workers[0]!.reply(secondId, 'current text')
    expect(await second).toBe('current text')
  })
  it('hard-stops an unresponsive cancelled worker after1.5s and invalidates its identity', async () => {
    vi.useFakeTimers()
    await seedCache()
    await engine.loadBuiltinModel()
    autoReply = false
    const identity = engine.getBuiltinState().identity
    const controller = new AbortController()
    const task = engine.generateBuiltinInsertion(prompt, {
      maxTokens: 12,
      temperature: 0,
      signal: controller.signal,
    })
    const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    await vi.advanceTimersByTimeAsync(1500)
    expect(workers[0]?.terminated).toBe(true)
    expect(engine.getBuiltinState()).toMatchObject({
      status: 'idle',
      cached: true,
    })
    expect(engine.getBuiltinState().identity).not.toBe(identity)
  })
  it('unloads idle model memory after5minutes while preserving the verified cache', async () => {
    vi.useFakeTimers()
    await seedCache()
    await engine.loadBuiltinModel()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(workers[0]?.terminated).toBe(true)
    expect(engine.getBuiltinState()).toMatchObject({
      status: 'idle',
      cached: true,
      backend: null,
    })
    expect(responses.size).toBe(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('removal frees the cache and worker without touching unrelated browser storage', async () => {
    await seedCache()
    await engine.loadBuiltinModel()
    await engine.removeBuiltinModel()
    expect(workers[0]?.terminated).toBe(true)
    expect(engine.getBuiltinState()).toMatchObject({
      status: 'idle',
      cached: false,
    })
    expect(responses.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('an already aborted request starts no inference or download', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      engine.downloadBuiltinModel({ signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(workers).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
