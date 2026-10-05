import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test'

type Provider = 'openai' | 'openrouter' | 'anthropic'
const providers: Record<Provider, { endpoint: string; label: string }> = {
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI',
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    label: 'OpenRouter',
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    label: 'Anthropic',
  },
}
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': '*',
}
const prefix = 'The '
const suffix = ' ending.'
const key = 'e2e-synthetic-key-only'
interface Payload {
  model: string
  max_tokens: number
  system?: string
  messages: { role: string; content: string }[]
  response_format?: unknown
  n?: unknown
}
function requestSystem(body: Payload): string {
  return (
    body.system ??
    body.messages.find(message => message.role === 'system')?.content ??
    ''
  )
}
function isOptions(body: Payload): boolean {
  return requestSystem(body).includes('"insertions"')
}
async function respond(route: Route, provider: Provider, text: string) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: cors,
    body: JSON.stringify(
      provider === 'anthropic'
        ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
        : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
    ),
  })
}
function content(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Note content', exact: true })
}
async function writingText(editor: Locator): Promise<string> {
  return editor.evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll('.cm-ghost-suggestion')
      .forEach(ghost => ghost.remove())
    return clone.textContent ?? ''
  })
}
async function note(page: Page, title: string) {
  const start = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await start.isVisible()) await start.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await dialog
    .getByLabel(/^Context for suggestions/)
    .fill('Complete only the missing phrase without changing either side.')
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue(title)
  return content(page)
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
async function automatic(page: Page, enabled: boolean) {
  const dialog = await preferences(page, 'Local suggestions')
  await dialog
    .getByRole('switch', { name: /^Suggest after a pause/ })
    .setChecked(enabled)
  await dialog.getByLabel('Pause before suggesting').selectOption('1800')
  await dialog.getByLabel('Suggestion length').selectOption('short')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}
async function configure(page: Page, provider: Provider) {
  await automatic(page, false)
  const dialog = await preferences(page, 'External models')
  await dialog.getByLabel('Configure provider').selectOption(provider)
  await dialog
    .getByLabel('Model', { exact: true })
    .fill('synthetic-writing-model')
  await dialog.getByLabel('API key', { exact: true }).fill(key)
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(
    dialog.getByText('Ready for this session.', { exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('button', { name: 'Choose suggestion engine', exact: true })
    .click()
  const chooser = page.getByRole('dialog', {
    name: 'Choose your suggestion engine',
  })
  await chooser
    .getByRole('group', { name: 'External providers' })
    .getByRole('button', { name: providers[provider].label, exact: true })
    .click()
  await chooser
    .getByRole('button', {
      name: `Use ${providers[provider].label} continuously`,
      exact: true,
    })
    .click()
}
async function cursorAt(editor: Locator, position: number) {
  await editor.focus()
  await editor.press('Control+Home')
  for (let index = 0; index < position; index++)
    await editor.press('ArrowRight')
}

test.describe.configure({ timeout: 45_000 })

for (const provider of ['openai', 'openrouter', 'anthropic'] as const) {
  test(`${provider}: automatic inline stays single; manual choices refresh, accept and undo without changing the suffix`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const requests: Payload[] = []
    const options = [
      ['careful', 'patient', 'steady'],
      ['thoughtful', 'unhurried', 'quiet'],
      ['precise', 'natural', 'clear'],
    ]
    let manualRequests = 0
    await page.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        return route.continue()
      if (request.method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: cors })
      if (
        request.url() !== providers[provider].endpoint ||
        request.method() !== 'POST'
      )
        return route.abort('blockedbyclient')
      const body = request.postDataJSON() as Payload
      requests.push(body)
      expect(body.model).toBe('synthetic-writing-model')
      expect(body.max_tokens).toBeGreaterThan(0)
      expect(body.max_tokens).toBeLessThanOrEqual(isOptions(body) ? 384 : 128)
      expect(body.response_format).toBeUndefined()
      expect(body.n).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain(key)
      const writing = JSON.parse(
        body.messages.find(message => message.role === 'user')!.content
      )
      expect(writing.beforeCursor).toBe(prefix)
      expect(writing.afterCursor).toBe(suffix)
      const headers = request.headers()
      if (provider === 'anthropic') {
        expect(headers['x-api-key']).toBe(key)
        expect(headers['anthropic-version']).toBe('2023-06-01')
      } else expect(headers.authorization).toBe(`Bearer ${key}`)
      const result = isOptions(body)
        ? JSON.stringify({
            insertions: options[Math.min(manualRequests++, options.length - 1)],
          })
        : 'careful'
      await respond(route, provider, result)
    })
    await page.goto('/')
    const editor = await note(page, `${provider} choices`)
    await configure(page, provider)
    await editor.fill('The ending.')
    await cursorAt(editor, 3)
    await automatic(page, true)
    await cursorAt(editor, 3)
    await editor.press('Space')
    await expect(page.locator('.cm-ghost-text')).toHaveText('careful')
    expect(requests).toHaveLength(1)
    expect(isOptions(requests[0]!)).toBe(false)
    await expect(
      page.getByRole('listbox', { name: 'Suggestions' })
    ).toHaveCount(0)
    expect(await writingText(editor)).toBe(prefix + suffix)

    await editor.press('Control+Space')
    await expect(page.locator('.cm-suggestion-option-text')).toHaveText(
      options[0]!
    )
    expect(requests).toHaveLength(2)
    await editor.press('Control+Space')
    await expect(page.locator('.cm-suggestion-option-text')).toHaveText(
      options[1]!
    )
    expect(requests).toHaveLength(3)
    expect(await writingText(editor)).toBe(prefix + suffix)
    await editor.press('ArrowDown')
    await expect(
      page
        .getByRole('listbox', { name: 'Suggestions' })
        .getByRole('option')
        .nth(1)
    ).toHaveAttribute('aria-selected', 'true')
    await editor.press('Enter')
    await expect(editor).toHaveText(prefix + 'unhurried' + suffix)
    await expect(editor).toBeFocused()
    await editor.press('Control+z')
    await expect(editor).toHaveText(prefix + suffix)

    await editor.press('Control+Space')
    await expect(page.locator('.cm-suggestion-option-text')).toHaveText(
      options[2]!
    )
    await page
      .getByRole('listbox', { name: 'Suggestions' })
      .getByRole('option')
      .nth(2)
      .click()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveText(prefix + 'clear' + suffix)
    await editor.press('Control+z')
    await expect(editor).toHaveText(prefix + suffix)
    await automatic(page, false)
    expect(requests).toHaveLength(4)
    expect(requests.filter(isOptions)).toHaveLength(3)
    expect(manualRequests).toBe(3)
    expect(errors).toEqual([])
  })
}

test('the recorded real-model choices keep a separator at a complete-word cursor on preview, acceptance and undo', async ({
  page,
}) => {
  const gardenPrefix = 'At dawn, the garden'
  const gardenSuffix = ' while the city was still asleep.'
  const recorded = ['exhaled cool air', 'smelled of rain', 'held its breath']
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let posts = 0
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return route.continue()
    if (request.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: cors })
    if (
      request.url() !== providers.openrouter.endpoint ||
      request.method() !== 'POST'
    )
      return route.abort('blockedbyclient')
    posts += 1
    const body = request.postDataJSON() as Payload
    expect(isOptions(body)).toBe(true)
    const writing = JSON.parse(
      body.messages.find(message => message.role === 'user')!.content
    )
    expect(writing.beforeCursor).toBe(gardenPrefix)
    expect(writing.afterCursor).toBe(gardenSuffix)
    await respond(route, 'openrouter', JSON.stringify({ insertions: recorded }))
  })
  await page.goto('/')
  const editor = await note(page, 'Recorded model spacing regression')
  await configure(page, 'openrouter')
  await editor.fill(gardenPrefix + gardenSuffix)
  await cursorAt(editor, gardenPrefix.length)
  await editor.press('Control+Space')
  await expect(page.locator('.cm-suggestion-option-text')).toHaveText(recorded)
  const list = page.getByRole('listbox', { name: 'Suggestions' })
  for (let index = 0; index < recorded.length; index++) {
    if (index) await editor.press('ArrowDown')
    await expect(list.getByRole('option').nth(index)).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(page.locator('.cm-ghost-text')).toHaveText(
      ` ${recorded[index]!}`
    )
    expect(await page.locator('.cm-ghost-text').textContent()).toBe(
      ` ${recorded[index]!}`
    )
    expect(await writingText(editor)).toBe(gardenPrefix + gardenSuffix)
  }
  await editor.press('Tab')
  await expect(editor).toHaveText(
    'At dawn, the garden held its breath while the city was still asleep.'
  )
  expect(await editor.textContent()).toBe(
    'At dawn, the garden held its breath while the city was still asleep.'
  )
  await expect(page.locator('.cm-ghost-text')).toHaveCount(0)
  await editor.press('Control+z')
  await expect(editor).toHaveText(gardenPrefix + gardenSuffix)
  expect(posts).toBe(1)
  expect(errors).toEqual([])
})

test('a late hosted choices response is aborted on note change and cannot enter the next draft', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let postCount = 0
  let aborted = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  page.on('requestfailed', request => {
    if (request.url() === providers.openai.endpoint) aborted += 1
  })
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      return route.continue()
    if (request.method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: cors })
    if (
      request.url() !== providers.openai.endpoint ||
      request.method() !== 'POST'
    )
      return route.abort('blockedbyclient')
    postCount += 1
    const body = request.postDataJSON() as Payload
    expect(isOptions(body)).toBe(true)
    await gate
    await respond(
      route,
      'openai',
      JSON.stringify({
        insertions: ['STALE FIRST', 'STALE SECOND', 'STALE THIRD'],
      })
    ).catch(() => {})
  })
  try {
    await page.goto('/')
    const editor = await note(page, 'Pending source note')
    await configure(page, 'openai')
    await editor.fill(prefix + suffix)
    await cursorAt(editor, prefix.length)
    await editor.press('Control+Space')
    await expect.poll(() => postCount).toBe(1)
    const next = await note(page, 'A separate next note')
    await next.fill('A new beginning remains mine.')
    release()
    await expect.poll(() => aborted).toBe(1)
    await expect(
      page.getByRole('listbox', { name: 'Suggestions' })
    ).toHaveCount(0)
    await expect(page.locator('.cm-ghost-text')).toHaveCount(0)
    await expect(next).toHaveText('A new beginning remains mine.')
    expect(postCount).toBe(1)
    expect(errors).toEqual([])
  } finally {
    release()
  }
})
