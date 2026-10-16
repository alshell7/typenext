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
  await expect(editor).toContainText('[[Garden plan]]')
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
