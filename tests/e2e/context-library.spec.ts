import { expect, test, type Locator, type Page } from '@playwright/test'
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
    'Context actions must not cause unhandled browser errors'
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

async function openContexts(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Contexts', exact: true })
  if (!(await dialog.isVisible()))
    await page.getByRole('button', { name: /^Contexts\b/ }).click()
  await expect(dialog).toBeVisible()
  return dialog
}

async function createContext(dialog: Locator, name: string) {
  await dialog.getByRole('button', { name: 'New context', exact: true }).click()
  await dialog.getByLabel('Context name', { exact: true }).fill(name)
  await dialog
    .getByRole('button', { name: 'Create context', exact: true })
    .click()
  await expect(dialog.getByRole('heading', { name, exact: true })).toBeVisible()
}

async function addFile(dialog: Locator, name: string, text: string) {
  await dialog
    .getByLabel('Add files to this context', { exact: true })
    .setInputFiles({
      name,
      mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
      buffer: Buffer.from(text),
    })
  await expect(
    dialog.getByRole('button', { name: `Preview ${name}`, exact: true })
  ).toBeVisible()
}

async function openContextPanel(page: Page) {
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

test('creates reusable contexts before a note and selects multiple packages independently per note', async ({
  page,
}) => {
  const outgoing = outsideRequests(page)
  let contexts = await openContexts(page)
  await createContext(contexts, 'Research')
  await addFile(
    contexts,
    'Morning.md',
    'At dawn, the garden held the scent of rain.'
  )
  await addFile(
    contexts,
    'Plan.txt',
    'A small plan begins with one deliberate step.'
  )
  await createContext(contexts, 'Voice')
  await addFile(
    contexts,
    'Tone.md',
    'Use short clear sentences and concrete observations.'
  )
  await expect(
    contexts.getByRole('checkbox', { name: 'Use Research in this note' })
  ).toBeDisabled()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()

  const first = await createNote(page, 'First draft')
  await first.fill('My first thought stays mine.')
  contexts = await openContexts(page)
  await expect(
    contexts.getByRole('checkbox', { name: 'Use Voice in this note' })
  ).not.toBeChecked()
  await contexts
    .getByRole('checkbox', { name: 'Use Research in this note' })
    .check()
  await contexts
    .getByRole('checkbox', { name: 'Use Voice in this note' })
    .check()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await createNote(page, 'Second draft')
  contexts = await openContexts(page)
  await expect(
    contexts.getByRole('checkbox', { name: 'Use Research in this note' })
  ).not.toBeChecked()
  await contexts
    .getByRole('checkbox', { name: 'Use Research in this note' })
    .check()
  await contexts
    .getByRole('checkbox', { name: 'Use Voice in this note' })
    .check()
  await contexts
    .getByRole('checkbox', { name: 'Use Voice in this note' })
    .uncheck()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()

  await expect
    .poll(
      async () =>
        (await saved(page))?.notes.find(note => note.title === 'Second draft')
          ?.contextPackageIds?.length
    )
    .toBe(1)
  const workspace = (await saved(page))!
  const research = workspace.contextPackages!.find(
    context => context.name === 'Research'
  )!
  const voice = workspace.contextPackages!.find(
    context => context.name === 'Voice'
  )!
  expect(research.sourceIds).toHaveLength(2)
  expect(voice.sourceIds).toHaveLength(1)
  expect(workspace.contextLibrary).toHaveLength(3)
  expect(workspace.notes.every(note => note.sources.length === 0)).toBe(true)
  expect(
    workspace.notes.find(note => note.title === 'First draft')
      ?.contextPackageIds
  ).toEqual([research.id, voice.id])
  expect(
    workspace.notes.find(note => note.title === 'First draft')?.content
  ).toBe('My first thought stays mine.')
  await page.reload()
  contexts = await openContexts(page)
  await expect(
    contexts.getByRole('checkbox', { name: 'Use Research in this note' })
  ).toBeChecked()
  await expect(
    contexts.getByRole('checkbox', { name: 'Use Voice in this note' })
  ).not.toBeChecked()
  expect(outgoing).toEqual([])
})

test('deduplicates shared snapshots while package changes and removal preserve other contexts and writing', async ({
  page,
}) => {
  const text = 'A shared reference is kept once in the notebook.'
  const first = await createNote(page, 'First writer')
  await first.fill('My first words stay here.')
  let contexts = await openContexts(page)
  await createContext(contexts, 'Research')
  await addFile(contexts, 'Shared.txt', text)
  await contexts
    .getByRole('checkbox', { name: 'Use Research in this note' })
    .check()
  await createContext(contexts, 'Voice')
  await addFile(contexts, 'Shared.txt', text)
  await contexts
    .getByRole('checkbox', { name: 'Use Voice in this note' })
    .check()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  const second = await createNote(page, 'Second writer')
  await second.fill('My second words stay here.')
  contexts = await openContexts(page)
  await contexts
    .getByRole('checkbox', { name: 'Use Research in this note' })
    .check()
  await contexts.getByRole('button', { name: 'Open Research context' }).click()
  await expect(
    contexts.getByText('Used in 2 notes.', { exact: false })
  ).toBeVisible()
  await contexts
    .getByRole('button', { name: 'Rename Research', exact: true })
    .click()
  await contexts.getByLabel('Context name').fill('Research revised')
  await contexts.getByRole('button', { name: 'Save name', exact: true }).click()
  await expect(
    contexts.getByRole('checkbox', {
      name: 'Use Research revised in this note',
    })
  ).toBeChecked()
  await expect
    .poll(async () => (await saved(page))?.contextLibrary?.length)
    .toBe(1)

  await contexts
    .getByRole('button', {
      name: 'Remove Shared.txt from Research revised',
      exact: true,
    })
    .click()
  const confirmation = contexts.getByRole('group', {
    name: 'Confirm context removal',
  })
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await expect(
    contexts.getByRole('button', { name: 'Preview Shared.txt' })
  ).toBeVisible()
  await contexts
    .getByRole('button', {
      name: 'Remove Shared.txt from Research revised',
      exact: true,
    })
    .click()
  await confirmation
    .getByRole('button', { name: 'Remove source', exact: true })
    .click()
  await expect(
    contexts.getByRole('button', { name: 'Preview Shared.txt' })
  ).toHaveCount(0)
  await contexts.getByRole('button', { name: 'Open Voice context' }).click()
  await contexts
    .getByRole('button', { name: 'Preview Shared.txt', exact: true })
    .click()
  await expect(contexts.locator('.context-library-preview-text')).toHaveText(
    text
  )

  await contexts
    .getByRole('button', { name: 'Open Research revised context' })
    .click()
  await contexts
    .getByRole('button', {
      name: 'Remove Research revised context',
      exact: true,
    })
    .click()
  await expect(confirmation).toContainText('2 notes')
  await confirmation
    .getByRole('button', { name: 'Remove context', exact: true })
    .click()
  await expect(
    contexts.getByRole('checkbox', {
      name: 'Use Research revised in this note',
    })
  ).toHaveCount(0)
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(async () => (await saved(page))?.contextPackages?.length)
    .toBe(1)
  const workspace = (await saved(page))!
  const voice = workspace.contextPackages![0]!
  expect(workspace.contextLibrary).toHaveLength(1)
  expect(
    workspace.notes.find(note => note.title === 'First writer')
      ?.contextPackageIds
  ).toEqual([voice.id])
  expect(
    workspace.notes.find(note => note.title === 'Second writer')
      ?.contextPackageIds
  ).toEqual([])
  expect(workspace.notes.map(note => note.content).sort()).toEqual([
    'My first words stay here.',
    'My second words stay here.',
  ])
})

test('uses live note sources in a package, follows new words and titles, and excludes its own note', async ({
  page,
}) => {
  const outgoing = outsideRequests(page)
  const research = await createNote(page, 'Research')
  await research.fill('At dawn, the garden held the scent of rain.')
  const draft = await createNote(page, 'Draft')
  await draft.fill('At dawn, the garden')
  let contexts = await openContexts(page)
  await createContext(contexts, 'Live reference')
  await contexts
    .getByRole('button', { name: 'Use a note', exact: true })
    .click()
  await contexts
    .getByRole('searchbox', { name: 'Search notes' })
    .fill('Research')
  await contexts
    .getByRole('button', {
      name: 'Add Research to Live reference',
      exact: true,
    })
    .click()
  await contexts
    .getByRole('checkbox', { name: 'Use Live reference in this note' })
    .check()
  await contexts
    .getByRole('button', { name: 'Use a note', exact: true })
    .click()
  await contexts
    .getByRole('button', { name: 'Add Draft to Live reference', exact: true })
    .click()
  await expect(
    contexts.getByText('Live note · Left out for its own note', {
      exact: false,
    })
  ).toBeVisible()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()

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
  contexts = await openContexts(page)
  await contexts
    .getByRole('button', { name: 'Preview Research revised', exact: true })
    .click()
  await expect(contexts.locator('.context-library-preview-text')).toHaveText(
    'At dawn, the garden held the smell of cedar.'
  )
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
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
  const workspace = (await saved(page))!
  expect(workspace.contextLibrary).toHaveLength(2)
  expect(
    workspace.contextLibrary!.every(
      source => source.kind === 'note' && source.text === ''
    )
  ).toBe(true)
  expect(workspace.notes.find(note => note.title === 'Draft')?.sources).toEqual(
    []
  )
  expect(outgoing).toEqual([])
})

test('imports bounded folder snapshots into one context, filters sources and retrieves local matching excerpts', async ({
  page,
}) => {
  const outgoing = outsideRequests(page)
  await createNote(page, 'Folder draft')
  const contexts = await openContexts(page)
  await createContext(contexts, 'Interviews')
  await contexts
    .getByLabel('Add folder to this context', { exact: true })
    .setInputFiles(fixture('library-folder'))
  await expect(
    contexts.getByRole('button', { name: 'Preview overview.md' })
  ).toBeVisible()
  await expect(
    contexts.getByRole('button', { name: 'Preview session.txt' })
  ).toBeVisible()
  await expect(
    contexts.getByRole('button', { name: 'Preview ignored.csv' })
  ).toHaveCount(0)
  await contexts
    .getByRole('combobox', { name: 'Folder', exact: true })
    .selectOption('library-folder/interviews')
  await expect(
    contexts.getByRole('button', { name: 'Preview overview.md' })
  ).toHaveCount(0)
  await contexts
    .getByRole('searchbox', { name: 'Find a source' })
    .fill('overview')
  await expect(contexts.getByText('No sources match.')).toBeVisible()
  await contexts
    .getByRole('combobox', { name: 'Folder', exact: true })
    .selectOption('')
  await expect(
    contexts.getByRole('button', { name: 'Preview overview.md' })
  ).toBeVisible()
  await contexts
    .getByRole('checkbox', { name: 'Use Interviews in this note' })
    .check()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()

  const panel = await openContextPanel(page)
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
    .getByRole('button', { name: 'Detach Interviews', exact: true })
    .click()
  await expect(panel.getByRole('heading', { name: 'session.txt' })).toHaveCount(
    0
  )
  await expect(
    panel.getByRole('button', { name: 'Find passages', exact: true })
  ).toBeDisabled()
  await expect
    .poll(async () => (await saved(page))?.notes[0]?.contextPackageIds?.length)
    .toBe(0)
  const workspace = (await saved(page))!
  expect(workspace.contextLibrary!.map(source => source.folder).sort()).toEqual(
    ['library-folder', 'library-folder/interviews']
  )
  expect(workspace.notes[0]?.sources).toEqual([])
  expect(workspace.notes[0]?.contextPackageIds).toEqual([])
  expect(outgoing).toEqual([])
})

test('stores an explicitly imported website inside a context and reuses the snapshot without another fetch', async ({
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
  let contexts = await openContexts(page)
  await createContext(contexts, 'Reading')
  await contexts
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
  contexts = await openContexts(page)
  await contexts
    .getByRole('button', { name: 'Preview A patient morning' })
    .click()
  await expect(contexts.locator('.context-library-preview-text')).toContainText(
    'a slow breath'
  )
  await expect(
    contexts.getByRole('link', { name: 'View original' })
  ).toHaveAttribute('href', url)
  await contexts
    .getByRole('checkbox', { name: 'Use Reading in this note' })
    .check()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await createNote(page, 'Second web draft')
  contexts = await openContexts(page)
  await contexts
    .getByRole('checkbox', { name: 'Use Reading in this note' })
    .check()
  await contexts
    .getByRole('button', { name: 'Preview A patient morning' })
    .click()
  await expect(contexts.locator('.context-library-preview-text')).toContainText(
    'a slow breath'
  )
  expect(imports).toEqual([url])
})

test('keeps named contexts usable in narrow dark mode and returns focus after inline preview dismissal', async ({
  page,
}) => {
  await createNote(page, 'Narrow draft')
  let contexts = await openContexts(page)
  await createContext(contexts, 'Research for a patient first draft')
  await addFile(
    contexts,
    'A long reference name for a narrow window.md',
    'A short reference with details that are easy to preview.'
  )
  await contexts
    .getByRole('checkbox', {
      name: 'Use Research for a patient first draft in this note',
    })
    .check()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  const panel = await openContextPanel(page)
  await panel
    .getByRole('button', { name: 'Manage contexts', exact: true })
    .click()
  contexts = page.getByRole('dialog', { name: 'Contexts', exact: true })
  await expect(contexts).toBeVisible()
  const box = await contexts.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(391)
  expect(box!.y + box!.height).toBeLessThanOrEqual(845)
  expect(
    await contexts.evaluate(
      element => element.scrollWidth > element.clientWidth + 1
    )
  ).toBe(false)
  await contexts
    .getByRole('button', {
      name: 'Preview A long reference name for a narrow window.md',
    })
    .click()
  await expect(contexts.locator('.context-library-preview-text')).toHaveText(
    'A short reference with details that are easy to preview.'
  )
  await contexts.press('Escape')
  await expect(contexts.locator('.context-library-preview-text')).toHaveCount(0)
  await expect(contexts).toBeVisible()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: 'Manage contexts', exact: true })
  ).toBeFocused()
})

test('migrates older flat references without attaching the whole saved collection to a note', async ({
  page,
}) => {
  await createNote(page, 'Legacy draft')
  await expect.poll(async () => (await saved(page))?.notes.length).toBe(1)
  const workspace = (await saved(page))!
  const source = (id: string, name: string, text: string) => ({
    id,
    name,
    text,
    kind: 'text' as const,
    enabled: true,
    addedAt: 1,
  })
  workspace.contextLibrary = [
    source('attached', 'Original.txt', 'The original blue lavender reference.'),
    source(
      'unrelated',
      'Other.txt',
      'An unrelated crimson lighthouse reference.'
    ),
  ]
  delete workspace.contextPackages
  delete workspace.notes[0]!.contextPackageIds
  workspace.notes[0]!.sources = [
    {
      ...workspace.contextLibrary[0]!,
      text: '',
      libraryId: 'attached',
    },
  ]
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: workspaceKey, value: workspace }
  )
  await page.reload()
  const contexts = await openContexts(page)
  await expect(
    contexts.getByRole('checkbox', {
      name: 'Use Saved references in this note',
    })
  ).not.toBeChecked()
  await expect(
    contexts.getByRole('button', { name: 'Preview Other.txt' })
  ).toBeVisible()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  const panel = await openContextPanel(page)
  await panel.getByText('Find in attached context', { exact: true }).click()
  await panel
    .getByRole('searchbox', { name: 'Search attached references' })
    .fill('crimson lighthouse')
  await panel
    .getByRole('button', { name: 'Find passages', exact: true })
    .click()
  await expect(
    panel.getByText('No matching passages. Try another phrase.')
  ).toBeVisible()
  await panel
    .getByRole('searchbox', { name: 'Search attached references' })
    .fill('blue lavender')
  await panel
    .getByRole('button', { name: 'Find passages', exact: true })
    .click()
  await expect(
    panel.getByRole('heading', { name: 'Original.txt' })
  ).toBeVisible()
  const stored = (await saved(page))!
  expect(stored.notes[0]!.sources.map(item => item.libraryId)).toEqual([
    'attached',
  ])
  expect(stored.notes[0]!.contextPackageIds ?? []).toEqual([])
})

test('allows renaming and detaching a context after a live source grows beyond the context budget', async ({
  page,
}) => {
  await createNote(page, 'Live reference')
  await createNote(page, 'Budget draft')
  await expect.poll(async () => (await saved(page))?.notes.length).toBe(2)
  const workspace = (await saved(page))!
  const linked = workspace.notes.find(note => note.title === 'Live reference')!
  const draft = workspace.notes.find(note => note.title === 'Budget draft')!
  linked.content =
    'An existing source grows beyond the recall context budget. '.repeat(36_000)
  const canonical = {
    id: 'live-source',
    name: linked.title,
    text: '',
    kind: 'note' as const,
    linkedNoteId: linked.id,
    enabled: true,
    addedAt: 1,
  }
  workspace.contextLibrary = [canonical]
  workspace.contextPackages = [
    {
      id: 'grown-context',
      name: 'Grown context',
      sourceIds: [canonical.id],
      createdAt: 1,
      updatedAt: 1,
    },
  ]
  draft.contextPackageIds = ['grown-context']
  draft.content = 'Keep the writing intact while changing context membership.'
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: workspaceKey, value: workspace }
  )
  await page.reload()
  const contexts = await openContexts(page)
  await contexts
    .getByRole('button', { name: 'Rename Grown context', exact: true })
    .click()
  await contexts.getByLabel('Context name').fill('Grown context revised')
  await contexts.getByRole('button', { name: 'Save name', exact: true }).click()
  await expect(
    contexts.getByRole('checkbox', {
      name: 'Use Grown context revised in this note',
    })
  ).toBeChecked()
  await contexts
    .getByRole('checkbox', { name: 'Use Grown context revised in this note' })
    .uncheck()
  await contexts.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await saved(page))?.notes.find(note => note.id === draft.id)
          ?.contextPackageIds?.length
    )
    .toBe(0)
  const stored = (await saved(page))!
  expect(stored.notes.find(note => note.id === linked.id)?.content).toBe(
    linked.content
  )
  expect(stored.notes.find(note => note.id === draft.id)?.content).toBe(
    draft.content
  )
  expect(stored.contextPackages![0]!.name).toBe('Grown context revised')
})
