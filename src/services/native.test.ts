import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

beforeEach(() => {
  vi.resetModules()
  native.invoke.mockReset()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

describe('native provider bridge', () => {
  it('keeps browser keys in memory even when asked to remember them', async () => {
    const { getSecret, setSecret } = await import('./native')
    await setSecret('provider:openrouter', 'session-test-key', true)
    expect(await getSecret('provider:openrouter')).toBe('session-test-key')
    expect(native.invoke).not.toHaveBeenCalled()
    expect(JSON.stringify(localStorage)).not.toContain('session-test-key')
    vi.resetModules()
    expect(
      await (await import('./native')).getSecret('provider:openrouter')
    ).toBe('')
  })

  it('uses the OS vault only when requested and removes a saved key when remembering is disabled', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    native.invoke.mockResolvedValue(undefined)
    const { setSecret, getSecret } = await import('./native')
    await setSecret('provider:openai', 'test-key', true)
    expect(native.invoke).toHaveBeenCalledWith('set_secret', {
      id: 'provider:openai',
      value: 'test-key',
    })
    await setSecret('provider:openai', 'test-key', false)
    expect(native.invoke).toHaveBeenLastCalledWith('set_secret', {
      id: 'provider:openai',
      value: null,
    })
    expect(await getSecret('provider:openai')).toBe('test-key')
  })

  it('aborts the actual native request through its request id', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    native.invoke.mockImplementation((command: string) =>
      command === 'http_request' ? new Promise(() => {}) : Promise.resolve()
    )
    const { requestJson } = await import('./native')
    const controller = new AbortController()
    const pending = requestJson('http://localhost:1234/v1/completions', {
      body: { prompt: 'My words' },
      signal: controller.signal,
    })
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'http_request',
        expect.anything()
      )
    )
    const requestId = native.invoke.mock.calls[0]?.[1]?.request.requestId
    controller.abort()
    await assertion
    expect(native.invoke).toHaveBeenCalledWith('cancel_http_request', {
      requestId,
    })
  })

  it('keeps offline models and session keys usable when the OS vault is unavailable', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    native.invoke.mockRejectedValue(
      'The operating system credential vault is unavailable'
    )
    const { getSecret, setSecret } = await import('./native')
    expect(await getSecret('provider:local')).toBe('')
    await expect(
      setSecret('provider:openai', 'temporary-key', true)
    ).rejects.toThrow('ready for this session')
    expect(await getSecret('provider:openai')).toBe('temporary-key')
  })

  it('forwards website-only network guards and preserves usable provider errors', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    native.invoke.mockResolvedValue({
      status: 401,
      body: '{"error":{"message":"Invalid API key"}}',
    })
    const { requestText } = await import('./native')
    await expect(
      requestText('https://example.com', { publicOnly: true })
    ).rejects.toThrow('HTTP 401. Invalid API key')
    expect(native.invoke).toHaveBeenCalledWith(
      'http_request',
      expect.objectContaining({
        request: expect.objectContaining({ publicOnly: true }),
      })
    )
  })

  it('rejects remote plaintext, URL credentials and malformed server JSON', async () => {
    const { requestJson } = await import('./native')
    await expect(requestJson('http://example.com')).rejects.toThrow('HTTPS')
    await expect(requestJson('https://user:key@example.com')).rejects.toThrow(
      'credentials'
    )
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    native.invoke.mockResolvedValue({ status: 200, body: 'not JSON' })
    await expect(
      requestJson('http://127.0.0.1:8000/v1/models')
    ).rejects.toThrow('not valid JSON')
  })
})
