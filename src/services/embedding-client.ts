import type { EmbeddingDimensions, MediaKind } from '../types/notebook'
import type { EmbeddingEndpoint } from './embedding-runtime'

/** Full EmbeddingGemma 2 output width. Shorter vectors are Matryoshka prefixes. */
export const EMBEDDING_WIDTH = 768
export const EMBEDDING_MODEL = 'google/embeddinggemma-2'
const MAX_BATCH = 16
const MAX_TEXT_CHARACTERS = 6_000
const TEXT_TIMEOUT_MS = 30_000
const MEDIA_TIMEOUT_MS = 180_000
const MAX_QUEUED_BACKGROUND = 64

export interface EmbeddingServerInfo {
  mediaMarker?: string
  modalities: { vision: boolean; audio: boolean; video: boolean }
  build?: string
}

export interface MediaInput {
  kind: MediaKind
  /** Base64 file bytes as the server expects them (PNG/JPEG, WAV/MP3, MP4). */
  base64: string
}

type Priority = 'interactive' | 'background'
interface Job {
  priority: Priority
  signal?: AbortSignal
  run(): Promise<void>
}

// llama-server runs one slot. Interactive queries go ahead of indexing.
const queue: Job[] = []
let draining = false
const infoCache = new Map<string, Promise<EmbeddingServerInfo>>()

function abortError() {
  return new DOMException('Embedding cancelled.', 'AbortError')
}

function enqueue<T>(
  priority: Priority,
  signal: AbortSignal | undefined,
  work: () => Promise<T>
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const job: Job = {
      priority,
      signal,
      async run() {
        if (signal?.aborted) return reject(abortError())
        try {
          resolve(await work())
        } catch (error) {
          reject(error)
        }
      },
    }
    if (priority === 'interactive') {
      const firstBackground = queue.findIndex(
        item => item.priority === 'background'
      )
      queue.splice(firstBackground < 0 ? queue.length : firstBackground, 0, job)
    } else {
      if (
        queue.filter(item => item.priority === 'background').length >=
        MAX_QUEUED_BACKGROUND
      )
        return reject(new Error('The embedding queue is full. Try again soon.'))
      queue.push(job)
    }
    void drain()
  })
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      // An aborted job rejects immediately inside run().
      await queue.shift()!.run()
    }
  } finally {
    draining = false
  }
}

function headers(endpoint: EmbeddingEndpoint): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  }
}

async function post(
  endpoint: EmbeddingEndpoint,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, timeoutMs)
  try {
    const response = await fetch(`${endpoint.endpoint}${path}`, {
      method: 'POST',
      headers: headers(endpoint),
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = ''
      try {
        const value = JSON.parse(text) as { error?: { message?: string } }
        detail = value.error?.message ?? ''
      } catch {
        // Keep HTML or proxy errors out of the interface.
      }
      throw new Error(
        `The embedding server returned HTTP ${response.status}.${detail ? ` ${detail.slice(0, 200)}` : ''}`
      )
    }
    return JSON.parse(text) as unknown
  } catch (error) {
    if (signal?.aborted) throw abortError()
    if (controller.signal.aborted)
      throw new Error('The embedding server took too long to respond.')
    if (error instanceof TypeError)
      throw new Error(
        'TypeNext could not reach the embedding server. Check that it is running.'
      )
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/** Unit vector of the leading `dimensions` values (Matryoshka truncation). */
export function truncateVector(
  vector: ArrayLike<number>,
  dimensions: number = EMBEDDING_WIDTH
): Float32Array {
  const size = Math.min(dimensions, vector.length)
  const result = new Float32Array(size)
  let norm = 0
  for (let index = 0; index < size; index++) {
    const value = Number(vector[index])
    result[index] = value
    norm += value * value
  }
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm === 0)
    throw new Error('The embedding server returned an invalid vector.')
  for (let index = 0; index < size; index++) result[index]! /= norm
  return result
}

export function dot(a: Float32Array, b: Float32Array): number {
  const size = Math.min(a.length, b.length)
  let total = 0
  for (let index = 0; index < size; index++) total += a[index]! * b[index]!
  return total
}

function validVector(value: unknown): number[] {
  const vector =
    Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value
  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_WIDTH ||
    !vector.every(item => typeof item === 'number' && Number.isFinite(item))
  )
    throw new Error(
      'The embedding server returned an unexpected vector. Use EmbeddingGemma 2 with mean pooling.'
    )
  return vector as number[]
}

/** EmbeddingGemma 2 retrieval prefix for a search query. */
export function queryPrompt(query: string): string {
  return `task: search result | query: ${query.replace(/\s+/gu, ' ').trim().slice(0, MAX_TEXT_CHARACTERS)}`
}

/** EmbeddingGemma 2 document format. `none` marks a missing title. */
export function documentPrompt(title: string, text: string): string {
  const name =
    title
      .replace(/[|\s]+/gu, ' ')
      .trim()
      .slice(0, 200) || 'none'
  return `title: ${name} | text: ${text.slice(0, MAX_TEXT_CHARACTERS)}`
}

export async function embeddingServerInfo(
  endpoint: EmbeddingEndpoint,
  signal?: AbortSignal
): Promise<EmbeddingServerInfo> {
  const key = `${endpoint.endpoint}\u0000${endpoint.apiKey ?? ''}`
  let pending = infoCache.get(key)
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`${endpoint.endpoint}/props`, {
        headers: headers(endpoint),
        credentials: 'omit',
        signal,
      }).catch(() => {
        throw new Error(
          'TypeNext could not reach the embedding server. Check that it is running.'
        )
      })
      if (!response.ok)
        throw new Error(
          `The embedding server returned HTTP ${response.status} for its properties.`
        )
      const props = (await response.json()) as {
        media_marker?: unknown
        modalities?: { vision?: unknown; audio?: unknown; video?: unknown }
        build_info?: unknown
      }
      return {
        ...(typeof props.media_marker === 'string'
          ? { mediaMarker: props.media_marker }
          : {}),
        modalities: {
          vision: props.modalities?.vision === true,
          audio: props.modalities?.audio === true,
          video: props.modalities?.video === true,
        },
        ...(typeof props.build_info === 'string'
          ? { build: props.build_info.slice(0, 80) }
          : {}),
      }
    })()
    infoCache.set(key, pending)
    pending.catch(() => infoCache.delete(key))
  }
  return pending
}

/** Embed prepared prompts. Results are unit vectors of `dimensions`. */
export function embedTexts(
  endpoint: EmbeddingEndpoint,
  prompts: string[],
  dimensions: EmbeddingDimensions,
  options: { signal?: AbortSignal; priority?: Priority } = {}
): Promise<Float32Array[]> {
  const batches: string[][] = []
  for (let index = 0; index < prompts.length; index += MAX_BATCH)
    batches.push(prompts.slice(index, index + MAX_BATCH))
  return Promise.all(
    batches.map(batch =>
      enqueue(options.priority ?? 'interactive', options.signal, async () => {
        const value = (await post(
          endpoint,
          '/v1/embeddings',
          {
            model: 'embeddinggemma2',
            input: batch,
            encoding_format: 'float',
          },
          TEXT_TIMEOUT_MS,
          options.signal
        )) as { data?: { index?: number; embedding?: unknown }[] }
        if (!Array.isArray(value?.data) || value.data.length !== batch.length)
          throw new Error('The embedding server returned an incomplete batch.')
        const ordered = [...value.data].sort(
          (a, b) => (a.index ?? 0) - (b.index ?? 0)
        )
        return ordered.map(item =>
          truncateVector(validVector(item.embedding), dimensions)
        )
      })
    )
  ).then(results => results.flat())
}

/** Embed one image, audio clip or video at full width. */
export function embedMedia(
  endpoint: EmbeddingEndpoint,
  input: MediaInput,
  options: { signal?: AbortSignal } = {}
): Promise<Float32Array> {
  return enqueue('interactive', options.signal, async () => {
    const info = await embeddingServerInfo(endpoint, options.signal)
    const supported =
      input.kind === 'image'
        ? info.modalities.vision
        : input.kind === 'audio'
          ? info.modalities.audio
          : info.modalities.video
    if (!supported || !info.mediaMarker)
      throw new Error(
        `This embedding server cannot read ${input.kind}. Turn on images, audio and video in Preferences → Knowledge.`
      )
    const value = (await post(
      endpoint,
      '/embeddings',
      {
        content: {
          prompt_string: info.mediaMarker,
          multimodal_data: [input.base64],
        },
      },
      MEDIA_TIMEOUT_MS,
      options.signal
    )) as { embedding?: unknown }[] | { embedding?: unknown }
    const item = Array.isArray(value) ? value[0] : value
    return truncateVector(validVector(item?.embedding), EMBEDDING_WIDTH)
  })
}

/** Connection check for Preferences. Embeds one short probe. */
export async function checkEmbeddingServer(
  endpoint: EmbeddingEndpoint,
  signal?: AbortSignal
): Promise<EmbeddingServerInfo & { latencyMs: number }> {
  infoCache.clear()
  const started = performance.now()
  const info = await embeddingServerInfo(endpoint, signal)
  await embedTexts(endpoint, [queryPrompt('connection check')], 128, { signal })
  return { ...info, latencyMs: Math.round(performance.now() - started) }
}

export function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(
    vector.buffer,
    vector.byteOffset,
    vector.byteLength
  )
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function decodeVector(value: string): Float32Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4))
}

/** Test-only reset. */
export function resetEmbeddingClientForTests() {
  queue.length = 0
  draining = false
  infoCache.clear()
}
