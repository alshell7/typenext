import type { DictationSettings } from '../types/notebook'
import {
  getWhistleState,
  loadWhistleModel,
  transcribeWhistle,
  unloadWhistleModel,
  type WhistleState,
} from './whistle'
import {
  WHISTLE_LANGUAGES,
  WHISTLE_MAX_SECONDS,
  WHISTLE_MODEL,
  type WhistleLanguage,
} from './whistle-model'
import {
  SPEECH_RUNTIME,
  getSpeechRuntimeStatus,
  speechEndpoint,
  stopSpeechRuntime,
  type SpeechRuntimeStatus,
} from './speech-runtime'
import { transcribeFluid } from './fluid-speech'

/**
 * One interface for both dictation engines. Whistle runs in the page on
 * clips of up to 30 seconds. Fluid Speech Mini runs in the managed desktop
 * server, accepts long dictation and is fast enough to transcribe phrases at
 * natural pauses while the writer keeps speaking.
 */
export type DictationEngineId = DictationSettings['engine']

export interface DictationCapabilities {
  /** Longest single recording. */
  maxSeconds: number
  /** Can insert finished phrases at pauses while recording continues. */
  livePhrases: boolean
  /** Fast enough for a faint preview of the phrase in progress. */
  interim: boolean
  /** Languages the writer can choose; English-only engines list one. */
  languages: readonly WhistleLanguage[]
}

export type DictationReadiness =
  | { state: 'ready' }
  /** Needs an explicit download first. */
  | { state: 'setup'; action: string; bytes: number }
  /** Downloading or loading; recording waits. */
  | { state: 'busy'; message: string; progress?: number }
  | { state: 'unavailable'; message: string }

export interface DictationTranscribeOptions {
  signal?: AbortSignal
  language?: WhistleLanguage
  /** A provisional preview; engines may answer with less care. */
  interim?: boolean
}

export interface DictationEngine {
  id: DictationEngineId
  name: string
  capabilities: DictationCapabilities
  readiness(): DictationReadiness
  /**
   * Warm up while the microphone opens. Call once per session and always
   * pair it with `release`, even when it fails.
   */
  prepare(signal?: AbortSignal): Promise<void>
  transcribe(
    pcm: Float32Array,
    options?: DictationTranscribeOptions
  ): Promise<string>
  /** A session ended. `cancelled` releases memory at once. */
  release(cancelled: boolean): void
}

export function whistleReadiness(state: WhistleState): DictationReadiness {
  if (state.status === 'unavailable')
    return {
      state: 'unavailable',
      message: state.error ?? 'Whistle cannot run in this browser.',
    }
  if (state.status === 'downloading')
    return {
      state: 'busy',
      message: 'Downloading Whistle',
      progress: state.progress / 100,
    }
  if (state.status === 'checking')
    return { state: 'busy', message: 'Checking Whistle' }
  if (state.status === 'loading')
    return { state: 'busy', message: 'Loading Whistle' }
  if (!state.cached)
    return {
      state: 'setup',
      action: 'Download Whistle · 17 MB',
      bytes: WHISTLE_MODEL.bytes,
    }
  return { state: 'ready' }
}

export function fluidReadiness(
  status: SpeechRuntimeStatus
): DictationReadiness {
  if (status.state === 'unsupported')
    return {
      state: 'unavailable',
      message: 'Fluid Speech Mini needs the TypeNext desktop app.',
    }
  if (status.state === 'downloading') {
    const progress = status.progress
    return {
      state: 'busy',
      message: 'Downloading Fluid Speech Mini',
      ...(progress && progress.totalBytes > 0
        ? {
            progress: Math.min(
              1,
              progress.downloadedBytes / progress.totalBytes
            ),
          }
        : {}),
    }
  }
  if (!status.installed.runtime || !status.installed.model)
    return {
      state: 'setup',
      action: 'Download Fluid Speech Mini (347 MB)',
      bytes: SPEECH_RUNTIME.model.bytes + SPEECH_RUNTIME.runtimeBytes,
    }
  return { state: 'ready' }
}

export const whistleEngine: DictationEngine = {
  id: 'whistle',
  name: 'Whistle',
  capabilities: {
    maxSeconds: WHISTLE_MAX_SECONDS,
    livePhrases: false,
    interim: false,
    languages: WHISTLE_LANGUAGES.map(item => item.id),
  },
  readiness: () => whistleReadiness(getWhistleState()),
  async prepare(signal) {
    const state = getWhistleState()
    if (state.cached && state.status === 'idle')
      await loadWhistleModel({ signal }).catch(error => {
        if (signal?.aborted) throw error
        // transcribe() loads again and reports a lasting failure.
      })
  },
  async transcribe(pcm, options = {}) {
    const result = await transcribeWhistle(pcm, {
      language: options.language ?? '',
      signal: options.signal,
    })
    return result.text
  },
  release(cancelled) {
    // A cancelled clip frees the model at once; otherwise Whistle unloads
    // itself after a minute without use.
    if (cancelled) unloadWhistleModel()
  },
}

/** The server stops after this long without dictation. */
export const FLUID_IDLE_STOP_MS = 15 * 60_000
let idleTimer: ReturnType<typeof setTimeout> | null = null
let activeSessions = 0

function clearIdle() {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleStop() {
  clearIdle()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (activeSessions > 0) return
    if (getSpeechRuntimeStatus().state !== 'running') return
    void stopSpeechRuntime().catch(() => undefined)
  }, FLUID_IDLE_STOP_MS)
}

export const fluidEngine: DictationEngine = {
  id: 'fluid',
  name: 'Fluid Speech Mini',
  capabilities: {
    maxSeconds: 30 * 60,
    livePhrases: true,
    interim: true,
    languages: ['en'],
  },
  readiness: () => fluidReadiness(getSpeechRuntimeStatus()),
  async prepare() {
    clearIdle()
    activeSessions++
    await speechEndpoint()
  },
  async transcribe(pcm, options = {}) {
    clearIdle()
    const result = await transcribeFluid(pcm, {
      signal: options.signal,
      timeoutMs: options.interim ? 8_000 : undefined,
    })
    return result.text
  },
  release() {
    activeSessions = Math.max(0, activeSessions - 1)
    if (activeSessions === 0) scheduleIdleStop()
  },
}

export function dictationEngine(id: DictationEngineId): DictationEngine {
  return id === 'fluid' ? fluidEngine : whistleEngine
}

export interface DictationEngineChoice {
  /** The engine to record with now, or null when setup comes first. */
  engine: DictationEngine | null
  preferred: DictationEngine
  readiness: DictationReadiness
  /** Whistle stands in for a Fluid Speech Mini that is not ready. */
  fallback: boolean
  /** Whistle can stand in, when the writer accepts it. */
  canFallBack: boolean
}

/**
 * Choose the engine for a new session. A ready preferred engine wins. When
 * Fluid Speech Mini is not installed, Whistle stands in only if the writer
 * accepted that (`acceptFallback`) or Fluid cannot run here at all.
 */
export function chooseDictationEngine(
  preferred: DictationEngineId,
  acceptFallback = false,
  readinessOf: (engine: DictationEngine) => DictationReadiness = engine =>
    engine.readiness()
): DictationEngineChoice {
  const wanted = dictationEngine(preferred)
  const readiness = readinessOf(wanted)
  if (readiness.state === 'ready')
    return {
      engine: wanted,
      preferred: wanted,
      readiness,
      fallback: false,
      canFallBack: false,
    }
  const whistleReady =
    wanted.id === 'fluid' && readinessOf(whistleEngine).state === 'ready'
  const automatic = readiness.state === 'unavailable'
  return {
    engine:
      whistleReady && (acceptFallback || automatic) ? whistleEngine : null,
    preferred: wanted,
    readiness,
    fallback: whistleReady && (acceptFallback || automatic),
    canFallBack: wanted.id === 'fluid',
  }
}

/** Test-only reset of the idle timer. */
export function resetDictationEnginesForTests() {
  clearIdle()
  activeSessions = 0
}
