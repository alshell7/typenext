import { constants, performance, PerformanceObserver } from 'node:perf_hooks'
import { mkdir, writeFile } from 'node:fs/promises'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { wordCount } from '../../src/notebook/model.ts'

// Run from the repository root with Node >=22.13:
// node --expose-gc tests/perf/word-count.mjs final
// No browser, credentials, note data, model runtime or network is used.
if (typeof globalThis.gc !== 'function') {
  throw new Error('Run this diagnostic with node --expose-gc.')
}
const label = process.argv[2] ?? 'final'
if (!/^[a-z\d_-]{1,40}$/iu.test(label)) {
  throw new Error('Use a short alphanumeric report label.')
}
const regexCount = text => text.trim().match(/\S+/gu)?.length ?? 0
const paragraph =
  'A careful writer keeps the original thought visible, makes room for silence, and considers the details before changing a sentence. **Markdown emphasis** remains readable.\n\n'
const profile =
  '# A synthetic large note\n\n' +
  paragraph.repeat(5900) +
  'PROFILE_CANCEL_PREFIX '
const maximum = paragraph
  .repeat(Math.ceil((8 * 1024 * 1024 - 1024) / paragraph.length))
  .slice(0, 8 * 1024 * 1024 - 1024)
const unicodeParagraph =
  'Café\u00a0patient\u1680writing\u2000stays\u202ffamiliar\u205fwith\u3000中文\u2028lines\u2029and\ufeffthoughts.\n'
function unicodeFixture(bytes) {
  return unicodeParagraph.repeat(
    Math.floor(bytes / Buffer.byteLength(unicodeParagraph))
  )
}
const fixtures = [
  { name: 'same-editor-profile', text: profile },
  { name: 'near8MiB-ascii', text: maximum },
  { name: 'near1MiB-unicode', text: unicodeFixture(1024 * 1024) },
  { name: 'near8MiB-unicode', text: unicodeFixture(8 * 1024 * 1024 - 1024) },
]
const round = number => Math.round(number * 1000) / 1000
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.floor(sorted.length * 0.95)]),
    samples: sorted.length,
  }
}
const gcEntries = []
const observer = new PerformanceObserver(list =>
  gcEntries.push(...list.getEntries())
)
observer.observe({ entryTypes: ['gc'] })
const gcHeap = async () => {
  globalThis.gc()
  await nextTurn()
  return process.memoryUsage().heapUsed
}
let checksum = 0
const results = []
for (const fixture of fixtures) {
  const { text } = fixture
  text.charCodeAt(text.length - 1)
  const expected = regexCount(text)
  if (wordCount(text) !== expected)
    throw new Error(`Count mismatch in ${fixture.name}`)
  const result = {
    name: fixture.name,
    characters: text.length,
    utf8Bytes: Buffer.byteLength(text),
    words: expected,
  }
  for (const [name, operation] of [
    ['regex', regexCount],
    ['scanner', wordCount],
  ]) {
    for (let warmup = 0; warmup < 8; warmup++) checksum += operation(text)
    await gcHeap()
    const samples = []
    const started = performance.now()
    for (let sample = 0; sample < 25; sample++) {
      const before = performance.now()
      checksum += operation(text)
      samples.push(performance.now() - before)
    }
    const stopped = performance.now()
    await nextTurn()
    await nextTurn()
    const automaticGC = gcEntries.filter(
      entry =>
        entry.startTime >= started &&
        entry.startTime < stopped &&
        !(entry.detail.flags & constants.NODE_PERFORMANCE_GC_FLAGS_FORCED)
    )
    const heapBefore = await gcHeap()
    checksum += operation(text)
    const heapAfterCall = process.memoryUsage().heapUsed
    const heapAfterCollection = await gcHeap()
    result[name] = {
      ...distribution(samples),
      automaticGC: {
        count: automaticGC.length,
        totalMs: round(
          automaticGC.reduce((sum, entry) => sum + entry.duration, 0)
        ),
      },
      singleCallHeapDeltaBeforeExplicitGC: heapAfterCall - heapBefore,
      retainedHeapDeltaAfterExplicitGC: heapAfterCollection - heapBefore,
    }
  }
  results.push(result)
}
observer.disconnect()
const report = {
  label,
  date: new Date().toISOString(),
  node: process.version,
  syntheticOnly: true,
  method:
    'Single process; each algorithm gets 8 warmups and 25 timed calls; GC events within timed windows; heap sampled once before/after a call and again after explicit GC. Heap deltas are snapshots rather than total allocation.',
  results,
  checksum,
}
await mkdir('artifacts/service-benchmark', { recursive: true })
await writeFile(
  `artifacts/service-benchmark/word-count-${label}.json`,
  JSON.stringify(report, null, 2)
)
console.log(JSON.stringify(report, null, 2))
