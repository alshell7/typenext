import {
  BUILTIN_DOWNLOAD_BYTES,
  BUILTIN_MODEL,
  boundBuiltinPrompt,
  builtinFileUrl,
  validBuiltinCacheFile,
  type BuiltinPrompt,
} from './builtin-model'

export type { BuiltinPrompt } from './builtin-model'
export type BuiltinBackend = 'auto' | 'wasm' | 'webgpu'
export interface BuiltinState {
  status:
    | 'unavailable'
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'loading'
    | 'ready'
    | 'generating'
    | 'error'
  cached: boolean
  progress: number
  downloadedBytes: number
  totalBytes: number
  backend: 'wasm' | 'webgpu' | null
  error?: string
  identity: string
}
export interface BuiltinLoadOptions {
  backend?: BuiltinBackend
  signal?: AbortSignal
}
export interface BuiltinGenerationOptions {
  maxTokens: number
  temperature: number
  signal?: AbortSignal
}

let generation = 0
let preferredBackend: BuiltinBackend = 'wasm'
const modelIdentity = `${BUILTIN_MODEL.id}@${BUILTIN_MODEL.revision}:q8`
let state: BuiltinState = {
  status: 'idle',
  cached: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: BUILTIN_DOWNLOAD_BYTES,
  backend: null,
  identity: `${modelIdentity}:0`,
}
const listeners = new Set<() => void>()
let worker: Worker | null = null
let operation: AbortController | null = null
let sequence = 0
interface Pending {
  id: number
  kind: 'load' | 'generate'
  resolve(value: string): void
  reject(error: Error): void
  settled: boolean
  detach(): void
  timer: ReturnType<typeof setTimeout>
}
let pending: Pending | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

export function getBuiltinState(): BuiltinState {
  return state
}
export function getBuiltinBackendPreference(): BuiltinBackend {
  return preferredBackend
}
export function subscribeBuiltinState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function update(patch: Partial<BuiltinState>): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  state = { ...state, ...patch }
  if (state.status === 'ready')
    idleTimer = setTimeout(() => {
      if (state.status === 'ready' && !busy()) stopWorker()
    }, 5 * 60_000)
  listeners.forEach(listener => listener())
}
function abortError(): DOMException {
  return new DOMException('Offline model request cancelled.', 'AbortError')
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}
function available(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof caches !== 'undefined' &&
    typeof crypto?.subtle !== 'undefined'
  )
}
function busy(): boolean {
  return Boolean(operation || pending)
}

async function cachedFiles(): Promise<boolean> {
  const cache = await caches.open(BUILTIN_MODEL.cache)
  for (const file of BUILTIN_MODEL.files) {
    if (
      !validBuiltinCacheFile(await cache.match(builtinFileUrl(file.name)), file)
    )
      return false
  }
  return true
}

/** Checks cache metadata only. This never fetches or loads model weights. */
export async function checkBuiltinCache(): Promise<boolean> {
  if (!available()) {
    update({
      status: 'unavailable',
      error:
        'Offline inference needs a modern browser with workers, WebAssembly and device storage.',
    })
    return false
  }
  if (busy() || state.status === 'ready') return state.cached
  update({ status: 'checking', error: undefined })
  try {
    const cached = await cachedFiles()
    update({
      cached,
      status: 'idle',
      progress: cached ? 100 : 0,
      downloadedBytes: cached ? BUILTIN_DOWNLOAD_BYTES : 0,
    })
    return cached
  } catch {
    update({
      status: 'unavailable',
      cached: false,
      error:
        'Device model storage is unavailable. Check browser storage permissions.',
    })
    return false
  }
}

/** Only this explicit action contacts the public model host. No writing is sent. */
export async function downloadBuiltinModel(
  options: BuiltinLoadOptions = {}
): Promise<void> {
  throwIfAborted(options.signal)
  if (!available())
    throw new Error('Device model storage is unavailable in this browser.')
  if (busy()) throw new Error('The offline model is already busy.')
  if (state.status === 'ready') return
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  operation = controller
  const downloadTimer = setTimeout(cancel, 10 * 60_000)
  update({
    status: 'downloading',
    error: undefined,
    downloadedBytes: 0,
    progress: 0,
  })
  try {
    const cache = await caches.open(BUILTIN_MODEL.cache)
    const estimate = await navigator.storage?.estimate?.()
    if (
      estimate?.quota &&
      estimate.usage !== undefined &&
      estimate.quota - estimate.usage < BUILTIN_DOWNLOAD_BYTES * 1.15
    ) {
      throw new Error(
        'Not enough device storage for this model. Free about 160 MB and try again.'
      )
    }
    let complete = 0
    let lastProgressAt = 0
    for (const file of BUILTIN_MODEL.files) {
      throwIfAborted(controller.signal)
      if (
        validBuiltinCacheFile(
          await cache.match(builtinFileUrl(file.name)),
          file
        )
      ) {
        complete += file.bytes
        update({
          downloadedBytes: complete,
          progress: (complete / BUILTIN_DOWNLOAD_BYTES) * 100,
        })
        continue
      }
      const response = await fetch(builtinFileUrl(file.name), {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
      if (!response.ok || !response.body)
        throw new Error(
          `The public model download failed (${response.status}). Try again later.`
        )
      const declared = Number(response.headers.get('content-length'))
      if (declared > file.bytes)
        throw new Error(
          'The model download size does not match its pinned manifest.'
        )
      const bytes = new Uint8Array(file.bytes)
      const reader = response.body.getReader()
      let offset = 0
      try {
        while (true) {
          throwIfAborted(controller.signal)
          const part = await reader.read()
          if (part.done) break
          if (offset + part.value.byteLength > file.bytes)
            throw new Error('The model download exceeded its pinned size.')
          bytes.set(part.value, offset)
          offset += part.value.byteLength
          if (
            performance.now() - lastProgressAt >= 100 ||
            offset === file.bytes
          ) {
            lastProgressAt = performance.now()
            update({
              downloadedBytes: complete + offset,
              progress: ((complete + offset) / BUILTIN_DOWNLOAD_BYTES) * 100,
            })
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      throwIfAborted(controller.signal)
      if (offset !== file.bytes)
        throw new Error(
          'The model download ended early. Try downloading again.'
        )
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const hash = Array.from(new Uint8Array(digest), value =>
        value.toString(16).padStart(2, '0')
      ).join('')
      if (hash !== file.sha256)
        throw new Error('Model integrity check failed. The file was not saved.')
      throwIfAborted(controller.signal)
      await cache.put(
        builtinFileUrl(file.name),
        new Response(bytes, {
          headers: {
            'content-length': String(file.bytes),
            'x-typenext-sha256': file.sha256,
            'content-type': file.name.endsWith('.json')
              ? 'application/json'
              : 'application/octet-stream',
          },
        })
      )
      complete += file.bytes
    }
    update({
      cached: true,
      progress: 100,
      downloadedBytes: BUILTIN_DOWNLOAD_BYTES,
      status: 'idle',
    })
  } catch (error) {
    const cancelled = controller.signal.aborted
    update({
      status: cancelled ? 'idle' : 'error',
      error: cancelled
        ? undefined
        : error instanceof Error
          ? error.message
          : 'The model download failed.',
    })
    throw cancelled ? abortError() : error
  } finally {
    clearTimeout(downloadTimer)
    options.signal?.removeEventListener('abort', cancel)
    if (operation === controller) operation = null
  }
  throwIfAborted(options.signal)
  await loadBuiltinModel(options)
}

function stopWorker(error?: Error): void {
  worker?.terminate()
  worker = null
  if (pending) {
    clearTimeout(pending.timer)
    pending.detach()
    if (!pending.settled) pending.reject(error ?? abortError())
    pending = null
  }
  generation += 1
  update({
    status: 'idle',
    backend: null,
    identity: `${modelIdentity}:${generation}`,
  })
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./builtin-engine.worker.ts', import.meta.url), {
    type: 'module',
  })
  const current = worker
  current.onmessage = event => {
    if (worker !== current || !pending || event.data?.id !== pending.id) return
    const task = pending
    const message = event.data as {
      type: string
      text?: string
      error?: string
      backend?: 'wasm' | 'webgpu'
    }
    if (message.type !== 'done' && message.type !== 'error') return
    clearTimeout(task.timer)
    task.detach()
    pending = null
    if (message.type === 'error') {
      const error = new Error(
        message.error ??
          'The offline model could not run. Try CPU mode or free some memory.'
      )
      if (!task.settled) task.reject(error)
      stopWorker()
      update({ status: 'error', error: error.message })
    } else {
      if (task.kind === 'load' && message.backend)
        preferredBackend = message.backend
      update({
        status: 'ready',
        backend: message.backend ?? state.backend,
        error: undefined,
      })
      if (!task.settled) task.resolve(message.text ?? '')
    }
  }
  current.onerror = () => {
    if (worker !== current) return
    stopWorker(
      new Error(
        'The offline model worker stopped. Reload the cached model to try again.'
      )
    )
    update({
      status: 'error',
      error:
        'The offline model worker stopped. Reload the cached model to try again.',
    })
  }
  return current
}

function runWorker(
  kind: 'load' | 'generate',
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal)
  if (pending) throw new Error('The offline model is already busy.')
  const current = ensureWorker()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timeout = () => {
      if (pending?.id !== id) return
      stopWorker(
        new Error(
          'The offline model exceeded its time limit. Try a shorter context or CPU mode.'
        )
      )
      update({
        status: 'error',
        error:
          'The offline model exceeded its time limit. Try a shorter context or CPU mode.',
      })
    }
    const timer = setTimeout(timeout, kind === 'load' ? 90_000 : 20_000)
    const cancel = () => {
      if (pending?.id !== id) return
      pending.settled = true
      reject(abortError())
      if (kind === 'load') {
        stopWorker()
      } else {
        // Give the worker a brief chance to stop between tokens and retain its model.
        current.postMessage({ type: 'cancel', id })
        clearTimeout(pending.timer)
        pending.timer = setTimeout(() => {
          if (pending?.id === id) stopWorker()
        }, 1500)
      }
    }
    signal?.addEventListener('abort', cancel, { once: true })
    pending = {
      id,
      kind,
      resolve,
      reject,
      settled: false,
      timer,
      detach: () => signal?.removeEventListener('abort', cancel),
    }
    current.postMessage({ type: kind, id, ...payload })
  })
}

/** An explicit cache-only load; missing files produce an error, never a download. */
export async function loadBuiltinModel(
  options: BuiltinLoadOptions = {}
): Promise<void> {
  throwIfAborted(options.signal)
  if (!available())
    throw new Error('Offline inference is unavailable in this browser.')
  if (busy()) throw new Error('The offline model is already busy.')
  if (state.status === 'ready') return
  if (!(await cachedFiles())) {
    update({ cached: false, status: 'idle' })
    throw new Error(
      'Download the offline model first. Cached loading never uses the network.'
    )
  }
  throwIfAborted(options.signal)
  update({ cached: true, status: 'loading', error: undefined })
  const payload = {
    backend: options.backend ?? preferredBackend,
    runtimeBase: new URL('runtime/builtin/', document.baseURI).href,
  }
  preferredBackend = payload.backend
  try {
    await runWorker('load', payload, options.signal)
  } catch (error) {
    if (payload.backend !== 'auto' || options.signal?.aborted) throw error
    // Failed ONNX session initialization poisons its worker's internal promise chain.
    // CPU fallback therefore starts a fresh worker and still uses only cached files.
    stopWorker()
    update({ status: 'loading', error: undefined })
    await runWorker('load', { ...payload, backend: 'wasm' }, options.signal)
  }
}

export async function generateBuiltinInsertion(
  prompt: BuiltinPrompt,
  options: BuiltinGenerationOptions
): Promise<string> {
  throwIfAborted(options.signal)
  if (pending?.kind === 'generate' && pending.settled)
    await waitForCancelledGeneration(options.signal)
  throwIfAborted(options.signal)
  if (state.status !== 'ready' || !worker)
    throw new Error(
      state.status === 'generating'
        ? 'The offline model is already busy.'
        : 'Load the downloaded offline model in Preferences first.'
    )
  update({ status: 'generating', error: undefined })
  return await runWorker(
    'generate',
    {
      prompt: boundBuiltinPrompt(prompt),
      maxTokens: Math.max(
        1,
        Math.min(
          48,
          Number.isFinite(options.maxTokens)
            ? Math.floor(options.maxTokens)
            : 24
        )
      ),
      temperature: Math.max(
        0,
        Math.min(
          1,
          Number.isFinite(options.temperature) ? options.temperature : 0.3
        )
      ),
    },
    options.signal
  )
}

/** A cancelled previous request may briefly be finishing its current token. */
function waitForCancelledGeneration(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      detach()
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish(abortError())
    const detach = subscribeBuiltinState(() => {
      if (!pending) finish()
    })
    const timer = setTimeout(() => finish(), 1600)
    signal?.addEventListener('abort', cancel, { once: true })
    if (!pending) finish()
    else if (signal?.aborted) cancel()
  })
}

export function unloadBuiltinModel(): void {
  operation?.abort()
  stopWorker()
  update({ error: undefined })
}

export async function removeBuiltinModel(): Promise<void> {
  if (operation)
    throw new Error('Cancel the current model download before removing it.')
  unloadBuiltinModel()
  await caches.delete(BUILTIN_MODEL.cache)
  update({ cached: false, progress: 0, downloadedBytes: 0 })
}
