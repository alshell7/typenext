import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import type { Workspace } from '../../src/types/notebook'

const storageKey = 'typenext.workspace.v1'
const demoId = 'typenext-demo-bramble-house-v1'
const demoTitle = 'A morning at Bramble House'
const details = 'Bramble House · details'
const voice = 'Bramble House · voice'
const continuation = ' on Friday at 16:00.'
const runtimeErrors = new WeakMap<Page, string[]>()
const outgoing = new WeakMap<Page, string[]>()
const content = (page: Page) =>
  page.getByRole('textbox', { name: 'Note content', exact: true })
const normalized = (text: string) => text.replace(/\r\n?/gu, '\n')

test.beforeEach(async ({ page }) => {
  const errors: string[] = [],
    requests: string[] = []
  runtimeErrors.set(page, errors)
  outgoing.set(page, requests)
  page.on('pageerror', error => errors.push(error.message))
  page.context().on('request', request => {
    if (
      /^https?:/u.test(request.url()) &&
      new URL(request.url()).origin !== 'http://127.0.0.1:1420'
    )
      requests.push(request.url())
  })
  await page.context().route('**/*', async route => {
    if (
      /^https?:/u.test(route.request().url()) &&
      new URL(route.request().url()).origin !== 'http://127.0.0.1:1420'
    )
      await route.abort()
    else await route.continue()
  })
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
})
test.afterEach(async ({ page }) => {
  expect(
    runtimeErrors.get(page),
    'Sample flows must not throw browser exceptions'
  ).toEqual([])
  expect(
    outgoing.get(page),
    'Opening or recalling sample material must not download a model or send writing to a server'
  ).toEqual([])
})

async function saved(page: Page): Promise<Workspace | undefined> {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Workspace) : undefined
  }, storageKey)
}
async function savedDemo(page: Page) {
  return (await saved(page))?.notes.find(note => note.id === demoId)
}
async function writingText(editor: Locator) {
  return editor.evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll('.cm-ghost-suggestion')
      .forEach(ghost => ghost.remove())
    return Array.from(
      clone.querySelectorAll('.cm-line'),
      line => line.textContent ?? ''
    ).join('\n')
  })
}
async function cursorOffset(editor: Locator) {
  return editor.evaluate(element => {
    const selection = window.getSelection()
    if (!selection?.focusNode || !element.contains(selection.focusNode))
      return undefined
    const range = document.createRange()
    range.selectNodeContents(element)
    range.setEnd(selection.focusNode, selection.focusOffset)
    return range.toString().length
  })
}
async function openContexts(page: Page) {
  await page.getByRole('button', { name: /^Contexts\b/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Contexts', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function createNote(page: Page, title: string) {
  await page.getByRole('button', { name: 'Start a note', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click()
  await expect(content(page)).toBeVisible()
  return content(page)
}
async function preferences(page: Page, pane: 'Writing' | 'Local suggestions') {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}
async function openSample(page: Page, action: Locator) {
  await action.click()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue(demoTitle)
  await expect(content(page)).toBeFocused()
}

test('the welcome sample is optional, installs its own contexts, recalls at the ready cursor, accepts and undoes', async ({
  page,
}) => {
  const before = await saved(page)
  expect(before?.notes ?? []).toEqual([])
  expect(before?.contextPackages ?? []).toEqual([])
  await expect(
    page.getByRole('button', { name: 'Start a note', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Open Markdown', exact: true })
  ).toBeVisible()
  await openSample(
    page,
    page.getByRole('button', { name: 'Try a sample', exact: true })
  )
  await expect(
    page.getByRole('note', { name: 'Sample writing tip' })
  ).toContainText('Tab')
  await expect
    .poll(async () => (await savedDemo(page))?.contextPackageIds?.length)
    .toBe(2)
  const installed = (await saved(page))!
  const original = normalized((await savedDemo(page))!.content)
  expect(installed.notes).toHaveLength(1)
  expect(installed.contextPackages).toHaveLength(2)
  expect(installed.contextLibrary).toHaveLength(4)
  expect(installed.notes[0]!.sources).toEqual([])
  expect(installed.settings.localEngine).toBe('recall')
  expect(installed.settings.provider).toBe('local')
  expect(original).toMatch(/Guests arrive at Bramble House$/u)
  expect(await writingText(content(page))).toBe(original)
  // No click or cursor movement is necessary after opening a fresh sample.
  await content(page).press('Control+Space')
  await expect(page.locator('.cm-ghost-text')).toHaveText(continuation)
  await expect(
    page.getByRole('listbox', { name: 'Suggestions' })
  ).toContainText('From house.md')
  expect(await writingText(content(page))).toBe(original)
  await content(page).press('Tab')
  await expect
    .poll(async () => (await savedDemo(page))?.content)
    .toBe(original + continuation)
  await content(page).press('Control+z')
  await expect.poll(async () => (await savedDemo(page))?.content).toBe(original)
  await page.reload()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue(demoTitle)
  const contexts = await openContexts(page)
  await expect(
    contexts.getByRole('button', { name: 'Open sample', exact: true })
  ).toBeVisible()
  await expect(
    contexts.getByRole('checkbox', { name: `Use ${details} in this note` })
  ).toBeChecked()
  await expect(
    contexts.getByRole('checkbox', { name: `Use ${voice} in this note` })
  ).toBeChecked()
})

test('typing and pausing recalls each sample fact automatically without a model', async ({
  page,
}) => {
  await openSample(
    page,
    page.getByRole('button', { name: 'Try a sample', exact: true })
  )
  const editor = content(page)
  for (const [fragment, expected] of [
    ['Guests arrive at Bramble House', continuation],
    [
      'The Saturday writing session begins',
      ' at 09:30 in the shared writing room.',
    ],
    [
      'The coastal walk starts',
      ' at the blue orchard gate and ends at the same gate.',
    ],
  ]) {
    await editor.fill(fragment.slice(0, -1))
    await editor.press('Control+End')
    await editor.press(fragment.slice(-1))
    await expect(page.locator('.cm-ghost-text')).toHaveText(expected)
    await expect(
      page.getByRole('listbox', { name: 'Suggestions' })
    ).toHaveCount(0)
    expect(await writingText(editor)).toBe(fragment)
    await editor.press('Tab')
    expect(await writingText(editor)).toBe(fragment + expected)
    await editor.press('Control+z')
    expect(await writingText(editor)).toBe(fragment)
  }
})

test('existing writers can try and reopen the sample without changing their note, settings, removed context or cursor', async ({
  page,
}) => {
  const own = await createNote(page, 'My existing draft')
  await own.fill('A thought I wrote before opening any sample.')
  let settings = await preferences(page, 'Local suggestions')
  await settings
    .getByRole('switch', { name: /^Suggest after a pause/ })
    .uncheck()
  await settings
    .getByLabel('Use on this device', { exact: true })
    .selectOption('server')
  await settings
    .getByLabel('Server address', { exact: true })
    .fill('http://127.0.0.1:1337/v1')
  await settings
    .getByLabel('Model', { exact: true })
    .fill('preserved-local-writer')
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  settings = await preferences(page, 'Writing')
  await settings.getByLabel('Appearance', { exact: true }).selectOption('dark')
  await settings.getByRole('switch', { name: /^Autosave/ }).uncheck()
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('button', { name: 'Unsaved · save now', exact: true })
    .click()
  await expect
    .poll(async () => (await saved(page))?.settings.autoSave)
    .toBe(false)
  const before = (await saved(page))!
  const contexts = await openContexts(page)
  await openSample(
    page,
    contexts.getByRole('button', { name: 'Try a sample', exact: true })
  )
  await expect(contexts).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Unsaved · save now', exact: true })
    .click()
  await expect.poll(async () => (await saved(page))?.notes.length).toBe(2)
  let installed = (await saved(page))!
  expect(installed.settings).toEqual(before.settings)
  expect(installed.notes.find(note => note.id === before.activeNoteId)).toEqual(
    before.notes[0]
  )
  expect(
    installed.notes.find(note => note.id === before.activeNoteId)
      ?.contextPackageIds ?? []
  ).toEqual([])

  const edited = 'A sample line I edited for myself.'
  await content(page).fill(edited)
  let library = await openContexts(page)
  await library
    .getByRole('checkbox', { name: `Use ${voice} in this note` })
    .uncheck()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await content(page).focus()
  await content(page).press('Control+Home')
  await content(page).press('ArrowRight')
  await content(page).press('ArrowRight')
  await content(page).press('ArrowRight')
  library = await openContexts(page)
  await openSample(
    page,
    library.getByRole('button', { name: 'Open sample', exact: true })
  )
  await expect.poll(() => cursorOffset(content(page))).toBe(3)
  expect(await writingText(content(page))).toBe(edited)
  await page
    .getByRole('button', { name: 'Unsaved · save now', exact: true })
    .click()
  await expect.poll(async () => (await savedDemo(page))?.content).toBe(edited)
  installed = (await saved(page))!
  expect(installed.notes).toHaveLength(2)
  expect(installed.contextPackages).toHaveLength(2)
  expect(installed.contextLibrary).toHaveLength(4)
  expect(
    installed.notes.find(note => note.id === demoId)?.contextPackageIds
  ).toHaveLength(1)
  expect(installed.settings).toEqual(before.settings)
  expect(installed.notes.find(note => note.id === before.activeNoteId)).toEqual(
    before.notes[0]
  )
  await page.reload()
  await expect(content(page)).toHaveText(edited)
  expect((await saved(page))!.settings).toEqual(before.settings)
})

test('sample files download as a real local ZIP and the flow fits a narrow dark window', async ({
  page,
}, testInfo) => {
  const capture = process.env.TYPENEXT_CAPTURE_DEMO === '1'
  if (capture)
    await page.screenshot({ path: 'docs/screenshots/demo-welcome.png' })
  await openSample(
    page,
    page.getByRole('button', { name: 'Try a sample', exact: true })
  )
  if (
    await page.getByRole('button', { name: 'Dismiss notification' }).isVisible()
  )
    await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await content(page).press('Control+Space')
  await expect(page.locator('.cm-ghost-text')).toHaveText(continuation)
  if (capture) {
    await page
      .locator('.cm-suggestion-menu, .cm-ghost-suggestion')
      .evaluateAll(async elements => {
        await Promise.all(
          elements.flatMap(element =>
            element
              .getAnimations()
              .map(animation => animation.finished.catch(() => undefined))
          )
        )
      })
    await page.screenshot({ path: 'docs/screenshots/demo-writing.png' })
  }
  await content(page).press('Escape')
  let contexts = await openContexts(page)
  await expect(
    contexts.getByRole('button', { name: 'Open sample', exact: true })
  ).toBeVisible()
  const archiveLink = contexts.getByRole('link', {
    name: 'Download sample files',
    exact: true,
  })
  await expect(archiveLink).toHaveAttribute(
    'href',
    /demo\/typenext-sample\.zip$/u
  )
  const downloading = page.waitForEvent('download')
  await archiveLink.click()
  const archive = await downloading
  expect(await archive.failure()).toBeNull()
  expect(archive.suggestedFilename()).toBe('typenext-sample.zip')
  const path = testInfo.outputPath('typenext-sample.zip')
  await archive.saveAs(path)
  const files = unzipSync(new Uint8Array(readFileSync(path)))
  expect(Object.keys(files)).toHaveLength(6)
  expect(
    new TextDecoder().decode(files['bramble-house/details/house.md'])
  ).toContain('Guests arrive at Bramble House on Friday at 16:00.')
  if (capture)
    await page.screenshot({ path: 'docs/screenshots/demo-contexts.png' })
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.getByRole('button', { name: /^Context(?: \d+)?$/u }).click()
  const panel = page.getByRole('complementary', { name: 'Note context' })
  await panel
    .getByRole('button', { name: 'Manage contexts', exact: true })
    .click()
  contexts = page.getByRole('dialog', { name: 'Contexts', exact: true })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const bounds = await contexts.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(845)
  expect(
    await contexts.evaluate(
      element => element.scrollWidth > element.clientWidth + 1
    )
  ).toBe(false)
  await expect(
    contexts.getByRole('link', { name: 'Download sample files', exact: true })
  ).toBeVisible()
  if (capture)
    await page.screenshot({ path: 'docs/screenshots/demo-contexts-narrow.png' })
  // Opening through Contexts closes narrow overlays and hands focus to the writer.
  await openSample(
    page,
    contexts.getByRole('button', { name: 'Open sample', exact: true })
  )
  await expect(panel).toHaveCount(0)
  await expect(contexts).toHaveCount(0)
  await expect(
    page.getByRole('note', { name: 'Sample writing tip' })
  ).toBeVisible()
  if (capture) {
    if (
      await page
        .getByRole('button', { name: 'Dismiss notification' })
        .isVisible()
    )
      await page.getByRole('button', { name: 'Dismiss notification' }).click()
    await content(page).focus()
    await page.screenshot({ path: 'docs/screenshots/demo-writing-narrow.png' })
  }
})
