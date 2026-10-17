import { expect, test, type Page } from '@playwright/test'
import { noteEditor, savedMarkdown, startNote } from './support/notes'

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

test('find in a note highlights matches, counts them and moves with Enter', async ({
  page,
}) => {
  await startNote(page, 'Garden')
  await page.keyboard.type(
    'Rose by the gate. A rose by the wall. Roses everywhere.'
  )
  await page.keyboard.press('ControlOrMeta+f')
  const bar = page.getByRole('search', { name: 'Find in note' })
  const field = bar.getByRole('textbox', { name: 'Find in note' })
  await expect(field).toBeFocused()
  // Fast typing goes into the field, never into the note.
  await page.keyboard.type('rose')
  await expect(bar.getByRole('status')).toHaveText(/of 3/u)
  await expect(page.locator('.cm-find-match')).toHaveCount(3)
  await expect(page.locator('.cm-find-current')).toHaveCount(1)
  // The format bar stays away while a match is selected.
  await expect(page.locator('.cm-format-bar')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(bar.getByRole('status')).toHaveText(/^\d of 3$/u)
  await page.keyboard.press('Shift+Enter')
  await bar.getByRole('button', { name: 'Whole word' }).click()
  await expect(bar.getByRole('status')).toHaveText(/of 2/u)
  await bar.getByRole('button', { name: 'Match case' }).click()
  await expect(bar.getByRole('status')).toHaveText('1 of 1')
  await field.fill('tulip')
  await expect(bar.getByRole('status')).toHaveText('No results')
  await savedMarkdown(
    page,
    'Rose by the gate. A rose by the wall. Roses everywhere.'
  )
  // Escape closes the bar and returns to the writing.
  await page.keyboard.press('Escape')
  await expect(bar).toBeHidden()
  await expect(noteEditor(page)).toBeFocused()
  await expect(page.locator('.cm-find-match')).toHaveCount(0)
})

test('the selection seeds the search, and the bar stays in view while scrolling', async ({
  page,
}) => {
  await startNote(page, 'Long')
  for (let index = 0; index < 60; index++) {
    await page.keyboard.type(`Line ${index} with a lantern.`)
    await page.keyboard.press('Enter')
  }
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('ControlOrMeta+f')
  const bar = page.getByRole('search', { name: 'Find in note' })
  await expect(bar.getByRole('textbox', { name: 'Find in note' })).toHaveValue(
    'Line 0 with a lantern.'
  )
  await bar.getByRole('textbox', { name: 'Find in note' }).fill('lantern')
  await expect(bar.getByRole('status')).toHaveText(/of 60/u)
  // Jump to the last match: the bar is still on screen.
  await page.keyboard.press('Shift+Enter')
  await expect(bar.getByRole('status')).toHaveText('60 of 60')
  const box = await bar.boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeLessThan(300)
})

test('find and replace changes one match or all, and undo restores them', async ({
  page,
}) => {
  await startNote(page, 'Edits')
  await page.keyboard.type('The cat sat. The cat ran. The cat slept.')
  await page.keyboard.press('ControlOrMeta+Alt+f')
  const bar = page.getByRole('search', { name: 'Find in note' })
  await expect(bar.getByRole('textbox', { name: 'Find in note' })).toBeFocused()
  await page.keyboard.type('cat')
  await bar.getByRole('textbox', { name: 'Replace with' }).fill('dog')
  await bar.getByRole('button', { name: 'Replace', exact: true }).click()
  await savedMarkdown(
    page,
    /^The dog sat\. The cat ran\. The cat slept\.$|^The cat sat\. The dog ran\. The cat slept\.$/u
  )
  await bar.getByRole('button', { name: 'All', exact: true }).click()
  await expect(bar).toContainText('Replaced 2')
  await savedMarkdown(page, 'The dog sat. The dog ran. The dog slept.')
  await page.keyboard.press('Escape')
  await noteEditor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await savedMarkdown(page, /cat ran\. The cat slept\./u)
})

test('pattern replacement uses capture groups and shows a bad pattern calmly', async ({
  page,
}) => {
  await startNote(page, 'Dates')
  await page.keyboard.type('Due 2026-10-18, then 2026-11-02.')
  await page.keyboard.press('ControlOrMeta+Alt+f')
  const bar = page.getByRole('search', { name: 'Find in note' })
  await bar.getByRole('button', { name: 'Pattern' }).click()
  await bar.getByRole('textbox', { name: 'Find in note' }).fill('(')
  await expect(bar.getByRole('status')).toHaveText('Pattern not valid')
  await bar
    .getByRole('textbox', { name: 'Find in note' })
    .fill('(\\d{4})-(\\d{2})-(\\d{2})')
  await expect(bar.getByRole('status')).toHaveText(/of 2/u)
  const replace = bar.getByRole('textbox', { name: 'Replace with' })
  await replace.fill('$3.$2.$1')
  await replace.press('ControlOrMeta+Enter')
  await savedMarkdown(page, 'Due 18.10.2026, then 02.11.2026.')
})

test('a workspace can wear an icon chosen from the picker', async ({
  page,
}) => {
  await startNote(page, 'Anything')
  await page
    .getByRole('button', { name: /^Workspace: .*Switch workspace$/ })
    .click()
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  await page.keyboard.type('Novel draft')
  await page.keyboard.press('Enter')
  // A fitting icon is suggested from the name.
  const switcher = page.getByRole('button', { name: /^Workspace: Novel draft/ })
  await expect(switcher.locator('.space-avatar svg')).toBeVisible()
  await switcher.click()
  await page.getByRole('button', { name: 'Manage workspaces' }).click()
  const manager = page.getByRole('dialog', { name: 'Workspaces' })
  await manager.getByRole('button', { name: 'Choose an icon' }).click()
  const picker = page.getByRole('dialog', { name: 'Workspace icon' })
  await picker.getByRole('textbox', { name: 'Find an icon' }).fill('cat')
  await picker.getByRole('button', { name: 'Cat', exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(manager).toBeVisible()
  await manager.getByRole('button', { name: 'Choose an icon' }).click()
  await expect(
    picker.getByRole('button', { name: 'Cat', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await picker.getByRole('button', { name: /First letter/ }).click()
  await page.keyboard.press('Escape')
  await expect(switcher.locator('.space-avatar')).toHaveText('N')
})
