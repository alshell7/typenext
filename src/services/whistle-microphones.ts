export interface WhistleMicrophone {
  /** Empty means the operating system/browser default input. */
  deviceId: string
  label: string
}
export interface WhistleMicrophoneOptions {
  signal?: AbortSignal
  /** Only set from the explicit microphone setup gesture, never on page load. */
  requestPermission?: boolean
}

function aborted(): DOMException {
  return new DOMException('Microphone setup cancelled.', 'AbortError')
}

export function normalizedMicrophoneId(deviceId?: string): string | undefined {
  if (deviceId === undefined) return undefined
  if (
    typeof deviceId !== 'string' ||
    deviceId.length > 512 ||
    deviceId.includes('\u0000')
  )
    throw new Error('Choose a microphone from the available devices.')
  const selected = deviceId.trim()
  return !selected || selected === 'default' ? undefined : selected
}

export function microphoneAccessError(
  error: unknown,
  selectedId?: string
): Error {
  const name =
    error && typeof error === 'object' && 'name' in error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new Error(
      'Microphone access was denied. Allow it in your browser or system privacy settings, then record again.'
    )
  if (
    selectedId &&
    (name === 'OverconstrainedError' || name === 'NotFoundError')
  )
    return new Error(
      'The selected microphone is unavailable. Reconnect it or choose another microphone or System default.'
    )
  if (name === 'NotFoundError')
    return new Error('No microphone was found. Connect one and record again.')
  if (name === 'NotReadableError' || name === 'TrackStartError')
    return new Error(
      'The microphone could not be opened. Close other apps using it and record again.'
    )
  if (name === 'AbortError')
    return new Error(
      'Microphone setup was interrupted. Check device permissions and record again.'
    )
  return error instanceof Error
    ? error
    : new Error('The microphone could not be opened. Record again.')
}

/** Local device metadata only. Permission access is a separate, explicit option. */
export async function listWhistleMicrophones(
  options: WhistleMicrophoneOptions = {}
): Promise<WhistleMicrophone[]> {
  if (options.signal?.aborted || document.visibilityState === 'hidden')
    throw aborted()
  const media = navigator.mediaDevices
  if (!media?.enumerateDevices)
    throw new Error(
      'Microphone selection is unavailable here. Use TypeNext desktop or a browser over HTTPS or localhost.'
    )
  let stream: MediaStream | null = null
  let stopped: Error | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectWaiting!: (error: Error) => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectWaiting = reject
  })
  const stopTracks = () => {
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }
  const cancel = () => {
    stopped = aborted()
    stopTracks()
    rejectWaiting(stopped)
  }
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') cancel()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  document.addEventListener('visibilitychange', visibilityChanged)
  try {
    if (options.requestPermission) {
      if (!media.getUserMedia)
        throw new Error('Microphone access is unavailable here.')
      // Keep the temporary stream only while reading labels. Some browsers
      // expose names only during a permitted stream, rather than after Stop.
      const permission = media
        .getUserMedia({ audio: true, video: false })
        .then(value => {
          if (
            stopped ||
            options.signal?.aborted ||
            document.visibilityState === 'hidden'
          ) {
            value.getTracks().forEach(track => track.stop())
            throw stopped ?? aborted()
          }
          stream = value
        })
      await Promise.race([permission, interrupted])
    }
    timer = setTimeout(() => {
      stopped = new Error(
        'Microphone details could not be read. Try refreshing the list.'
      )
      stopTracks()
      rejectWaiting(stopped)
    }, 3_000)
    const devices = await Promise.race([media.enumerateDevices(), interrupted])
    if (stopped || options.signal?.aborted) throw stopped ?? aborted()
    const result: WhistleMicrophone[] = [
      { deviceId: '', label: 'System default' },
    ]
    const seen = new Set(['', 'default'])
    for (const device of devices.slice(0, 256)) {
      if (
        device.kind !== 'audioinput' ||
        seen.has(device.deviceId) ||
        !device.deviceId ||
        device.deviceId.length > 512 ||
        device.deviceId.includes('\u0000')
      )
        continue
      seen.add(device.deviceId)
      result.push({
        deviceId: device.deviceId,
        label:
          device.label.split('\u0000').join('').trim().slice(0, 160) ||
          `Microphone ${result.length}`,
      })
      if (result.length >= 65) break
    }
    return result
  } catch (error) {
    if (stopped || options.signal?.aborted) throw stopped ?? aborted()
    throw microphoneAccessError(error)
  } finally {
    if (timer !== null) clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    document.removeEventListener('visibilitychange', visibilityChanged)
    stopTracks()
  }
}

/** Subscribes without requesting access, enumerating devices or opening audio. */
export function subscribeWhistleMicrophoneChanges(
  listener: () => void
): () => void {
  const media = navigator.mediaDevices
  if (!media?.addEventListener) return () => undefined
  media.addEventListener('devicechange', listener)
  return () => media.removeEventListener('devicechange', listener)
}
