import {
  test,
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
} from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workspaceKey = 'typenext.workspace.v1'
const backupKey = `${workspaceKey}.backup`
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const localServer = 'http://127.0.0.1:1337/v1'
const openAI = 'https://api.openai.com/v1'
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

interface SavedNote {
  id: string
  title: string
  content: string
  objective: string
  context: string
  sources: {
    name: string
    text: string
    enabled: boolean
    kind: string
    linkedNoteId?: string
    libraryId?: string
  }[]
}

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
    'The real app must not throw unhandled browser errors'
  ).toEqual([])
})

function editor(page: Page) {
  return page.getByRole('textbox', { name: 'Note content', exact: true })
}

async function createNote(page: Page, title: string, context = '') {
  const start = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await start.isVisible()) await start.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  if (context) await dialog.getByLabel(/^Context for suggestions/).fill(context)
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue(title)
  await expect(editor(page)).toBeVisible()
  return editor(page)
}

async function preferences(
  page: Page,
  pane: 'Writing' | 'Local suggestions' | 'External models'
) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}

async function setAutomaticSuggestions(page: Page, enabled: boolean) {
  const dialog = await preferences(page, 'Local suggestions')
  await dialog
    .getByRole('switch', { name: /^Suggest after a pause/ })
    .setChecked(enabled)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function configureLocalModel(page: Page, automatic = false) {
  const dialog = await preferences(page, 'Local suggestions')
  await dialog
    .getByRole('switch', { name: /^Suggest after a pause/ })
    .setChecked(automatic)
  await dialog.getByLabel('Server address', { exact: true }).fill(localServer)
  await dialog.getByLabel('Model', { exact: true }).fill('stub-local-writer')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function configureExternalModel(page: Page) {
  const dialog = await preferences(page, 'External models')
  await dialog.getByLabel('Configure provider').selectOption('openai')
  await dialog.getByLabel('Server address', { exact: true }).fill(openAI)
  await dialog.getByLabel('Model', { exact: true }).fill('stub-external-writer')
  await dialog.getByLabel('API key', { exact: true }).fill('e2e-not-a-real-key')
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(
    dialog.getByText('Ready for this session.', { exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function openContext(page: Page) {
  const panel = page.getByRole('complementary', {
    name: 'Note context',
    exact: true,
  })
  if (!(await panel.isVisible())) {
    await page.getByRole('button', { name: /^Context(?: \d+)?$/ }).click()
  }
  await expect(panel).toBeVisible()
  return panel
}

async function attachFile(page: Page, name: string) {
  const panel = await openContext(page)
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles(fixture(name))
  await expect(
    panel.getByRole('checkbox', { name: `Use ${name} as context`, exact: true })
  ).toBeChecked()
  return panel
}

async function cursorAt(content: Locator, offset: number) {
  await content.focus()
  await content.press('Control+Home')
  for (let index = 0; index < offset; index++) await content.press('ArrowRight')
}

async function requestLocal(page: Page) {
  await editor(page).focus()
  await editor(page).press('Control+Space')
}

async function savedNote(
  page: Page,
  title: string
): Promise<SavedNote | undefined> {
  return page.evaluate(
    ({ key, title }) => {
      const saved = localStorage.getItem(key)
      if (!saved) return undefined
      try {
        const workspace = JSON.parse(saved) as {
          notes: SavedNote[]
          contextLibrary?: (SavedNote['sources'][number] & { id: string })[]
        }
        const note = workspace.notes.find(note => note.title === title)
        return note
          ? {
              ...note,
              sources: note.sources.map(source =>
                source.libraryId
                  ? {
                      ...source,
                      text:
                        workspace.contextLibrary?.find(
                          item => item.id === source.libraryId
                        )?.text ?? '',
                    }
                  : source
              ),
            }
          : undefined
      } catch {
        // Recovery deliberately preserves the damaged primary until the next
        // complete save. Poll only a readable newly committed snapshot.
        return undefined
      }
    },
    { key: workspaceKey, title }
  )
}

async function expectSaved(page: Page, title: string, content: string) {
  await expect
    .poll(async () => (await savedNote(page, title))?.content)
    .toBe(content)
  await expect(
    page.getByRole('button', { name: 'Saved locally', exact: true })
  ).toBeVisible()
}

async function completionResponse(route: Route, text: string, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders,
    body: JSON.stringify(
      status === 200
        ? { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
        : { error: { message: text } }
    ),
  })
}

function providerData(request: Request) {
  const payload = request.postDataJSON() as {
    model: string
    stream: boolean
    temperature: number
    max_tokens: number
    messages: { role: string; content: string }[]
  }
  const user = payload.messages.find(message => message.role === 'user')
  if (!user) throw new Error('The real provider request had no writer context')
  return {
    payload,
    data: JSON.parse(user.content) as {
      objective: string
      writingBrief: string
      beforeCursor: string
      afterCursor: string
      references: { name: string; text: string }[]
    },
  }
}

test('first run asks for a title and context, then autosaves the writer’s Markdown across reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start a note', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await expect(
    dialog.getByRole('button', { name: 'Create note', exact: true })
  ).toBeDisabled()
  await dialog.getByLabel('Title', { exact: true }).fill('   ')
  await expect(
    dialog.getByRole('button', { name: 'Create note', exact: true })
  ).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()

  const content = await createNote(
    page,
    'A patient draft',
    'For a reflective essay; keep my direct voice.'
  )
  const markdown =
    '# My objective\n\nThese are my own words.\n\n- A concrete detail\n- Another thought'
  await content.fill(markdown)
  await expectSaved(page, 'A patient draft', markdown)
  expect((await savedNote(page, 'A patient draft'))?.context).toBe(
    'For a reflective essay; keep my direct voice.'
  )
  await page.reload()
  await expect(editor(page)).toHaveText(markdown, { useInnerText: true })
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('A patient draft')
  const panel = await openContext(page)
  await expect(
    panel.getByLabel('Background & voice', { exact: true })
  ).toHaveValue('For a reflective essay; keep my direct voice.')
})

test('two tabs can close, reopen from search, and retain their independent text', async ({
  page,
}) => {
  await (
    await createNote(page, 'Morning draft')
  ).fill('The first page belongs to the morning.')
  await expectSaved(
    page,
    'Morning draft',
    'The first page belongs to the morning.'
  )
  await (
    await createNote(page, 'Evening draft')
  ).fill('The second page belongs to the evening.')
  await expectSaved(
    page,
    'Evening draft',
    'The second page belongs to the evening.'
  )
  const tabs = page.getByRole('navigation', { name: 'Open notes', exact: true })
  await expect(
    tabs.getByRole('button', { name: 'Morning draft', exact: true })
  ).toBeVisible()
  await expect(
    tabs.getByRole('button', { name: 'Evening draft', exact: true })
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Close Morning draft tab', exact: true })
    .click()
  await expect(
    tabs.getByRole('button', { name: 'Morning draft', exact: true })
  ).toHaveCount(0)
  await page
    .getByRole('textbox', { name: 'Search notes', exact: true })
    .fill('morning')
  const notebook = page.getByRole('complementary', {
    name: 'Notebook',
    exact: true,
  })
  await expect(
    notebook.getByRole('button', { name: /^Evening draft/ })
  ).toHaveCount(0)
  await notebook.getByRole('button', { name: /^Morning draft/ }).click()
  await expect(editor(page)).toHaveText(
    'The first page belongs to the morning.'
  )
  await page
    .getByRole('textbox', { name: 'Search notes', exact: true })
    .fill('')
  await tabs.getByRole('button', { name: 'Evening draft', exact: true }).click()
  await expect(editor(page)).toHaveText(
    'The second page belongs to the evening.'
  )
  await expect(
    page.getByRole('button', { name: 'Saved locally', exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(editor(page)).toHaveText(
    'The second page belongs to the evening.'
  )
  await expect(
    tabs.getByRole('button', { name: 'Morning draft', exact: true })
  ).toBeVisible()
})

test('attached text controls exact private recall, word acceptance, Tab, undo, and suffix preservation', async ({
  page,
}) => {
  const content = await createNote(page, 'Grounded writing')
  await setAutomaticSuggestions(page, false)
  const panel = await attachFile(page, 'reference.txt')
  const original = 'The patient writer before breakfast.'
  await content.fill(original)
  await cursorAt(content, 'The patient writer'.length)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(' pauses and listens')
  await expectSaved(page, 'Grounded writing', original)
  await content.press('Control+ArrowRight')
  await expect(page.locator('.cm-ghost-text')).toHaveText('and listens')
  await content.press('Tab')
  const accepted = 'The patient writer pauses and listens before breakfast.'
  await expect(content).toHaveText(accepted)
  await expectSaved(page, 'Grounded writing', accepted)
  await content.press('Control+z')
  await content.press('Control+z')
  await expect(content).toHaveText(original)

  await panel
    .getByRole('checkbox', {
      name: 'Use reference.txt as context',
      exact: true,
    })
    .uncheck()
  await cursorAt(content, 'The patient writer'.length)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await expect(page.locator('.suggestion-message')).toContainText(
    'Try a new line'
  )
  await panel
    .getByRole('checkbox', {
      name: 'Use reference.txt as context',
      exact: true,
    })
    .check()
  await cursorAt(content, 'The patient writer'.length)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(' pauses and listens')
  await content.press('Escape')
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await panel
    .getByRole('button', { name: 'Remove reference.txt', exact: true })
    .click()
  await expect(
    panel.getByRole('checkbox', {
      name: 'Use reference.txt as context',
      exact: true,
    })
  ).toHaveCount(0)
  await expect
    .poll(
      async () => (await savedNote(page, 'Grounded writing'))?.sources.length
    )
    .toBe(0)
})

test('exact local recall withholds a sentence before an unrelated lowercase suffix and accepts only a proven bridge', async ({
  page,
}) => {
  const outgoing: string[] = []
  page.on('request', request => {
    if (
      /^https?:/u.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1:1420/')
    )
      outgoing.push(request.url())
  })
  const title = 'A careful garden thought'
  const reference = 'At dawn, the garden held the scent of rain.'
  const prefix = 'At dawn, the garden'
  const content = await createNote(page, title)
  await setAutomaticSuggestions(page, false)
  const panel = await openContext(page)
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles({
      name: 'garden-reference.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(reference, 'utf8'),
    })
  await expect(
    panel.getByRole('checkbox', {
      name: 'Use garden-reference.txt as context',
      exact: true,
    })
  ).toBeChecked()

  const unrelatedSuffix = ' while city streets are still asleep.'
  const original = `${prefix}${unrelatedSuffix}`
  await content.fill(original)
  await cursorAt(content, prefix.length)
  await requestLocal(page)
  await expect(page.locator('.suggestion-message')).toContainText(
    'Try a new line'
  )
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await expect(content).toHaveText(original)
  await expectSaved(page, title, original)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)

  const matchingSuffix = ' the scent of rain.'
  await content.fill(`${prefix}${matchingSuffix}`)
  await cursorAt(content, prefix.length)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(' held')
  await content.press('Tab')
  await expect(content).toHaveText(reference)
  await expectSaved(page, title, reference)
  await content.press('Control+z')
  await expect(content).toHaveText(`${prefix}${matchingSuffix}`)
  expect(
    outgoing,
    'Exact recall must not fall back to a model or send the writing out'
  ).toEqual([])
})

for (const name of ['reference.pdf', 'reference.docx']) {
  test(`real ${name.endsWith('.pdf') ? 'PDF worker' : 'DOCX parser'} imports selectable text locally and can recall it`, async ({
    page,
  }) => {
    const outgoing: string[] = []
    page.on('request', request => {
      if (
        /^https?:/u.test(request.url()) &&
        !request.url().startsWith('http://127.0.0.1:1420/')
      )
        outgoing.push(request.url())
    })
    const title = `Actual ${name} import`
    const content = await createNote(page, title)
    await setAutomaticSuggestions(page, false)
    const panel = await attachFile(page, name)
    await expect
      .poll(async () => (await savedNote(page, title))?.sources[0]?.text)
      .toContain('The patient writer pauses and listens before breakfast.')
    const source = (await savedNote(page, title))?.sources[0]
    expect(source?.kind).toBe(name.endsWith('.pdf') ? 'pdf' : 'docx')
    await panel
      .getByRole('button', { name: `Preview ${name}`, exact: true })
      .click()
    const preview = page.getByRole('dialog', { name, exact: true })
    await expect(preview.locator('.source-preview-text')).toContainText(
      'The patient writer pauses and listens before breakfast.'
    )
    await preview.getByRole('button', { name: 'Done', exact: true }).click()
    await content.fill('The patient writer')
    await content.press('Control+End')
    await requestLocal(page)
    await expect(page.locator('.cm-ghost-text')).toHaveText(
      ' pauses and listens before breakfast.'
    )
    await content.press('Tab')
    await expect(content).toHaveText(
      'The patient writer pauses and listens before breakfast.'
    )
    expect(
      outgoing,
      'File import and exact recall must stay on the device'
    ).toEqual([])
  })
}

test('a PDF without selectable text and an empty text source report useful errors without adding broken references', async ({
  page,
}) => {
  await createNote(page, 'Unreadable reference')
  const panel = await openContext(page)
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles(fixture('empty.pdf'))
  await expect(page.getByText(/This PDF has no selectable text/)).toBeVisible()
  await expect(panel.getByRole('checkbox')).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click()
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles({
      name: 'empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(0),
    })
  await expect(
    page.getByText(/This source contains no readable text/)
  ).toBeVisible()
  await expect(panel.getByRole('checkbox')).toHaveCount(0)
})

test('font, size, theme, and per-session key behavior persist correctly', async ({
  page,
}) => {
  await (
    await createNote(page, 'A comfortable page')
  ).fill('A writing surface should feel quiet.')
  const dialog = await preferences(page, 'Writing')
  await dialog
    .getByLabel('Typeface', { exact: true })
    .selectOption('JetBrains Mono')
  await dialog.getByLabel('Size (px)', { exact: true }).fill('21')
  await dialog.getByLabel('Appearance', { exact: true }).selectOption('dark')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.document-font')).toContainText('JetBrains Mono')
  await expect(editor(page)).toHaveCSS('font-size', '21px')
  await expect(page.locator('.cm-scroller')).toHaveCSS(
    'font-family',
    /JetBrains Mono/
  )
  await configureExternalModel(page)
  await expectSaved(
    page,
    'A comfortable page',
    'A writing surface should feel quiet.'
  )
  expect(
    await page.evaluate(
      key => localStorage.getItem(key)?.includes('e2e-not-a-real-key'),
      workspaceKey
    )
  ).toBe(false)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(editor(page)).toHaveCSS('font-size', '21px')
  const reopened = await preferences(page, 'External models')
  await expect(reopened.getByLabel('Model', { exact: true })).toHaveValue(
    'stub-external-writer'
  )
  await expect(reopened.getByLabel('API key', { exact: true })).toHaveValue('')
  await reopened.getByRole('button', { name: 'Done', exact: true }).click()
})

test('local inference sends the first-line objective and exact cursor context without touching a cloud provider', async ({
  page,
}) => {
  const requests: Request[] = []
  const remote: string[] = []
  page.on('request', request => {
    if (/^https:/u.test(request.url())) remote.push(request.url())
  })
  await page.route(`${localServer}/**`, async route => {
    if (route.request().method() === 'POST') {
      requests.push(route.request())
      await completionResponse(route, ' chooses one clear sentence.')
    } else
      await route.fulfill({
        contentType: 'application/json',
        headers: corsHeaders,
        body: JSON.stringify({ data: [{ id: 'stub-local-writer' }] }),
      })
  })
  const content = await createNote(
    page,
    'First-line intention',
    'A synthetic test for a reflective audience.'
  )
  await configureLocalModel(page)
  const text = 'Clarify the promise of a quiet page.\nThe patient writer'
  await content.fill(text)
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    ' chooses one clear sentence.'
  )
  expect(requests).toHaveLength(1)
  const { payload, data } = providerData(requests[0]!)
  expect(payload.model).toBe('stub-local-writer')
  expect(payload.stream).toBe(false)
  expect(data.objective).toBe('Clarify the promise of a quiet page.')
  expect(data.writingBrief).toBe('A synthetic test for a reflective audience.')
  expect(data.beforeCursor).toBe(text)
  expect(data.afterCursor).toBe('')
  expect(remote).toEqual([])
})

test('external mode stays local until enabled, then continues until switched off', async ({
  page,
}) => {
  const requests: Request[] = []
  await page.route(`${openAI}/**`, async route => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    requests.push(route.request())
    await completionResponse(route, ' pauses and listens before breakfast.')
  })
  const content = await createNote(
    page,
    'Optional external help',
    'For an essay in my existing voice.'
  )
  const panel = await attachFile(page, 'reference.txt')
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles({
      name: 'disabled-private.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('DISABLED_PRIVATE_REFERENCE: this must not be sent.'),
    })
  await panel
    .getByRole('checkbox', {
      name: 'Use disabled-private.txt as context',
      exact: true,
    })
    .uncheck()
  await configureExternalModel(page)
  await content.fill('The patient writer before breakfast.')
  await content.press('Control+End')
  await requestLocal(page)
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
  const chooser = page.getByRole('dialog', {
    name: 'Choose your suggestion engine',
  })
  await expect(chooser).toContainText('nearby writing')
  await expect(chooser).toContainText('stays active')
  expect(requests).toHaveLength(0)
  await chooser.getByRole('button', { name: 'Use OpenAI continuously' }).click()
  await cursorAt(content, 'The patient writer'.length)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(' pauses and listens')
  expect(requests).toHaveLength(1)
  const { payload, data } = providerData(requests[0]!)
  expect(payload.model).toBe('stub-external-writer')
  expect(data.beforeCursor).toBe('The patient writer')
  expect(data.afterCursor).toBe(' before breakfast.')
  expect(
    data.references.some(reference => reference.name === 'reference.txt')
  ).toBe(true)
  expect(requests[0]?.postData()).not.toContain('DISABLED_PRIVATE_REFERENCE')
  await content.press('Tab')
  await content.fill('The patient writer has another though')
  await content.press('Control+End')
  await content.press('t')
  await expect.poll(() => requests.length).toBe(2)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        key => JSON.parse(localStorage.getItem(key)!).settings.provider,
        workspaceKey
      )
    )
    .toBe('openai')
  await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
  await chooser.getByRole('button', { name: /On this device/ }).click()
  await content.fill('A different private thought')
  await requestLocal(page)
  await page.waitForTimeout(1300)
  expect(requests).toHaveLength(2)
})

test('local provider errors stay visible, and a new manual request can recover', async ({
  page,
}) => {
  let requests = 0
  await page.route(`${localServer}/**`, async route => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    requests += 1
    await completionResponse(
      route,
      requests === 1 ? 'Too many requests for this test.' : ' remains yours.',
      requests === 1 ? 429 : 200
    )
  })
  const content = await createNote(page, 'A recoverable connection')
  await configureLocalModel(page)
  await content.fill('The next sentence')
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.suggestion-message')).toContainText(
    /rate|429|too many/i
  )
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(' remains yours.')
  expect(requests).toBe(2)
  await content.press('Tab')
  await expect(content).toHaveText('The next sentence remains yours.')
})

test('Escape cancels a pending request and a late response cannot enter a newly opened note', async ({
  page,
}) => {
  let release: (() => void) | undefined
  let requests = 0
  const aborted: string[] = []
  page.on('requestfailed', request => {
    if (request.url().startsWith(localServer))
      aborted.push(request.failure()?.errorText ?? '')
  })
  await page.route(`${localServer}/**`, async route => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    requests += 1
    if (requests === 1) {
      await new Promise<void>(resolve => {
        release = resolve
      })
      try {
        await completionResponse(route, ' STALE_WORDS_MUST_NOT_APPEAR.')
      } catch (error) {
        if (!route.request().failure()) throw error
      }
    } else await completionResponse(route, ' starts cleanly.')
  })
  try {
    const first = await createNote(page, 'The previous thought')
    await configureLocalModel(page)
    await first.fill('An unfinished old sentence')
    await first.press('Control+End')
    await requestLocal(page)
    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.suggestion-message')).toContainText(
      'Finding a continuation'
    )
    await first.press('Escape')
    await expect.poll(() => aborted.length).toBe(1)
    const second = await createNote(page, 'A new thought')
    await second.fill('This new page')
    await second.press('Control+End')
    await requestLocal(page)
    await expect(page.locator('.cm-ghost-text')).toHaveText(' starts cleanly.')
    release?.()
    await page.waitForTimeout(100)
    await expect(second).not.toContainText('STALE_WORDS_MUST_NOT_APPEAR')
    await second.press('Tab')
    await expectSaved(page, 'A new thought', 'This new page starts cleanly.')
    await expectSaved(
      page,
      'The previous thought',
      'An unfinished old sentence'
    )
  } finally {
    release?.()
  }
})

test('opening an actual Markdown file preserves its source and saves it in recent notes', async ({
  page,
}) => {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open Markdown', exact: true }).click()
  await (await chooser).setFiles(fixture('opened-note.md'))
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('opened-note')
  await expectSaved(
    page,
    'opened-note',
    readFileSync(fixture('opened-note.md'), 'utf8')
  )
  await page.reload()
  await expect(editor(page)).toContainText(
    'This Markdown belongs to its writer.'
  )
  await expect(
    page
      .getByRole('complementary', { name: 'Notebook', exact: true })
      .getByRole('button', { name: /^opened-note/ })
  ).toBeVisible()
})

test('unrecoverable saved data is preserved and blocks autosave while the recovery screen is shown', async ({
  page,
}) => {
  const corrupt = '{ this is not a valid saved notebook'
  const corruptBackup = '{ this is not a valid recovery copy'
  await page.evaluate(
    ({ key, backup, corrupt, corruptBackup }) => {
      localStorage.setItem(key, corrupt)
      localStorage.setItem(backup, corruptBackup)
    },
    { key: workspaceKey, backup: backupKey, corrupt, corruptBackup }
  )
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Your saved notebook needs attention.' })
  ).toBeVisible()
  await expect(
    page.getByText('TypeNext has kept your existing data and paused saving.')
  ).toBeVisible()
  await page.waitForTimeout(1500)
  expect(
    await page.evaluate(key => localStorage.getItem(key), workspaceKey)
  ).toBe(corrupt)
  expect(await page.evaluate(key => localStorage.getItem(key), backupKey)).toBe(
    corruptBackup
  )
  await expect(editor(page)).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Try opening again', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Your saved notebook needs attention.' })
  ).toBeVisible()
  expect(
    await page.evaluate(key => localStorage.getItem(key), workspaceKey)
  ).toBe(corrupt)
})

test('dropping a real file opens a readable local preview and inclusion changes agree in both views', async ({
  page,
}) => {
  await createNote(page, 'Dropped references')
  const panel = await openContext(page)
  const text = 'The patient writer pauses and listens before breakfast.'
  const transfer = await page.evaluateHandle(text => {
    const data = new DataTransfer()
    data.items.add(
      new File([text], 'dropped-reference.txt', { type: 'text/plain' })
    )
    return data
  }, text)
  await panel.dispatchEvent('dragenter', { dataTransfer: transfer })
  await expect(
    page.getByText('Drop your references here', { exact: true })
  ).toBeVisible()
  await panel.dispatchEvent('drop', { dataTransfer: transfer })
  await transfer.dispose()
  const included = panel.getByRole('checkbox', {
    name: 'Use dropped-reference.txt as context',
    exact: true,
  })
  await expect(included).toBeChecked()
  await panel
    .getByRole('button', { name: 'Preview dropped-reference.txt', exact: true })
    .click()
  const preview = page.getByRole('dialog', {
    name: 'dropped-reference.txt',
    exact: true,
  })
  await expect(preview.locator('.source-preview-text')).toHaveText(text)
  await expect(preview).toContainText('Cached locally')
  await preview
    .getByRole('checkbox', { name: 'Include in suggestions', exact: true })
    .uncheck()
  await preview.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(included).not.toBeChecked()
  await panel
    .getByRole('button', { name: 'Preview dropped-reference.txt', exact: true })
    .click()
  await expect(preview).toContainText('Currently left out of this note.')
  await preview
    .getByRole('checkbox', { name: 'Include in suggestions', exact: true })
    .check()
  await preview.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(included).toBeChecked()
  await expect
    .poll(
      async () =>
        (await savedNote(page, 'Dropped references'))?.sources[0]?.text
    )
    .toBe(text)
})

test('website context is fetched once without note text, previewed, then reused for private recall', async ({
  page,
}) => {
  const url = 'https://reference.example.org/writing-guide'
  const requests: Request[] = []
  const title = 'A patient writing guide'
  const paragraph =
    'The patient writer pauses and listens before breakfast. A quiet page gives a person room to consider an idea, preserve their own voice, and look carefully at the details that matter.'
  await page.route(url, async route => {
    requests.push(route.request())
    await route.fulfill({
      contentType: 'text/html',
      headers: corsHeaders,
      body: `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${paragraph}</p><p>${paragraph}</p><p>${paragraph}</p></article></body></html>`,
    })
  })
  const content = await createNote(
    page,
    'A cached website',
    'PRIVATE_NOTE_BACKGROUND_MUST_STAY_LOCAL'
  )
  await setAutomaticSuggestions(page, false)
  const panel = await openContext(page)
  await panel
    .getByRole('button', { name: 'Add a website', exact: true })
    .click()
  const importDialog = page.getByRole('dialog', {
    name: 'Bring a website into context',
  })
  await expect(importDialog).toContainText('Your note is not sent.')
  await importDialog.getByLabel('Website URL', { exact: true }).fill(url)
  await importDialog
    .getByRole('button', { name: 'Import website', exact: true })
    .click()
  await expect(
    panel.getByRole('checkbox', {
      name: `Use ${title} as context`,
      exact: true,
    })
  ).toBeChecked()
  expect(requests).toHaveLength(1)
  expect(requests[0]?.method()).toBe('GET')
  expect(requests[0]?.postData()).toBeNull()
  expect(JSON.stringify(requests[0]?.headers())).not.toContain(
    'PRIVATE_NOTE_BACKGROUND_MUST_STAY_LOCAL'
  )
  await panel
    .getByRole('button', { name: `Preview ${title}`, exact: true })
    .click()
  const preview = page.getByRole('dialog', { name: title, exact: true })
  await expect(
    preview.getByRole('link', { name: 'View original', exact: true })
  ).toHaveAttribute('href', url)
  await expect(preview.locator('.source-preview-text')).toContainText(
    'The patient writer pauses and listens before breakfast.'
  )
  await preview.getByRole('button', { name: 'Done', exact: true }).click()
  await content.fill('The patient writer')
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    ' pauses and listens before breakfast.'
  )
  await content.press('Escape')
  await requestLocal(page)
  expect(
    requests,
    'Suggestions must reuse imported article text instead of refetching'
  ).toHaveLength(1)
})

test('turning autosave off keeps edits unsaved until the writer explicitly saves, and persists the preference', async ({
  page,
}) => {
  const title = 'Saving by choice'
  const content = await createNote(page, title)
  await content.fill('This version was saved automatically.')
  await expectSaved(page, title, 'This version was saved automatically.')
  const dialog = await preferences(page, 'Writing')
  await dialog.getByRole('switch', { name: /^Autosave/ }).uncheck()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await content.fill('The next version is saved when I choose.')
  await expect(
    page.getByRole('button', { name: 'Unsaved · save now', exact: true })
  ).toBeVisible()
  await page.waitForTimeout(900)
  expect((await savedNote(page, title))?.content).toBe(
    'This version was saved automatically.'
  )
  await page
    .getByRole('button', { name: 'Unsaved · save now', exact: true })
    .click()
  await expectSaved(page, title, 'The next version is saved when I choose.')
  await page.reload()
  await expect(editor(page)).toHaveText(
    'The next version is saved when I choose.'
  )
  const reopened = await preferences(page, 'Writing')
  await expect(
    reopened.getByRole('switch', { name: /^Autosave/ })
  ).not.toBeChecked()
  await reopened.getByRole('button', { name: 'Done', exact: true }).click()
})

test('native FIM on a local server receives both sides of the cursor and keeps the suffix intact', async ({
  page,
}) => {
  const requests: Request[] = []
  await page.route('http://127.0.0.1:1337/infill', async route => {
    requests.push(route.request())
    await route.fulfill({
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        content: ' pauses and listens before breakfast.',
      }),
    })
  })
  const content = await createNote(
    page,
    'An infill draft',
    'Preserve my existing sentence.'
  )
  const dialog = await preferences(page, 'Local suggestions')
  await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).uncheck()
  await dialog.getByLabel('Server address', { exact: true }).fill(localServer)
  await dialog.getByLabel('Model', { exact: true }).fill('stub-fim-writer')
  await dialog.getByText('Advanced protocol', { exact: true }).click()
  await dialog
    .getByLabel('Completion protocol', { exact: true })
    .selectOption('fim')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await content.fill('The patient writer before breakfast.')
  await cursorAt(content, 'The patient writer'.length)
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(' pauses and listens')
  expect(requests).toHaveLength(1)
  const body = requests[0]?.postDataJSON() as {
    input_prefix: string
    input_suffix: string
    input_extra: { filename: string; text: string }[]
    n_predict: number
    stream: boolean
  }
  expect(body.input_prefix).toBe('The patient writer')
  expect(body.input_suffix).toBe(' before breakfast.')
  expect(body.input_extra[0]?.filename).toBe('writing-brief.txt')
  expect(body.input_extra[0]?.text).toContain('Preserve my existing sentence.')
  expect(body.stream).toBe(false)
  expect(body.n_predict).toBeGreaterThan(0)
  await content.press('Tab')
  await expect(content).toHaveText(
    'The patient writer pauses and listens before breakfast.'
  )
})

test('a remote address placed in local settings is blocked for both automatic and normal manual requests', async ({
  page,
}) => {
  const requests: Request[] = []
  await page.route('https://remote.example.org/**', async route => {
    requests.push(route.request())
    await completionResponse(route, ' MUST_NEVER_BE_REQUESTED.')
  })
  const content = await createNote(page, 'Keep local private')
  const dialog = await preferences(page, 'Local suggestions')
  await dialog
    .getByLabel('Server address', { exact: true })
    .fill('https://remote.example.org/v1')
  await dialog.getByLabel('Model', { exact: true }).fill('a-remote-model')
  await dialog.getByLabel('Pause before suggesting').selectOption('650')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await content.fill('My writing belongs on this device')
  await content.press('Control+End')
  await content.press('Space')
  await expect(page.locator('.suggestion-message')).toContainText(
    'Local suggestions require a server on localhost'
  )
  expect(requests).toHaveLength(0)
  await requestLocal(page)
  await expect(page.locator('.suggestion-message')).toContainText(
    'Local suggestions require a server on localhost'
  )
  expect(requests).toHaveLength(0)
})

test('a valid recovery copy opens after corruption and remains intact when the writer saves again', async ({
  page,
}) => {
  const title = 'A recoverable draft'
  const content = await createNote(page, title)
  const recovered = 'A first version worth preserving.'
  await content.fill(recovered)
  await expectSaved(page, title, recovered)
  await content.fill('A newer version that will be corrupted.')
  await expectSaved(page, title, 'A newer version that will be corrupted.')
  const backup = await page.evaluate(
    key => localStorage.getItem(key),
    backupKey
  )
  expect(backup).toContain(recovered)
  const corrupt = '{ a damaged current notebook'
  await page.evaluate(
    ({ key, corrupt }) => localStorage.setItem(key, corrupt),
    { key: workspaceKey, corrupt }
  )
  await page.reload()
  await expect(editor(page)).toHaveText(recovered)
  expect(
    await page.evaluate(key => localStorage.getItem(key), workspaceKey)
  ).toBe(corrupt)
  const next = 'The recovered draft can safely continue.'
  await editor(page).fill(next)
  await expectSaved(page, title, next)
  expect(await page.evaluate(key => localStorage.getItem(key), backupKey)).toBe(
    backup
  )
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage)
        .filter(key => key.startsWith('typenext.workspace.v1.corrupt.'))
        .map(key => localStorage.getItem(key))
    )
  ).toContain(corrupt)
})

test('a narrow writing surface keeps the editor, preferences, and context accessible without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 850 })
  await page.reload()
  const content = await createNote(page, 'A small quiet page')
  await content.fill(
    'A narrow writing window still leaves enough room for the writer to finish a clear thought and return to it later.'
  )
  await expect(content).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page
    .getByRole('button', { name: 'Show note sidebar', exact: true })
    .click()
  const dialog = await preferences(page, 'Writing')
  await dialog
    .getByLabel('Typeface', { exact: true })
    .selectOption('EB Garamond')
  await dialog
    .getByRole('group', { name: 'Dark palette', exact: true })
    .getByText('Custom', { exact: true })
    .click()
  await dialog.getByLabel('Dark page color', { exact: true }).fill('#181a1f')
  await dialog.getByLabel('Dark sidebar color', { exact: true }).fill('#101114')
  await dialog.getByLabel('Dark accent color', { exact: true }).fill('#b4bfcd')
  expect(
    await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)
  ).toBe(true)
  expect(
    await dialog
      .locator('.preference-body')
      .evaluate(element => element.scrollWidth <= element.clientWidth)
  ).toBe(true)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('button', { name: 'Hide note sidebar', exact: true })
    .click()
  const panel = await openContext(page)
  await panel
    .getByLabel('Objective', { exact: true })
    .fill('Keep this note comfortable on a small screen.')
  await panel
    .getByRole('button', { name: 'Close context panel', exact: true })
    .click()
  await expect(content).toBeVisible()
  await expect(page.locator('.document-font')).toContainText('EB Garamond')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
})

test('continuous writing reaches a durable browser snapshot before the writer pauses', async ({
  page,
}) => {
  const title = 'A continuously saved thought'
  const content = await createNote(page, title)
  await setAutomaticSuggestions(page, false)
  await content.fill('A thought worth keeping. ')
  await expectSaved(page, title, 'A thought worth keeping. ')
  await content.press('Control+End')
  let typingFinished = false
  const continuation =
    'The writer can keep following this sentence while the notebook saves in the background.'
  const typing = content
    .pressSequentially(continuation, { delay: 65 })
    .then(() => {
      typingFinished = true
    })
  await expect
    .poll(async () => (await savedNote(page, title))?.content.length ?? 0, {
      timeout: 4000,
    })
    .toBeGreaterThan('A thought worth keeping. '.length)
  expect(
    typingFinished,
    'A save must occur during continuous input, before the idle timer can run'
  ).toBe(false)
  await typing
  await expectSaved(page, title, `A thought worth keeping. ${continuation}`)
  await page.reload()
  await expect(editor(page)).toHaveText(
    `A thought worth keeping. ${continuation}`
  )
})

test('an oversized paste keeps existing writing and explains the limit on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 850 })
  await page.reload()
  const content = await createNote(page, 'Keep the original words')
  const original = 'These words must survive a rejected paste.'
  await content.fill(original)
  await content.press('Control+End')
  await content.evaluate(element => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'x'.repeat(8 * 1024 * 1024 + 1))
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      })
    )
  })
  await expect(content).toHaveText(original)
  await expect(page.locator('.notice')).toContainText(/8 MiB|too large|limit/i)
  await expectSaved(page, 'Keep the original words', original)
  await page.reload()
  await expect(editor(page)).toHaveText(original)
})

test('a batch of references stops at its aggregate budget and keeps earlier attachments', async ({
  page,
}) => {
  const content = await createNote(page, 'Bounded reference collection')
  await content.fill('The writer remains in control.')
  const dialog = await preferences(page, 'Writing')
  await dialog.getByRole('switch', { name: /^Autosave/ }).uncheck()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  const panel = await openContext(page)
  await panel
    .getByLabel('Attach reference files', { exact: true })
    .setInputFiles(
      Array.from({ length: 7 }, (_, index) => ({
        name: `Reference ${index + 1}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('reference '.repeat(30_000)),
      }))
    )
  await expect(
    panel.getByRole('checkbox', { name: /^Use Reference \d\.txt as context$/ })
  ).toHaveCount(6)
  await expect(
    panel.getByRole('checkbox', {
      name: 'Use Reference 6.txt as context',
      exact: true,
    })
  ).toBeChecked()
  await expect(page.locator('.notice')).toContainText(
    'These references are too large'
  )
  await expect(
    panel.getByLabel('Attach reference files', { exact: true })
  ).toBeEnabled()
  await expect(editor(page)).toHaveText('The writer remains in control.')
})

test('legacy export timestamps and a backwards clock cannot mark new writing or context clean', async ({
  page,
}) => {
  const title = 'A draft from an earlier clock'
  const content = await createNote(page, title)
  await content.fill('The saved first version.')
  await expectSaved(page, title, 'The saved first version.')
  const future = Date.now() + 1_000_000
  const setLegacyExport = async (exportedAt: number) => {
    await page.evaluate(
      ({ key, exportedAt }) => {
        const workspace = JSON.parse(localStorage.getItem(key)!)
        workspace.notes[0].exportedAt = exportedAt
        localStorage.setItem(key, JSON.stringify(workspace))
      },
      { key: workspaceKey, exportedAt }
    )
    await page.reload()
    await expect(editor(page)).toHaveText(/The saved/)
  }
  await setLegacyExport(future)
  await editor(page).fill('The saved first version. A new sentence.')
  await expectSaved(page, title, 'The saved first version. A new sentence.')
  const updatedAt = () =>
    page.evaluate(
      key =>
        JSON.parse(localStorage.getItem(key)!).notes[0].updatedAt as number,
      workspaceKey
    )
  expect(await updatedAt()).toBeGreaterThan(future)
  await setLegacyExport(future + 1_000_000)
  await attachFile(page, 'reference.txt')
  await expect.poll(updatedAt).toBeGreaterThan(future + 1_000_000)
  await expect(editor(page)).toHaveText(
    'The saved first version. A new sentence.'
  )
})

test('the default dark appearance is neutral graphite with a slate sidebar', async ({
  page,
}) => {
  await createNote(page, 'A neutral dark page')
  await page
    .getByRole('button', { name: 'Toggle light and dark mode', exact: true })
    .click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'graphite')
  await expect(page.locator('.app-shell')).toHaveCSS(
    'background-color',
    'rgb(33, 33, 33)'
  )
  await expect(page.locator('.note-sidebar')).toHaveCSS(
    'background-color',
    'rgb(23, 25, 28)'
  )
  await expect(
    page.getByRole('button', { name: 'Saved locally', exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'graphite')
})

test('light and dark palette previews remain independent across toggling and reload', async ({
  page,
}) => {
  await createNote(page, 'Colours that feel familiar')
  const dialog = await preferences(page, 'Writing')
  await dialog
    .getByRole('group', { name: 'Light palette', exact: true })
    .getByText('Linen', { exact: true })
    .click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'linen')
  const dark = dialog.getByRole('group', { name: 'Dark palette', exact: true })
  await dark.getByText('Graphite', { exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await dark.getByRole('radio', { name: 'Graphite', exact: true }).focus()
  await dark
    .getByRole('radio', { name: 'Graphite', exact: true })
    .press('ArrowRight')
  await expect(
    dark.getByRole('radio', { name: 'Pure black', exact: true })
  ).toBeChecked()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'black')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('button', { name: 'Toggle light and dark mode', exact: true })
    .click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'linen')
  await expect(page.locator('.app-shell')).toHaveCSS(
    'background-color',
    'rgb(250, 246, 239)'
  )
  await page
    .getByRole('button', { name: 'Toggle light and dark mode', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Saved locally', exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'black')
  const restored = await preferences(page, 'Writing')
  await expect(
    restored
      .getByRole('group', { name: 'Light palette', exact: true })
      .getByRole('radio', { name: 'Linen', exact: true })
  ).toBeChecked()
  await expect(
    restored
      .getByRole('group', { name: 'Dark palette', exact: true })
      .getByRole('radio', { name: 'Pure black', exact: true })
  ).toBeChecked()
})

test('custom colours keep mixed light and dark surfaces readable and reject invalid input', async ({
  page,
}) => {
  await createNote(page, 'My own writing palette')
  await editor(page).fill('Clear words on a page of my own.')
  const dialog = await preferences(page, 'Writing')
  await dialog
    .getByRole('group', { name: 'Dark palette', exact: true })
    .getByText('Custom', { exact: true })
    .click()
  await dialog.getByLabel('Dark page color', { exact: true }).fill('#ffffff')
  await dialog.getByLabel('Dark sidebar color', { exact: true }).fill('#000000')
  await dialog.getByLabel('Dark accent color', { exact: true }).fill('#ffffff')
  const accent = dialog.getByLabel('Dark accent color', { exact: true })
  await accent.fill('#zzzzzz')
  await accent.blur()
  await expect(accent).toHaveAttribute('aria-invalid', 'true')
  await expect(
    dialog.getByText('Use # and six hex digits.', { exact: true })
  ).toBeVisible()
  await accent.focus()
  await accent.press('Escape')
  await expect(accent).toHaveValue('#ffffff')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.app-shell')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)'
  )
  await expect(page.locator('.note-sidebar')).toHaveCSS(
    'background-color',
    'rgb(0, 0, 0)'
  )
  const contrasts = await page.evaluate(() => {
    const lum = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map(value => {
          const channel = value / 255
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4
        })
      return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
    }
    const ratio = (foreground: string, background: string) => {
      const values = [lum(foreground), lum(background)].sort((a, b) => a - b)
      return (values[1]! + 0.05) / (values[0]! + 0.05)
    }
    const side = getComputedStyle(document.querySelector('.note-sidebar')!)
    const page = getComputedStyle(document.querySelector('.app-shell')!)
    const writing = getComputedStyle(document.querySelector('.cm-content')!)
    return {
      sidebar: ratio(side.color, side.backgroundColor),
      writing: ratio(writing.color, page.backgroundColor),
    }
  })
  expect(contrasts.sidebar).toBeGreaterThanOrEqual(4.5)
  expect(contrasts.writing).toBeGreaterThanOrEqual(4.5)
  await expect(
    page.getByRole('button', { name: 'Saved locally', exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'custom')
  await expect(page.locator('.note-sidebar')).toHaveCSS(
    'background-color',
    'rgb(0, 0, 0)'
  )
})

test('one activation supports repeated external requests and saved model switching', async ({
  page,
}) => {
  let requests = 0
  await page.route(`${openAI}/**`, async route => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    requests++
    await completionResponse(route, ' continues carefully.')
  })
  const content = await createNote(page, 'Continuous suggestions')
  await setAutomaticSuggestions(page, false)
  await configureExternalModel(page)
  const dialog = await preferences(page, 'External models')
  await dialog
    .getByLabel('Suggestion instructions', { exact: true })
    .fill('Preserve my direct voice. Never add a metaphor.')
  await dialog
    .getByRole('button', { name: 'Save this model', exact: true })
    .click()
  await dialog.getByLabel('Model', { exact: true }).fill('second-writer')
  await dialog
    .getByRole('button', { name: 'Save this model', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
  const chooser = page.getByRole('dialog', {
    name: 'Choose your suggestion engine',
  })
  await chooser
    .getByRole('button', { name: 'stub-external-writer', exact: true })
    .click()
  await chooser.getByRole('button', { name: 'Use OpenAI continuously' }).click()
  for (let round = 1; round <= 10; round++) {
    await content.fill(`This synthetic thought number ${round}`)
    await content.press('Control+End')
    await requestLocal(page)
    await expect(page.locator('.cm-ghost-text')).toHaveText(
      ' continues carefully.'
    )
    expect(requests).toBe(round)
    await content.press('Escape')
  }
  await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
  await chooser
    .getByRole('button', { name: 'second-writer', exact: true })
    .click()
  await chooser.getByRole('button', { name: 'Use OpenAI continuously' }).click()
  await content.fill('A new sentence with another model')
  await requestLocal(page)
  await expect.poll(() => requests).toBe(11)
})

test('with both models configured, an actual automatic inference and the normal shortcut choose the local server', async ({
  page,
}) => {
  let localRequests = 0
  let cloudRequests = 0
  await page.route(`${localServer}/**`, async route => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    localRequests += 1
    await completionResponse(route, 'stays with its writer.')
  })
  await page.route(`${openAI}/**`, async route => {
    if (route.request().method() === 'POST') cloudRequests += 1
    await completionResponse(route, ' MUST_NOT_CONTACT_CLOUD.')
  })
  const content = await createNote(page, 'Two configured models')
  await configureExternalModel(page)
  await configureLocalModel(page, true)
  await content.fill('This synthetic thought')
  await content.press('Control+End')
  await content.press('Space')
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    'stays with its writer.'
  )
  expect(
    localRequests,
    'The automatic pause must actually run local inference'
  ).toBe(1)
  expect(cloudRequests).toBe(0)
  await content.press('Escape')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    'stays with its writer.'
  )
  expect(cloudRequests).toBe(0)
})

test('optional Firecrawl import discloses its service and sends only the website URL, never the note', async ({
  page,
}) => {
  const requests: Request[] = []
  await page.route('https://api.firecrawl.dev/v2/scrape', async route => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    requests.push(route.request())
    await route.fulfill({
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        success: true,
        data: {
          markdown: 'The patient writer pauses and listens before breakfast.',
          metadata: { title: 'A Firecrawl reference' },
        },
      }),
    })
  })
  await createNote(
    page,
    'Service import',
    'PRIVATE_BACKGROUND_NEVER_SENT_TO_IMPORTER'
  )
  const settings = await preferences(page, 'External models')
  await settings.getByText('Website import service', { exact: true }).click()
  await settings
    .getByLabel('Website importer', { exact: true })
    .selectOption('firecrawl')
  const key = settings.getByLabel('Firecrawl API key', { exact: true })
  await key.fill('e2e-not-a-real-firecrawl-key')
  await key
    .locator('..')
    .getByRole('button', { name: 'Save key', exact: true })
    .click()
  await expect(
    settings.getByText('Ready for this session.', { exact: true })
  ).toBeVisible()
  await settings.getByRole('button', { name: 'Done', exact: true }).click()
  const panel = await openContext(page)
  await panel
    .getByRole('button', { name: 'Add a website', exact: true })
    .click()
  const disclosure = page.getByRole('dialog', {
    name: 'Bring a website into context',
  })
  await expect(disclosure).toContainText(
    'Firecrawl will receive this website URL'
  )
  await expect(disclosure).toContainText('Your note is not sent.')
  const url = 'https://reference.example.org/scripted-guide'
  await disclosure.getByLabel('Website URL', { exact: true }).fill(url)
  await disclosure
    .getByRole('button', { name: 'Import through Firecrawl', exact: true })
    .click()
  await expect(
    panel.getByRole('checkbox', {
      name: 'Use A Firecrawl reference as context',
      exact: true,
    })
  ).toBeChecked()
  expect(requests).toHaveLength(1)
  expect(requests[0]?.postDataJSON()).toEqual({
    url,
    formats: ['markdown'],
    onlyMainContent: true,
  })
  expect(requests[0]?.postData()).not.toContain(
    'PRIVATE_BACKGROUND_NEVER_SENT_TO_IMPORTER'
  )
  await expectSaved(page, 'Service import', '')
  expect(
    await page.evaluate(
      key =>
        localStorage.getItem(key)?.includes('e2e-not-a-real-firecrawl-key'),
      workspaceKey
    )
  ).toBe(false)
})

test('preferences support keyboard tab navigation and Escape restores the invoking control', async ({
  page,
}) => {
  await createNote(page, 'Keyboard preferences')
  const dialog = await preferences(page, 'Writing')
  const writing = dialog.getByRole('tab', { name: 'Writing', exact: true })
  await writing.focus()
  await writing.press('ArrowRight')
  const local = dialog.getByRole('tab', {
    name: 'Local suggestions',
    exact: true,
  })
  await expect(local).toBeFocused()
  await expect(local).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('tabpanel')).toHaveAttribute(
    'aria-labelledby',
    'tab-local'
  )
  await local.press('End')
  const external = dialog.getByRole('tab', {
    name: 'External models',
    exact: true,
  })
  await expect(external).toBeFocused()
  await expect(external).toHaveAttribute('aria-selected', 'true')
  await external.press('Home')
  await expect(writing).toBeFocused()
  await expect(writing).toHaveAttribute('aria-selected', 'true')
  await writing.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Preferences', exact: true })
  ).toBeFocused()
})

test('focus mode hides surrounding panels and its keyboard shortcut restores the writing context without changing text', async ({
  page,
}) => {
  const text = 'This is still the writer’s original paragraph.'
  const content = await createNote(page, 'A focused paragraph')
  await content.fill(text)
  await openContext(page)
  await page
    .getByRole('button', { name: 'Enter focus mode', exact: true })
    .click()
  await expect(
    page.getByRole('complementary', { name: 'Notebook', exact: true })
  ).not.toBeVisible()
  await expect(
    page.getByRole('complementary', { name: 'Note context', exact: true })
  ).not.toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Open notes', exact: true })
  ).not.toBeVisible()
  await expect(content).toHaveText(text)
  await content.focus()
  await content.press('Control+Shift+F')
  await expect(
    page.getByRole('button', { name: 'Enter focus mode', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('complementary', { name: 'Notebook', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('complementary', { name: 'Note context', exact: true })
  ).toBeVisible()
  await expect(content).toHaveText(text)
  await page
    .getByRole('button', { name: 'Enter focus mode', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Show note sidebar', exact: true })
    .click()
  await expect(
    page.getByRole('complementary', { name: 'Notebook', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Enter focus mode', exact: true })
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Enter focus mode', exact: true })
    .click()
  await content.focus()
  await content.press('Control+b')
  await expect(
    page.getByRole('complementary', { name: 'Notebook', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Enter focus mode', exact: true })
  ).toBeVisible()
  await expect(content).toHaveText(text)
  await expectSaved(page, 'A focused paragraph', text)
})

test('another note provides live private context that follows edits, persists as a link, and respects inclusion and removal', async ({
  page,
}) => {
  const outgoing: string[] = []
  page.on('request', request => {
    if (
      /^https?:/u.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1:1420/')
    )
      outgoing.push(request.url())
  })
  const sourceTitle = 'An earlier thought'
  const title = 'A related paragraph'
  const original = 'The patient writer pauses and listens before breakfast.'
  const revised =
    'The patient writer notices the quiet around the next thought.'
  const prefix = 'The patient writer'
  const sourceContent = await createNote(page, sourceTitle)
  await setAutomaticSuggestions(page, false)
  await sourceContent.fill(original)
  await expectSaved(page, sourceTitle, original)
  const sourceId = (await savedNote(page, sourceTitle))?.id
  expect(sourceId).toBeTruthy()

  const content = await createNote(page, title)
  await content.fill(prefix)
  const panel = await openContext(page)
  await panel.getByRole('button', { name: 'Use a note', exact: true }).click()
  const picker = page.getByRole('dialog', {
    name: 'Use a note as context',
    exact: true,
  })
  await expect(
    picker.getByRole('button', { name: `Use ${title} as context`, exact: true })
  ).toHaveCount(0)
  await picker.getByLabel('Search notes', { exact: true }).fill('earlier')
  await picker
    .getByRole('button', {
      name: `Use ${sourceTitle} as context`,
      exact: true,
    })
    .click()
  await expect(picker).toHaveCount(0)
  const included = panel.getByRole('checkbox', {
    name: `Use ${sourceTitle} as context`,
    exact: true,
  })
  await expect(included).toBeChecked()
  await expect
    .poll(async () => (await savedNote(page, title))?.sources[0]?.linkedNoteId)
    .toBe(sourceId)
  expect((await savedNote(page, title))?.sources[0]).toMatchObject({
    kind: 'note',
    text: '',
    enabled: true,
  })
  await panel
    .getByRole('button', { name: `Preview ${sourceTitle}`, exact: true })
    .click()
  let preview = page.getByRole('dialog', { name: sourceTitle, exact: true })
  await expect(preview.locator('.source-preview-text')).toHaveText(original)
  await expect(preview).toContainText('Linked note · Live context')
  await preview.getByRole('button', { name: 'Done', exact: true }).click()
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    original.slice(prefix.length)
  )
  await content.press('Escape')

  const tabs = page.getByRole('navigation', { name: 'Open notes', exact: true })
  await tabs.getByRole('button', { name: sourceTitle, exact: true }).click()
  await editor(page).fill(revised)
  await expectSaved(page, sourceTitle, revised)
  await tabs.getByRole('button', { name: title, exact: true }).click()
  await expect(content).toHaveText(prefix)
  await panel
    .getByRole('button', { name: `Preview ${sourceTitle}`, exact: true })
    .click()
  preview = page.getByRole('dialog', { name: sourceTitle, exact: true })
  await expect(preview.locator('.source-preview-text')).toHaveText(revised)
  await expect(preview.locator('.source-preview-text')).not.toContainText(
    'pauses and listens'
  )
  await preview.getByRole('button', { name: 'Done', exact: true }).click()
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    revised.slice(prefix.length)
  )
  await content.press('Escape')
  await expectSaved(page, title, prefix)
  await page.reload()
  await expect(content).toHaveText(prefix)
  const reloadedPanel = await openContext(page)
  const reloadedInclusion = reloadedPanel.getByRole('checkbox', {
    name: `Use ${sourceTitle} as context`,
    exact: true,
  })
  await expect(reloadedInclusion).toBeChecked()
  expect((await savedNote(page, title))?.sources[0]?.text).toBe('')

  await reloadedInclusion.uncheck()
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await expect(page.locator('.suggestion-message')).toContainText(
    'Try a new line'
  )
  await reloadedInclusion.check()
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-text')).toHaveText(
    revised.slice(prefix.length)
  )
  await content.press('Tab')
  await expect(content).toHaveText(revised)
  await content.press('Control+z')
  await expect(content).toHaveText(prefix)
  await reloadedPanel
    .getByRole('button', { name: `Remove ${sourceTitle}`, exact: true })
    .click()
  await expect(reloadedInclusion).toHaveCount(0)
  await expect
    .poll(async () => (await savedNote(page, title))?.sources.length)
    .toBe(0)
  await content.press('Control+End')
  await requestLocal(page)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  expect(outgoing, 'Linked notes and exact recall must remain private').toEqual(
    []
  )
})

test('three providers keep independent keys and models, and the chooser routes to each without reconfiguration', async ({
  page,
}) => {
  const calls: {
    url: string
    model: string
    authorization?: string
    apiKey?: string
    system: string
  }[] = []
  const providers = [
    {
      id: 'openai',
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      model: 'writer-openai',
      key: 'e2e-openai',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1',
      model: 'writer-openrouter:free',
      key: 'e2e-openrouter',
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      model: 'writer-anthropic',
      key: 'e2e-anthropic',
    },
  ]
  for (const provider of providers)
    await page.route(`${provider.endpoint}/**`, async route => {
      if (route.request().method() !== 'POST')
        return route.fulfill({ status: 204, headers: corsHeaders })
      const body = route.request().postDataJSON()
      calls.push({
        url: route.request().url(),
        model: body.model,
        authorization: route.request().headers().authorization,
        apiKey: route.request().headers()['x-api-key'],
        system:
          body.system ??
          body.messages.find((item: { role: string }) => item.role === 'system')
            ?.content ??
          '',
      })
      if (provider.id === 'anthropic')
        return route.fulfill({
          status: 200,
          headers: corsHeaders,
          contentType: 'application/json',
          body: JSON.stringify({
            content: [{ type: 'text', text: ' makes room for a thought.' }],
            stop_reason: 'end_turn',
          }),
        })
      await completionResponse(route, ' makes room for a thought.')
    })
  const content = await createNote(page, 'Every model, one notebook')
  await setAutomaticSuggestions(page, false)
  const prefs = await preferences(page, 'External models')
  await prefs
    .getByLabel('Suggestion instructions', { exact: true })
    .fill('Keep my direct voice. Use simple words.')
  for (const provider of providers) {
    await prefs.getByLabel('Configure provider').selectOption(provider.id)
    await prefs.getByLabel('Model', { exact: true }).fill(provider.model)
    await prefs.getByLabel('API key', { exact: true }).fill(provider.key)
    await prefs.getByRole('button', { name: 'Save key', exact: true }).click()
    await expect(
      prefs.getByText('Ready for this session.', { exact: true })
    ).toBeVisible()
    await prefs
      .getByRole('button', { name: 'Save this model', exact: true })
      .click()
  }
  await prefs.getByRole('button', { name: 'Done', exact: true }).click()
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index]!
    await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
    const chooser = page.getByRole('dialog', {
      name: 'Choose your suggestion engine',
    })
    await chooser
      .getByRole('button', { name: provider.name, exact: true })
      .click()
    await expect(chooser.getByLabel('Model', { exact: true })).toHaveValue(
      provider.model
    )
    await chooser
      .getByRole('button', { name: `Use ${provider.name} continuously` })
      .click()
    await expect(content).toBeFocused()
    await content.fill(`The writer ${index}`)
    await content.press('Control+End')
    await requestLocal(page)
    await expect(page.locator('.cm-ghost-text')).toHaveText(
      ' makes room for a thought.'
    )
    await content.press('Escape')
    expect(calls[index]?.model).toBe(provider.model)
    expect(calls[index]?.system).toContain(
      'Keep my direct voice. Use simple words.'
    )
    expect(
      provider.id === 'anthropic'
        ? calls[index]?.apiKey
        : calls[index]?.authorization
    ).toBe(
      provider.id === 'anthropic' ? provider.key : `Bearer ${provider.key}`
    )
  }
  const writing = await preferences(page, 'Writing')
  await writing.getByLabel('Appearance', { exact: true }).selectOption('dark')
  await writing.getByRole('button', { name: 'Done', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        key => JSON.parse(localStorage.getItem(key)!).settings.provider,
        workspaceKey
      )
    )
    .toBe('anthropic')
  const raw = await page.evaluate(
    key => localStorage.getItem(key)!,
    workspaceKey
  )
  providers.forEach(provider => expect(raw).not.toContain(provider.key))
})

test('pure black and contrast presets are distinct and persist without changing model choice', async ({
  page,
}) => {
  await createNote(page, 'Contrast preferences')
  const prefs = await preferences(page, 'Writing')
  const dark = prefs.getByRole('group', { name: 'Dark palette', exact: true })
  await dark.getByText('Pure black', { exact: true }).click()
  await expect(page.locator('.app-shell')).toHaveCSS(
    'background-color',
    'rgb(0, 0, 0)'
  )
  await dark.getByText('Dark contrast', { exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'contrast')
  await expect(page.locator('html')).toHaveCSS('--ink', '#ffffff')
  await prefs
    .getByRole('group', { name: 'Light palette', exact: true })
    .getByText('Light contrast', { exact: true })
    .click()
  await expect(page.locator('html')).toHaveCSS('--ink', '#000000')
  await prefs.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Saved locally', exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'contrast')
})
