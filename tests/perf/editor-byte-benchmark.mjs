import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

mkdirSync('artifacts', { recursive: true })
const result = await build({
  stdin: {
    contents:
      "export { EditorState } from '@codemirror/state'; export { documentByteSize, proposedDocumentByteSize } from './src/components/notebook/editor-extensions.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const modulePath = 'artifacts/editor-byte-runtime.mjs'
writeFileSync(modulePath, result.outputFiles[0].text)
const { EditorState, documentByteSize, proposedDocumentByteSize } =
  await import(pathToFileURL(modulePath).href)
const noteLimit = 8 * 1024 * 1024
const cases = []
const line =
  'A synthetic Markdown paragraph keeps each changed range short. **Calm writing**.\n\n'
for (const size of [1_000_000, noteLimit - 1024]) {
  const document = line.repeat(Math.ceil(size / line.length)).slice(0, size)
  for (const guarded of [false, true]) {
    const timings = []
    let finalBytes
    for (let round = 0; round < 3; round++) {
      let state = EditorState.create({
        doc: document,
        extensions: guarded
          ? [
              documentByteSize,
              EditorState.transactionFilter.of(transaction =>
                proposedDocumentByteSize(transaction) <= noteLimit
                  ? transaction
                  : []
              ),
            ]
          : [],
      })
      const from = Math.floor(size / 2)
      for (let index = 0; index < 500; index++)
        state = state.update({
          changes: { from, to: from + 1, insert: index % 2 ? 'a' : 'b' },
        }).state
      global.gc?.()
      const start = performance.now()
      for (let index = 0; index < 5000; index++)
        state = state.update({
          changes: { from, to: from + 1, insert: index % 2 ? 'a' : 'b' },
        }).state
      timings.push(performance.now() - start)
      finalBytes = guarded ? state.field(documentByteSize) : size
    }
    timings.sort((a, b) => a - b)
    cases.push({
      documentCharacters: size,
      guarded,
      changesPerRound: 5000,
      medianTotalMs: timings[1],
      medianMsPerChange: timings[1] / 5000,
      finalBytes,
    })
  }
}
writeFileSync(
  'artifacts/editor-byte-benchmark.json',
  JSON.stringify({ runtime: process.version, cases }, null, 2)
)
console.log(JSON.stringify({ runtime: process.version, cases }))
