import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhistleState } from './whistle'
import type { SpeechRuntimeStatus } from './speech-runtime'

const mock = vi.hoisted(() => ({
  whistle: {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 0,
  } as WhistleState,
  speech: {
    state: 'idle',
    installed: { runtime: true, model: true },
    diskBytes: 1,
  } as SpeechRuntimeStatus,
  transcribeWhistle: vi.fn(),
  loadWhistle: vi.fn(),
  unloadWhistle: vi.fn(),
  endpoint: vi.fn(),
  stop: vi.fn(),
  transcribeFluid: vi.fn(),
}))
vi.mock('./whistle', () => ({
  getWhistleState: () => mock.whistle,
  loadWhistleModel: mock.loadWhistle,
  transcribeWhistle: mock.transcribeWhistle,
  unloadWhistleModel: mock.unloadWhistle,
}))
vi.mock('./speech-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('./speech-runtime')>()),
  getSpeechRuntimeStatus: () => mock.speech,
  speechEndpoint: mock.endpoint,
  stopSpeechRuntime: mock.stop,
}))
vi.mock('./fluid-speech', () => ({ transcribeFluid: mock.transcribeFluid }))
import {
  FLUID_IDLE_STOP_MS,
  chooseDictationEngine,
  dictationEngine,
  fluidEngine,
  fluidReadiness,
  resetDictationEnginesForTests,
  whistleEngine,
  whistleReadiness,
} from './dictation-engine'

beforeEach(() => {
  resetDictationEnginesForTests()
  mock.whistle = {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 0,
  }
  mock.speech = {
    state: 'idle',
    installed: { runtime: true, model: true },
    diskBytes: 1,
  }
  mock.transcribeWhistle
    .mockReset()
    .mockResolvedValue({ text: 'Hello.', language: 'en' })
  mock.loadWhistle.mockReset().mockResolvedValue(undefined)
  mock.unloadWhistle.mockReset()
  mock.endpoint.mockReset().mockResolvedValue('http://127.0.0.1:1')
  mock.stop.mockReset().mockResolvedValue(mock.speech)
  mock.transcribeFluid
    .mockReset()
    .mockResolvedValue({ text: 'Fluid words.', duration: 1, segments: [] })
})
afterEach(() => {
  vi.useRealTimers()
  resetDictationEnginesForTests()
})

describe('dictation engines', () => {
  it('describes each engine’s capabilities', () => {
    expect(whistleEngine.capabilities).toMatchObject({
      maxSeconds: 30,
      livePhrases: false,
      interim: false,
    })
    expect(fluidEngine.capabilities).toMatchObject({
      livePhrases: true,
      interim: true,
      languages: ['en'],
    })
    expect(fluidEngine.capabilities.maxSeconds).toBeGreaterThan(600)
    expect(dictationEngine('fluid')).toBe(fluidEngine)
    expect(dictationEngine('whistle')).toBe(whistleEngine)
  })

  it('reports readiness from each engine’s own state', () => {
    expect(whistleReadiness(mock.whistle)).toEqual({ state: 'ready' })
    expect(whistleReadiness({ ...mock.whistle, cached: false })).toMatchObject({
      state: 'setup',
      action: 'Download Whistle · 17 MB',
    })
    expect(
      whistleReadiness({ ...mock.whistle, status: 'downloading', progress: 40 })
    ).toEqual({ state: 'busy', message: 'Downloading Whistle', progress: 0.4 })
    expect(
      whistleReadiness({ ...mock.whistle, status: 'unavailable' }).state
    ).toBe('unavailable')
    expect(fluidReadiness(mock.speech)).toEqual({ state: 'ready' })
    expect(
      fluidReadiness({
        ...mock.speech,
        installed: { runtime: true, model: false },
      })
    ).toMatchObject({
      state: 'setup',
      action: 'Download Fluid Speech Mini (347 MB)',
    })
    expect(
      fluidReadiness({
        ...mock.speech,
        state: 'downloading',
        progress: { file: 'model', downloadedBytes: 50, totalBytes: 200 },
      })
    ).toEqual({
      state: 'busy',
      message: 'Downloading Fluid Speech Mini',
      progress: 0.25,
    })
    expect(
      fluidReadiness({ ...mock.speech, state: 'unsupported' })
    ).toMatchObject({
      state: 'unavailable',
      message: 'Fluid Speech Mini needs the TypeNext desktop app.',
    })
  })

  it('chooses the preferred engine when ready', () => {
    expect(chooseDictationEngine('fluid')).toMatchObject({
      engine: fluidEngine,
      fallback: false,
    })
    expect(chooseDictationEngine('whistle').engine).toBe(whistleEngine)
  })

  it('offers Whistle when Fluid is not installed and uses it once accepted', () => {
    mock.speech = {
      ...mock.speech,
      installed: { runtime: false, model: false },
    }
    expect(chooseDictationEngine('fluid')).toMatchObject({
      engine: null,
      preferred: fluidEngine,
      readiness: { state: 'setup' },
      canFallBack: true,
    })
    expect(chooseDictationEngine('fluid', true)).toMatchObject({
      engine: whistleEngine,
      fallback: true,
    })
    mock.whistle = { ...mock.whistle, cached: false }
    expect(chooseDictationEngine('fluid', true).engine).toBeNull()
  })

  it('falls back to Whistle by itself where Fluid cannot run', () => {
    mock.speech = { ...mock.speech, state: 'unsupported' }
    expect(chooseDictationEngine('fluid')).toMatchObject({
      engine: whistleEngine,
      fallback: true,
    })
  })

  it('needs setup for Whistle before its download', () => {
    mock.whistle = { ...mock.whistle, cached: false }
    expect(chooseDictationEngine('whistle')).toMatchObject({
      engine: null,
      canFallBack: false,
      readiness: { state: 'setup' },
    })
  })

  it('transcribes with Whistle and frees it after a cancelled clip', async () => {
    const pcm = new Float32Array(10)
    await whistleEngine.prepare()
    expect(mock.loadWhistle).toHaveBeenCalledTimes(1)
    expect(await whistleEngine.transcribe(pcm, { language: 'fr' })).toBe(
      'Hello.'
    )
    expect(mock.transcribeWhistle).toHaveBeenCalledWith(
      pcm,
      expect.objectContaining({ language: 'fr' })
    )
    whistleEngine.release(false)
    expect(mock.unloadWhistle).not.toHaveBeenCalled()
    whistleEngine.release(true)
    expect(mock.unloadWhistle).toHaveBeenCalledTimes(1)
  })

  it('starts Fluid on prepare and stops it after 15 minutes without dictation', async () => {
    vi.useFakeTimers()
    await fluidEngine.prepare()
    expect(mock.endpoint).toHaveBeenCalledTimes(1)
    expect(await fluidEngine.transcribe(new Float32Array(10))).toBe(
      'Fluid words.'
    )
    mock.speech = {
      ...mock.speech,
      state: 'running',
      running: { endpoint: 'x' },
    }
    fluidEngine.release(false)
    vi.advanceTimersByTime(FLUID_IDLE_STOP_MS - 1)
    expect(mock.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mock.stop).toHaveBeenCalledTimes(1)
  })

  it('restarts the idle clock when dictation resumes', async () => {
    vi.useFakeTimers()
    mock.speech = {
      ...mock.speech,
      state: 'running',
      running: { endpoint: 'x' },
    }
    await fluidEngine.prepare()
    fluidEngine.release(false)
    vi.advanceTimersByTime(FLUID_IDLE_STOP_MS / 2)
    await fluidEngine.prepare()
    vi.advanceTimersByTime(FLUID_IDLE_STOP_MS)
    expect(mock.stop).not.toHaveBeenCalled()
    fluidEngine.release(true)
    vi.advanceTimersByTime(FLUID_IDLE_STOP_MS)
    expect(mock.stop).toHaveBeenCalledTimes(1)
  })

  it('pairs a failed Fluid start with its release', async () => {
    vi.useFakeTimers()
    mock.endpoint.mockRejectedValueOnce(
      new Error('Fluid Speech Mini did not start.')
    )
    await expect(fluidEngine.prepare()).rejects.toThrow('did not start')
    fluidEngine.release(true)
    mock.speech = {
      ...mock.speech,
      state: 'running',
      running: { endpoint: 'x' },
    }
    vi.advanceTimersByTime(FLUID_IDLE_STOP_MS)
    expect(mock.stop).toHaveBeenCalledTimes(1)
  })
})
