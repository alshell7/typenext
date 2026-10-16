import type { EmbeddingQuantization, SemanticSettings } from '../types/notebook'
import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from './native'
import { huggingFaceToken } from './huggingface'

/**
 * TypeNext can install a pinned llama.cpp build and EmbeddingGemma 2 weights,
 * then run `llama-server --embeddings` on a private loopback port. The Rust
 * side verifies every download with SHA-256 before it is used.
 */
export const EMBEDDING_RUNTIME = Object.freeze({
  llamaCppRelease: 'b11696',
  modelRepository: 'unsloth/embeddinggemma-2-GGUF',
  modelRevision: '031f0d4b35536f69ab3509d4893c923264fcf253',
  models: {
    'UD-Q4_K_XL': {
      label: 'Balanced (Q4)',
      file: 'embeddinggemma-2-UD-Q4_K_XL.gguf',
      bytes: 175_673_856,
    },
    Q8_0: {
      label: 'Precise (Q8)',
      file: 'embeddinggemma-2-Q8_0.gguf',
      bytes: 309_855_520,
    },
  } satisfies Record<
    EmbeddingQuantization,
    { label: string; file: string; bytes: number }
  >,
  media: { file: 'mmproj-Q8_0.gguf', bytes: 554_821_120 },
  /** Approximate size of the platform llama.cpp archive. */
  runtimeBytes: 20_000_000,
})

export interface EmbeddingRuntimeStatus {
  state:
    'unsupported' | 'idle' | 'downloading' | 'starting' | 'running' | 'error'
  installed: {
    runtime: boolean
    models: EmbeddingQuantization[]
    media: boolean
  }
  running?: {
    /** Base URL without a path, for example http://127.0.0.1:53124 */
    endpoint: string
    /** Random per-launch key the server requires as a Bearer token. */
    apiKey: string
    quantization: EmbeddingQuantization
    media: boolean
  }
  progress?: { file: string; downloadedBytes: number; totalBytes: number }
  error?: string
  /** Set when Hugging Face refused the download (see huggingface.ts). */
  errorCode?: 'huggingface-auth' | 'huggingface-rate-limit'
  /** Bytes used by installed runtime and model files. */
  diskBytes: number
}

export interface EmbeddingEndpoint {
  endpoint: string
  apiKey?: string
  media: boolean
}

const UNSUPPORTED: EmbeddingRuntimeStatus = {
  state: 'unsupported',
  installed: { runtime: false, models: [], media: false },
  diskBytes: 0,
}

// Resolved on first use so importing this module never touches native APIs.
let current: EmbeddingRuntimeStatus | null = null
function initialStatus(): EmbeddingRuntimeStatus {
  current ??= isDesktop() ? { ...UNSUPPORTED, state: 'idle' } : UNSUPPORTED
  return current
}
const listeners = new Set<() => void>()
let listening: Promise<void> | null = null
let starting: Promise<EmbeddingRuntimeStatus> | null = null

function publish(next: EmbeddingRuntimeStatus) {
  current = next
  listeners.forEach(listener => listener())
}

function invokeRuntime<T = EmbeddingRuntimeStatus>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return invoke<T>(command, args)
}

function listen() {
  if (!isDesktop()) return Promise.resolve()
  listening ??= import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<EmbeddingRuntimeStatus>('embedding-runtime-status', event =>
        publish(event.payload)
      )
    )
    .then(() => undefined)
    .catch(() => {
      listening = null
    })
  return listening
}

export function getEmbeddingRuntimeStatus(): EmbeddingRuntimeStatus {
  return initialStatus()
}

export function subscribeEmbeddingRuntime(listener: () => void): () => void {
  listeners.add(listener)
  void listen()
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshEmbeddingRuntime(): Promise<EmbeddingRuntimeStatus> {
  if (!isDesktop()) return initialStatus()
  await listen()
  publish(await invokeRuntime('embedding_runtime_status'))
  return initialStatus()
}

/** Explicit writer action. Downloads only pinned, verified files. */
export async function installEmbeddingRuntime(
  quantization: EmbeddingQuantization,
  media: boolean
): Promise<EmbeddingRuntimeStatus> {
  if (!isDesktop())
    throw new Error(
      'Managed downloads need the desktop app. Connect a llama.cpp server instead.'
    )
  await listen()
  publish(
    await invokeRuntime('embedding_runtime_install', {
      request: {
        quantization,
        media,
        hfToken: (await huggingFaceToken()) || null,
      },
    })
  )
  return initialStatus()
}

export async function cancelEmbeddingInstall(): Promise<void> {
  if (isDesktop()) await invokeRuntime('embedding_runtime_cancel')
}

export async function stopEmbeddingRuntime(): Promise<EmbeddingRuntimeStatus> {
  if (!isDesktop()) return initialStatus()
  publish(await invokeRuntime('embedding_runtime_stop'))
  return initialStatus()
}

export async function removeEmbeddingRuntime(): Promise<EmbeddingRuntimeStatus> {
  if (!isDesktop()) return initialStatus()
  publish(await invokeRuntime('embedding_runtime_remove'))
  return initialStatus()
}

function sameLaunch(
  running: EmbeddingRuntimeStatus['running'],
  settings: SemanticSettings
) {
  return (
    !!running &&
    running.quantization === settings.quantization &&
    (running.media || !settings.media)
  )
}

/** Start the managed server when it is installed and not yet running. */
export async function startEmbeddingRuntime(
  settings: SemanticSettings
): Promise<EmbeddingRuntimeStatus> {
  if (!isDesktop())
    throw new Error('The managed embedding runtime needs the desktop app.')
  if (sameLaunch(initialStatus().running, settings)) return initialStatus()
  starting ??= (async () => {
    try {
      await listen()
      publish(
        await invokeRuntime('embedding_runtime_start', {
          request: {
            quantization: settings.quantization,
            media: settings.media,
            contextSize: settings.media ? 8192 : 2048,
          },
        })
      )
      return initialStatus()
    } finally {
      starting = null
    }
  })()
  return starting
}

/** The managed server stops after this long without embedding requests. */
export const EMBEDDING_IDLE_MS = 15 * 60_000
let lastUse = 0
let idleTimer: ReturnType<typeof setInterval> | null = null

function noteUse() {
  lastUse = Date.now()
  // A server holds the model in memory. Release it when writing pauses; the
  // next request starts it again, and retrieval uses BM25 until it is ready.
  idleTimer ??= setInterval(() => {
    if (
      Date.now() - lastUse < EMBEDDING_IDLE_MS ||
      !initialStatus().running ||
      starting
    )
      return
    if (idleTimer) clearInterval(idleTimer)
    idleTimer = null
    void stopEmbeddingRuntime().catch(() => undefined)
  }, 60_000)
}

/** Resolve where embedding requests go. Never starts a download. */
export async function resolveEmbeddingEndpoint(
  settings: SemanticSettings
): Promise<EmbeddingEndpoint> {
  if (settings.runtime === 'server') {
    const endpoint = settings.endpoint.trim().replace(/\/+$/u, '')
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new Error('Enter the address of your llama.cpp embedding server.')
    }
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.protocol !== 'http:'
    )
      throw new Error(
        'Semantic search needs a server on localhost, 127.0.0.1 or [::1].'
      )
    return { endpoint: endpoint.replace(/\/v1$/u, ''), media: settings.media }
  }
  if (!isDesktop())
    throw new Error(
      'The browser preview cannot run the managed runtime. Choose “My own server”.'
    )
  noteUse()
  const known = sameLaunch(initialStatus().running, settings)
    ? initialStatus()
    : await refreshEmbeddingRuntime()
  if (
    !known.installed.runtime ||
    !known.installed.models.includes(settings.quantization) ||
    (settings.media && !known.installed.media)
  )
    throw new Error(
      'Download the embedding model in Preferences → Knowledge before using semantic search.'
    )
  const running = sameLaunch(known.running, settings)
    ? known
    : await startEmbeddingRuntime(settings)
  if (!running.running)
    throw new Error(running.error ?? 'The embedding server did not start.')
  return {
    endpoint: running.running.endpoint,
    apiKey: running.running.apiKey,
    media: running.running.media,
  }
}

/** Test-only reset for module state. */
export function resetEmbeddingRuntimeForTests(
  next: EmbeddingRuntimeStatus | null = null
) {
  current = next
  starting = null
  lastUse = 0
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
  listening = null
  listeners.clear()
}
