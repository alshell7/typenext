import { expect, test, type Locator, type Page } from '@playwright/test'

const endpoint = 'https://openrouter.ai/api/v1/chat/completions'
const model = 'nvidia/nemotron-3.5-lightning:free'
const syntheticKey = 'synthetic-demo-replay-key'
const title = 'A morning at Bramble House'
const fragment = 'Guests arrive at Bramble House'
const arrivalFact = 'Guests arrive at Bramble House on Friday at 16:00.'
// This real model response failed factual quality. Replaying it protects
// insertion mechanics without making a claim that its content is useful.
const capturedResponse =
  'There is room here for an unfinished thought. Bring a notebook, find a chair, and begin wherever you are.'
const expectedInsertion = ' There is room here for an unfinished thought.'
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': '*',
}

interface CompletionBody {
  model?: string
  max_tokens?: number
  reasoning?: { enabled?: boolean; exclude?: boolean }
  messages?: { role?: string; content?: string }[]
}
interface WritingData {
  noteTitle?: string
  beforeCursor?: string
  afterCursor?: string
  references?: { name?: string; text?: string }[]
}

async function writingText(editor: Locator): Promise<string> {
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

async function savedWriting(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('typenext.workspace.v1')
    if (!raw) return undefined
    const workspace = JSON.parse(raw) as {
      notes?: { id?: string; content?: string }[]
    }
    return workspace.notes?.find(
      note => note.id === 'typenext-demo-bramble-house-v1'
    )?.content
  })
}

async function preferences(
  page: Page,
  pane: 'Local suggestions' | 'External models'
) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}

test('the captured demo provider response stays a preview, accepts with a separator, and undoes exactly', async ({
  page,
}) => {
  const errors: string[] = []
  const unexpectedRequests: string[] = []
  const requests: { body: CompletionBody; authorization?: string }[] = []
  page.on('pageerror', error => errors.push(error.message))
  // Every hosted request is fulfilled or blocked here. No real key, public
  // catalog, model download or inference endpoint is contacted by this test.
  await page.context().route('**/*', async route => {
    const request = route.request()
    if (
      ['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(request.url()).hostname
      )
    )
      return route.continue()
    if (request.url() === endpoint && request.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: cors })
    if (request.url() === endpoint && request.method() === 'POST') {
      requests.push({
        body: request.postDataJSON() as CompletionBody,
        authorization: request.headers().authorization,
      })
      if (requests.length === 1)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify({
            choices: [
              { message: { content: capturedResponse }, finish_reason: 'stop' },
            ],
            usage: { cost: 0 },
          }),
        })
    }
    unexpectedRequests.push(request.url())
    return route.abort('blockedbyclient')
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Try a sample', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue(title)
  const editor = page.getByRole('textbox', {
    name: 'Note content',
    exact: true,
  })
  const original = await writingText(editor)
  expect(original.endsWith(fragment)).toBe(true)

  let dialog = await preferences(page, 'Local suggestions')
  await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).uncheck()
  await dialog.getByLabel('Pause before suggesting').selectOption('1800')
  await dialog.getByLabel('Suggestion length').selectOption('short')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await editor.fill(original.slice(0, -fragment.length))

  dialog = await preferences(page, 'External models')
  await dialog.getByLabel('Configure provider').selectOption('openrouter')
  await dialog.getByLabel('Model', { exact: true }).fill(model)
  await dialog.getByLabel('API key', { exact: true }).fill(syntheticKey)
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(
    dialog.getByText('Ready for this session.', { exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()

  dialog = await preferences(page, 'Local suggestions')
  await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).check()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('button', { name: 'Choose suggestion engine', exact: true })
    .click()
  const chooser = page.getByRole('dialog', {
    name: 'Choose your suggestion engine',
  })
  await chooser
    .getByRole('group', { name: 'External providers' })
    .getByRole('button', { name: 'OpenRouter', exact: true })
    .click()
  await chooser
    .getByRole('button', { name: 'Use OpenRouter continuously', exact: true })
    .click()
  expect(requests, 'Setup and activation must not send writing.').toHaveLength(
    0
  )

  await editor.focus()
  await editor.press('Control+End')
  await editor.pressSequentially(fragment, { delay: 15 })
  const ghost = page.locator('.cm-ghost-text')
  await expect(ghost).toBeVisible()
  expect(await ghost.textContent()).toBe(expectedInsertion)
  expect(requests).toHaveLength(1)
  const { body, authorization } = requests[0]!
  expect(authorization).toBe(`Bearer ${syntheticKey}`)
  expect(body.model).toBe(model)
  expect(body.max_tokens).toBeGreaterThan(0)
  expect(body.max_tokens).toBeLessThanOrEqual(64)
  expect(body.reasoning).toMatchObject({ enabled: false, exclude: true })
  expect(JSON.stringify(body)).not.toContain(syntheticKey)
  const system =
    body.messages?.find(message => message.role === 'system')?.content ?? ''
  expect(system).not.toContain('"insertions"')
  const writing = JSON.parse(
    body.messages?.find(message => message.role === 'user')?.content ?? '{}'
  ) as WritingData
  expect(writing.noteTitle).toBe(title)
  expect(writing.beforeCursor).toBe(original)
  expect(writing.afterCursor).toBe('')
  expect(
    writing.references?.some(
      reference =>
        reference.name === 'house.md' && reference.text?.includes(arrivalFact)
    )
  ).toBe(true)
  expect(await writingText(editor)).toBe(original)
  await expect.poll(() => savedWriting(page)).toBe(original)

  await editor.press('Tab')
  await expect
    .poll(() => writingText(editor))
    .toBe(original + expectedInsertion)
  expect(await writingText(editor)).toContain('Bramble House There is room')
  expect(await writingText(editor)).not.toContain('HouseThere')
  await expect(editor).toBeFocused()
  await editor.press('Control+z')
  await expect.poll(() => writingText(editor)).toBe(original)

  // Cancel the next automatic offer through the same user-facing control.
  dialog = await preferences(page, 'Local suggestions')
  await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).uncheck()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect.poll(() => savedWriting(page)).toBe(original)
  expect(requests).toHaveLength(1)
  expect(
    unexpectedRequests,
    'Only the single mocked provider POST is allowed.'
  ).toEqual([])
  expect(errors).toEqual([])
})
