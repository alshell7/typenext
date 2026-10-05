import {
  WHISTLE_RUNTIME,
  WHISTLE_MAX_TEXT,
  parseWhistleTranscript,
  validateWhistleAudio,
  validateWhistleLanguage,
  WHISTLE_MODEL,
  type WhistleLanguage,
} from './whistle-model'

interface NeedleModule {
  HEAPU8: Uint8Array
  _malloc(bytes: number): number
  _free(pointer: number): void
  _needle_load(pointer: number, bytes: bigint): number
  _needle_models(): number
  _needle_transcribe(
    pcm: number,
    samples: number,
    language: number,
    keywords: number,
    times: number,
    out: number,
    capacity: number
  ): number
  _needle_last_error(): number
  UTF8ToString(pointer: number, maxBytes?: number): string
}
type NeedleFactory = (options: {
  wasmBinary: Uint8Array
  print(): void
  printErr(): void
}) => Promise<NeedleModule>
type Task =
  | { id: number; type: 'load'; model: ArrayBuffer; runtimeBase: string }
  | {
      id: number
      type: 'transcribe'
      pcm: Float32Array
      language: WhistleLanguage
    }
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Task>) => void) | null
  postMessage(value: unknown): void
  location: { href: string }
}
let engine: NeedleModule | null = null
let busy = false

function allocate(module: NeedleModule, bytes: number): number {
  const pointer = module._malloc(bytes)
  if (!pointer)
    throw new Error(
      'Not enough memory for offline dictation. Close other models and try again.'
    )
  return pointer
}

async function load(task: Extract<Task, { type: 'load' }>): Promise<void> {
  if (
    !(task.model instanceof ArrayBuffer) ||
    task.model.byteLength !== WHISTLE_MODEL.bytes
  )
    throw new Error('The offline speech model has an invalid size.')
  const base = new URL(task.runtimeBase)
  if (
    base.origin !== new URL(scope.location.href).origin ||
    !base.pathname.endsWith('/runtime/whistle/')
  )
    throw new Error(
      'The offline speech runtime must come from TypeNext’s bundled files.'
    )
  const response = await fetch(new URL('needle.wasm', base), {
    credentials: 'omit',
  })
  if (!response.ok)
    throw new Error(
      'The bundled speech runtime is missing. Reinstall TypeNext and try again.'
    )
  const wasm = await response.arrayBuffer()
  if (wasm.byteLength !== WHISTLE_RUNTIME.wasm.bytes)
    throw new Error('The bundled speech runtime has an invalid size.')
  const digest = await crypto.subtle.digest('SHA-256', wasm)
  const hash = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  if (hash !== WHISTLE_RUNTIME.wasm.sha256)
    throw new Error('The bundled speech runtime failed its integrity check.')
  const source = (await import(
    /* @vite-ignore */ new URL('needle.js', base).href
  )) as { default: NeedleFactory }
  const module = await source.default({
    wasmBinary: new Uint8Array(wasm),
    print: () => {},
    printErr: () => {},
  })
  const bytes = new Uint8Array(task.model)
  const pointer = allocate(module, bytes.byteLength)
  module.HEAPU8.set(bytes, pointer)
  // The loaded model may refer into its container. Keep this allocation alive
  // for the worker lifetime; terminating the worker releases it in one step.
  if (
    module._needle_load(pointer, BigInt(bytes.byteLength)) < 0 ||
    !(module._needle_models() & 2)
  )
    throw new Error(
      module.UTF8ToString(module._needle_last_error(), 1_024) ||
        'The offline speech model could not load.'
    )
  engine = module
}

function transcribe(task: Extract<Task, { type: 'transcribe' }>) {
  if (!engine) throw new Error('Load the downloaded dictation model first.')
  validateWhistleAudio(task.pcm)
  validateWhistleLanguage(task.language)
  const allocations: number[] = []
  const reserve = (bytes: number) => {
    const pointer = allocate(engine!, bytes)
    allocations.push(pointer)
    return pointer
  }
  try {
    const pcm = reserve(task.pcm.byteLength)
    new Float32Array(engine.HEAPU8.buffer, pcm, task.pcm.length).set(task.pcm)
    const language = task.language ? reserve(3) : 0
    if (language)
      engine.HEAPU8.set(
        new TextEncoder().encode(`${task.language}\u0000`),
        language
      )
    const capacity = WHISTLE_MAX_TEXT * 5 + 4_096
    const out = reserve(capacity)
    if (
      engine._needle_transcribe(
        pcm,
        task.pcm.length,
        language,
        0,
        0,
        out,
        capacity
      ) < 0
    )
      throw new Error(
        engine.UTF8ToString(engine._needle_last_error(), 1_024) ||
          'Whistle could not transcribe this recording.'
      )
    return parseWhistleTranscript(
      JSON.parse(engine.UTF8ToString(out, capacity))
    )
  } finally {
    for (const pointer of allocations) engine._free(pointer)
    task.pcm.fill(0)
  }
}

scope.onmessage = event => {
  const task = event.data
  if (!task || !Number.isSafeInteger(task.id)) return
  if (busy) {
    scope.postMessage({
      id: task.id,
      type: 'error',
      error: 'Offline dictation is already busy.',
    })
    return
  }
  busy = true
  void (async () => {
    try {
      if (task.type === 'load') {
        await load(task)
        scope.postMessage({ id: task.id, type: 'done' })
      } else if (task.type === 'transcribe') {
        scope.postMessage({
          id: task.id,
          type: 'done',
          result: transcribe(task),
        })
      }
    } catch (error) {
      scope.postMessage({
        id: task.id,
        type: 'error',
        error:
          error instanceof Error ? error.message : 'Offline dictation failed.',
      })
    } finally {
      busy = false
    }
  })()
}
