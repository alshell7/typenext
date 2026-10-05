import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

const modelBody = 'synthetic-model'
const modelHash = Array.from(
  new Uint8Array(
    await webcrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(modelBody)
    )
  ),
  byte => byte.toString(16).padStart(2, '0')
).join('')
const responses = new Map<string, Response>()
const fetchMock = vi.fn()
const workers: FakeWorker[] = []
let autoTranscribe = true
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  messages: {
    id: number
    type: string
    model?: ArrayBuffer
    pcm?: Float32Array
    language?: string
  }[] = []
  constructor() {
    workers.push(this)
  }
  postMessage(message: (typeof this.messages)[number]) {
    this.messages.push(message)
    if (message.type === 'load' || autoTranscribe)
      queueMicrotask(() =>
        this.reply(
          message.id,
          message.type === 'transcribe'
            ? { text: 'A patient thought.', language: 'en' }
            : undefined
        )
      )
  }
  reply(id: number, result?: unknown) {
    this.onmessage?.({ data: { id, type: 'done', result } } as MessageEvent)
  }
  terminate() {
    this.terminated = true
  }
}
let service: typeof import('./whistle')
let model: typeof import('./whistle-model')

function headers() {
  return {
    'content-length': String(modelBody.length),
    'x-typenext-sha256': modelHash,
  }
}
function seedCache(body = modelBody) {
  responses.set(
    model.whistleModelUrl(),
    new Response(body, { headers: headers() })
  )
}
beforeEach(async () => {
  vi.resetModules()
  vi.doMock('./whistle-model', async () => {
    const actual =
      await vi.importActual<typeof import('./whistle-model')>('./whistle-model')
    return {
      ...actual,
      WHISTLE_MODEL: {
        ...actual.WHISTLE_MODEL,
        bytes: modelBody.length,
        sha256: modelHash,
      },
      validWhistleCache: (response: Response | undefined) =>
        Boolean(
          response?.ok &&
          response.headers.get('content-length') === String(modelBody.length) &&
          response.headers.get('x-typenext-sha256') === modelHash
        ),
    }
  })
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('caches', {
    open: vi.fn(async () => ({
      match: async (url: string) => responses.get(url)?.clone(),
      put: async (url: string, response: Response) => {
        responses.set(url, response.clone())
      },
      delete: async (url: string) => responses.delete(url),
    })),
    delete: vi.fn(async () => {
      responses.clear()
      return true
    }),
  })
  responses.clear()
  workers.length = 0
  autoTranscribe = true
  fetchMock.mockReset().mockResolvedValue(new Response(modelBody))
  model = await import('./whistle-model')
  service = await import('./whistle')
})
afterEach(() => {
  service.unloadWhistleModel()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('./whistle-model')
})

describe('explicit offline Whistle lifecycle', () => {
  it('never downloads, loads a worker or records audio on cache checks or missing-cache loading', async () => {
    expect(await service.checkWhistleCache()).toBe(false)
    await expect(service.loadWhistleModel()).rejects.toThrow('Download Whistle')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
  })
  it('downloads only the pinned public model, then loads/transcribes entirely from local cache', async () => {
    await service.downloadWhistleModel()
    expect(workers).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      model.whistleModelUrl(),
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
    )
    const audio = new Float32Array([0.1, -0.1, 0])
    expect(await service.transcribeWhistle(audio, { language: 'en' })).toEqual({
      text: 'A patient thought.',
      language: 'en',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(workers).toHaveLength(1)
    expect(workers[0]?.messages.map(message => message.type)).toEqual([
      'load',
      'transcribe',
    ])
    expect(workers[0]?.messages[1]?.language).toBe('en')
    expect(audio[0]).toBeCloseTo(0.1)
    expect(service.getWhistleState()).toMatchObject({
      status: 'ready',
      cached: true,
      progress: 100,
    })
  })
  it('shares metadata checks and ignores a stale check after a model has loaded', async () => {
    let finishCheck!: (response: Response | undefined) => void
    vi.mocked(caches.open).mockResolvedValueOnce({
      match: () =>
        new Promise<Response | undefined>(resolve => {
          finishCheck = resolve
        }),
    } as unknown as Cache)
    const first = service.checkWhistleCache()
    const duplicate = service.checkWhistleCache()
    await Promise.resolve()
    seedCache()
    await service.loadWhistleModel()
    finishCheck(undefined)
    expect(await first).toBe(true)
    expect(await duplicate).toBe(true)
    expect(caches.open).toHaveBeenCalledTimes(2)
    expect(service.getWhistleState()).toMatchObject({
      status: 'ready',
      cached: true,
    })
  })
  it.each(['altered-model!!', 'too short'])(
    'rejects incorrect size or hash before caching/loading: %s',
    async body => {
      fetchMock.mockResolvedValue(new Response(body))
      await expect(service.downloadWhistleModel()).rejects.toThrow(
        /integrity|ended early|pinned size/
      )
      expect(responses.size).toBe(0)
      expect(workers).toHaveLength(0)
    }
  )
  it('rejects oversized declared and streamed model data without retaining it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('x', { headers: { 'content-length': '999999999' } })
    )
    await expect(service.downloadWhistleModel()).rejects.toThrow('pinned size')
    fetchMock.mockResolvedValueOnce(
      new Response('x'.repeat(modelBody.length + 1))
    )
    await expect(service.downloadWhistleModel()).rejects.toThrow('pinned size')
    expect(responses.size).toBe(0)
    expect(workers).toHaveLength(0)
  })
  it('revalidates cached bytes and removes corrupted downloadable weights without network fallback', async () => {
    seedCache('x'.repeat(modelBody.length))
    expect(await service.checkWhistleCache()).toBe(true)
    await expect(service.loadWhistleModel()).rejects.toThrow('integrity')
    expect(responses.size).toBe(0)
    expect(service.getWhistleState().cached).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(workers).toHaveLength(0)
  })
  it('cancels an in-flight local cache read and cannot resurrect an unloaded worker', async () => {
    responses.set(
      model.whistleModelUrl(),
      new Response(new ReadableStream({ start() {} }), { headers: headers() })
    )
    const controller = new AbortController()
    const loading = service.loadWhistleModel({ signal: controller.signal })
    const rejected = expect(loading).rejects.toMatchObject({
      name: 'AbortError',
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    service.unloadWhistleModel()
    await rejected
    expect(workers).toHaveLength(0)
    expect(service.getWhistleState().status).toBe('idle')
  })
  it('terminates actual worker work on cancellation, ignores stale messages and permits a fresh recording', async () => {
    seedCache()
    await service.loadWhistleModel()
    autoTranscribe = false
    const controller = new AbortController()
    const first = service.transcribeWhistle(new Float32Array([0.1]), {
      signal: controller.signal,
    })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const old = workers[0]!
    controller.abort()
    await rejected
    expect(old.terminated).toBe(true)
    old.reply(old.messages.at(-1)!.id, {
      text: 'Stale private speech.',
      language: 'en',
    })
    expect(service.getWhistleState().status).toBe('idle')
    autoTranscribe = true
    expect(
      (await service.transcribeWhistle(new Float32Array([0.2]))).text
    ).toBe('A patient thought.')
    expect(workers).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('bounds clips and language before any model access and forbids overlapping inference', async () => {
    await expect(
      service.transcribeWhistle(new Float32Array(480_001))
    ).rejects.toThrow('30 seconds')
    await expect(
      service.transcribeWhistle(new Float32Array([Number.NaN]))
    ).rejects.toThrow('invalid audio')
    await expect(
      service.transcribeWhistle(new Float32Array([2]))
    ).rejects.toThrow('invalid audio')
    await expect(
      service.transcribeWhistle(new Float32Array([0.1]), {
        language: 'unbounded' as 'en',
      })
    ).rejects.toThrow('supported languages')
    expect(workers).toHaveLength(0)
    seedCache()
    await service.loadWhistleModel()
    autoTranscribe = false
    const controller = new AbortController()
    const pending = service.transcribeWhistle(new Float32Array([0]), {
      signal: controller.signal,
    })
    const cancelled = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    await expect(
      service.transcribeWhistle(new Float32Array([0]))
    ).rejects.toThrow('already busy')
    controller.abort()
    await cancelled
  })
  it('times out a stalled decoder and releases idle memory while keeping the model cache', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    seedCache()
    await service.loadWhistleModel()
    vi.advanceTimersByTime(60_000)
    expect(workers[0]?.terminated).toBe(true)
    expect(responses.size).toBe(1)
    await service.loadWhistleModel()
    autoTranscribe = false
    const pending = service.transcribeWhistle(new Float32Array([0.1]))
    const failed = expect(pending).rejects.toThrow('took too long')
    vi.advanceTimersByTime(45_000)
    await failed
    expect(workers[1]?.terminated).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('removes only this model cache and reports unsupported device storage', async () => {
    seedCache()
    await service.loadWhistleModel()
    await service.removeWhistleModel()
    expect(workers[0]?.terminated).toBe(true)
    expect(responses.size).toBe(0)
    expect(caches.delete).toHaveBeenCalledWith(model.WHISTLE_MODEL.cache)
    vi.stubGlobal('Worker', undefined)
    expect(await service.checkWhistleCache()).toBe(false)
    expect(service.getWhistleState().status).toBe('unavailable')
  })
  it('blocks loading while a cache removal is pending', async () => {
    seedCache()
    await service.checkWhistleCache()
    let finishRemoval!: (removed: boolean) => void
    vi.mocked(caches.delete).mockReturnValueOnce(
      new Promise(resolve => {
        finishRemoval = resolve
      })
    )
    const removal = service.removeWhistleModel()
    await expect(service.loadWhistleModel()).rejects.toThrow('already busy')
    finishRemoval(true)
    await removal
    expect(service.getWhistleState()).toMatchObject({
      status: 'idle',
      cached: false,
    })
  })
})
