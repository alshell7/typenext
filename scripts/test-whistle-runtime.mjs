import { readFile, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Run prepare-whistle-fixture.mjs first. Supply the pinned model file as argv[2]
// or place it in artifacts/whistle/whistle.cact. This smoke never downloads it.
const folder = fileURLToPath(new URL('../artifacts/whistle/', import.meta.url))
const modelPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(folder, 'whistle.cact')
if ((await stat(modelPath)).size !== 16_919_407)
  throw new Error('Use the pinned Whistle model (16,919,407 bytes).')
const model = await readFile(modelPath)
if (
  createHash('sha256').update(model).digest('hex') !==
  'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb'
)
  throw new Error(
    'The supplied speech model does not match the pinned revision.'
  )
const runtime = new URL('../public/runtime/whistle/', import.meta.url)
const wasm = await readFile(new URL('needle.wasm', runtime))
if (
  createHash('sha256').update(wasm).digest('hex') !==
  'c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d'
)
  throw new Error('WASM hash mismatch.')
const adapted = await readFile(new URL('needle.js', runtime))
const suffix = Buffer.from('\nexport default createNeedle;\n')
if (!adapted.subarray(-suffix.length).equals(suffix))
  throw new Error('Unknown runtime adapter.')
const classic = adapted.subarray(0, -suffix.length)
if (
  createHash('sha256').update(classic).digest('hex') !==
  'f3f7366dcad9555b792ee519d2518f3c506038bcb2ffd179e76e850000749359'
)
  throw new Error('JS runtime hash mismatch.')
const nodeRuntime = path.join(folder, 'needle.cjs')
await writeFile(nodeRuntime, classic)
const createNeedle = createRequire(import.meta.url)(nodeRuntime)
const pcmPath = path.join(folder, 'synthetic.f32')
const pcmSize = (await stat(pcmPath)).size
if (!pcmSize || pcmSize % 4 || pcmSize > 1_920_000)
  throw new Error(
    'Expected bounded 16 kHz Float32 PCM. Run prepare-whistle-fixture.mjs.'
  )
const bytes = await readFile(pcmPath)
const pcm = new Float32Array(
  bytes.buffer,
  bytes.byteOffset,
  bytes.byteLength / 4
)
for (const value of pcm)
  if (!Number.isFinite(value) || value < -1 || value > 1)
    throw new Error('Invalid PCM fixture.')
const began = performance.now()
const engine = await createNeedle({
  wasmBinary: wasm,
  print: () => {},
  printErr: () => {},
})
const weights = engine._malloc(model.length)
engine.HEAPU8.set(model, weights)
if (engine._needle_load(weights, BigInt(model.length)) < 0)
  throw new Error(engine.UTF8ToString(engine._needle_last_error()))
const loaded = performance.now()
const samples = engine._malloc(pcm.byteLength)
new Float32Array(engine.HEAPU8.buffer, samples, pcm.length).set(pcm)
const out = engine._malloc(64_096)
const tokens = engine._needle_transcribe(
  samples,
  pcm.length,
  0,
  0,
  0,
  out,
  64_096
)
if (tokens < 0)
  throw new Error(engine.UTF8ToString(engine._needle_last_error()))
const finished = performance.now()
const result = JSON.parse(engine.UTF8ToString(out, 64_096))
const normalized = result.text
  ?.toLowerCase()
  .replace(/[^a-z ]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
if (normalized !== 'the patient writer leaves room for another thought')
  throw new Error(
    `Synthetic transcription did not match the reference: ${result.text}`
  )
const report = {
  fixture: 'Offline Windows System.Speech synthetic voice; no human recording',
  audioSeconds: pcm.length / 16_000,
  loadMs: Number((loaded - began).toFixed(1)),
  transcribeMs: Number((finished - loaded).toFixed(1)),
  wasmHeapBytes: engine.HEAPU8.byteLength,
  rssBytes: process.memoryUsage().rss,
  tokens,
  result,
}
await writeFile(
  path.join(folder, 'asr-smoke.json'),
  `${JSON.stringify(report, null, 2)}\n`
)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
engine._free(samples)
engine._free(out)
engine._needle_reset()
engine._free(weights)
