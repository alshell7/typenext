import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  install: vi.fn(),
  endpoint: vi.fn(),
  desktop: false,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('./native', () => ({ isDesktop: () => mock.desktop }))
vi.mock('./speech-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('./speech-runtime')>()),
  installSpeechRuntime: mock.install,
  speechEndpoint: mock.endpoint,
}))
import {
  downloadFluidSpeech,
  encodeWav,
  parseFluidTranscript,
  resetFluidSpeechForTests,
  transcribeFluid,
} from './fluid-speech'
import { getHuggingFacePrompt, resetHuggingFaceForTests } from './huggingface'
import { readWav, useNodeMultipart } from '../notebook/dictation/live-audio'

const ANSWER = {
  task: 'transcribe',
  language: 'en',
  duration: 3.16,
  text: 'Guests arrive at Bramble House on Friday afternoon.',
  segments: [
    {
      id: 0,
      start: 0,
      end: 3.16,
      text: 'Guests arrive at Bramble House on Friday afternoon.',
    },
  ],
}
const fetchMock = vi.fn()

beforeEach(() => {
  resetFluidSpeechForTests()
  resetHuggingFaceForTests()
  mock.desktop = false
  mock.invoke.mockReset()
  mock.install.mockReset()
  mock.endpoint.mockReset().mockResolvedValue('http://127.0.0.1:18090')
  fetchMock
    .mockReset()
    .mockImplementation(
      async () => new Response(JSON.stringify(ANSWER), { status: 200 })
    )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WAV encoding', () => {
  it('writes a 44-byte RIFF header for 16 kHz mono 16-bit PCM', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, 2, Number.NaN]))
    const view = new DataView(wav.buffer)
    const text = (at: number) =>
      String.fromCharCode(...wav.subarray(at, at + 4))
    expect(wav.byteLength).toBe(44 + 12)
    expect(text(0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 12)
    expect(text(8)).toBe('WAVE')
    expect(text(12)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(12)
    expect(
      [0, 1, 2, 3, 4, 5].map(index => view.getInt16(44 + index * 2, true))
    ).toEqual([0, 32767, -32768, 16384, 32767, 0])
  })
})

describe('Fluid Speech Mini client', () => {
  it('parses verbose JSON and rejects unreadable answers', () => {
    expect(parseFluidTranscript(ANSWER)).toEqual({
      text: ANSWER.text,
      duration: 3.16,
      segments: [{ start: 0, end: 3.16, text: ANSWER.text }],
    })
    expect(() => parseFluidTranscript({ text: 3 })).toThrow('unreadable')
    expect(() => parseFluidTranscript(null)).toThrow('unreadable')
  })

  it('posts a multipart WAV to the loopback server', async () => {
    const result = await transcribeFluid(new Float32Array(16_000), {
      endpoint: 'http://127.0.0.1:18090/',
    })
    expect(result.text).toBe(ANSWER.text)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:18090/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('omit')
    const form = init.body as FormData
    expect(form.get('model')).toBe('fluid-speech-mini')
    expect(form.get('response_format')).toBe('verbose_json')
    const file = form.get('file') as File
    expect(file.type).toBe('audio/wav')
    expect(file.size).toBe(44 + 32_000)
  })

  it('starts the managed server when no endpoint is given', async () => {
    await transcribeFluid(new Float32Array(160))
    expect(mock.endpoint).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://127.0.0.1:18090/v1/audio/transcriptions'
    )
  })

  it('splits audio longer than one request and joins the text in order', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'First part.', duration: 120 }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'Second part.', duration: 5 }))
      )
    const result = await transcribeFluid(new Float32Array(16_000 * 125), {
      endpoint: 'http://127.0.0.1:1',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('First part. Second part.')
    expect(result.duration).toBe(125)
  })

  it('reports HTTP errors with the server message', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "missing required field 'file'" } }),
        { status: 400 }
      )
    )
    await expect(
      transcribeFluid(new Float32Array(160), { endpoint: 'http://x' })
    ).rejects.toThrow(
      "Fluid Speech Mini returned HTTP 400. missing required field 'file'"
    )
    fetchMock.mockResolvedValue(new Response('<html>', { status: 503 }))
    await expect(
      transcribeFluid(new Float32Array(160), { endpoint: 'http://x' })
    ).rejects.toThrow('still starting')
    fetchMock.mockRejectedValue(new TypeError('Load failed'))
    await expect(
      transcribeFluid(new Float32Array(160), { endpoint: 'http://x' })
    ).rejects.toThrow('could not reach Fluid Speech Mini')
  })

  it('aborts in flight and reports a timeout in words', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        )
    )
    const controller = new AbortController()
    const pending = transcribeFluid(new Float32Array(160), {
      endpoint: 'http://x',
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      transcribeFluid(new Float32Array(160), {
        endpoint: 'http://x',
        timeoutMs: 5,
      })
    ).rejects.toThrow('took too long')
    await expect(
      transcribeFluid(new Float32Array(0), { endpoint: 'http://x' })
    ).rejects.toThrow('Record a moment')
  })

  it('relays through the desktop app with the WAV as the raw body', async () => {
    mock.desktop = true
    mock.invoke.mockResolvedValue(ANSWER)
    const result = await transcribeFluid(new Float32Array(160))
    expect(result.text).toBe(ANSWER.text)
    expect(fetchMock).not.toHaveBeenCalled()
    const [command, body, options] = mock.invoke.mock.calls[0]!
    expect(command).toBe('speech_runtime_transcribe')
    expect(body).toBeInstanceOf(Uint8Array)
    expect((body as Uint8Array).byteLength).toBe(44 + 320)
    expect(options.headers['x-typenext-request-id']).toMatch(/^dictation-/)
  })

  it('cancels a relayed request and falls back to HTTP when the relay is missing', async () => {
    mock.desktop = true
    mock.invoke.mockImplementation((command: string) =>
      command === 'speech_runtime_transcribe'
        ? new Promise(() => undefined)
        : Promise.resolve()
    )
    const controller = new AbortController()
    const pending = transcribeFluid(new Float32Array(160), {
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.invoke).toHaveBeenLastCalledWith(
      'speech_runtime_cancel_transcribe',
      { request: { requestId: expect.stringMatching(/^dictation-/) } }
    )
    mock.invoke
      .mockReset()
      .mockRejectedValue('Command speech_runtime_transcribe not found')
    const result = await transcribeFluid(new Float32Array(160))
    expect(result.text).toBe(ANSWER.text)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await transcribeFluid(new Float32Array(160))
    expect(mock.invoke).toHaveBeenCalledTimes(1)
  })

  it('shows the Hugging Face token guide when the model download is refused', async () => {
    mock.install.mockRejectedValueOnce(
      new Error('huggingface-auth: Hugging Face asks for a sign-in token.')
    )
    expect(await downloadFluidSpeech()).toEqual({
      error: 'Hugging Face asked for a token. Follow the guide to continue.',
    })
    expect(getHuggingFacePrompt()).toEqual({
      issue: 'auth',
      model: 'Fluid Speech Mini',
      repository: 'FluidVoice-Labs/fluid-speech-mini-gguf',
      source: 'speech',
    })
    resetHuggingFaceForTests()
    mock.install.mockResolvedValueOnce({
      state: 'error',
      installed: { runtime: true, model: false },
      error: 'Too many requests',
      errorCode: 'huggingface-rate-limit',
      diskBytes: 0,
    })
    expect((await downloadFluidSpeech()).error).toContain('token')
    expect(getHuggingFacePrompt()?.issue).toBe('rate-limit')
    resetHuggingFaceForTests()
    mock.install.mockRejectedValueOnce(new Error('Disk full'))
    expect(await downloadFluidSpeech()).toEqual({ error: 'Disk full' })
    expect(getHuggingFacePrompt()).toBeNull()
  })
})

const live = process.env.TYPENEXT_SPEECH_URL
describe.skipIf(!live)(
  'Fluid Speech Mini live server (TYPENEXT_SPEECH_URL)',
  () => {
    it('transcribes a 16 kHz WAV recording', async () => {
      vi.unstubAllGlobals()
      useNodeMultipart()
      const pcm = readWav(
        process.env.TYPENEXT_SPEECH_WAV ??
          `${process.env.TMPDIR ?? '/tmp'}/speech.wav`
      )
      const started = performance.now()
      const result = await transcribeFluid(pcm, {
        endpoint: live!,
        transport: 'http',
      })
      expect(result.text.length).toBeGreaterThan(3)
      expect(result.duration).toBeGreaterThan(0)
      // Optional: TYPENEXT_SPEECH_EXPECT="Bramble House" checks the words.
      const expected = process.env.TYPENEXT_SPEECH_EXPECT
      if (expected) expect(result.text).toContain(expected)
      expect(performance.now() - started).toBeLessThan(15_000)
    })
  }
)
