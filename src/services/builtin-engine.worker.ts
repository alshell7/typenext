import {
  BUILTIN_MODEL,
  builtinFileUrl,
  boundBuiltinPrompt,
  prepareBuiltinInput,
  boundBuiltinOutput,
  validBuiltinCacheFile,
  type BuiltinPrompt,
} from './builtin-model'
import type {
  TextGenerationPipeline,
  InterruptableStoppingCriteria,
} from '@huggingface/transformers'

interface Command {
  type: 'load' | 'generate' | 'cancel'
  id: number
  backend?: 'auto' | 'wasm' | 'webgpu'
  runtimeBase?: string
  prompt?: BuiltinPrompt
  maxTokens?: number
  temperature?: number
}
let generator: TextGenerationPipeline | null = null
let backend: 'wasm' | 'webgpu' = 'wasm'
let active = false
let interrupt: InterruptableStoppingCriteria | null = null
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Command>) => void) | null
  postMessage(message: unknown): void
}

async function load(command: Command): Promise<void> {
  const { pipeline, env, LogLevel } = await import('@huggingface/transformers')
  const cache = await caches.open(BUILTIN_MODEL.cache)
  const runtimeBase = new URL(
    command.runtimeBase ?? '',
    globalThis.location.href
  )
  if (
    runtimeBase.origin !== globalThis.location.origin ||
    !runtimeBase.pathname.endsWith('/runtime/builtin/')
  )
    throw new Error('Invalid bundled runtime path.')
  env.logLevel = LogLevel.NONE
  env.allowRemoteModels = false
  // v4 pipeline file discovery reads config before forwarding its revision option.
  // Fix the template itself so even that internal lookup sees only pinned bytes.
  env.remoteHost = 'https://huggingface.co/'
  env.remotePathTemplate = `{model}/resolve/${BUILTIN_MODEL.revision}/`
  env.allowLocalModels = true
  env.localModelPath = '/__typenext_cached_model__/'
  env.useFS = false
  env.useFSCache = false
  env.useBrowserCache = false
  env.useCustomCache = true
  env.useWasmCache = false
  env.experimental_useCrossOriginStorage = false
  env.customCache = {
    async match(request: string) {
      const file = BUILTIN_MODEL.files.find(
        candidate => request === builtinFileUrl(candidate.name)
      )
      if (!file) return undefined
      const response = await cache.match(request)
      return validBuiltinCacheFile(response, file) ? response : undefined
    },
    async put() {
      throw new Error('Inference cannot download or modify model files.')
    },
  }
  env.fetch = async (input, init) => {
    const url = new URL(String(input), globalThis.location.href)
    if (
      url.origin === runtimeBase.origin &&
      url.pathname.startsWith(runtimeBase.pathname)
    )
      return fetch(url, { ...init, credentials: 'omit' })
    // Optional model files may be absent. A local 404 prevents any network attempt.
    return new Response('', { status: 404 })
  }
  const wasm = env.backends.onnx.wasm
  if (!wasm) throw new Error('WebAssembly inference is unavailable.')
  wasm.numThreads = 1
  wasm.proxy = false
  const requested = command.backend ?? 'auto'
  const hasGpu = 'gpu' in navigator
  backend = requested === 'wasm' || !hasGpu ? 'wasm' : 'webgpu'
  if (requested === 'webgpu' && !hasGpu)
    throw new Error('WebGPU is unavailable. Select CPU mode.')
  const setRuntime = (gpu: boolean) => {
    const stem = `ort-wasm-simd-threaded${gpu ? '.asyncify' : ''}`
    wasm.wasmPaths = {
      mjs: new URL(`${stem}.mjs`, runtimeBase).href,
      wasm: new URL(`${stem}.wasm`, runtimeBase).href,
    }
  }
  setRuntime(backend === 'webgpu')
  generator = await pipeline('text-generation', BUILTIN_MODEL.id, {
    dtype: BUILTIN_MODEL.dtype,
    revision: BUILTIN_MODEL.revision,
    device: backend,
    local_files_only: true,
  })
}

async function generate(command: Command): Promise<string> {
  if (!generator || !command.prompt) throw new Error('The model is not loaded.')
  const {
    InterruptableStoppingCriteria,
    StoppingCriteria,
    StoppingCriteriaList,
  } = await import('@huggingface/transformers')
  interrupt = new InterruptableStoppingCriteria()
  const deadline = performance.now() + 15_000
  class Deadline extends StoppingCriteria {
    override _call(inputIds: number[][]): boolean[] {
      return inputIds.map(() => performance.now() > deadline)
    }
  }
  const criteria = new StoppingCriteriaList()
  criteria.push(interrupt)
  criteria.push(new Deadline())
  const prompt = boundBuiltinPrompt(command.prompt)
  const tokenizer = generator.tokenizer
  const input = prepareBuiltinInput(
    prompt,
    messages =>
      tokenizer.apply_chat_template(messages, {
        tokenize: false,
        add_generation_prompt: true,
      }) as string,
    text => tokenizer.encode(text, { add_special_tokens: false }).length
  )
  if (!input) return ''
  const output = await generator(input, {
    max_new_tokens: Math.max(1, Math.min(48, command.maxTokens ?? 24)),
    do_sample: (command.temperature ?? 0) > 0,
    temperature: Math.max(0.01, Math.min(1, command.temperature ?? 0.3)),
    top_p: 0.9,
    repetition_penalty: 1.1,
    return_full_text: false,
    add_special_tokens: false,
    tokenizer_encode_kwargs: { truncation: false },
    stopping_criteria: criteria,
  })
  return boundBuiltinOutput(output[0]?.generated_text ?? '')
}

scope.onmessage = event => {
  const command = event.data
  if (command.type === 'cancel') {
    interrupt?.interrupt()
    return
  }
  if (active) {
    scope.postMessage({
      type: 'error',
      id: command.id,
      error: 'The offline model is already busy.',
    })
    return
  }
  active = true
  void (async () => {
    try {
      const text =
        command.type === 'load'
          ? (await load(command), '')
          : await generate(command)
      scope.postMessage({ type: 'done', id: command.id, text, backend })
    } catch {
      // Do not echo library errors, prompt contents, or writing into logs/UI.
      scope.postMessage({
        type: 'error',
        id: command.id,
        error:
          command.type === 'load'
            ? 'The offline model could not load. Try CPU mode or free some memory.'
            : 'The offline model could not finish this insertion. Reload it and try a shorter context.',
      })
    } finally {
      active = false
      interrupt = null
    }
  })()
}
