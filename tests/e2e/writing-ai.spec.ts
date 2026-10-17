import { expect, test, type Page, type Route } from '@playwright/test'
import { noteEditor, savedMarkdown, startNote } from './support/notes'

const localServer = 'http://127.0.0.1:1338/v1'
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

async function fresh(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
}

/** Change saved settings directly, then reload: faster than the dialog. */
async function patchSettings(page: Page, patch: Record<string, unknown>) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(localStorage.getItem('typenext.workspace.v1'))
      )
    )
    .toBe(true)
  await page.evaluate(next => {
    const workspace = JSON.parse(localStorage.getItem('typenext.workspace.v1')!)
    for (const [key, value] of Object.entries(next)) {
      const current = workspace.settings[key]
      workspace.settings[key] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { ...current, ...value }
          : value
    }
    localStorage.setItem('typenext.workspace.v1', JSON.stringify(workspace))
  }, patch)
  await page.reload()
  await expect(noteEditor(page)).toBeVisible()
}

async function useLocalModel(page: Page) {
  await patchSettings(page, {
    localEngine: 'server',
    autoSuggest: false,
    profiles: {
      local: { endpoint: localServer, model: 'stub-writer', protocol: 'chat' },
    },
  })
}

interface Mock {
  /** Milliseconds before each answer. */
  delay?: number
  edit?(passage: string, system: string): string
  continuation?: string
}

async function mockModel(page: Page, mock: Mock = {}) {
  const requests: { system: string; user: string }[] = []
  await page.route(`${localServer}/**`, async (route: Route) => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 204, headers: corsHeaders })
    const body = route.request().postDataJSON() as {
      messages: { content: string }[]
    }
    const system = body.messages[0]?.content ?? ''
    const user = body.messages.at(-1)?.content ?? ''
    requests.push({ system, user })
    let content = mock.continuation ?? ' and the kettle starts to sing.'
    try {
      const data = JSON.parse(user) as { passage?: string }
      if (data.passage !== undefined)
        content = mock.edit
          ? mock.edit(data.passage, system)
          : data.passage.replace('run', 'runs')
      else if (system.includes('insertions'))
        content = JSON.stringify({
          insertions: [content, ' while the guests unpack.', ' before noon.'],
        })
    } catch {
      // Plain prompt: keep the continuation.
    }
    if (mock.delay)
      await new Promise(resolve => setTimeout(resolve, mock.delay))
    await route.fulfill({
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
      }),
    })
  })
  return requests
}

/** Select text in the editor the way a browser does, through the DOM. */
async function selectText(page: Page, text: string) {
  await page.evaluate(target => {
    const content = document.querySelector<HTMLElement>(
      '.document-page .cm-content'
    )!
    content.focus()
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(target) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + target.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`Text not found: ${target}`)
  }, text)
  // CodeMirror reads the DOM selection on the next selectionchange.
  await page.waitForTimeout(120)
}

async function savedSetting(page: Page, key: string) {
  return page.evaluate(name => {
    const raw = localStorage.getItem('typenext.workspace.v1')
    return raw ? JSON.parse(raw).settings?.[name] : undefined
  }, key)
}

test.beforeEach(async ({ page }) => {
  await fresh(page)
})

test('selected text stays readable and the format bar matches the theme', async ({
  page,
}) => {
  await startNote(page, 'Selection')
  await page.keyboard.type('A quiet line to select.')
  for (const theme of ['dark', 'light'] as const) {
    await patchSettings(page, { theme })
    await noteEditor(page).click()
    await selectText(page, 'quiet line')
    const bar = page.locator('.cm-format-bar')
    await expect(bar).toBeVisible()
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const selection = document.querySelector<HTMLElement>(
        '.document-page .cm-selectionBackground'
      )!
      const formatBar = document.querySelector<HTMLElement>('.cm-format-bar')!
      const button = formatBar.querySelector('button')!
      const probe = document.createElement('span')
      probe.style.color = root.getPropertyValue('--editor-selection')
      document.body.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return {
        selection: getComputedStyle(selection).backgroundColor,
        expected,
        bar: getComputedStyle(formatBar).backgroundColor,
        text: getComputedStyle(button).color,
      }
    })
    // The palette's selection colour wins over CodeMirror's lavender.
    expect(colors.selection).toBe(colors.expected)
    // rgb(…) uses 0–255; color(srgb …) from color-mix uses 0–1.
    const channel = (value: string) => {
      const number = Number(
        /[\d.]+/u.exec(value.replace(/^color\(srgb\s*/u, ''))?.[0] ?? 0
      )
      return value.startsWith('color(') ? number * 255 : number
    }
    // A dark bar in dark mode and a light one in light mode, with contrast.
    if (theme === 'dark') expect(channel(colors.bar)).toBeLessThan(90)
    else expect(channel(colors.bar)).toBeGreaterThan(200)
    expect(
      Math.abs(channel(colors.bar) - channel(colors.text))
    ).toBeGreaterThan(70)
  }
})

test('editor tooltips never show through a dialog', async ({ page }) => {
  await startNote(page, 'Tooltips')
  await page.keyboard.type('Select me please.')
  await selectText(page, 'Select me')
  await expect(page.locator('.cm-format-bar')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+,')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.cm-format-bar')).toBeHidden()
})

test('links shrink to their text, open up for editing and keep working', async ({
  page,
}) => {
  await startNote(page, 'Links')
  await page.keyboard.type(
    'Read [the house guide](https://example.com/guide) and [[Packing list|what to pack]].'
  )
  await page.keyboard.press('Enter')
  await page.keyboard.type(
    'Long https://example.com/bramble/visitors/arrival-information-2026-autumn here.'
  )
  await page.keyboard.press('Enter')
  const first = page.locator('.document-page .cm-line').first()
  await expect(first).toHaveText('Read the house guide and what to pack.')
  await expect(first.locator('.cm-link-text')).toHaveText('the house guide')
  await expect(
    page.locator('.cm-link-short', {
      hasText: 'example.com/…/arrival-information',
    })
  ).toBeVisible()
  // The cursor inside a link shows its Markdown; the saved text never changes.
  await selectText(page, 'house')
  await expect(first).toContainText(
    '[the house guide](https://example.com/guide)'
  )
  await savedMarkdown(
    page,
    /\[the house guide\]\(https:\/\/example\.com\/guide\)/u
  )
  await page.keyboard.press('ControlOrMeta+End')
  await expect(first).toHaveText('Read the house guide and what to pack.')

  // Hover card: Unlink keeps the words and removes the link.
  await page.route('https://example.com/**', route =>
    route.fulfill({ status: 404, body: '' })
  )
  await first.locator('.cm-link-text').hover()
  const card = page.locator('.cm-link-card')
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: 'Open link' })).toBeVisible()
  await card
    .getByRole('button', { name: 'Keep the text and remove the link' })
    .click()
  await savedMarkdown(
    page,
    /^Read the house guide and \[\[Packing list\|what to pack\]\]\./u
  )
})

test('link text stays put while a click places the cursor', async ({
  page,
}) => {
  await startNote(page, 'Clicks')
  await page.keyboard.type(
    'See [a long label here](https://example.com/x) now.'
  )
  await page.keyboard.press('Enter')
  const label = page.locator('.cm-link-text', { hasText: 'a long label here' })
  const before = await label.boundingBox()
  await page.mouse.move(before!.x + 20, before!.y + 5)
  await page.mouse.down()
  // While the button is down the line does not jump.
  const during = await label.boundingBox()
  expect(Math.abs(during!.x - before!.x)).toBeLessThan(1)
  await page.mouse.up()
  // After release the link opens for editing.
  await expect(page.locator('.document-page .cm-line').first()).toContainText(
    '[a long label here](https://example.com/x)'
  )
})

test('AI actions propose an edit, show it word by word and replace on request', async ({
  page,
}) => {
  await startNote(page, 'Edit with AI')
  await page.keyboard.type('The river run clear under the bridge.')
  await useLocalModel(page)
  const requests = await mockModel(page, { delay: 700 })
  await noteEditor(page).click()
  await selectText(page, 'The river run clear')
  await page
    .locator('.cm-format-bar')
    .getByRole('button', { name: /AI actions/ })
    .click()
  const panel = page.getByRole('dialog', {
    name: 'AI actions for the selection',
  })
  await expect(panel).toBeVisible()
  await expect(
    panel.getByRole('textbox', { name: 'Describe a change for the AI' })
  ).toBeFocused()
  await expect(panel).toContainText('Local model · stub-writer')
  await panel.getByRole('option', { name: /Fix grammar/ }).click()
  // While the model works: the animation and the shimmering selection.
  await expect(panel.locator('.ai-pulse')).toBeVisible()
  await expect(page.locator('.cm-ai-working')).toHaveText('The river run clear')
  await expect(panel.locator('ins')).toHaveText('runs')
  await expect(panel.locator('del')).toHaveText('run')
  await expect(panel).toContainText('1 word added · 1 removed')
  expect(requests.at(-1)?.system).toContain('Correct only spelling')
  // The document is unchanged until Replace.
  await savedMarkdown(page, 'The river run clear under the bridge.')
  await panel.getByRole('button', { name: /^Replace/ }).click()
  await expect(panel).toBeHidden()
  await savedMarkdown(page, 'The river runs clear under the bridge.')
  await expect(page.locator('.cm-ai-applied')).toBeVisible()
  // One undo restores the original.
  await page.keyboard.press('ControlOrMeta+z')
  await savedMarkdown(page, 'The river run clear under the bridge.')
})

test('AI actions open with the keyboard, take a custom request and close with Escape', async ({
  page,
}) => {
  await startNote(page, 'Keyboard AI')
  await page.keyboard.type('Hello there friend.')
  await useLocalModel(page)
  const requests = await mockModel(page, { edit: () => 'Bonjour, mon ami.' })
  await noteEditor(page).click()
  await selectText(page, 'Hello there friend.')
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('dialog', {
    name: 'AI actions for the selection',
  })
  // Typing goes to the request field at once, never over the selection.
  await page.keyboard.type('Translate to French')
  await expect(
    panel.getByRole('textbox', { name: 'Describe a change for the AI' })
  ).toHaveValue('Translate to French')
  await page.keyboard.press('Enter')
  await expect(panel.locator('ins')).toContainText('Bonjour')
  expect(requests.at(-1)?.system).toContain('"Translate to French"')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await savedMarkdown(page, 'Hello there friend.')
  await expect(noteEditor(page)).toBeFocused()
})

test('AI actions are offered only with a chat model', async ({ page }) => {
  await startNote(page, 'No model')
  await page.keyboard.type('Plain local writing.')
  await selectText(page, 'Plain')
  await expect(page.locator('.cm-format-bar')).toBeVisible()
  await expect(
    page.locator('.cm-format-bar').getByRole('button', { name: /AI actions/ })
  ).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+j')
  await expect(
    page.getByRole('dialog', { name: 'AI actions for the selection' })
  ).toHaveCount(0)
})

test('a chosen animation plays at the cursor while a suggestion loads, and can be off', async ({
  page,
}) => {
  await startNote(page, 'Pulse')
  await page.keyboard.type('Guests arrive at noon')
  await useLocalModel(page)
  await mockModel(page, { delay: 1200 })
  await noteEditor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('ControlOrMeta+Space')
  await expect(
    page.locator('.cm-ai-pulse-widget .ai-pulse.is-orb')
  ).toBeVisible()
  await expect(page.locator('.suggestion-bar .ai-pulse.is-orb')).toBeVisible()
  await expect(page.locator('.cm-ghost-text')).toBeVisible()
  await expect(page.locator('.cm-ai-pulse-widget')).toHaveCount(0)

  await page.keyboard.press('Escape')
  const dialog = await openPreferences(page, 'Suggestions')
  await dialog.getByRole('radio', { name: /^Dots/ }).click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await noteEditor(page).click()
  await page.keyboard.type(' sharp')
  await page.keyboard.press('ControlOrMeta+Space')
  await expect(
    page.locator('.cm-ai-pulse-widget .ai-pulse.is-dots')
  ).toBeVisible()

  await page.keyboard.press('Escape')
  const again = await openPreferences(page, 'Suggestions')
  await again.getByRole('radio', { name: /^Off/ }).click()
  await again.getByRole('button', { name: 'Done', exact: true }).click()
  await noteEditor(page).click()
  await page.keyboard.type(' today')
  await page.keyboard.press('ControlOrMeta+Space')
  await expect(page.locator('.suggestion-message')).toContainText(
    'Finding a continuation'
  )
  await expect(page.locator('.cm-ai-pulse-widget')).toHaveCount(0)
})

async function openPreferences(page: Page, pane: string) {
  await page.keyboard.press('ControlOrMeta+,')
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}

test('the suggestion key can be recorded, is shown everywhere and replaces the old key', async ({
  page,
}) => {
  await startNote(page, 'Keys')
  await page.keyboard.type('Guests arrive at noon')
  await useLocalModel(page)
  const requests = await mockModel(page)
  const dialog = await openPreferences(page, 'Shortcuts')
  const field = dialog.getByRole('button', { name: /^Suggest at the cursor:/ })
  await field.click()
  await expect(dialog).toContainText('Press the new keys')
  // A key the app uses is refused with the reason.
  await page.keyboard.press('ControlOrMeta+s')
  await expect(dialog).toContainText('Already used for Save')
  await field.click()
  await page.keyboard.press('Alt+Period')
  await expect(field).toContainText(process.platform === 'darwin' ? '⌥' : 'Alt')
  // Escape while recording cancels the recording, not Preferences.
  await field.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.suggestion-message')).toContainText(
    process.platform === 'darwin' ? '⌥ .' : 'Alt .'
  )
  await noteEditor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  const before = requests.length
  await page.keyboard.press('ControlOrMeta+Space')
  await page.waitForTimeout(400)
  expect(requests.length).toBe(before)
  await page.keyboard.press('Alt+Period')
  await expect(page.locator('.cm-ghost-text')).toBeVisible()
  // Reset brings the default back.
  const reopen = await openPreferences(page, 'Shortcuts')
  await reopen
    .getByRole('button', { name: 'Reset suggest at the cursor to the default' })
    .click()
  await expect(
    reopen.getByRole('button', { name: /^Suggest at the cursor:/ })
  ).toContainText('Space')
})

test('the suggestion word limit is chosen with a slider and saved', async ({
  page,
}) => {
  await startNote(page, 'Length')
  const dialog = await openPreferences(page, 'Suggestions')
  await dialog.getByRole('radio', { name: 'Custom', exact: true }).click()
  const slider = dialog.getByRole('slider', {
    name: 'Most words in a suggestion',
  })
  await expect(slider).toHaveValue('12')
  await slider.fill('5')
  await expect(dialog).toContainText('Up to 5 words')
  await expect.poll(() => savedSetting(page, 'suggestionWords')).toBe(5)
  await dialog.getByRole('radio', { name: 'Adapt', exact: true }).click()
  await expect.poll(() => savedSetting(page, 'suggestionWords')).toBe(0)
})

test('custom colours open a picker that edits live and closes on its own', async ({
  page,
}) => {
  await startNote(page, 'Colours')
  const dialog = await openPreferences(page, 'Writing')
  const darkGroup = dialog.getByRole('group', { name: 'Dark palette' })
  await darkGroup.getByText('Custom', { exact: true }).click()
  await dialog
    .getByRole('button', { name: 'Choose the dark accent colour' })
    .click()
  const picker = page.getByRole('dialog', { name: 'Dark accent colour' })
  await expect(picker).toBeVisible()
  // The picker stays inside the Preferences window.
  const box = await picker.boundingBox()
  const frame = await dialog.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1)
  const accent = dialog.getByLabel('Dark accent color', { exact: true })
  const start = await accent.inputValue()
  await picker
    .getByRole('slider', { name: 'Saturation and brightness' })
    .focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(accent).not.toHaveValue(start)
  await picker.getByRole('button', { name: 'Use #c4b5fd' }).click()
  await expect(accent).toHaveValue('#c4b5fd')
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Choose the dark accent colour' })
  ).toBeFocused()
})

test('instruction templates fill the instructions, and Undo brings back your own', async ({
  page,
}) => {
  await startNote(page, 'Templates')
  const dialog = await openPreferences(page, 'Suggestions')
  const field = dialog.getByLabel('Suggestion instructions', { exact: true })
  await field.fill('Always mention the garden.')
  const templates = dialog.getByRole('group', { name: 'Instruction templates' })
  await templates.getByRole('button', { name: /Technical writing/ }).click()
  await expect(field).toHaveValue(/precise technical prose/u)
  await expect(
    templates.getByRole('button', { name: /Technical writing/ })
  ).toHaveAttribute('aria-pressed', 'true')
  // Another template keeps Undo pointing at the writer's own text.
  await templates.getByRole('button', { name: /Fiction/ }).click()
  await expect(field).toHaveValue(/Continue the scene/u)
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(field).toHaveValue('Always mention the garden.')
  await expect(templates.getByRole('button', { pressed: true })).toHaveCount(0)
  await expect
    .poll(() => savedSetting(page, 'suggestionInstructions'))
    .toBe('Always mention the garden.')
})
