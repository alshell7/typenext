import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startWhistleRecording } from './whistle-recorder'

const getUserMedia = vi.fn()
const addModule = vi.fn()
const resume = vi.fn()
const contexts: FakeAudioContext[] = []
const nodes: FakeWorkletNode[] = []
let rejectRequestedRate = false
class FakeTrack extends EventTarget {
  stop = vi.fn()
}
const track = new FakeTrack()
const stream = { getTracks: () => [track] } as unknown as MediaStream
class FakeAudioContext {
  destination = {}
  close = vi.fn(async () => {})
  source = { connect: vi.fn(), disconnect: vi.fn() }
  audioWorklet = { addModule }
  constructor(options?: AudioContextOptions) {
    if (rejectRequestedRate && options) throw new Error('Unsupported rate')
    contexts.push(this)
  }
  resume = resume
  createMediaStreamSource = vi.fn(() => this.source)
}
class FakeWorkletNode {
  onprocessorerror: (() => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  }
  constructor() {
    nodes.push(this)
  }
  reply(data: unknown) {
    this.port.onmessage?.({ data } as MessageEvent)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  contexts.length = 0
  nodes.length = 0
  rejectRequestedRate = false
  track.stop.mockClear()
  getUserMedia.mockReset().mockResolvedValue(stream)
  addModule.mockReset().mockResolvedValue(undefined)
  resume.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('bounded microphone capture', () => {
  it('captures only after a direct call, stops the physical microphone before flushing, and closes the graph once', async () => {
    const duration = vi.fn()
    const capture = await startWhistleRecording({ onDuration: duration })
    const node = nodes[0]!
    const context = contexts[0]!
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: {
        channelCount: 1,
        sampleRate: 16_000,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
    expect(addModule.mock.calls[0]?.[0]).toContain(
      'whistle-recorder.worklet.js'
    )
    expect(context.source.connect).toHaveBeenCalledWith(node)
    expect(node.connect).toHaveBeenCalledWith(context.destination)
    node.reply({ type: 'progress', seconds: 31 })
    node.reply({ type: 'progress', seconds: -1 })
    node.reply({ type: 'progress', seconds: Number.NaN })
    expect(duration.mock.calls).toEqual([[30], [0]])
    let settled = false
    void capture.finished.then(() => {
      settled = true
    })
    capture.stop()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'stop' })
    expect(settled).toBe(false)
    const pcm = new Float32Array([0.1, -0.2])
    node.reply({ type: 'complete', samples: pcm })
    expect(await capture.finished).toBe(pcm)
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(node.port.close).toHaveBeenCalledTimes(1)
    capture.cancel()
    capture.stop()
    expect(context.close).toHaveBeenCalledTimes(1)
  })
  it('requires the explicitly selected input and never silently changes microphones', async () => {
    const capture = await startWhistleRecording({ deviceId: 'usb-input' })
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        audio: expect.objectContaining({ deviceId: { exact: 'usb-input' } }),
      })
    )
    const cancelled = expect(capture.finished).rejects.toMatchObject({
      name: 'AbortError',
    })
    capture.cancel()
    await cancelled
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, '', 'default'])(
    'uses the system input without a mandatory device constraint: %s',
    async deviceId => {
      const capture = await startWhistleRecording({ deviceId })
      expect(getUserMedia.mock.calls[0]?.[0].audio).not.toHaveProperty(
        'deviceId'
      )
      const cancelled = expect(capture.finished).rejects.toMatchObject({
        name: 'AbortError',
      })
      capture.cancel()
      await cancelled
    }
  )
  it.each(['OverconstrainedError', 'NotFoundError'])(
    'reports an unavailable selected input for %s without fallback',
    async name => {
      getUserMedia.mockRejectedValue(
        new DOMException('Missing selected input', name)
      )
      await expect(
        startWhistleRecording({ deviceId: 'disconnected' })
      ).rejects.toThrow('selected microphone is unavailable')
      expect(getUserMedia).toHaveBeenCalledTimes(1)
      expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
      expect(nodes).toHaveLength(0)
    }
  )
  it('rejects malformed or unsupported device selection before opening audio', async () => {
    await expect(
      startWhistleRecording({ deviceId: 'a'.repeat(513) })
    ).rejects.toThrow('Choose a microphone')
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia,
        getSupportedConstraints: () => ({ deviceId: false }),
      },
    })
    await expect(
      startWhistleRecording({ deviceId: 'usb-input' })
    ).rejects.toThrow('Choose System default')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(contexts).toHaveLength(0)
  })
  it('emits a finite bounded meter, resets it on Stop and ignores late levels while flushing', async () => {
    const level = vi.fn()
    const capture = await startWhistleRecording({ onLevel: level })
    const node = nodes[0]!
    node.reply({ type: 'progress', seconds: 0.2, level: 0.25 })
    node.reply({ type: 'progress', seconds: 0.4, level: 2 })
    node.reply({ type: 'progress', seconds: 0.6, level: -2 })
    node.reply({ type: 'progress', seconds: 0.8, level: Number.NaN })
    node.reply({
      type: 'progress',
      seconds: 1,
      level: Number.POSITIVE_INFINITY,
    })
    expect(level.mock.calls).toEqual([[0], [0.25], [1], [0]])
    capture.stop()
    expect(level).toHaveBeenLastCalledWith(0)
    const countAfterStop = level.mock.calls.length
    node.reply({ type: 'progress', seconds: 1.2, level: 0.9 })
    expect(level).toHaveBeenCalledTimes(countAfterStop)
    node.reply({ type: 'complete', samples: new Float32Array([0.1]) })
    await capture.finished
    expect(level).toHaveBeenLastCalledWith(0)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('stops listening at thirty seconds and times out a worklet that cannot flush', async () => {
    const capture = await startWhistleRecording()
    const failure = expect(capture.finished).rejects.toThrow('could not finish')
    vi.advanceTimersByTime(29_999)
    expect(track.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith({ type: 'stop' })
    vi.advanceTimersByTime(2_000)
    await failure
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('cancels capture immediately and discards late audio messages', async () => {
    const controller = new AbortController()
    const capture = await startWhistleRecording({ signal: controller.signal })
    const failure = expect(capture.finished).rejects.toMatchObject({
      name: 'AbortError',
    })
    const node = nodes[0]!
    controller.abort()
    await failure
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(node.port.onmessage).toBeNull()
    node.reply({ type: 'complete', samples: new Float32Array([0.1]) })
    expect(node.port.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops capture when the page is hidden', async () => {
    const capture = await startWhistleRecording()
    const failure = expect(capture.finished).rejects.toMatchObject({
      name: 'AbortError',
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await failure
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['NotAllowedError', 'Microphone access was denied'],
    ['NotFoundError', 'No microphone was found'],
  ])(
    'explains %s without leaving an audio graph running',
    async (name, message) => {
      getUserMedia.mockRejectedValue(new DOMException('OS media failure', name))
      await expect(startWhistleRecording()).rejects.toThrow(message)
      expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
      expect(nodes).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('rejects promptly if closed during a permission prompt and stops a later permission grant', async () => {
    let grant!: (value: MediaStream) => void
    getUserMedia.mockReturnValue(
      new Promise<MediaStream>(resolve => {
        grant = resolve
      })
    )
    const controller = new AbortController()
    const opening = startWhistleRecording({ signal: controller.signal })
    const failure = expect(opening).rejects.toMatchObject({
      name: 'AbortError',
    })
    controller.abort()
    await failure
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
    grant(stream)
    await Promise.resolve()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(nodes).toHaveLength(0)
  })
  it('cancels a still-pending permission prompt when hidden and stops its late grant', async () => {
    let grant!: (value: MediaStream) => void
    getUserMedia.mockReturnValue(
      new Promise<MediaStream>(resolve => {
        grant = resolve
      })
    )
    const opening = startWhistleRecording()
    const failure = expect(opening).rejects.toMatchObject({
      name: 'AbortError',
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await failure
    grant(stream)
    await Promise.resolve()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(nodes).toHaveLength(0)
  })

  it('stops a late microphone grant if loading its local worklet failed first', async () => {
    let grant!: (value: MediaStream) => void
    getUserMedia.mockReturnValue(
      new Promise<MediaStream>(resolve => {
        grant = resolve
      })
    )
    addModule.mockRejectedValue(new Error('Bundled worklet could not load'))
    await expect(startWhistleRecording()).rejects.toThrow('Bundled worklet')
    grant(stream)
    await Promise.resolve()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
  })
  it('distinguishes a startup AbortError from user cancellation', async () => {
    addModule.mockRejectedValue(
      new DOMException('Runtime module failed', 'AbortError')
    )
    await expect(startWhistleRecording()).rejects.toThrow(
      'Microphone setup was interrupted'
    )
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    new Float32Array(),
    new Float32Array([Number.NaN]),
    new Float32Array(480_001),
  ])(
    'rejects invalid audio before transcription and closes every capture resource',
    async pcm => {
      const capture = await startWhistleRecording()
      const failure = expect(capture.finished).rejects.toThrow(
        /audio|30 seconds/
      )
      nodes[0]?.reply({ type: 'complete', samples: pcm })
      await failure
      expect(track.stop).toHaveBeenCalledTimes(1)
      expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('handles disconnected microphones and unsupported requested sample rates', async () => {
    rejectRequestedRate = true
    const capture = await startWhistleRecording()
    const failure = expect(capture.finished).rejects.toThrow(
      'microphone disconnected'
    )
    track.dispatchEvent(new Event('ended'))
    await failure
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
})
