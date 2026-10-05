import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { build } from 'vite'
import { execFileSync } from 'node:child_process'

// Explicit engineering smoke. Only public pinned model files may be downloaded;
// all writing below is synthetic. No hosted inference endpoints are used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const directory = path.join(root, 'artifacts', 'builtin-model-smoke')
const resourcesOnly = process.argv.includes('--resources-only')
const demoOnly = process.argv.includes('--demo')
const selectedBackend = process.env.TYPENEXT_BUILTIN_BACKEND ?? 'wasm'
const reportName = resourcesOnly
  ? 'resources.json'
  : demoOnly
    ? 'demo-report.json'
    : 'report.json'
function ownedBrowserStatistics() {
  if (process.platform !== 'win32') return null
  const code = `$builtinProcesses=Get-CimInstance Win32_Process; $builtinIds=[System.Collections.Generic.HashSet[int]]::new(); foreach($builtinProcess in $builtinProcesses){ if($builtinProcess.Name -eq 'msedge.exe' -and $builtinProcess.CommandLine -and $builtinProcess.CommandLine.Contains($env:TYPENEXT_SMOKE_PROFILE)){[void]$builtinIds.Add([int]$builtinProcess.ProcessId)}}; do{$builtinAdded=$false; foreach($builtinProcess in $builtinProcesses){if($builtinIds.Contains([int]$builtinProcess.ParentProcessId) -and -not $builtinIds.Contains([int]$builtinProcess.ProcessId)){[void]$builtinIds.Add([int]$builtinProcess.ProcessId);$builtinAdded=$true}}}while($builtinAdded); $builtinStats=@($builtinIds | ForEach-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue}); [PSCustomObject]@{processes=$builtinStats.Count;privateBytes=($builtinStats|Measure-Object PrivateMemorySize64 -Sum).Sum;workingSetBytes=($builtinStats|Measure-Object WorkingSet64 -Sum).Sum;cpuSeconds=($builtinStats|ForEach-Object {$_.TotalProcessorTime.TotalSeconds}|Measure-Object -Sum).Sum} | ConvertTo-Json -Compress`
  try {
    return JSON.parse(
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', code],
        {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
          env: {
            ...process.env,
            TYPENEXT_SMOKE_PROFILE: path.join(directory, 'profile'),
          },
        }
      )
    )
  } catch {
    return null
  }
}
await mkdir(directory, { recursive: true })
const harness = path.join(directory, 'harness')
await build({
  configFile: false,
  root,
  publicDir: false,
  logLevel: 'error',
  worker: {
    format: 'es',
    plugins: () => [
      {
        name: 'synthetic-load-diagnostics',
        enforce: 'pre',
        transform(code, id) {
          if (id.endsWith('/builtin-engine.worker.ts'))
            return code.replace(
              '} catch {',
              '} catch (error) { console.error("Synthetic offline engine diagnostic:", error);'
            )
        },
      },
    ],
  },
  plugins: [
    {
      name: 'synthetic-offline-model-harness',
      resolveId(id) {
        if (id === 'builtin-harness') return '\0builtin-harness'
      },
      load(id) {
        if (id === '\0builtin-harness')
          return `import * as engine from ${JSON.stringify(path.join(root, 'src/services/builtin-engine.ts').replaceAll('\\', '/'))};import {suggest} from ${JSON.stringify(path.join(root, 'src/services/completion.ts').replaceAll('\\', '/'))};import {defaultSettings,emptyWorkspace} from ${JSON.stringify(path.join(root, 'src/notebook/model.ts').replaceAll('\\', '/'))};import {addDemoWorkspace} from ${JSON.stringify(path.join(root, 'src/notebook/demo.ts').replaceAll('\\', '/'))};import {resolveNoteContext} from ${JSON.stringify(path.join(root, 'src/notebook/note-context.ts').replaceAll('\\', '/'))};import {retrieveContext} from ${JSON.stringify(path.join(root, 'src/services/retrieval.ts').replaceAll('\\', '/'))};globalThis.builtinEngine=engine;globalThis.syntheticCompletion={suggest,defaultSettings,retrieveContext,createDemo(){const w=addDemoWorkspace(emptyWorkspace());return resolveNoteContext(w.notes[0],w.notes,w.contextLibrary,w.contextPackages)}};`
      },
    },
  ],
  build: {
    outDir: harness,
    emptyOutDir: false,
    rollupOptions: {
      input: 'builtin-harness',
      output: { entryFileNames: 'builtin-harness.js' },
    },
  },
})
await cp(
  path.join(root, 'public/runtime/builtin'),
  path.join(harness, 'runtime/builtin'),
  { recursive: true }
)
await writeFile(
  path.join(harness, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic offline inference smoke</title></head><body><p>Only synthetic model tests.</p><script type="module" src="/builtin-harness.js"></script></body></html>'
)
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1:1422')
      .pathname
    if (pathname === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    const file = path.resolve(
      harness,
      `.${pathname === '/' ? '/index.html' : pathname}`
    )
    if (!file.startsWith(harness + path.sep)) {
      response.writeHead(403)
      response.end()
      return
    }
    const content = await readFile(file)
    const type = file.endsWith('.wasm')
      ? 'application/wasm'
      : /\.(?:js|mjs)$/u.test(file)
        ? 'text/javascript'
        : file.endsWith('.html')
          ? 'text/html'
          : 'application/octet-stream'
    response.writeHead(200, { 'content-type': type })
    response.end(content)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(1422, '127.0.0.1', resolve)
})
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
  (process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined)
const report = {
  date: new Date().toISOString(),
  platform: process.platform,
  backend: selectedBackend,
  syntheticOnly: true,
  requests: [],
  runs: [],
  errors: [],
}
let context
try {
  context = await chromium.launchPersistentContext(
    path.join(directory, 'profile'),
    { executablePath, headless: true, viewport: { width: 1000, height: 800 } }
  )
  const page = await context.newPage()
  page.on('pageerror', error => {
    report.errors.push(error.name + ': ' + error.message.slice(0, 240))
  })
  page.on('console', message => {
    if (message.type() === 'error')
      report.errors.push(message.text().slice(0, 700))
  })
  context.on('request', request => {
    const url = new URL(request.url())
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      report.requests.push({
        host: url.hostname,
        path: url.pathname,
        method: request.method(),
      })
  })
  await page.goto('http://127.0.0.1:1422')
  await page.waitForFunction(() => Boolean(globalThis.builtinEngine), {
    timeout: 30_000,
  })
  const initial = await page.evaluate(async () => {
    const engine = globalThis.builtinEngine
    const cached = await engine.checkBuiltinCache()
    return {
      cached,
      state: engine.getBuiltinState(),
      userAgent: navigator.userAgent,
      wasm: typeof WebAssembly !== 'undefined',
      gpu: 'gpu' in navigator,
      heap: performance.memory?.usedJSHeapSize ?? null,
    }
  })
  report.initial = initial
  report.initial.processes = ownedBrowserStatistics()
  if (resourcesOnly && !initial.cached)
    throw new Error(
      'Resource-only smoke requires the already downloaded verified model.'
    )
  const started = performance.now()
  const loaded = await page.evaluate(
    async options => {
      const engine = globalThis.builtinEngine
      if (options.cached)
        await engine.loadBuiltinModel({ backend: options.backend })
      else await engine.downloadBuiltinModel({ backend: options.backend })
      return {
        state: engine.getBuiltinState(),
        heap: performance.memory?.usedJSHeapSize ?? null,
      }
    },
    { cached: initial.cached, backend: selectedBackend }
  )
  report.load = {
    milliseconds: Math.round(performance.now() - started),
    ...loaded,
  }
  report.load.processes = ownedBrowserStatistics()
  // Offline generation must still succeed after all external requests are blocked.
  const afterDownload = report.requests.length
  await context.route(
    /^https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/))/u,
    route => route.abort()
  )
  const fixtures = demoOnly
    ? await page.evaluate(() => {
        const note = globalThis.syntheticCompletion.createDemo()
        return [
          'Guests arrive at Bramble House',
          'The Saturday writing session begins',
          'The coastal walk starts',
        ].map(beforeCursor => ({
          name: 'shipped demo: ' + beforeCursor,
          noteTitle: note.title,
          objective: note.objective,
          writingBrief: note.context,
          references: note.sources.map(source => ({
            name: source.name,
            text: source.text,
          })),
          beforeCursor,
          afterCursor: '',
        }))
      })
    : [
        {
          name: 'informal testing fragment',
          noteTitle: 'Writing practice',
          objective: 'Try a little everyday writing.',
          writingBrief: 'An informal personal note.',
          references: [],
          beforeCursor:
            "Sometimes the words come slowly, and that is okay.\nI'm just testing if",
          afterCursor: '',
        },
        {
          name: 'quoted prose',
          noteTitle: 'A conversation',
          objective: 'A quiet conversation about writing.',
          writingBrief: '',
          references: [],
          beforeCursor:
            '\"I can try again,\" she said.\nThe most useful part of this exercise was',
          afterCursor: '',
        },
        {
          name: 'ordinary prose',
          noteTitle: 'A slower morning',
          objective: 'Describe an unhurried morning.',
          writingBrief: '',
          references: [],
          beforeCursor: 'I opened the window and',
          afterCursor: '',
        },
        {
          name: 'reference aware',
          noteTitle: 'Rain in the garden',
          objective: 'Describe the garden after rain.',
          writingBrief: '',
          references: [
            {
              name: 'Synthetic garden reference',
              text: 'At dawn, the garden held the scent of rain. The leaves were wet and the streets were quiet.',
            },
          ],
          beforeCursor: 'At dawn, the garden',
          afterCursor: '',
        },
        {
          name: 'suffix bridge',
          noteTitle: 'A patient writer',
          objective: 'Write calmly about making time.',
          writingBrief: '',
          references: [],
          beforeCursor: 'A patient writer',
          afterCursor: ' before the next sentence.',
        },
      ]
  for (const fixture of resourcesOnly
    ? []
    : fixtures.flatMap(fixture =>
        [0, 0.35].map(temperature => ({ ...fixture, temperature }))
      )) {
    const startedRun = performance.now()
    const { name, temperature, ...prompt } = fixture
    const result = await page.evaluate(
      async ({ input, temperature }) => {
        const engine = globalThis.builtinEngine
        const { suggest, defaultSettings, retrieveContext } =
          globalThis.syntheticCompletion
        const note = {
          id: 'synthetic-' + crypto.randomUUID(),
          title: input.noteTitle,
          objective: input.objective,
          context: input.writingBrief,
          content: input.beforeCursor + input.afterCursor,
          createdAt: 1,
          updatedAt: 1,
          sources: input.references.map((reference, index) => ({
            id: 'source-' + index,
            name: reference.name,
            text: reference.text,
            kind: 'text',
            enabled: true,
            addedAt: 1,
          })),
        }
        const retrieved = retrieveContext(
          note,
          `${input.beforeCursor.slice(-900)} ${input.afterCursor.slice(0, 250)} ${input.objective} ${input.writingBrief.slice(0, 400)} ${input.noteTitle}`,
          4,
          `${(input.beforeCursor.split('\n').at(-1) ?? '').slice(-250)} ${input.afterCursor.slice(0, 100).split('\n', 1)[0] ?? ''}`
        )
        const raw = await engine.generateBuiltinInsertion(
          {
            ...input,
            references: retrieved.map(chunk => ({
              name: chunk.sourceName,
              text: chunk.text,
            })),
          },
          {
            maxTokens: 48,
            temperature,
          }
        )
        const suggestion = await suggest(
          note,
          {
            text: note.content,
            cursor: input.beforeCursor.length,
            selectionEmpty: true,
            inCode: false,
          },
          {
            ...defaultSettings(),
            localEngine: 'embedded',
            temperature,
          }
        )
        return {
          raw,
          retrieved: retrieved.map(chunk => ({
            name: chunk.sourceName,
            text: chunk.text,
          })),
          suggestion,
          accepted: input.beforeCursor + suggestion.text + input.afterCursor,
          reconstructed: input.beforeCursor + raw + input.afterCursor,
          state: engine.getBuiltinState(),
          heap: performance.memory?.usedJSHeapSize ?? null,
        }
      },
      { input: prompt, temperature }
    )
    for (const candidate of [
      result.suggestion,
      ...(result.suggestion.alternatives ?? []),
    ]) {
      assert.doesNotMatch(
        candidate.text,
        /<\/?[a-z][^>]*>|&lt;|```|~~~|\{\s*"[^"]+"\s*:/iu,
        `${name}: malformed code escaped the prose guard`
      )
    }
    assert.equal(result.state.status, 'ready')
    report.runs.push({
      name,
      temperature,
      milliseconds: Math.round(performance.now() - startedRun),
      ...result,
    })
  }
  if (!resourcesOnly)
    assert.ok(
      report.runs.some(
        run => run.suggestion.mode === 'model' && run.suggestion.text.trim()
      ),
      'The real model must supply at least one usable prose continuation'
    )
  const warmStarted = performance.now()
  report.warmReload = await page.evaluate(async backend => {
    const engine = globalThis.builtinEngine
    engine.unloadBuiltinModel()
    await engine.loadBuiltinModel({ backend })
    return {
      state: engine.getBuiltinState(),
      heap: performance.memory?.usedJSHeapSize ?? null,
    }
  }, selectedBackend)
  report.warmReload.milliseconds = Math.round(performance.now() - warmStarted)
  report.warmReload.processes = ownedBrowserStatistics()
  report.externalRequestsAfterDownload = report.requests.slice(afterDownload)
  assert.equal(
    report.externalRequestsAfterDownload.length,
    0,
    'Cached inference must stay offline'
  )
  assert.deepEqual(report.errors, [], 'Browser/runtime errors')
  report.unloaded = await page.evaluate(async () => {
    const engine = globalThis.builtinEngine
    engine.unloadBuiltinModel()
    return {
      state: engine.getBuiltinState(),
      heap: performance.memory?.usedJSHeapSize ?? null,
    }
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await new Promise(resolve => setTimeout(resolve, 2000))
  report.unloaded.processes = ownedBrowserStatistics()
} catch (error) {
  report.errors.push(error.name + ': ' + error.message.slice(0, 240))
  process.exitCode = 1
} finally {
  if (context) await context.close()
  await new Promise(resolve => server.close(resolve))
  await writeFile(
    path.join(directory, reportName),
    JSON.stringify(report, null, 2)
  )
  console.log(
    JSON.stringify(
      {
        report: `artifacts/builtin-model-smoke/${reportName}`,
        errors: report.errors,
        loadMilliseconds: report.load?.milliseconds,
        runs: report.runs.map(run => ({
          name: run.name,
          milliseconds: run.milliseconds,
          raw: run.raw,
          temperature: run.temperature,
          suggestion: run.suggestion,
        })),
        externalRequestsAfterDownload:
          report.externalRequestsAfterDownload?.length,
        processMemory: {
          initial: report.initial?.processes,
          loaded: report.load?.processes,
          reloaded: report.warmReload?.processes,
          unloaded: report.unloaded?.processes,
        },
      },
      null,
      2
    )
  )
}
