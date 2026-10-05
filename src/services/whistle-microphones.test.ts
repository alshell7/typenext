import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWhistleMicrophones,
  subscribeWhistleMicrophoneChanges,
} from './whistle-microphones'

class FakeMedia extends EventTarget {
  enumerateDevices = vi.fn()
  getUserMedia = vi.fn()
}
const media = new FakeMedia()
const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
function input(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    label,
    kind: 'audioinput',
    groupId: '',
    toJSON: () => ({}),
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  track.stop.mockClear()
  media.enumerateDevices.mockReset().mockResolvedValue([])
  media.getUserMedia.mockReset().mockResolvedValue(stream)
  vi.stubGlobal('navigator', { mediaDevices: media })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('explicit microphone selection', () => {
  it('lists local metadata without requesting access and excludes duplicate/default/non-input devices', async () => {
    media.enumerateDevices.mockResolvedValue([
      input('default', 'Default - USB'),
      input('usb', 'USB microphone'),
      input('anonymous', ''),
      input('usb', 'Duplicate'),
      input('', ''),
      { ...input('speaker', 'Speaker'), kind: 'audiooutput' },
    ])
    expect(await listWhistleMicrophones()).toEqual([
      { deviceId: '', label: 'System default' },
      { deviceId: 'usb', label: 'USB microphone' },
      { deviceId: 'anonymous', label: 'Microphone 2' },
    ])
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(track.stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('requests audio only from explicit setup access, reads names while permitted and immediately stops that stream', async () => {
    media.enumerateDevices.mockImplementation(async () => {
      expect(track.stop).not.toHaveBeenCalled()
      return [input('usb', 'USB microphone')]
    })
    expect(
      await listWhistleMicrophones({ requestPermission: true })
    ).toHaveLength(2)
    expect(media.getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: true,
      video: false,
    })
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a permission prompt promptly and stops a late grant without enumerating or recording', async () => {
    let grant!: (value: MediaStream) => void
    media.getUserMedia.mockReturnValue(
      new Promise<MediaStream>(resolve => {
        grant = resolve
      })
    )
    const controller = new AbortController()
    const listing = listWhistleMicrophones({
      requestPermission: true,
      signal: controller.signal,
    })
    const failure = expect(listing).rejects.toMatchObject({
      name: 'AbortError',
    })
    controller.abort()
    await failure
    grant(stream)
    await Promise.resolve()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })
  it('stops setup access when hidden, including a late permission grant', async () => {
    let grant!: (value: MediaStream) => void
    media.getUserMedia.mockReturnValue(
      new Promise<MediaStream>(resolve => {
        grant = resolve
      })
    )
    const listing = listWhistleMicrophones({ requestPermission: true })
    const failure = expect(listing).rejects.toMatchObject({
      name: 'AbortError',
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await failure
    grant(stream)
    await Promise.resolve()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })
  it('does not open audio or enumerate when already cancelled or hidden', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      listWhistleMicrophones({
        signal: controller.signal,
        requestPermission: true,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await expect(
      listWhistleMicrophones({ requestPermission: true })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })
  it('cancels a pending enumeration and releases its temporary input stream', async () => {
    media.enumerateDevices.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const listing = listWhistleMicrophones({
      requestPermission: true,
      signal: controller.signal,
    })
    const failure = expect(listing).rejects.toMatchObject({
      name: 'AbortError',
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await failure
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds how long enumeration may hold an allowed microphone open', async () => {
    media.enumerateDevices.mockReturnValue(new Promise(() => {}))
    const listing = listWhistleMicrophones({ requestPermission: true })
    const failure = expect(listing).rejects.toThrow('details could not be read')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    vi.advanceTimersByTime(2_999)
    expect(track.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await failure
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports denied setup permission and does not retry through another input', async () => {
    media.getUserMedia.mockRejectedValue(
      new DOMException('Denied', 'NotAllowedError')
    )
    await expect(
      listWhistleMicrophones({ requestPermission: true })
    ).rejects.toThrow('Microphone access was denied')
    expect(media.getUserMedia).toHaveBeenCalledTimes(1)
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })
  it('bounds retained choices and display names', async () => {
    media.enumerateDevices.mockResolvedValue(
      Array.from({ length: 300 }, (_, index) =>
        input(`input-${index}`, 'a'.repeat(200))
      )
    )
    const microphones = await listWhistleMicrophones()
    expect(microphones).toHaveLength(65)
    expect(microphones[1]?.label).toHaveLength(160)
  })
  it('subscribes/unsubscribes to device changes without opening audio or querying devices', () => {
    const changed = vi.fn()
    const unsubscribe = subscribeWhistleMicrophoneChanges(changed)
    media.dispatchEvent(new Event('devicechange'))
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
    media.dispatchEvent(new Event('devicechange'))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(media.getUserMedia).not.toHaveBeenCalled()
    expect(media.enumerateDevices).not.toHaveBeenCalled()
  })
})
