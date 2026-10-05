import { chromium } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const label = process.argv[2] ?? 'current'
if (!/^[a-z0-9-]{1,64}$/.test(label))
  throw new Error(
    'Use a short lowercase label containing letters, numbers, or hyphens.'
  )
mkdirSync('artifacts', { recursive: true })
const windowsEdge =
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const executablePath =
  process.env.TYPENEXT_BROWSER_EXECUTABLE ??
  (existsSync(windowsEdge) ? windowsEdge : undefined)
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--enable-precise-memory-info'],
})
const context = await browser.newContext({
  viewport: { width: 1360, height: 900 },
})
const page = await context.newPage()
const errors = []
let unloadPrompts = 0
page.on('dialog', async dialog => {
  if (dialog.type() === 'beforeunload') unloadPrompts++
  else
    errors.push(
      `Unexpected ${dialog.type()}: ${dialog.message().slice(0, 160)}`
    )
  await dialog.dismiss()
})
page.on('pageerror', error => errors.push(error.message))
let requests = 0
let cancelled = 0
let release
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
await page.route('http://127.0.0.1:1337/v1/**', async route => {
  if (route.request().method() !== 'POST')
    return route.fulfill({ status: 204, headers: cors })
  requests++
  await new Promise(resolve => {
    release = resolve
  })
  try {
    await route.fulfill({
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({
        choices: [{ message: { content: ' STALE_PROFILE_TEXT.' } }],
      }),
    })
  } catch (error) {
    if (!route.request().failure()) throw error
  }
})
page.on('requestfailed', request => {
  if (request.url().includes(':1337/')) cancelled++
})
const editor = () =>
  page.getByRole('textbox', { name: 'Note content', exact: true })
async function createNote(title) {
  const start = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await start.isVisible()) await start.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click()
  await editor().waitFor()
}
async function settle() {
  await page.evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  )
}
const cdp = await context.newCDPSession(page)
async function heap() {
  await cdp.send('HeapProfiler.collectGarbage')
  return (await cdp.send('Runtime.getHeapUsage')).usedSize
}
async function observeView() {
  return page.evaluate(async () => {
    const code = await (
      await fetch('/src/components/notebook/MarkdownEditor.tsx')
    ).text()
    const moduleURL = code.match(
      /from\s*["']([^"']*codemirror_view[^"']*)["']/
    )?.[1]
    if (!moduleURL)
      throw new Error('Could not locate installed CodeMirror view module')
    const { EditorView } = await import(moduleURL)
    const view = EditorView.findFromDOM(
      document.querySelector('[aria-label="Note content"]')
    )
    const prototype = Object.getPrototypeOf(view.state.doc)
    if (!prototype.profileOriginalToString) {
      prototype.profileOriginalToString = prototype.toString
      prototype.toString = function () {
        window.profileConversions = (window.profileConversions ?? 0) + 1
        window.profileConvertedChars =
          (window.profileConvertedChars ?? 0) + this.length
        return prototype.profileOriginalToString.call(this)
      }
    }
    window.profileConversions = 0
    window.profileConvertedChars = 0
    return { characters: view.state.doc.length, lines: view.state.doc.lines }
  })
}
async function counters() {
  return page.evaluate(() => ({
    conversions: window.profileConversions,
    charactersMaterialized: window.profileConvertedChars,
  }))
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
  }
}

try {
  await page.goto('http://127.0.0.1:1420/')
  await createNote('Synthetic profile setup')
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const prefs = page.getByRole('dialog', { name: 'Make yourself at home' })
  await prefs.getByRole('switch', { name: /^Autosave/ }).uncheck()
  await prefs
    .getByRole('tab', { name: 'Local suggestions', exact: true })
    .click()
  await prefs.getByRole('switch', { name: /^Suggest after a pause/ }).uncheck()
  await prefs
    .getByLabel('Server address', { exact: true })
    .fill('http://127.0.0.1:1337/v1')
  await prefs
    .getByLabel('Model', { exact: true })
    .fill('synthetic-profile-model')
  await prefs.getByRole('button', { name: 'Done', exact: true }).click()
  await prefs.waitFor({ state: 'hidden' })
  const idleHeap = await heap()
  const paragraph =
    'A careful writer keeps the original thought visible, makes room for silence, and considers the details before changing a sentence. **Markdown emphasis** remains readable.\n\n'
  const document =
    '# A synthetic large note\n\n' +
    paragraph.repeat(5900) +
    'PROFILE_CANCEL_PREFIX '
  const reference = paragraph.repeat(1500)
  const fillStart = performance.now()
  const chooser = page.waitForEvent('filechooser')
  void chooser.catch(() => {})
  await page
    .getByRole('button', { name: 'Open a Markdown file', exact: true })
    .click()
  await (
    await chooser
  ).setFiles({
    name: 'Synthetic resource profile.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(document),
  })
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Note title"]')?.value ===
      'Synthetic resource profile'
  )
  await settle()
  const fillMs = performance.now() - fillStart
  await page.getByRole('button', { name: 'Context', exact: true }).click()
  const panel = page.getByRole('complementary', {
    name: 'Note context',
    exact: true,
  })
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles({
      name: 'synthetic-large-reference.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(reference),
    })
  await panel
    .getByRole('checkbox', {
      name: 'Use synthetic-large-reference.txt as context',
      exact: true,
    })
    .waitFor()
  await editor().press('Control+End')
  await settle()
  const viewSize = await observeView()
  const typing = []
  for (const character of 'twenty measured keys') {
    const start = performance.now()
    await editor().press(character === ' ' ? 'Space' : character)
    await settle()
    typing.push(performance.now() - start)
  }
  const typingConversions = await counters()
  await observeView()
  const cursor = []
  for (let index = 0; index < 30; index++) {
    const start = performance.now()
    await editor().press(index % 2 ? 'ArrowRight' : 'ArrowLeft')
    await settle()
    cursor.push(performance.now() - start)
  }
  const cursorConversions = await counters()
  const loadedHeap = await heap()
  await editor().press('Control+End')
  const requestStart = performance.now()
  await editor().press('Control+Space')
  await page.waitForFunction(() =>
    document
      .querySelector('.suggestion-message')
      ?.textContent?.includes('Finding a continuation')
  )
  for (let index = 0; index < 200 && !requests; index++)
    await page.waitForTimeout(50)
  if (!requests)
    throw new Error(
      'Synthetic cancelled inference never reached its isolated route'
    )
  const requestMs = performance.now() - requestStart
  const cancelStart = performance.now()
  await editor().press('Escape')
  for (let index = 0; index < 40 && !cancelled; index++)
    await page.waitForTimeout(25)
  const cancelMs = performance.now() - cancelStart
  await createNote('Synthetic fresh tab')
  await editor().fill('Fresh note after cancelled request.')
  release?.()
  await settle()
  const staleGhosts = await page.locator('.cm-ghost-suggestion').count()
  const tabs = page.getByRole('navigation', { name: 'Open notes', exact: true })
  const switches = []
  for (let index = 0; index < 8; index++) {
    const start = performance.now()
    await tabs
      .getByRole('button', {
        name: index % 2 ? 'Synthetic fresh tab' : 'Synthetic resource profile',
        exact: true,
      })
      .click()
    await settle()
    switches.push(performance.now() - start)
  }
  await page
    .getByRole('button', {
      name: 'Close Synthetic resource profile tab',
      exact: true,
    })
    .click()
  await settle()
  const closedHeap = await heap()
  const domEditors = await page.locator('.cm-editor').count()
  const result = {
    label,
    documentCharacters: document.length,
    referenceCharacters: reference.length,
    viewSize,
    fillMs,
    typing: distribution(typing),
    cursor: distribution(cursor),
    typingConversions,
    cursorConversions,
    heapBytes: {
      idle: idleHeap,
      loaded: loadedHeap,
      afterTabClose: closedHeap,
    },
    tabSwitch: distribution(switches),
    requestMs,
    cancelMs,
    requests,
    cancelled,
    staleGhosts,
    domEditors,
    unloadPrompts,
    errors,
  }
  writeFileSync(
    `artifacts/editor-resource-${label}.json`,
    JSON.stringify(result, null, 2)
  )
  console.log(JSON.stringify(result))
} catch (error) {
  console.log(
    JSON.stringify({ label, error: error.message.slice(0, 320), errors })
  )
  process.exitCode = 1
} finally {
  release?.()
  await context.close()
  await browser.close()
}
