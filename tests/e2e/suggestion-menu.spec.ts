import { expect, test, type Page } from '@playwright/test'

const workspaceKey = 'typenext.workspace.v1'
const browserErrors = new WeakMap<Page, string[]>()

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
})

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([])
})

const editor = (page: Page) =>
  page.getByRole('textbox', { name: 'Note content', exact: true })
const suggestions = (page: Page) =>
  page.getByRole('listbox', { name: 'Suggestions', exact: true })

async function createNote(page: Page, title: string) {
  await page.getByRole('button', { name: 'Start a note', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByRole('button', { name: 'Create note', exact: true }).click()
  await expect(editor(page)).toBeVisible()
  return editor(page)
}

async function localPreferences(page: Page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog
    .getByRole('tab', { name: 'Local suggestions', exact: true })
    .click()
  return dialog
}

async function savedText(page: Page) {
  return page.evaluate(key => {
    const value = localStorage.getItem(key)
    if (!value) return undefined
    const workspace = JSON.parse(value) as {
      activeNoteId: string
      notes: { id: string; content: string; sources: unknown[] }[]
    }
    return workspace.notes.find(note => note.id === workspace.activeNoteId)
  }, workspaceKey)
}

async function previewText(page: Page) {
  await expect(page.locator('.cm-ghost-text')).toBeVisible()
  return (await page.locator('.cm-ghost-text').textContent()) ?? ''
}

function watchOutsideRequests(page: Page) {
  const outgoing: string[] = []
  page.on('request', request => {
    if (
      /^https?:/u.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1:1420/')
    )
      outgoing.push(request.url())
  })
  return outgoing
}

test('a blank note needs no references or model: preview choices, accept one, undo and dismiss', async ({
  page,
}) => {
  const outgoing = watchOutsideRequests(page)
  const content = await createNote(page, 'A slower morning')
  await content.press('Control+Space')
  const menu = suggestions(page)
  await expect(menu).toBeVisible()
  const count = await menu.getByRole('option').count()
  expect(count).toBeGreaterThanOrEqual(2)
  expect(count).toBeLessThanOrEqual(3)
  await expect(content).toBeFocused()
  await expect(menu).toContainText('Writing starter')
  const first = await previewText(page)
  await content.press('ArrowDown')
  const selected = menu.getByRole('option', { selected: true })
  const selectedId = await selected.getAttribute('id')
  await expect(content).toHaveAttribute('aria-activedescendant', selectedId!)
  const second = await previewText(page)
  expect(second).not.toBe(first)
  await expect.poll(async () => (await savedText(page))?.content).toBe('')
  expect((await savedText(page))?.sources).toEqual([])
  await content.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await expect.poll(async () => (await savedText(page))?.content).toBe(second)
  await content.press('Control+z')
  await expect.poll(async () => (await savedText(page))?.content).toBe('')
  await content.press('Control+Space')
  await expect(menu).toBeVisible()
  await content.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await expect(content).not.toHaveAttribute('aria-activedescendant', /.+/u)
  expect(outgoing, 'Offline starters must make no network requests').toEqual([])
})

test('pausing gives an inline starter; Ctrl+Space reveals choices and a pointer accepts the chosen text', async ({
  page,
}) => {
  const outgoing = watchOutsideRequests(page)
  const content = await createNote(page, 'A plan for the week')
  const prefix = 'I want to'
  await content.fill('I want t')
  await content.press('o')
  await expect(page.locator('.cm-ghost-text')).toBeVisible()
  await expect(suggestions(page)).toHaveCount(0)
  await expect(page.locator('.suggestion-message')).toContainText(
    'Writing starter'
  )
  await content.press('Control+Space')
  const menu = suggestions(page)
  await expect(menu).toBeVisible()
  await content.press('ArrowDown')
  const insertion = await previewText(page)
  await menu.getByRole('option', { selected: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(content).toBeFocused()
  await expect
    .poll(async () => (await savedText(page))?.content)
    .toBe(prefix + insertion)

  const dialog = await localPreferences(page)
  await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).uncheck()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await content.fill('The next step is')
  await content.press('Control+End')
  await page.waitForTimeout(1300)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await content.press('Control+Space')
  await expect(menu).toBeVisible()
  await content.press('x')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  expect(outgoing).toEqual([])
})

test('a local model can suggest without references and manual choices use only one inference request', async ({
  page,
}) => {
  const payloads: Record<string, unknown>[] = []
  await page.route('http://127.0.0.1:1337/v1/chat/completions', async route => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
        },
      })
      return
    }
    payloads.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
      },
      body: JSON.stringify({
        choices: [{ message: { content: ' comes into focus.' } }],
      }),
    })
  })
  const content = await createNote(page, 'A small observation')
  const dialog = await localPreferences(page)
  await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).uncheck()
  await dialog
    .getByLabel('Server address', { exact: true })
    .fill('http://127.0.0.1:1337/v1')
  await dialog
    .getByLabel('Model', { exact: true })
    .fill('synthetic-local-writer')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await content.fill('A small detail')
  await content.press('Control+End')
  await content.press('Control+Space')
  await expect(suggestions(page)).toBeVisible()
  expect(await previewText(page)).toBe(' comes into focus.')
  await expect(suggestions(page)).toContainText('Local model')
  expect(payloads).toHaveLength(1)
  const messages = payloads[0]!.messages as { role: string; content: string }[]
  const data = JSON.parse(
    messages.find(message => message.role === 'user')!.content
  )
  expect(data.references).toEqual([])
  expect(data.beforeCursor).toBe('A small detail')
  await content.press('ArrowDown')
  await content.press('ArrowUp')
  expect(payloads).toHaveLength(1)
  await content.press('Tab')
  await expect
    .poll(async () => (await savedText(page))?.content)
    .toBe('A small detail comes into focus.')
})

test('the dark suggestion menu fits a narrow viewport, follows reduced motion and closes on blur', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.reload()
  const content = await createNote(page, 'Small observations')
  await content.fill('The next step is')
  await content.press('Control+End')
  await content.press('Control+Space')
  const menu = suggestions(page)
  await expect(menu).toBeVisible()
  const panel = page.locator('.cm-suggestion-menu')
  const box = await panel.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(391)
  expect(box!.y + box!.height).toBeLessThanOrEqual(845)
  const motion = await panel.evaluate(element => {
    const style = getComputedStyle(element)
    return {
      animation: style.animationDuration,
      transition: style.transitionDuration,
    }
  })
  for (const value of [motion.animation, motion.transition]) {
    expect(
      value.split(',').every(duration => Number.parseFloat(duration) <= 0.001)
    ).toBe(true)
  }
  await expect(page.locator('.acceptance-help')).not.toBeVisible()
  await page.getByRole('textbox', { name: 'Note title', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await content.fill('I want t')
  await content.press('o')
  await expect(page.locator('.cm-ghost-text')).toBeVisible()
  const help = await page.locator('.acceptance-help').boundingBox()
  const local = await page.locator('.local-suggestion-button').boundingBox()
  const external = await page
    .locator('.external-suggestion-button')
    .boundingBox()
  expect(help).not.toBeNull()
  expect(help!.x).toBeGreaterThanOrEqual(local!.x + local!.width + 4)
  expect(help!.x + help!.width).toBeLessThanOrEqual(external!.x - 4)
})
