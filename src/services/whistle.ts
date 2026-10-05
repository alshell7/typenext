import {
  WHISTLE_MODEL,
  parseWhistleTranscript,
  validWhistleCache,
  validateWhistleAudio,
  validateWhistleLanguage,
  whistleModelUrl,
  type WhistleLanguage,
  type WhistleTranscript,
} from './whistle-model'

export interface WhistleState {
  status:
    | 'idle'
    | 'unavailable'
    | 'checking'
    | 'downloading'
    | 'loading'
    | 'ready'
    | 'transcribing'
    | 'error'
  cached: boolean
  progress: number
  downloadedBytes: number
  error?: string
}
export interface WhistleOptions {
  signal?: AbortSignal
}
export interface WhistleTranscriptionOptions extends WhistleOptions {
  language?: WhistleLanguage
}

let state: WhistleState = {
  status: 'idle',
  cached: false,
  progress: 0,
  downloadedBytes: 0,
}
const listeners = new Set<() => void>()
let worker: Worker | null = null
let operation: AbortController | null = null
let loadTask: Promise<void> | null = null
let cacheTask: Promise<boolean> | null = null
let lifecycle = 0
let sequence = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
interface Pending {
  id: number
  resolve(value: unknown): void
  reject(error: Error): void
  detach(): void
  timer: ReturnType<typeof setTimeout>
}
let pending: Pending | null = null

export function getWhistleState(): WhistleState {
  return state
}
export function subscribeWhistleState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function update(patch: Partial<WhistleState>): void {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}
function aborted(): DOMException {
  return new DOMException('Dictation cancelled.', 'AbortError')
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted()
}
function supported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof caches !== 'undefined' &&
    typeof crypto?.subtle !== 'undefined'
  )
}
function clearIdle(): void {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = null
}
function scheduleIdle(): void {
  clearIdle()
  // Dictation is intermittent. Release the WASM heap without removing its cache.
  idleTimer = setTimeout(() => {
    if (!pending && !operation) unloadWhistleModel()
  }, 60_000)
}

async function readModel(
  response: Response,
  signal?: AbortSignal,
  progress?: (bytes: number) => void
): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error(
      'The dictation model could not be read. Try downloading it again.'
    )
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > WHISTLE_MODEL.bytes)
    throw new Error('The dictation model exceeds its pinned size.')
  const bytes = new Uint8Array(WHISTLE_MODEL.bytes)
  const reader = response.body.getReader()
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelRead, { once: true })
  let offset = 0
  let notified = 0
  try {
    for (;;) {
      checkAbort(signal)
      const part = await reader.read()
      if (part.done) break
      if (offset + part.value.byteLength > bytes.byteLength)
        throw new Error('The dictation model exceeds its pinned size.')
      bytes.set(part.value, offset)
      offset += part.value.byteLength
      if (offset - notified >= WHISTLE_MODEL.bytes / 100) {
        progress?.(offset)
        notified = offset
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelRead)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  checkAbort(signal)
  if (offset !== bytes.byteLength)
    throw new Error(
      'The dictation download ended early. Download the model again.'
    )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  if (hash !== WHISTLE_MODEL.sha256)
    throw new Error(
      'The dictation model failed its integrity check. Download it again.'
    )
  checkAbort(signal)
  progress?.(offset)
  return bytes
}

/** Reads local metadata only; opening the UI never starts a download or microphone. */
export async function checkWhistleCache(): Promise<boolean> {
  if (!supported()) {
    update({
      status: 'unavailable',
      error:
        'Offline dictation needs a modern browser with WebAssembly and device storage.',
    })
    return false
  }
  if (operation || pending || loadTask || state.status === 'ready')
    return state.cached
  if (cacheTask) return cacheTask
  const checkedLifecycle = lifecycle
  update({ status: 'checking', error: undefined })
  const task = (async () => {
    try {
      const cache = await caches.open(WHISTLE_MODEL.cache)
      const cached = validWhistleCache(await cache.match(whistleModelUrl()))
      if (checkedLifecycle !== lifecycle) return state.cached
      update({
        status: 'idle',
        cached,
        progress: cached ? 100 : 0,
        downloadedBytes: cached ? WHISTLE_MODEL.bytes : 0,
      })
      return cached
    } catch {
      if (checkedLifecycle !== lifecycle) return state.cached
      update({
        status: 'unavailable',
        cached: false,
        error:
          'Device storage is unavailable. Check browser storage permissions.',
      })
      return false
    }
  })()
  cacheTask = task
  try {
    return await task
  } finally {
    if (cacheTask === task) cacheTask = null
  }
}

/** The only external request in this service downloads this pinned public file. */
export async function downloadWhistleModel(
  options: WhistleOptions = {}
): Promise<void> {
  checkAbort(options.signal)
  if (!supported())
    throw new Error('Offline dictation storage is unavailable here.')
  if (operation || pending || loadTask)
    throw new Error('Offline dictation is already busy.')
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  operation = controller
  lifecycle++
  update({
    status: 'downloading',
    progress: 0,
    downloadedBytes: 0,
    error: undefined,
  })
  try {
    const cache = await caches.open(WHISTLE_MODEL.cache)
    const estimate = await navigator.storage?.estimate?.()
    if (
      estimate?.quota &&
      estimate.usage !== undefined &&
      estimate.quota - estimate.usage < WHISTLE_MODEL.bytes * 1.15
    )
      throw new Error(
        'Not enough device storage. Free about 20 MB and try again.'
      )
    checkAbort(controller.signal)
    const response = await fetch(whistleModelUrl(), {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    const bytes = await readModel(
      response,
      controller.signal,
      downloadedBytes =>
        update({
          downloadedBytes,
          progress: (downloadedBytes / WHISTLE_MODEL.bytes) * 100,
        })
    )
    await cache.put(
      whistleModelUrl(),
      new Response(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'x-typenext-sha256': WHISTLE_MODEL.sha256,
        },
      })
    )
    checkAbort(controller.signal)
    update({
      status: worker ? 'ready' : 'idle',
      cached: true,
      progress: 100,
      downloadedBytes: WHISTLE_MODEL.bytes,
    })
  } catch (error) {
    const cancelled = controller.signal.aborted
    update({
      status: cancelled ? 'idle' : 'error',
      error: cancelled
        ? undefined
        : error instanceof Error
          ? error.message
          : 'The dictation model download failed.',
    })
    throw cancelled ? aborted() : error
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    if (operation === controller) operation = null
  }
}

function stopWorker(reason?: Error): void {
  clearIdle()
  worker?.terminate()
  worker = null
  const task = pending
  pending = null
  if (task) {
    clearTimeout(task.timer)
    task.detach()
    task.reject(reason ?? aborted())
  }
  update({ status: 'idle' })
}

function ensureWorker(): Worker {
  if (worker) return worker
  const current = new Worker(new URL('./whistle.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker = current
  current.onmessage = event => {
    if (worker !== current || !pending || event.data?.id !== pending.id) return
    const task = pending
    const message = event.data as {
      type: string
      result?: unknown
      error?: string
    }
    if (message.type !== 'done' && message.type !== 'error') return
    pending = null
    clearTimeout(task.timer)
    task.detach()
    if (message.type === 'error') {
      const error = new Error(
        message.error || 'Whistle could not process this recording.'
      )
      stopWorker()
      update({ status: 'error', error: error.message })
      task.reject(error)
    } else {
      update({ status: 'ready', error: undefined })
      scheduleIdle()
      task.resolve(message.result)
    }
  }
  current.onerror = () => {
    if (worker !== current) return
    const error = new Error(
      'The offline speech worker stopped. Record again to reload it.'
    )
    stopWorker(error)
    update({ status: 'error', error: error.message })
  }
  return current
}

function runWorker(
  type: 'load' | 'transcribe',
  payload: Record<string, unknown>,
  transfer: Transferable[],
  signal?: AbortSignal
): Promise<unknown> {
  checkAbort(signal)
  if (pending) throw new Error('Offline dictation is already busy.')
  clearIdle()
  const current = ensureWorker()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        if (pending?.id !== id) return
        const error = new Error(
          'Offline dictation took too long. Try a shorter recording.'
        )
        stopWorker(error)
        update({ status: 'error', error: error.message })
      },
      type === 'load' ? 30_000 : 45_000
    )
    const cancel = () => {
      if (pending?.id === id) stopWorker(aborted())
    }
    signal?.addEventListener('abort', cancel, { once: true })
    pending = {
      id,
      resolve,
      reject,
      timer,
      detach: () => signal?.removeEventListener('abort', cancel),
    }
    try {
      current.postMessage({ id, type, ...payload }, transfer)
    } catch (error) {
      stopWorker(
        error instanceof Error
          ? error
          : new Error('The offline worker could not start.')
      )
    }
  })
}

/** Cache-only loading: missing/corrupt weights never trigger a network fetch. */
export async function loadWhistleModel(
  options: WhistleOptions = {}
): Promise<void> {
  checkAbort(options.signal)
  if (!supported()) throw new Error('Offline dictation is unavailable here.')
  if (operation || pending || loadTask)
    throw new Error('Offline dictation is already busy.')
  if (state.status === 'ready' && worker) {
    scheduleIdle()
    return
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  operation = controller
  lifecycle++
  update({ status: 'loading', error: undefined })
  const task = (async () => {
    const cache = await caches.open(WHISTLE_MODEL.cache)
    const response = await cache.match(whistleModelUrl())
    checkAbort(controller.signal)
    if (!validWhistleCache(response)) {
      update({ cached: false })
      throw new Error('Download Whistle for offline dictation first.')
    }
    let model: Uint8Array
    try {
      model = await readModel(response!, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) {
        await cache.delete(whistleModelUrl())
        update({ cached: false, progress: 0, downloadedBytes: 0 })
      }
      throw error
    }
    checkAbort(controller.signal)
    update({ cached: true })
    await runWorker(
      'load',
      {
        model: model.buffer,
        runtimeBase: new URL('runtime/whistle/', document.baseURI).href,
      },
      [model.buffer],
      controller.signal
    )
  })()
  loadTask = task
  try {
    await task
  } catch (error) {
    if (!controller.signal.aborted)
      update({
        status: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'The speech model could not load.',
      })
    else update({ status: 'idle', error: undefined })
    throw controller.signal.aborted ? aborted() : error
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    if (loadTask === task) loadTask = null
    if (operation === controller) operation = null
  }
}

export async function transcribeWhistle(
  pcm: Float32Array,
  options: WhistleTranscriptionOptions = {}
): Promise<WhistleTranscript> {
  checkAbort(options.signal)
  validateWhistleAudio(pcm)
  validateWhistleLanguage(options.language ?? '')
  if (operation || pending || loadTask)
    throw new Error('Offline dictation is already busy.')
  if (state.status !== 'ready' || !worker) await loadWhistleModel(options)
  checkAbort(options.signal)
  const audio = pcm.slice()
  update({ status: 'transcribing', error: undefined })
  const result = await runWorker(
    'transcribe',
    { pcm: audio, language: options.language ?? '' },
    [audio.buffer],
    options.signal
  )
  checkAbort(options.signal)
  return parseWhistleTranscript(result)
}

/** Termination cancels actual WASM work and releases its model/audio heap. */
export function unloadWhistleModel(): void {
  lifecycle++
  operation?.abort()
  stopWorker()
  update({ error: undefined })
}
export async function removeWhistleModel(): Promise<void> {
  if (operation || loadTask)
    throw new Error(
      'Cancel the current dictation setup before removing its model.'
    )
  unloadWhistleModel()
  const controller = new AbortController()
  operation = controller
  lifecycle++
  update({ status: 'checking', error: undefined })
  try {
    await caches.delete(WHISTLE_MODEL.cache)
    update({ cached: false, progress: 0, downloadedBytes: 0 })
    checkAbort(controller.signal)
    update({ status: 'idle' })
  } catch (error) {
    update({
      status: controller.signal.aborted ? 'idle' : 'error',
      error: controller.signal.aborted
        ? undefined
        : 'The dictation model could not be removed from device storage.',
    })
    throw controller.signal.aborted ? aborted() : error
  } finally {
    if (operation === controller) operation = null
  }
}
