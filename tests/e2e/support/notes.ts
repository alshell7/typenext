import { expect, type Page } from '@playwright/test'

export function noteEditor(page: Page) {
  return page.getByRole('textbox', { name: 'Note content', exact: true })
}

/** Open the context panel with its Intent section expanded. */
export async function openIntent(page: Page) {
  const panel = page.getByRole('complementary', {
    name: 'Note context',
    exact: true,
  })
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: /^Context(?: \d+)?$/ }).click()
  await expect(panel).toBeVisible()
  const intent = panel.getByRole('button', { name: 'Intent', exact: true })
  if (
    (await intent.count()) &&
    (await intent.getAttribute('aria-expanded')) === 'false'
  )
    await intent.click()
  return panel
}

/**
 * Notes start at once with the cursor in the page. A title and background
 * are optional and set afterwards, as a writer would.
 */
export async function startNote(page: Page, title = '', context = '') {
  const start = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await start.isVisible()) await start.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  await expect(noteEditor(page)).toBeFocused()
  if (title) {
    await page
      .getByRole('textbox', { name: 'Note title', exact: true })
      .fill(title)
    await expect(
      page.getByRole('textbox', { name: 'Note title', exact: true })
    ).toHaveValue(title)
  }
  if (context) {
    const panel = await openIntent(page)
    await panel.getByLabel('Background & voice', { exact: true }).fill(context)
    await page.getByRole('button', { name: 'Close context panel' }).click()
  }
  await noteEditor(page).click()
  return noteEditor(page)
}

/** The active note's Markdown, as saved in the browser notebook. */
export async function noteMarkdown(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('typenext.workspace.v1')
    if (!raw) return ''
    const workspace = JSON.parse(raw) as {
      activeNoteId: string | null
      notes: { id: string; content: string }[]
    }
    return (
      workspace.notes.find(note => note.id === workspace.activeNoteId)
        ?.content ?? ''
    )
  })
}

/** Wait for autosave, then return the active note's Markdown. */
export async function savedMarkdown(page: Page, expected: RegExp | string) {
  await expect
    .poll(() => noteMarkdown(page), { timeout: 5_000 })
    .toMatch(expected)
  return noteMarkdown(page)
}
