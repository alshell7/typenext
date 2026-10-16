import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from './native'
import { huggingFaceIssue, requestHuggingFaceToken } from './huggingface'
import {
  SPEECH_RUNTIME,
  installSpeechRuntime,
  speechEndpoint,
  type SpeechRuntimeStatus,
} from './speech-runtime'

/**
 * Client for Fluid Speech Mini in the managed `parakeet-server`. Audio goes
 * as 16-bit PCM WAV, built in memory, to the loopback server only.
 *
 * The webview cannot read the server's responses directly because it sends
 * no CORS headers, so the desktop app relays the request through the native
 * `speech_runtime_transcribe` command. `fetch` is the fallback for tests,
 * browser development and servers that allow the page's origin.
 */
export const FLUID_REQUEST_MODEL = 'fluid-speech-mini'
export const FLUID_TIMEOUT_MS = 45_000
export const FLUID_MAX_TEXT = 60_000

export interface FluidSegment {
  start: number
  end: number
  text: string
}
export interface FluidTranscript {
  text: string
  duration: number
  segments: FluidSegment[]
}
export interface FluidTranscribeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Use this server instead of the managed one (tests, live check). */
  endpoint?: string
  /** `auto` relays through the desktop app when it can. */
  transport?: 'auto' | 'native' | 'http'
}

function aborted() {
  return new DOMException('Dictation cancelled.', 'AbortError')
}

/** RIFF/WAVE, mono, 16-bit little-endian PCM. Samples are clamped. */
export function encodeWav(
  pcm: Float32Array,
  sampleRate: number = SPEECH_RUNTIME.sampleRate
): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let index = 0; index < pcm.length; index++) {
    const value = Math.max(-1, Math.min(1, pcm[index] || 0))
    view.setInt16(
      44 + index * 2,
      value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff),
      true
    )
  }
  return bytes
}

export function parseFluidTranscript(value: unknown): FluidTranscript {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Fluid Speech Mini returned an unreadable answer.')
  const result = value as Record<string, unknown>
  if (
    typeof result.text !== 'string' ||
    result.text.length > FLUID_MAX_TEXT ||
    result.text.includes('\u0000')
  )
    throw new Error('Fluid Speech Mini returned an unreadable answer.')
  const segments = Array.isArray(result.segments)
    ? result.segments.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const segment = item as Record<string, unknown>
        return typeof segment.text === 'string' &&
          Number.isFinite(segment.start) &&
          Number.isFinite(segment.end)
          ? [
              {
                start: Number(segment.start),
                end: Number(segment.end),
                text: segment.text.trim(),
              },
            ]
          : []
      })
    : []
  return {
    text: result.text.replace(/\s+/gu, ' ').trim(),
    duration: Number.isFinite(result.duration) ? Number(result.duration) : 0,
    segments,
  }
}

function serverError(status: number, body: string): Error {
  let detail = ''
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown } }
    if (typeof value.error?.message === 'string')
      detail = value.error.message.slice(0, 160)
  } catch {
    // Keep unreadable bodies out of the interface.
  }
  if (status === 503 || status === 502)
    return new Error('Fluid Speech Mini is still starting. Try again shortly.')
  return new Error(
    `Fluid Speech Mini returned HTTP ${status}.${detail ? ` ${detail}` : ''}`
  )
}

async function viaHttp(
  endpoint: string,
  wav: Uint8Array,
  signal: AbortSignal
): Promise<unknown> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([wav as BlobPart], { type: 'audio/wav' }),
    'dictation.wav'
  )
  form.append('model', FLUID_REQUEST_MODEL)
  form.append('response_format', 'verbose_json')
  let response: Response
  try {
    response = await fetch(
      `${endpoint.replace(/\/+$/u, '')}/v1/audio/transcriptions`,
      {
        method: 'POST',
        body: form,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      }
    )
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(
      'TypeNext could not reach Fluid Speech Mini. Restart it in Preferences → Dictation.'
    )
  }
  const body = await response.text()
  if (!response.ok) throw serverError(response.status, body)
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error('Fluid Speech Mini returned an unreadable answer.')
  }
}

let nativeMissing = false
let nextRequest = 0

function missingCommand(error: unknown) {
  return /not found|unknown command|not allowed|command .*speech_runtime_transcribe/iu.test(
    String(error instanceof Error ? error.message : error)
  )
}

function nativeError(error: unknown): Error {
  const text = String(error instanceof Error ? error.message : error)
  const status = /\bHTTP (\d{3})\b/u.exec(text)?.[1]
  if (status) return serverError(Number(status), '')
  return new Error(text.slice(0, 240) || 'Fluid Speech Mini did not answer.')
}

/** Relay through the desktop app. The raw request body is the WAV file. */
function viaNative(wav: Uint8Array, signal: AbortSignal): Promise<unknown> {
  const id = `dictation-${Date.now().toString(36)}-${++nextRequest}`
  return new Promise((resolve, reject) => {
    const stop = () => {
      void invoke('speech_runtime_cancel_transcribe', {
        request: { requestId: id },
      }).catch(
        () => undefined
      )
      reject(aborted())
    }
    signal.addEventListener('abort', stop, { once: true })
    invoke<unknown>('speech_runtime_transcribe', wav, {
      headers: { 'x-typenext-request-id': id },
    })
      .then(resolve, error => reject(signal.aborted ? aborted() : error))
      .finally(() => signal.removeEventListener('abort', stop))
  })
}

async function requestOnce(
  pcm: Float32Array,
  options: FluidTranscribeOptions,
  signal: AbortSignal
): Promise<FluidTranscript> {
  // Starts the managed server on demand; concurrent callers share the start.
  const endpoint = options.endpoint ?? (await speechEndpoint())
  if (signal.aborted) throw aborted()
  const wav = encodeWav(pcm)
  const transport = options.transport ?? 'auto'
  if (
    transport === 'native' ||
    (transport === 'auto' && isDesktop() && !options.endpoint && !nativeMissing)
  ) {
    try {
      return parseFluidTranscript(await viaNative(wav, signal))
    } catch (error) {
      if (signal.aborted) throw aborted()
      if (transport === 'native' || !missingCommand(error))
        throw nativeError(error)
      // A desktop build without the relay: try the server directly.
      nativeMissing = true
    }
  }
  return parseFluidTranscript(await viaHttp(endpoint, wav, signal))
}

/**
 * Transcribe 16 kHz mono PCM. Longer audio is sent in parts of at most
 * `SPEECH_RUNTIME.maxRequestSeconds` and joined in order.
 */
export async function transcribeFluid(
  pcm: Float32Array,
  options: FluidTranscribeOptions = {}
): Promise<FluidTranscript> {
  if (options.signal?.aborted) throw aborted()
  if (!(pcm instanceof Float32Array) || pcm.length === 0)
    throw new Error('Record a moment of speech first.')
  const controller = new AbortController()
  let timedOut = false
  const stop = () => controller.abort()
  options.signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? FLUID_TIMEOUT_MS)
  try {
    const part = SPEECH_RUNTIME.maxRequestSeconds * SPEECH_RUNTIME.sampleRate
    const results: FluidTranscript[] = []
    for (let start = 0; start < pcm.length; start += part) {
      results.push(
        await requestOnce(
          pcm.subarray(start, Math.min(pcm.length, start + part)),
          options,
          controller.signal
        )
      )
      if (controller.signal.aborted) throw aborted()
    }
    let offset = 0
    const segments: FluidSegment[] = []
    for (const result of results) {
      segments.push(
        ...result.segments.map(segment => ({
          ...segment,
          start: segment.start + offset,
          end: segment.end + offset,
        }))
      )
      offset += result.duration
    }
    return {
      text: results
        .map(result => result.text)
        .filter(Boolean)
        .join(' '),
      duration: offset || pcm.length / SPEECH_RUNTIME.sampleRate,
      segments,
    }
  } catch (error) {
    if (timedOut)
      throw new Error(
        'Fluid Speech Mini took too long to answer. Try again, or restart it in Preferences → Dictation.'
      )
    if (
      options.signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      throw aborted()
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
  }
}

/**
 * Ask for the Hugging Face token guide when the download was refused, with
 * `source: 'speech'` so the guide can retry this download.
 */
export function promptForFluidRefusal(
  error: unknown,
  status?: SpeechRuntimeStatus
): boolean {
  const issue =
    huggingFaceIssue(status?.errorCode ?? null) ??
    (error === undefined
      ? null
      : huggingFaceIssue(
          error instanceof Error ? error.message : String(error)
        ))
  if (!issue) return false
  requestHuggingFaceToken({
    issue,
    model: SPEECH_RUNTIME.model.name,
    repository: SPEECH_RUNTIME.modelRepository,
    source: 'speech',
  })
  return true
}

/**
 * The explicit download action. Shows the token guide for a Hugging Face
 * refusal and returns a short message for any other failure.
 */
export async function downloadFluidSpeech(): Promise<{
  status?: SpeechRuntimeStatus
  error?: string
}> {
  try {
    const status = await installSpeechRuntime()
    if (status.errorCode && promptForFluidRefusal(undefined, status))
      return {
        status,
        error: 'Hugging Face asked for a token. Follow the guide to continue.',
      }
    return { status }
  } catch (error) {
    if (promptForFluidRefusal(error))
      return {
        error: 'Hugging Face asked for a token. Follow the guide to continue.',
      }
    const text = String(error instanceof Error ? error.message : error)
    return {
      error:
        text && text !== '[object Object]'
          ? text.slice(0, 240)
          : 'Fluid Speech Mini could not be downloaded.',
    }
  }
}

/** Test-only reset. */
export function resetFluidSpeechForTests() {
  nativeMissing = false
  nextRequest = 0
}
