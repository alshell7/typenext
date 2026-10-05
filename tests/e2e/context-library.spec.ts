import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import type { Workspace } from '../../src/types/notebook'

const workspaceKey = 'typenext.workspace.v1'
const fixture = (path: string) =>
  fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url))
const runtimeErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
})
test.afterEach(async ({ page }) => {
  expect(
    runtimeErrors.get(page),
    'Context library actions must not cause unhandled browser errors'
  ).toEqual([])
})

const editor = (page: Page) =>
  page.getByRole('textbox', { name: 'Note content', exact: true })

async function createNote(page: Page, title: string) {
  const first = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await first.isVisible()) await first.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue(title)
  await expect(editor(page)).toBeVisible()
  return editor(page)
}

async function openLibrary(page: Page) {
  await page.getByRole('button', { name: /^Context library\b/ }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Context library',
    exact: true,
  })
  await expect(dialog).toBeVisible()
  return dialog
}

async function openContext(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Note context' })
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Context', exact: true }).click()
  await expect(panel).toBeVisible()
  return panel
}

async function saved(page: Page): Promise<Workspace | undefined> {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as Workspace
    } catch {
      return undefined
    }
  }, workspaceKey)
}

async function savedSources(page: Page, title: string) {
  return (await saved(page))?.notes.find(note => note.title === title)?.sources
}

function outsideRequests(page: Page) {
  const requests: string[] = []
  page.on('request', request => {
    if (
      /^https?:/u.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1:1420/')
    )
      requests.push(request.url())
  })
  return requests
}

test('imports before the first note, reuses multiple sources across notes and detaches only from the active note', async ({
  page,
}) => {
  const outgoing = outsideRequests(page)
  let library = await openLibrary(page)
  await library
    .getByLabel('Add files to context library', { exact: true })
    .setInputFiles([
      {
        name: 'Morning.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('At dawn, the garden held the scent of rain.'),
      },
      {
        name: 'Plans.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('A small plan begins with one deliberate step.'),
      },
    ])
  await expect(
    library.getByRole('button', { name: 'Preview Morning.md' })
  ).toBeVisible()
  await expect(
    library.getByRole('button', { name: 'Preview Plans.txt' })
  ).toBeVisible()
  await expect(
    library.getByRole('checkbox', { name: 'Use Morning.md in this note' })
  ).toBeDisabled()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await createNote(page, 'First draft')
  library = await openLibrary(page)
  await library
    .getByRole('checkbox', { name: 'Use Morning.md in this note' })
    .check()
  await library
    .getByRole('checkbox', { name: 'Use Plans.txt in this note' })
    .check()
  await expect(library.getByText('2 selected', { exact: true })).toBeVisible()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await createNote(page, 'Second draft')
  library = await openLibrary(page)
  await library
    .getByRole('checkbox', { name: 'Use Morning.md in this note' })
    .check()
  await library
    .getByRole('checkbox', { name: 'Use Plans.txt in this note' })
    .check()
  await expect(
    library.getByRole('button', { name: 'Preview Morning.md' })
  ).toContainText('Used in 2 notes')
  await library
    .getByRole('checkbox', { name: 'Use Plans.txt in this note' })
    .uncheck()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(async () => (await savedSources(page, 'Second draft'))?.length)
    .toBe(1)
  const workspace = (await saved(page))!
  expect(workspace.contextLibrary).toHaveLength(2)
  expect(
    workspace.contextLibrary!.every(source => source.text.length > 0)
  ).toBe(true)
  expect(
    workspace.notes.find(note => note.title === 'First draft')?.sources
  ).toHaveLength(2)
  expect(
    workspace.notes
      .flatMap(note => note.sources)
      .every(source => source.libraryId && source.text === '')
  ).toBe(true)
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue(
    'Second draft'
  )
  library = await openLibrary(page)
  await expect(
    library.getByRole('checkbox', { name: 'Use Morning.md in this note' })
  ).toBeChecked()
  await expect(
    library.getByRole('checkbox', { name: 'Use Plans.txt in this note' })
  ).not.toBeChecked()
  expect(outgoing).toEqual([])
})

test('reenables excluded references and confirms library removal with all affected notes', async ({
  page,
}) => {
  const first = await createNote(page, 'First writer')
  await first.fill('My first words stay here.')
  let library = await openLibrary(page)
  await library.getByLabel('Add files to context library').setInputFiles({
    name: 'Shared.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A shared reference is kept once in the notebook.'),
  })
  await expect(
    library.getByRole('checkbox', { name: 'Use Shared.txt in this note' })
  ).toBeChecked()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  const panel = await openContext(page)
  await panel
    .getByRole('checkbox', { name: 'Use Shared.txt as context' })
    .uncheck()
  await panel.getByRole('button', { name: 'Choose from library' }).click()
  library = page.getByRole('dialog', { name: 'Context library', exact: true })
  await expect(
    library.getByRole('checkbox', { name: 'Use Shared.txt in this note' })
  ).not.toBeChecked()
  await library
    .getByRole('checkbox', { name: 'Use Shared.txt in this note' })
    .check()
  await expect(
    library.getByRole('checkbox', { name: 'Use Shared.txt in this note' })
  ).toBeChecked()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(
    panel.getByRole('checkbox', { name: 'Use Shared.txt as context' })
  ).toBeChecked()
  await panel.getByRole('button', { name: 'Close context panel' }).click()
  const second = await createNote(page, 'Second writer')
  await second.fill('My second words stay here.')
  library = await openLibrary(page)
  await library
    .getByRole('checkbox', { name: 'Use Shared.txt in this note' })
    .check()
  await library
    .getByRole('button', { name: 'Remove Shared.txt from library' })
    .click()
  const confirmation = library.getByRole('group', {
    name: 'Confirm reference removal',
  })
  await expect(confirmation).toContainText('This detaches it from 2 notes.')
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect(
    library.getByRole('button', { name: 'Preview Shared.txt' })
  ).toBeVisible()
  await library
    .getByRole('button', { name: 'Remove Shared.txt from library' })
    .click()
  await library
    .getByRole('button', { name: 'Remove from library', exact: true })
    .click()
  await expect(
    library.getByRole('button', { name: 'Preview Shared.txt' })
  ).toHaveCount(0)
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(async () => (await saved(page))?.contextLibrary?.length)
    .toBe(0)
  const workspace = (await saved(page))!
  expect(workspace.notes.every(note => note.sources.length === 0)).toBe(true)
  expect(
    workspace.notes.find(note => note.title === 'First writer')?.content
  ).toBe('My first words stay here.')
  expect(
    workspace.notes.find(note => note.title === 'Second writer')?.content
  ).toBe('My second words stay here.')
})

test('reuses live note writing, follows edits and titles, and permits a canonical own-note entry without a self attachment', async ({
  page,
}) => {
  const reference = await createNote(page, 'Research')
  await reference.fill('At dawn, the garden held the scent of rain.')
  const draft = await createNote(page, 'Draft')
  await draft.fill('At dawn, the garden')
  let library = await openLibrary(page)
  await library.getByRole('button', { name: 'Use a note', exact: true }).click()
  await library
    .getByRole('searchbox', { name: 'Search notes' })
    .fill('Research')
  await library
    .getByRole('button', { name: 'Add Research to context library' })
    .click()
  await expect(
    library.getByRole('checkbox', { name: 'Use Research in this note' })
  ).toBeChecked()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Open notes' })
    .getByRole('button', { name: 'Research', exact: true })
    .click()
  await editor(page).fill('At dawn, the garden held the smell of cedar.')
  await page
    .getByRole('textbox', { name: 'Note title', exact: true })
    .fill('Research revised')
  await page
    .getByRole('navigation', { name: 'Open notes' })
    .getByRole('button', { name: 'Draft', exact: true })
    .click()
  library = await openLibrary(page)
  await library
    .getByRole('button', { name: 'Preview Research revised' })
    .click()
  await expect(library.locator('.context-library-preview-text')).toHaveText(
    'At dawn, the garden held the smell of cedar.'
  )
  await library
    .getByRole('checkbox', { name: 'Use Research revised in this note' })
    .uncheck()
  await library
    .getByRole('checkbox', { name: 'Use Research revised in this note' })
    .check()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await editor(page).focus()
  await editor(page).press('Control+End')
  await editor(page).press('Control+Space')
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    ' held the smell of cedar.'
  )
  await editor(page).press('Tab')
  await expect
    .poll(
      async () =>
        (await saved(page))?.notes.find(note => note.title === 'Draft')?.content
    )
    .toBe('At dawn, the garden held the smell of cedar.')
  library = await openLibrary(page)
  await library.getByRole('button', { name: 'Use a note', exact: true }).click()
  await library
    .getByRole('button', { name: 'Add Draft to context library' })
    .click()
  await expect(
    library.getByRole('checkbox', { name: 'Use Draft in this note' })
  ).toBeDisabled()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(async () => (await saved(page))?.contextLibrary?.length)
    .toBe(2)
  const workspace = (await saved(page))!
  expect(
    workspace.contextLibrary!.every(
      source => source.kind === 'note' && source.text === ''
    )
  ).toBe(true)
  expect(
    workspace.notes.find(note => note.title === 'Draft')?.sources
  ).toHaveLength(1)
})

test('imports supported folder snapshots, filters nested folders, and visibly retrieves matching local excerpts', async ({
  page,
}) => {
  const outgoing = outsideRequests(page)
  await createNote(page, 'Folder draft')
  const library = await openLibrary(page)
  await library
    .getByLabel('Add folder to context library')
    .setInputFiles(fixture('library-folder'))
  await expect(
    library.getByRole('button', { name: 'Preview overview.md' })
  ).toBeVisible()
  await expect(
    library.getByRole('button', { name: 'Preview session.txt' })
  ).toBeVisible()
  await expect(
    library.getByRole('button', { name: 'Preview ignored.csv' })
  ).toHaveCount(0)
  await library
    .getByRole('button', {
      name: 'Folder library-folder/interviews',
      exact: true,
    })
    .click()
  await expect(
    library.getByRole('button', { name: 'Preview overview.md' })
  ).toHaveCount(0)
  await library
    .getByRole('searchbox', { name: 'Search references' })
    .fill('overview')
  await expect(library.getByText('No references match.')).toBeVisible()
  await library.getByRole('button', { name: /^All references/ }).click()
  await expect(
    library.getByRole('button', { name: 'Preview overview.md' })
  ).toBeVisible()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  const panel = await openContext(page)
  await panel.getByText('Find in attached context', { exact: true }).click()
  await panel
    .getByRole('searchbox', { name: 'Search attached references' })
    .fill('cedar fox')
  await expect(panel.getByRole('heading', { name: 'session.txt' })).toHaveCount(
    0
  )
  await panel
    .getByRole('button', { name: 'Find passages', exact: true })
    .click()
  await expect(
    panel.getByRole('heading', { name: 'session.txt' })
  ).toBeVisible()
  await expect(panel.locator('.context-attached-results')).toContainText(
    'The cedar fox shelter protects the woodland'
  )
  await panel
    .getByRole('checkbox', { name: 'Use session.txt as context' })
    .uncheck()
  await expect(
    panel.getByText('References changed. Search again for current passages.')
  ).toBeVisible()
  await panel
    .getByRole('button', { name: 'Find passages', exact: true })
    .click()
  await expect(
    panel.getByText('No matching passages. Try another phrase.')
  ).toBeVisible()
  await expect
    .poll(async () => (await saved(page))?.contextLibrary?.length)
    .toBe(2)
  const canonical = (await saved(page))!.contextLibrary!
  expect(canonical.map(source => source.folder).sort()).toEqual([
    'library-folder',
    'library-folder/interviews',
  ])
  expect(outgoing).toEqual([])
})

test('caches a deliberately imported website and reuses it without fetching the page again', async ({
  page,
}) => {
  const url = 'https://library.example.org/article'
  const imports: string[] = []
  await page.route(url, async route => {
    imports.push(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'access-control-allow-origin': '*' },
      body: '<!doctype html><html><head><title>A patient morning</title></head><body><article><h1>A patient morning</h1><p>The quiet morning leaves room for a patient thought, a slow breath, and the scent of rain in the garden.</p><p>Keep the useful details close to your writing, and return to them when the next paragraph needs a clear direction.</p></article></body></html>',
    })
  })
  await createNote(page, 'Web draft')
  let library = await openLibrary(page)
  await library
    .getByRole('button', { name: 'Add a website', exact: true })
    .click()
  const website = page.getByRole('dialog', {
    name: 'Bring a website into context',
  })
  await website.getByLabel('Website URL', { exact: true }).fill(url)
  await website
    .getByRole('button', { name: 'Import website', exact: true })
    .click()
  await expect(website).toHaveCount(0)
  library = await openLibrary(page)
  await library
    .getByRole('button', { name: 'Preview A patient morning' })
    .click()
  await expect(library.locator('.context-library-preview-text')).toContainText(
    'a slow breath'
  )
  await expect(
    library.getByRole('link', { name: 'View original' })
  ).toHaveAttribute('href', url)
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await createNote(page, 'Second web draft')
  library = await openLibrary(page)
  await library
    .getByRole('checkbox', { name: 'Use A patient morning in this note' })
    .check()
  await library
    .getByRole('button', { name: 'Preview A patient morning' })
    .click()
  await expect(library.locator('.context-library-preview-text')).toContainText(
    'a slow breath'
  )
  expect(imports).toEqual([url])
})

test('keeps the library usable in narrow dark mode and restores focus after an inline preview closes', async ({
  page,
}) => {
  await createNote(page, 'Narrow draft')
  let library = await openLibrary(page)
  await library.getByLabel('Add files to context library').setInputFiles({
    name: 'A long reference name for a narrow window.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      'A short reference with details that are easy to preview.'
    ),
  })
  await expect(
    library.getByRole('button', {
      name: 'Preview A long reference name for a narrow window.md',
    })
  ).toBeVisible()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  const panel = await openContext(page)
  await panel.getByRole('button', { name: 'Choose from library' }).click()
  library = page.getByRole('dialog', { name: 'Context library', exact: true })
  await expect(library).toBeVisible()
  const box = await library.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(391)
  expect(box!.y + box!.height).toBeLessThanOrEqual(845)
  const horizontalOverflow = await library.evaluate(
    element => element.scrollWidth > element.clientWidth + 1
  )
  expect(horizontalOverflow).toBe(false)
  await library
    .getByRole('button', {
      name: 'Preview A long reference name for a narrow window.md',
    })
    .click()
  await expect(library.locator('.context-library-preview-text')).toHaveText(
    'A short reference with details that are easy to preview.'
  )
  await library.press('Escape')
  await expect(library.locator('.context-library-preview-text')).toHaveCount(0)
  await expect(library).toBeVisible()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: 'Choose from library' })
  ).toBeFocused()
})
