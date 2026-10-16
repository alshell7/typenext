import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from './native'
import { huggingFaceToken } from './huggingface'

/**
 * Fluid Speech Mini (FluidVoice, CC BY 4.0) runs in a pinned parakeet.cpp
 * `parakeet-server` on a private loopback port. The Rust side downloads the
 * runtime and the GGUF on an explicit action and verifies SHA-256 first.
 */
export const SPEECH_RUNTIME = Object.freeze({
  parakeetRelease: 'v0.6.1',
  modelRepository: 'FluidVoice-Labs/fluid-speech-mini-gguf',
  modelRevision: '490bcd5de891f5efd0e732434dfb0a4b0899aead',
  model: {
    name: 'Fluid Speech Mini',
    file: 'fluid-speech-mini-q2k-q4k.gguf',
    bytes: 347_357_184,
    license: 'CC BY 4.0',
    credit: 'Fluid Speech Mini by FluidVoice',
  },
  /** Approximate size of the platform parakeet.cpp archive. */
  runtimeBytes: 3_000_000,
  sampleRate: 16_000,
  /** One request carries at most this much audio. Long dictation is chunked. */
  maxRequestSeconds: 120,
})

export interface SpeechRuntimeStatus {
  state:
    'unsupported' | 'idle' | 'downloading' | 'starting' | 'running' | 'error'
  installed: { runtime: boolean; model: boolean }
  running?: { endpoint: string }
  progress?: { file: string; downloadedBytes: number; totalBytes: number }
  error?: string
  /** Set when Hugging Face refused the download (see huggingface.ts). */
  errorCode?: 'huggingface-auth' | 'huggingface-rate-limit'
  diskBytes: number
}

const UNSUPPORTED: SpeechRuntimeStatus = {
  state: 'unsupported',
  installed: { runtime: false, model: false },
  diskBytes: 0,
}

let current: SpeechRuntimeStatus | null = null
let starting: Promise<SpeechRuntimeStatus> | null = null
let listening: Promise<void> | null = null
const listeners = new Set<() => void>()

function initialStatus(): SpeechRuntimeStatus {
  current ??= isDesktop() ? { ...UNSUPPORTED, state: 'idle' } : UNSUPPORTED
  return current
}

function publish(next: SpeechRuntimeStatus) {
  current = next
  listeners.forEach(listener => listener())
}

function listen() {
  if (!isDesktop()) return Promise.resolve()
  listening ??= import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<SpeechRuntimeStatus>('speech-runtime-status', event =>
        publish(event.payload)
      )
    )
    .then(() => undefined)
    .catch(() => {
      listening = null
    })
  return listening
}

export function getSpeechRuntimeStatus(): SpeechRuntimeStatus {
  return initialStatus()
}

export function subscribeSpeechRuntime(listener: () => void): () => void {
  listeners.add(listener)
  void listen()
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshSpeechRuntime(): Promise<SpeechRuntimeStatus> {
  if (!isDesktop()) return initialStatus()
  await listen()
  publish(await invoke<SpeechRuntimeStatus>('speech_runtime_status'))
  return initialStatus()
}

/** Explicit writer action. Downloads only pinned, verified files. */
export async function installSpeechRuntime(): Promise<SpeechRuntimeStatus> {
  if (!isDesktop())
    throw new Error('Fluid Speech Mini needs the TypeNext desktop app.')
  await listen()
  publish(
    await invoke<SpeechRuntimeStatus>('speech_runtime_install', {
      request: { hfToken: (await huggingFaceToken()) || null },
    })
  )
  return initialStatus()
}

export async function cancelSpeechInstall(): Promise<void> {
  if (isDesktop()) await invoke('speech_runtime_cancel')
}

export async function stopSpeechRuntime(): Promise<SpeechRuntimeStatus> {
  if (!isDesktop()) return initialStatus()
  publish(await invoke<SpeechRuntimeStatus>('speech_runtime_stop'))
  return initialStatus()
}

export async function removeSpeechRuntime(): Promise<SpeechRuntimeStatus> {
  if (!isDesktop()) return initialStatus()
  publish(await invoke<SpeechRuntimeStatus>('speech_runtime_remove'))
  return initialStatus()
}

/** Start the installed server once; concurrent callers share the start. */
export async function speechEndpoint(): Promise<string> {
  const known = initialStatus()
  if (known.running) return known.running.endpoint
  if (!isDesktop())
    throw new Error('Fluid Speech Mini needs the TypeNext desktop app.')
  starting ??= (async () => {
    try {
      await listen()
      const status = await refreshSpeechRuntime()
      if (!status.installed.runtime || !status.installed.model)
        throw new Error(
          'Download Fluid Speech Mini in Preferences → Dictation first.'
        )
      if (status.running) return status
      publish(await invoke<SpeechRuntimeStatus>('speech_runtime_start'))
      return initialStatus()
    } finally {
      starting = null
    }
  })()
  const status = await starting
  if (!status.running)
    throw new Error(status.error ?? 'Fluid Speech Mini did not start.')
  return status.running.endpoint
}

/** Test-only reset. */
export function resetSpeechRuntimeForTests(
  next: SpeechRuntimeStatus | null = null
) {
  current = next
  starting = null
  listening = null
  listeners.clear()
}
