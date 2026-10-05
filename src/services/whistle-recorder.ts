import workletUrl from './whistle-recorder.worklet.js?url&no-inline'
import {
  microphoneAccessError,
  normalizedMicrophoneId,
} from './whistle-microphones'
import {
  WHISTLE_MAX_SECONDS,
  WHISTLE_SAMPLE_RATE,
  validateWhistleAudio,
} from './whistle-model'

export interface WhistleRecording {
  /** Resolves on Stop or the thirty-second limit; rejects on cancellation. */
  finished: Promise<Float32Array>
  stop(): void
  cancel(): void
}
export interface WhistleRecordingOptions {
  signal?: AbortSignal
  /** An explicit device is required exactly; absent/default follows the OS. */
  deviceId?: string
  onDuration?(seconds: number): void
  /** Normalized RMS amplitude (0..1), emitted at most about five times/second. */
  onLevel?(level: number): void
}

function aborted(): DOMException {
  return new DOMException('Recording cancelled.', 'AbortError')
}

/** Only call from a user's Record gesture. No speech-recognition network API is used. */
export async function startWhistleRecording(
  options: WhistleRecordingOptions = {}
): Promise<WhistleRecording> {
  if (options.signal?.aborted || document.visibilityState === 'hidden')
    throw aborted()
  const selectedId = normalizedMicrophoneId(options.deviceId)
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioContext === 'undefined' ||
    typeof AudioWorkletNode === 'undefined'
  )
    throw new Error(
      'Microphone recording is unavailable here. Use TypeNext desktop or a browser over HTTPS or localhost.'
    )
  if (
    selectedId &&
    navigator.mediaDevices.getSupportedConstraints &&
    !navigator.mediaDevices.getSupportedConstraints().deviceId
  )
    throw new Error(
      'Microphone selection is not supported here. Choose System default.'
    )
  let context: AudioContext
  try {
    context = new AudioContext({ sampleRate: WHISTLE_SAMPLE_RATE })
  } catch {
    context = new AudioContext()
  }
  if (!context.audioWorklet) {
    await context.close().catch(() => undefined)
    throw new Error(
      'Offline microphone capture needs AudioWorklet support. Update the browser or operating system.'
    )
  }
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let node: AudioWorkletNode | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  let stopping = false
  let cleaned = false
  let complete: ((pcm?: Float32Array, error?: Error) => void) | null = null
  let rejectStartup!: (error: Error) => void
  const startupAbort = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject
  })
  const tracks: MediaStreamTrack[] = []
  const ended = () =>
    complete?.(
      undefined,
      new Error('The microphone disconnected. Connect it and record again.')
    )
  const visibilityChanged = () => {
    if (document.visibilityState === 'hidden') cancel()
  }
  function cleanup() {
    if (cleaned) return
    cleaned = true
    if (timer !== null) clearTimeout(timer)
    if (stopTimer !== null) clearTimeout(stopTimer)
    options.signal?.removeEventListener('abort', cancel)
    document.removeEventListener('visibilitychange', visibilityChanged)
    for (const track of tracks) {
      track.removeEventListener('ended', ended)
      track.stop()
    }
    if (node) {
      node.port.onmessage = null
      node.onprocessorerror = null
      node.disconnect()
      node.port.close()
    }
    source?.disconnect()
    void context.close().catch(() => undefined)
    options.onLevel?.(0)
  }
  function cancel() {
    cancelled = true
    rejectStartup(aborted())
    if (complete) complete(undefined, aborted())
    else cleanup()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  document.addEventListener('visibilitychange', visibilityChanged)
  try {
    options.onLevel?.(0)
    // Start permission/resume while still inside the user's gesture. A late
    // permission grant after cancellation immediately stops its media tracks.
    const microphone = navigator.mediaDevices
      .getUserMedia({
        audio: {
          ...(selectedId ? { deviceId: { exact: selectedId } } : {}),
          channelCount: 1,
          sampleRate: WHISTLE_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      })
      .then(value => {
        stream = value
        if (cancelled || options.signal?.aborted)
          value.getTracks().forEach(track => track.stop())
        return value
      })
    const ready = Promise.all([
      microphone,
      context.resume(),
      context.audioWorklet.addModule(workletUrl),
    ])
    const [recordingStream] = await Promise.race([ready, startupAbort])
    if (cancelled || options.signal?.aborted) throw aborted()
    tracks.push(...recordingStream.getTracks())
    source = context.createMediaStreamSource(recordingStream)
    node = new AudioWorkletNode(context, 'typenext-whistle-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { emitLevel: typeof options.onLevel === 'function' },
    })
    const finished = new Promise<Float32Array>((resolve, reject) => {
      let settled = false
      complete = (pcm, error) => {
        if (settled) return
        settled = true
        cleanup()
        complete = null
        if (error) reject(error)
        else if (pcm) resolve(pcm)
        else
          reject(
            new Error(
              'No audio was captured. Check microphone permissions and record again.'
            )
          )
      }
    })
    node.port.onmessage = event => {
      if (
        event.data?.type === 'progress' &&
        Number.isFinite(event.data.seconds)
      )
        options.onDuration?.(
          Math.min(WHISTLE_MAX_SECONDS, Math.max(0, event.data.seconds))
        )
      if (
        !stopping &&
        event.data?.type === 'progress' &&
        Number.isFinite(event.data.level)
      )
        options.onLevel?.(Math.min(1, Math.max(0, event.data.level)))
      if (event.data?.type === 'complete') {
        try {
          validateWhistleAudio(event.data.samples)
          complete?.(event.data.samples)
        } catch (error) {
          complete?.(
            undefined,
            error instanceof Error
              ? error
              : new Error('The microphone returned invalid audio.')
          )
        }
      }
    }
    node.onprocessorerror = () =>
      complete?.(
        undefined,
        new Error('Microphone capture stopped. Record again.')
      )
    tracks.forEach(track =>
      track.addEventListener('ended', ended, { once: true })
    )
    source.connect(node)
    // The worklet writes no output samples, so the microphone is never played
    // through speakers. Connecting keeps its capture graph active on Safari.
    node.connect(context.destination)
    const stop = () => {
      if (!complete || stopTimer !== null) return
      stopping = true
      node?.port.postMessage({ type: 'stop' })
      // Stop the physical microphone immediately, including at the duration
      // limit; do not keep listening while waiting for the worklet to flush.
      for (const track of tracks) {
        track.removeEventListener('ended', ended)
        track.stop()
      }
      options.onLevel?.(0)
      stopTimer = setTimeout(
        () =>
          complete?.(
            undefined,
            new Error('Microphone capture could not finish. Record again.')
          ),
        2_000
      )
    }
    timer = setTimeout(stop, WHISTLE_MAX_SECONDS * 1_000)
    return { finished, stop, cancel }
  } catch (error) {
    const wasCancelled = cancelled || options.signal?.aborted
    cancelled = true
    if (stream)
      (stream as MediaStream).getTracks().forEach(track => track.stop())
    cleanup()
    if (wasCancelled) throw aborted()
    throw microphoneAccessError(error, selectedId)
  }
}
