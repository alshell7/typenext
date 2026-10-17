import { expect, test, type Page } from '@playwright/test'
import { noteEditor, savedMarkdown, startNote } from './support/notes'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function fresh(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await fresh(page)
})

test('the / menu inserts headings, lists, tasks and tables, and Escape keeps a literal slash', async ({
  page,
}) => {
  const editor = await startNote(page, 'Insert menu')
  await page.keyboard.type('/')
  const menu = page.locator('.cm-insert-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option', { name: /Heading 1/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await page.keyboard.type(' literal')
  await expect(editor).toContainText('/ literal')
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.press('Backspace')

  await page.keyboard.type('Plan /h2')
  await expect(menu.getByRole('option', { name: /Heading 2/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(editor).toContainText('## Plan')

  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/task')
  await expect(menu.getByRole('option', { name: /Task list/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Water the roses')
  await savedMarkdown(page, '## Plan \n- [ ] Water the roses')

  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/table')
  await expect(menu.getByRole('option', { name: /^Table/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Name')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Role')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Since')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Ada')
  await savedMarkdown(
    page,
    /\| Name +\| Role +\| Since +\|\n\| -+ \| -+ \| -+ \|\n\| Ada/u
  )
  // Leaving the table renders it; the Markdown stays the source.
  await page.keyboard.press(`${mod}+Home`)
  await expect(page.locator('.cm-lp-table')).toBeVisible()
  await expect(page.locator('.cm-lp-table th').first()).toHaveText('Name')
  // The task box is a real checkbox that edits the Markdown.
  const box = page.locator('.cm-lp-task').first()
  await box.click()
  await expect(box).toBeChecked()
  await savedMarkdown(page, '- [x] Water the roses')
})

test('Tab and Shift+Tab nest list items; Enter continues the list', async ({
  page,
}) => {
  const editor = await startNote(page, 'Lists')
  await page.keyboard.type('- one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.keyboard.type('three')
  await page.keyboard.press('Shift+Tab')
  const text = await editor.innerText()
  expect(text).toMatch(/one[\s\S]*two[\s\S]*three/u)
  await page.keyboard.press(`${mod}+Home`)
  await expect(page.locator('.cm-lp-bullet').first()).toBeVisible()
  await savedMarkdown(page, /^- one\n {2}- two\n- three$/u)
})

test('[[links]] complete note titles, preview on hover and open with a modifier click', async ({
  page,
}) => {
  await startNote(page, 'Garden plan')
  await page.keyboard.type('Roses go by the south wall. Compost in spring.')
  const editor = await startNote(page, 'Weekend')
  await page.keyboard.type('Read [[Gar')
  const menu = page.locator('.cm-insert-menu')
  await expect(menu.getByRole('option', { name: /Garden plan/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.type(' and [[Seed list]] later.')
  // The Markdown keeps the links; the page shows only their text.
  await savedMarkdown(page, 'Read [[Garden plan]] and [[Seed list]] later.')
  await expect(editor).toContainText('Read Garden plan and Seed list later.')
  const link = page.locator('.cm-wikilink', { hasText: 'Garden plan' })
  await link.hover()
  const card = page.locator('.cm-link-card')
  await expect(card).toContainText('Roses go by the south wall')
  await expect(card.getByRole('button', { name: 'Open note' })).toBeVisible()
  await link.click({ modifiers: [mod === 'Meta' ? 'Meta' : 'Control'] })
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('Garden plan')

  // An unresolved link offers to create its note.
  await page
    .getByRole('button', { name: 'Weekend', exact: true })
    .first()
    .click()
  const missing = page.locator('.cm-wikilink-missing', { hasText: 'Seed list' })
  await missing.hover()
  await page
    .locator('.cm-link-card')
    .getByRole('button', { name: /Create “Seed list”/ })
    .click()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('Seed list')
})

test('the note graph shows linked notes and opens one', async ({ page }) => {
  await startNote(page, 'Alpha')
  await page.keyboard.type('See [[Beta]].')
  await startNote(page, 'Beta')
  await page.keyboard.type('Back to [[Alpha]].')
  await page.getByRole('button', { name: 'Open note graph' }).click()
  const graph = page.getByRole('dialog')
  await expect(graph).toBeVisible()
  await expect(graph.locator('canvas')).toBeVisible()
  await graph.getByRole('button', { name: /List/ }).first().click()
  await graph
    .getByRole('button', { name: /^Alpha/ })
    .first()
    .click()
  await expect(graph).toBeHidden()
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('Alpha')
})

test('zen levels hide toolbars until an edge is reached, and Escape leaves zen', async ({
  page,
}) => {
  await startNote(page, 'Quiet')
  await page.getByRole('button', { name: 'Choose zen mode level' }).click()
  await page.getByRole('menuitemradio', { name: /Hide toolbars/ }).click()
  const toolbar = page.locator('.app-toolbar')
  await expect(page.locator('.app-shell')).toHaveClass(/zen-chrome/u)
  await expect(toolbar).toHaveCSS('opacity', '0')
  await expect(page.locator('.note-sidebar')).toBeHidden()
  await page.mouse.move(600, 3)
  await expect(toolbar).toHaveCSS('opacity', '1')
  await page.mouse.move(600, 450)
  await expect(toolbar).toHaveCSS('opacity', '0', { timeout: 3_000 })
  await noteEditor(page).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.app-shell')).not.toHaveClass(/zen/u)
  await expect(toolbar).toHaveCSS('opacity', '1')
  // The keyboard shortcut uses the saved level.
  await page.keyboard.press(`${mod}+Shift+f`)
  await expect(page.locator('.app-shell')).toHaveClass(/zen-chrome/u)
})

test('typing stays responsive in a long note with lists and tables', async ({
  page,
}) => {
  await startNote(page, 'Long note')
  const block = [
    '## Section',
    '- item one',
    '- item two',
    '  - nested',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    'A paragraph with **bold** and a [[Link]].',
    '',
  ].join('\n')
  const content = Array.from({ length: 400 }, () => block).join('\n')
  await noteEditor(page).evaluate((element, text) => {
    const data = new DataTransfer()
    data.setData('text/plain', text)
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      })
    )
  }, content)
  await expect(page.locator('.cm-lp-table').first()).toBeVisible()
  const timings = await page.evaluate(async () => {
    const editor = document.querySelector<HTMLElement>('.cm-content')!
    editor.focus()
    const samples: number[] = []
    for (let index = 0; index < 60; index++) {
      const started = performance.now()
      document.execCommand('insertText', false, 'x')
      await new Promise(resolve =>
        requestAnimationFrame(() => resolve(undefined))
      )
      samples.push(performance.now() - started)
    }
    samples.sort((a, b) => a - b)
    return { median: samples[30]!, p95: samples[57]! }
  })
  expect(timings.median).toBeLessThan(40)
  expect(timings.p95).toBeLessThan(120)
})

test('writing aids: format bar, smart typography, outline and linked-from', async ({ page }) => {
  await startNote(page, 'Target')
  await page.keyboard.type('The destination note.')
  await startNote(page, 'Aids')
  await page.keyboard.type('# Start\nIt works--mostly...\n\n## Middle\nSee [[Target]] here.\n\n## End\nLast words')
  await savedMarkdown(page, /It works—mostly…/u)
  // Select a word: the format bar appears and wraps it.
  await page.keyboard.press('Shift+Home')
  const bar = page.locator('.cm-format-bar')
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: 'Bold' }).click()
  await savedMarkdown(page, /\*\*Last words\*\*/u)
  // The outline lists the headings and jumps to one.
  const outline = page.getByRole('navigation', { name: 'Outline' })
  await expect(outline.getByRole('button')).toHaveCount(3)
  await outline.hover()
  await outline.getByRole('button', { name: 'Middle' }).click()
  await expect(outline.getByRole('button', { name: 'Middle' })).toHaveAttribute('aria-current', 'location')
  // The linked note shows where it is linked from.
  await page.getByRole('button', { name: 'Target', exact: true }).first().click()
  const linked = page.getByRole('region', { name: 'Linked from' })
  await expect(linked).toContainText('Aids')
  await linked.getByRole('button', { name: 'Aids' }).click()
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Aids')
})

test('the command palette opens notes, jumps to headings and runs actions', async ({ page }) => {
  await startNote(page, 'Recipes')
  await page.keyboard.type('Bread and soup.')
  await startNote(page, 'Palette')
  await page.keyboard.type('# Top\nFirst part.\n\n## Lower\nSecond part.')
  await savedMarkdown(page, /Second part\./u)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search notes, headings and actions' })
  // Open another note.
  await page.keyboard.press('ControlOrMeta+p')
  await expect(search).toBeFocused()
  await search.fill('recip')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Recipes')
  // Jump to a heading in the current note.
  await page.getByRole('button', { name: 'Palette', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Palette')
  await page.keyboard.press('ControlOrMeta+p')
  await search.fill('#lower')
  await expect(palette.getByRole('option', { name: /Lower/u })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(noteEditor(page)).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.type(' floor')
  await savedMarkdown(page, /## Lower floor\n/u)
  // Run an action: open a preference pane.
  await page.keyboard.press('ControlOrMeta+p')
  await search.fill('>dictation pref')
  await page.keyboard.press('Enter')
  const preferences = page.getByRole('dialog', { name: 'Make yourself at home' })
  await expect(preferences.getByRole('heading', { name: 'Dictation', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(preferences).toBeHidden()
  // Escape closes the palette and keeps the note.
  await page.keyboard.press('ControlOrMeta+p')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Note title', exact: true })).toHaveValue('Palette')
})

test('a new note title starts empty; a title from the first line is replaced on click', async ({ page }) => {
  await startNote(page)
  const title = page.getByRole('textbox', { name: 'Note title', exact: true })
  await expect(title).toHaveValue('')
  await expect(title).toHaveAttribute('placeholder', 'Untitled')
  await page.keyboard.type('Morning pages\nA few lines.')
  await expect(title).toHaveValue('Morning pages')
  await title.click()
  await page.keyboard.type('Evening pages')
  await expect(title).toHaveValue('Evening pages')
  await noteEditor(page).click()
  await page.keyboard.type(' More.')
  await expect(title).toHaveValue('Evening pages')
})
