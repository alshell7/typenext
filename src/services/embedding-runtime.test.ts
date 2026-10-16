import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SemanticSettings } from '../types/notebook'

const invoke = vi.fn()
let desktop = true
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }))
vi.mock('./native', () => ({ isDesktop: () => desktop }))

const runtime = await import('./embedding-runtime')

const settings = (patch: Partial<SemanticSettings> = {}): SemanticSettings => ({
  enabled: true,
  runtime: 'managed',
  endpoint: 'http://127.0.0.1:8080',
  quantization: 'UD-Q4_K_XL',
  dimensions: 512,
  media: false,
  ...patch,
})

const installed = {
  state: 'idle' as const,
  installed: { runtime: true, models: ['UD-Q4_K_XL' as const], media: false },
  diskBytes: 1,
}
const running = {
  ...installed,
  state: 'running' as const,
  running: { endpoint: 'http://127.0.0.1:51000', apiKey: 'k', quantization: 'UD-Q4_K_XL' as const, media: false },
}

beforeEach(() => {
  desktop = true
  invoke.mockReset()
  runtime.resetEmbeddingRuntimeForTests()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('embedding endpoint resolution', () => {
  it('accepts only a loopback server in server mode and strips /v1', async () => {
    await expect(runtime.resolveEmbeddingEndpoint(settings({ runtime: 'server', endpoint: 'http://localhost:8080/v1/' }))).resolves.toEqual({
      endpoint: 'http://localhost:8080',
      media: false,
    })
    await expect(runtime.resolveEmbeddingEndpoint(settings({ runtime: 'server', endpoint: 'https://models.example.com' }))).rejects.toThrow(/localhost/u)
    await expect(runtime.resolveEmbeddingEndpoint(settings({ runtime: 'server', endpoint: 'not a url' }))).rejects.toThrow(/address/u)
  })

  it('needs the desktop app for the managed runtime', async () => {
    desktop = false
    runtime.resetEmbeddingRuntimeForTests()
    await expect(runtime.resolveEmbeddingEndpoint(settings())).rejects.toThrow(/browser preview/u)
    expect(runtime.getEmbeddingRuntimeStatus().state).toBe('unsupported')
  })

  it('asks for a download when the model is not installed and never downloads by itself', async () => {
    invoke.mockResolvedValueOnce({ ...installed, installed: { runtime: false, models: [], media: false } })
    await expect(runtime.resolveEmbeddingEndpoint(settings())).rejects.toThrow(/Download the embedding model/u)
    expect(invoke).toHaveBeenCalledWith('embedding_runtime_status', undefined)
    expect(invoke).not.toHaveBeenCalledWith('embedding_runtime_install', expect.anything())
  })

  it('needs the media encoder when media is on', async () => {
    invoke.mockResolvedValueOnce(installed)
    await expect(runtime.resolveEmbeddingEndpoint(settings({ media: true }))).rejects.toThrow(/Download the embedding model/u)
  })

  it('starts the installed server once and reuses it', async () => {
    invoke.mockImplementation(async (command: string) => (command === 'embedding_runtime_status' ? installed : running))
    const [first, second] = await Promise.all([
      runtime.resolveEmbeddingEndpoint(settings()),
      runtime.resolveEmbeddingEndpoint(settings()),
    ])
    expect(first).toEqual({ endpoint: 'http://127.0.0.1:51000', apiKey: 'k', media: false })
    expect(second).toEqual(first)
    expect(invoke.mock.calls.filter(([command]) => command === 'embedding_runtime_start')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('embedding_runtime_start', {
      request: { quantization: 'UD-Q4_K_XL', media: false, contextSize: 2048 },
    })
    await runtime.resolveEmbeddingEndpoint(settings())
    expect(invoke.mock.calls.filter(([command]) => command === 'embedding_runtime_start')).toHaveLength(1)
  })

  it('stops an idle server after 15 minutes', async () => {
    vi.useFakeTimers()
    invoke.mockImplementation(async (command: string) =>
      command === 'embedding_runtime_status' ? installed : command === 'embedding_runtime_stop' ? installed : running
    )
    await runtime.resolveEmbeddingEndpoint(settings())
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(invoke).not.toHaveBeenCalledWith('embedding_runtime_stop', undefined)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(invoke).toHaveBeenCalledWith('embedding_runtime_stop', undefined)
    expect(runtime.getEmbeddingRuntimeStatus().running).toBeUndefined()
  })

  it('publishes status to subscribers', async () => {
    const listener = vi.fn()
    const stop = runtime.subscribeEmbeddingRuntime(listener)
    invoke.mockResolvedValueOnce(running)
    await runtime.refreshEmbeddingRuntime()
    expect(listener).toHaveBeenCalled()
    expect(runtime.getEmbeddingRuntimeStatus().state).toBe('running')
    stop()
  })
})
