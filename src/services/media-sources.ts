import type {
  ContextSource,
  MediaKind,
  SemanticSettings,
} from '../types/notebook'
import { embedMedia, encodeVector } from './embedding-client'
import { resolveEmbeddingEndpoint } from './embedding-runtime'
import { modelIdentity } from './semantic-retrieval'

/**
 * Basic input limits per modality. EmbeddingGemma 2 has an 8,192-token
 * context: an image costs about 280 tokens, a video frame about 140 tokens at
 * one frame per second, and audio about 25 tokens per second.
 */
export const MEDIA_LIMITS = Object.freeze({
  image: { bytes: 20 * 1024 * 1024, label: '20 MB' },
  audio: {
    bytes: 30 * 1024 * 1024,
    seconds: 180,
    label: '30 MB and 3 minutes',
  },
  video: {
    bytes: 50 * 1024 * 1024,
    seconds: 45,
    label: '50 MB and 45 seconds',
  },
})

const IMAGE_TYPES = /^image\/(?:png|jpeg|webp|gif|bmp)$/u
const AUDIO_TYPES =
  /^audio\/(?:wav|x-wav|wave|mpeg|mp3|mp4|x-m4a|aac|ogg|flac|webm)$/u
const VIDEO_TYPES = /^video\/(?:mp4|webm|quicktime)$/u
const EXTENSIONS: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  wav: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  mov: 'video',
}
export const MEDIA_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.gif,.bmp,.wav,.mp3,.m4a,.aac,.ogg,.flac,.mp4,.m4v,.webm,.mov'
const THUMBNAIL_EDGE = 320
const MAX_THUMBNAIL_CHARACTERS = 64_000

export function mediaKind(file: Pick<File, 'name' | 'type'>): MediaKind | null {
  if (IMAGE_TYPES.test(file.type)) return 'image'
  if (AUDIO_TYPES.test(file.type)) return 'audio'
  if (VIDEO_TYPES.test(file.type)) return 'video'
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSIONS[extension] ?? null
}

/** Check limits that do not need decoding. Throws a writer-facing message. */
export function checkMediaFile(
  file: Pick<File, 'name' | 'type' | 'size'>
): MediaKind {
  const kind = mediaKind(file)
  if (!kind)
    throw new Error(
      'This file type is not a supported image, audio or video file.'
    )
  const limit = MEDIA_LIMITS[kind]
  if (file.size > limit.bytes)
    throw new Error(
      `${file.name} is too large. ${capitalize(kind)} files can be up to ${limit.label}.`
    )
  if (file.size === 0) throw new Error(`${file.name} is empty.`)
  return kind
}

export function checkMediaDuration(
  kind: MediaKind,
  seconds: number,
  name: string
) {
  if (kind === 'image') return
  const limit = MEDIA_LIMITS[kind]
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(`TypeNext could not read the length of ${name}.`)
  if (seconds > limit.seconds)
    throw new Error(
      `${name} is ${Math.ceil(seconds)} seconds long. ${capitalize(kind)} can be up to ${limit.seconds} seconds.`
    )
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError')
}

async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function thumbnailFrom(
  source: CanvasImageSource,
  width: number,
  height: number
): string | undefined {
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return undefined
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  for (const quality of [0.72, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality)
    if (url.length <= MAX_THUMBNAIL_CHARACTERS) return url
  }
  return undefined
}

async function imageDetails(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      thumbnail: thumbnailFrom(image, image.naturalWidth, image.naturalHeight),
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function videoDetails(file: File) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  try {
    video.preload = 'metadata'
    video.muted = true
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () =>
        reject(new Error(`TypeNext could not read ${file.name}.`))
    })
    const duration = video.duration
    video.currentTime = Math.min(1, duration / 2)
    await new Promise<void>(resolve => {
      video.onseeked = () => resolve()
      setTimeout(resolve, 1_500)
    })
    return {
      durationSeconds: duration,
      width: video.videoWidth,
      height: video.videoHeight,
      thumbnail: video.videoWidth
        ? thumbnailFrom(video, video.videoWidth, video.videoHeight)
        : undefined,
    }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

async function audioDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file)
  const audio = document.createElement('audio')
  try {
    audio.preload = 'metadata'
    audio.src = url
    return await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(audio.duration)
      audio.onerror = () =>
        reject(new Error(`TypeNext could not read ${file.name}.`))
    })
  } finally {
    audio.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}

function describe(name: string, caption: string) {
  const title = name
    .replace(/\.[^.]+$/u, '')
    .replace(/[-_]+/gu, ' ')
    .trim()
  return caption.trim() ? `${caption.trim()}\n\n${title}` : title
}

/**
 * Import one image, audio clip or video as a context source. The file is read
 * locally and embedded by the local EmbeddingGemma 2 server; only its vector,
 * a small thumbnail and the caption are kept.
 */
export async function importMediaFile(
  file: File,
  settings: SemanticSettings,
  options: { caption?: string; signal?: AbortSignal } = {}
): Promise<ContextSource> {
  const kind = checkMediaFile(file)
  checkAbort(options.signal)
  if (!settings.enabled || !settings.media)
    throw new Error(
      'Turn on semantic search with images, audio and video in Preferences → Knowledge to add media.'
    )
  const details: {
    durationSeconds?: number
    width?: number
    height?: number
    thumbnail?: string
  } =
    kind === 'image'
      ? await imageDetails(file)
      : kind === 'video'
        ? await videoDetails(file)
        : { durationSeconds: await audioDuration(file) }
  checkAbort(options.signal)
  if (kind !== 'image')
    checkMediaDuration(kind, details.durationSeconds ?? Number.NaN, file.name)
  const endpoint = await resolveEmbeddingEndpoint(settings)
  const vector = await embedMedia(
    endpoint,
    { kind, base64: await base64(file) },
    { signal: options.signal }
  )
  checkAbort(options.signal)
  return {
    id: crypto.randomUUID(),
    name: file.name.slice(0, 200) || `Untitled ${kind}`,
    kind,
    text: describe(file.name, options.caption ?? ''),
    enabled: true,
    addedAt: Date.now(),
    media: {
      mime: file.type || `${kind}/*`,
      bytes: file.size,
      ...details,
      vector: encodeVector(vector),
      vectorModel: modelIdentity(settings),
    },
  }
}
