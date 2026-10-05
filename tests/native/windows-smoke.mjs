import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { once } from 'node:events'

// Build using artifacts/native-smoke/tauri.json before running. The independent
// app identifier is verified over real IPC before any writing is entered.
if (process.platform !== 'win32')
  throw new Error('This native smoke runs on Windows.')
const root = process.cwd()
const appPath = resolve(root, 'src-tauri/target/debug/typenext.exe')
const identifier = JSON.parse(
  readFileSync(resolve(root, 'artifacts/native-smoke/tauri.json'), 'utf8')
).identifier
if (!/^com\.typenext\.smoke\.t[a-z0-9]+$/u.test(identifier))
  throw new Error('Refusing to run against a non-smoke application identifier.')
const dataPath = join(process.env.APPDATA, identifier, 'workspace-v1.json')
const out = resolve(root, 'artifacts/native-smoke')
mkdirSync(out, { recursive: true })
if (!existsSync(appPath))
  throw new Error('Build the isolated native smoke app first.')
if (existsSync(dataPath))
  throw new Error(
    'The smoke profile already exists. Use a fresh isolated identifier before rerunning.'
  )
const offlineModels = process.env.TYPENEXT_NATIVE_AI_SMOKE === '1'
const syntheticWav = resolve(root, 'artifacts/whistle/synthetic.wav')
if (offlineModels && !existsSync(syntheticWav))
  throw new Error(
    'Create the synthetic speech fixture with the Whistle smoke script first.'
  )
const observations = []
const generationRequests = []
const server = createServer(async (request, response) => {
  if (request.headers.authorization)
    throw new Error(
      'Unexpected Authorization header in the isolated native smoke.'
    )
  let body = ''
  for await (const chunk of request) body += chunk
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/v1/models') {
    response.end(JSON.stringify({ data: [{ id: 'native-smoke-local' }] }))
  } else if (request.url === '/v1/chat/completions') {
    generationRequests.push(JSON.parse(body))
    response.end(
      JSON.stringify({
        choices: [{ message: { content: ' held its breath' } }],
      })
    )
  } else {
    response.statusCode = 404
    response.end('{}')
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`
let child
let browser
let page
const errors = []
const pause = ms => new Promise(done => setTimeout(done, ms))
async function waitForDebuggerShutdown() {
  // WebView2 can outlive the application's process briefly. Reusing its fixed
  // test debug port too soon can connect the next launch to a dying WebView.
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await fetch('http://127.0.0.1:19220/json/version', {
        signal: AbortSignal.timeout(500),
      })
    } catch {
      return
    }
    await pause(125)
  }
  throw new Error('The isolated WebView debug endpoint did not shut down.')
}
async function start() {
  child = spawn(appPath, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        '--remote-debugging-port=19220 --remote-debugging-address=127.0.0.1' +
        (offlineModels
          ? ` --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture="${syntheticWav}"`
          : ''),
      WEBVIEW2_USER_DATA_FOLDER: join(out, `webview-${identifier}`),
    },
  })
  for (let index = 0; index < 80; index++) {
    if (child.exitCode !== null)
      throw new Error(
        `Smoke application exited at startup (${child.exitCode}).`
      )
    try {
      const check = await fetch('http://127.0.0.1:19220/json/version', {
        signal: AbortSignal.timeout(500),
      })
      if (check.ok) break
    } catch {
      /* The WebView debug endpoint is not ready yet. */
    }
    if (index === 79) throw new Error('WebView2 debug endpoint did not start.')
    await pause(250)
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:19220')
  const context = browser.contexts()[0]
  page = context.pages()[0] ?? (await context.waitForEvent('page'))
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__))
  const actual = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')
  )
  if (actual !== identifier)
    throw new Error(
      'Refusing to write: this is not the isolated native smoke profile.'
    )
}
async function quitAndWait(action) {
  const exit = once(child, 'exit')
  await action()
  const [code] = await Promise.race([
    exit,
    pause(10_000).then(() => {
      throw new Error('Native save/quit did not exit.')
    }),
  ])
  if (code !== 0) throw new Error(`Native app quit with code ${code}.`)
  await browser.close().catch(() => {})
  await waitForDebuggerShutdown()
  browser = undefined
  child = undefined
}
async function crashAndWait() {
  // The exact isolated child identifier was verified by start(). This forces
  // process termination without the application receiving CloseRequested.
  const exit = once(child, 'exit')
  if (!child.kill())
    throw new Error('Could not terminate the isolated smoke app.')
  await Promise.race([
    exit,
    pause(10_000).then(() => {
      throw new Error('The isolated crash did not stop the application.')
    }),
  ])
  await browser.close().catch(() => {})
  await waitForDebuggerShutdown()
  browser = undefined
  child = undefined
}
function saved() {
  return JSON.parse(readFileSync(dataPath, 'utf8'))
}
async function osClose() {
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })
  )
  await expect(
    page.getByRole('dialog', { name: 'Save before closing?', exact: true })
  ).toBeVisible()
}
async function preferences(pane) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}
try {
  await start()
  await page.getByRole('button', { name: 'Start a note', exact: true }).click()
  await page
    .getByLabel('Title', { exact: true })
    .fill('Native smoke: a quiet garden')
  await page.getByRole('button', { name: 'Create note', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: 'Note content',
    exact: true,
  })
  const prefix = 'At dawn, the garden'
  const suffix = ' while the city was still asleep.'
  await editor.fill(prefix + suffix)
  await editor.press('Control+Home')
  for (let index = 0; index < prefix.length; index++)
    await editor.press('ArrowRight')
  const local = await preferences('Local suggestions')
  await local
    .getByRole('switch', { name: /^Suggest after a pause/ })
    .setChecked(false)
  await local.getByLabel('Server address', { exact: true }).fill(modelUrl)
  await local.getByLabel('Model', { exact: true }).fill('native-smoke-local')
  await local
    .getByRole('button', { name: 'Test connection', exact: true })
    .click()
  await expect(local.getByText(/Connected\./)).toBeVisible()
  await local.getByRole('button', { name: 'Done', exact: true }).click()
  await editor.focus()
  await editor.press('Control+Space')
  await expect(page.locator('.cm-ghost-text')).toHaveText(' held its breath')
  const suggestions = page.getByRole('listbox', {
    name: 'Suggestions',
    exact: true,
  })
  await expect(suggestions).toBeVisible()
  await expect(editor).toBeFocused()
  await expect(
    suggestions.getByRole('option', { selected: true })
  ).toContainText('held its breath')
  const original = await editor.evaluate(element => {
    const clone = element.cloneNode(true)
    clone
      .querySelectorAll('.cm-ghost-suggestion')
      .forEach(ghost => ghost.remove())
    return clone.textContent
  })
  expect(original).toBe(prefix + suffix)
  await editor.press('Tab')
  await expect(suggestions).toHaveCount(0)
  const accepted = prefix + ' held its breath' + suffix
  await expect(editor).toHaveText(accepted)
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await expect.poll(() => saved().notes[0].content).toBe(accepted)
  expect(saved().settings.provider).toBe('local')
  expect(generationRequests).toHaveLength(1)
  observations.push(
    'Real WebView2 editor -> native Rust localhost HTTP -> inline preview and suggestion menu -> Tab -> atomic native workspace autosave passed.'
  )

  if (offlineModels) {
    const modelSettings = await preferences('Local suggestions')
    const modelPanel = modelSettings.getByRole('region', {
      name: 'Built-in offline model',
    })
    await modelPanel
      .getByText('Performance and model limits', { exact: true })
      .click()
    await modelPanel
      .getByLabel('Run the offline model with', { exact: true })
      .selectOption('wasm')
    await modelPanel
      .getByRole('button', { name: /^(Download model|Load downloaded model)$/ })
      .click()
    await expect(
      modelPanel.getByRole('button', { name: 'Use this model', exact: true })
    ).toBeVisible({ timeout: 240_000 })
    await modelPanel
      .getByRole('button', { name: 'Use this model', exact: true })
      .click()
    await modelSettings
      .getByRole('button', { name: 'Done', exact: true })
      .click()
    await editor.fill('I opened the window and')
    await editor.press('Control+End')
    await editor.press('Control+Space')
    await expect(page.locator('.cm-ghost-text')).toBeVisible({
      timeout: 30_000,
    })
    const insertion = await page.locator('.cm-ghost-text').textContent()
    if (!insertion?.trim())
      throw new Error('The real embedded model did not produce an insertion.')
    await editor.press('Tab')
    await expect(editor).toHaveText('I opened the window and' + insertion)
    const unloadSettings = await preferences('Local suggestions')
    await unloadSettings
      .getByRole('button', { name: 'Unload model', exact: true })
      .click()
    await unloadSettings
      .getByRole('button', { name: 'Done', exact: true })
      .click()
    await editor.fill(accepted)
    observations.push(
      'Bundled SmolLM2 downloaded with hash verification, generated real text in the native WebView worker, inserted with Tab, and unloaded.'
    )
    await editor.press('Control+End')
    await page
      .getByRole('button', { name: 'Dictate on this device', exact: true })
      .click()
    const voice = page.getByRole('region', {
      name: 'Inline dictation',
      exact: true,
    })
    await expect(voice).toBeVisible()
    // Cached models let the toolbar record immediately. Stop that setup
    // gesture before choosing an exact input; uncached models just show setup.
    await editor.press('Escape')
    const chooseInput = voice.getByRole('button', {
      name: 'Choose microphone',
      exact: true,
    })
    if ((await chooseInput.getAttribute('aria-expanded')) !== 'true')
      await chooseInput.click()
    await voice
      .getByRole('button', {
        name: /^(Download Whistle|Load downloaded model)/,
      })
      .click()
    await expect(
      voice.getByRole('button', { name: 'Dictate', exact: true })
    ).toBeEnabled({ timeout: 120_000 })
    await voice
      .getByRole('button', {
        name: 'Allow and refresh microphones',
        exact: true,
      })
      .click()
    await expect(
      voice.getByRole('button', {
        name: 'Allow and refresh microphones',
        exact: true,
      })
    ).toBeEnabled()
    const microphoneId = await voice
      .getByRole('combobox', { name: 'Microphone', exact: true })
      .locator('option')
      .evaluateAll(options =>
        options.map(option => option.value).find(value => value !== '')
      )
    if (!microphoneId)
      throw new Error('The fake microphone was not discovered.')
    await voice
      .getByRole('combobox', { name: 'Microphone', exact: true })
      .selectOption(microphoneId)
    await voice
      .getByLabel('Dictation language', { exact: true })
      .selectOption('en')
    await voice
      .getByRole('button', { name: 'Choose microphone', exact: true })
      .click()
    const dictationSettings = await preferences('Local suggestions')
    await dictationSettings
      .getByLabel('Use on this device', { exact: true })
      .selectOption('server')
    await dictationSettings
      .getByRole('switch', { name: /^Suggest after a pause/ })
      .setChecked(true)
    await dictationSettings
      .getByRole('button', { name: 'Done', exact: true })
      .click()
    await editor.focus()
    await editor.press('Control+End')
    const requestsBeforeSpeech = generationRequests.length
    await page.bringToFront()
    await editor.press('Control+Shift+d')
    await expect(
      voice.getByRole('button', { name: 'Stop', exact: true })
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.cm-dictation-anchor')).toHaveText('Listening…')
    await editor.pressSequentially(' Typed alongside.')
    await page.waitForTimeout(4_000)
    expect(generationRequests.length).toBe(requestsBeforeSpeech)
    await editor.press('Control+Shift+d')
    await expect(page.locator('.cm-dictation-anchor')).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(editor).toContainText('patient writer')
    const dictated = await editor.textContent()
    expect(dictated.startsWith(accepted + ' Typed alongside. ')).toBe(true)
    await expect(editor).toBeFocused()
    await expect
      .poll(() => generationRequests.length)
      .toBe(requestsBeforeSpeech + 1)
    await expect(page.locator('.cm-ghost-text')).toBeVisible()
    await editor.press('Escape')
    await editor.press('Control+z')
    await expect(editor).toHaveText(accepted + ' Typed alongside.')
    await editor.press('Control+Shift+d')
    await expect(
      voice.getByRole('button', { name: 'Stop', exact: true })
    ).toBeVisible()
    await editor.press('Escape')
    await expect(page.locator('.cm-dictation-anchor')).toHaveCount(0)
    await expect(editor).toHaveText(accepted + ' Typed alongside.')
    await editor.fill(accepted)
    const quiet = await preferences('Local suggestions')
    await quiet
      .getByRole('switch', { name: /^Suggest after a pause/ })
      .setChecked(false)
    await quiet.getByRole('button', { name: 'Done', exact: true }).click()
    observations.push(
      'Real inline Whistle capture with a selected microphone, shortcut start/stop/cancel, concurrent typing, mapped insertion, automatic model suggestion and one-step speech undo passed.'
    )
  }

  await page.getByRole('button', { name: 'Context', exact: true }).click()
  await page
    .getByRole('button', { name: 'Manage contexts', exact: true })
    .click()
  const contexts = page.getByRole('dialog', { name: 'Contexts', exact: true })
  for (const name of ['Research', 'Voice']) {
    await contexts
      .getByRole('button', { name: 'New context', exact: true })
      .click()
    await contexts.getByLabel('Context name', { exact: true }).fill(name)
    await contexts
      .getByRole('button', { name: 'Create context', exact: true })
      .click()
    await contexts
      .getByLabel('Add files to this context', { exact: true })
      .setInputFiles({
        name: `${name}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(
          `Synthetic ${name} context remains attached after a native restart.`
        ),
      })
    await contexts
      .getByRole('button', { name: `Preview ${name}.txt`, exact: true })
      .waitFor()
    await contexts
      .getByRole('checkbox', { name: `Use ${name} in this note`, exact: true })
      .check()
  }
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await expect.poll(() => saved().contextPackages?.length).toBe(2)
  await expect.poll(() => saved().notes[0].contextPackageIds?.length).toBe(2)
  await page
    .getByRole('button', { name: 'Close context panel', exact: true })
    .click()

  const deniedPath = join(out, 'not-granted.md')
  const denial = await page.evaluate(async path => {
    try {
      await window.__TAURI_INTERNALS__.invoke('write_markdown_file', {
        path,
        content: 'This write must be denied.',
      })
      return ''
    } catch (error) {
      return String(error)
    }
  }, deniedPath)
  expect(denial).toContain('Access to this file has not been granted')
  expect(existsSync(deniedPath)).toBe(false)
  const publicDenial = await page.evaluate(async url => {
    try {
      await window.__TAURI_INTERNALS__.invoke('http_request', {
        request: {
          requestId: 'native-smoke-public',
          url,
          method: 'GET',
          headers: {},
          body: null,
          publicOnly: true,
        },
      })
      return ''
    } catch (error) {
      return String(error)
    }
  }, modelUrl + '/models')
  expect(publicDenial).toMatch(/public|private|local|loopback/i)
  observations.push(
    'Real native file-scope denial and website localhost denial passed.'
  )

  const writing = await preferences('Writing')
  await writing.getByRole('switch', { name: /^Autosave/ }).setChecked(false)
  await writing.getByRole('button', { name: 'Done', exact: true }).click()
  const last = accepted + '\n\nThe last unsaved thought belongs here.'
  await editor.fill(last)
  await osClose()
  await page.getByRole('button', { name: 'Keep writing', exact: true }).click()
  await expect(editor).toHaveText(last, { useInnerText: true })
  await osClose()
  await quitAndWait(() =>
    page.getByRole('button', { name: 'Save and quit', exact: true }).click()
  )
  expect(saved().notes[0].content).toBe(last)
  expect(
    existsSync(
      join(process.env.APPDATA, identifier, 'workspace-v1.backup.json')
    )
  ).toBe(true)
  observations.push(
    'OS CloseRequested interception, cancel, Save and quit, clean process exit and backup creation passed.'
  )

  await start()
  const reopened = page.getByRole('textbox', {
    name: 'Note content',
    exact: true,
  })
  await expect(reopened).toHaveText(last, { useInnerText: true })
  await page.getByRole('button', { name: 'Context', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Manage Research', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Manage Voice', exact: true })
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Close context panel', exact: true })
    .click()
  observations.push(
    'Two independently named context packages, source memberships and note attachments survived native autosave and restart.'
  )
  const snapshot = readFileSync(dataPath, 'utf8')
  await reopened.fill(last + '\nThis edit will be discarded deliberately.')
  await osClose()
  await quitAndWait(() =>
    page
      .getByRole('button', { name: 'Quit without saving', exact: true })
      .click()
  )
  expect(readFileSync(dataPath, 'utf8')).toBe(snapshot)
  expect(errors).toEqual([])
  observations.push(
    'Native restart recovery and autosave-off Quit without saving preserves saved bytes passed.'
  )

  await start()
  const crashEditor = page.getByRole('textbox', {
    name: 'Note content',
    exact: true,
  })
  await expect(crashEditor).toHaveText(last, { useInnerText: true })
  const crashWriting = await preferences('Writing')
  await crashWriting.getByRole('switch', { name: /^Autosave/ }).setChecked(true)
  await crashWriting.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await crashEditor.press('Control+End')
  const continuous =
    '\nA durable copy is kept even while this thought is still being written.'
  let finishedTyping = false
  const typing = crashEditor
    .pressSequentially(continuous, { delay: 75 })
    .then(() => {
      finishedTyping = true
    })
  await expect
    .poll(() => saved().notes[0].content.length, { timeout: 3_500 })
    .toBeGreaterThan(last.length)
  expect(finishedTyping).toBe(false)
  await typing
  await crashAndWait()
  const durableText = saved().notes[0].content
  expect((last + continuous).startsWith(durableText)).toBe(true)
  expect(durableText.length).toBeGreaterThan(last.length)
  await start()
  await expect(
    page.getByRole('textbox', { name: 'Note content', exact: true })
  ).toHaveText(durableText, { useInnerText: true })
  await quitAndWait(() =>
    page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('plugin:window|close', {
        label: 'main',
      })
    )
  )
  expect(errors).toEqual([])
  expect(generationRequests).toHaveLength(offlineModels ? 2 : 1)
  observations.push(
    'Continuous typing saves before the pause; abrupt native process termination restarts with exact last durable text.'
  )
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        identifier,
        observations,
        unhandledErrors: errors,
        generationRequests: generationRequests.length,
        modelTransport: offlineModels
          ? 'synthetic server plus real bundled SmolLM2 and Whistle worker inference'
          : 'synthetic local server through native Rust HTTP; not real model inference',
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      status: 'passed',
      observations,
      generationRequests: generationRequests.length,
    })
  )
} finally {
  if (browser) await browser.close().catch(() => {})
  if (child?.exitCode === null) child.kill()
  await new Promise(done => server.close(done))
}
