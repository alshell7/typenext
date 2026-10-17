import { expect, test, type Page } from '@playwright/test'
import { noteEditor, savedMarkdown, startNote } from './support/notes'

async function fresh(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    indexedDB.deleteDatabase('typenext-revisions')
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
}

async function saved(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('typenext.workspace.v1')
    return raw
      ? (JSON.parse(raw) as {
          notes: {
            id: string
            title: string
            folderId?: string
            tags?: string[]
            contextFolderIds?: string[]
          }[]
          folders?: { id: string; name: string; parentId?: string }[]
          tags?: { id: string; name: string; color: string }[]
        })
      : null
  })
}

async function openPreferences(page: Page, pane: string) {
  await page.keyboard.press('ControlOrMeta+,')
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}

const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: 'Notebook' })

test.beforeEach(async ({ page }) => {
  await fresh(page)
})

test('folders: create, rename, fill, move, collapse and remove without losing notes', async ({
  page,
}) => {
  await startNote(page, 'Loose note')
  await sidebar(page)
    .getByRole('button', { name: 'New folder', exact: true })
    .click()
  const name = sidebar(page).getByRole('textbox', { name: 'Folder name' })
  await expect(name).toBeFocused()
  await name.fill('Retreat')
  await name.press('Enter')
  const folder = sidebar(page).getByRole('button', { name: /^Retreat/ })
  await expect(folder).toHaveAttribute('aria-expanded', 'true')

  await sidebar(page)
    .getByRole('button', { name: 'New note in Retreat' })
    .click()
  await expect(noteEditor(page)).toBeFocused()
  await page.keyboard.type('Arrival day')
  await expect(page.locator('.breadcrumb')).toContainText('Retreat')
  await expect(page.locator('.org-strip-folder')).toHaveText('Retreat')
  await expect
    .poll(async () => {
      const value = await saved(page)
      const retreat = value?.folders?.find(item => item.name === 'Retreat')
      return (
        value?.notes.find(item => item.title === 'Arrival day')?.folderId ===
        retreat?.id
      )
    })
    .toBe(true)

  // Move by menu, from the note's folder chip.
  await page.locator('.org-strip-folder').click()
  await page.getByRole('menuitemradio', { name: 'Top level' }).click()
  await expect(page.locator('.org-strip-folder')).toHaveText('No folder')

  // Move by drag and drop onto the folder.
  const row = sidebar(page).locator('.note-list-item', {
    hasText: 'Arrival day',
  })
  await row.dragTo(
    sidebar(page).locator('.org-folder-row', { hasText: 'Retreat' })
  )
  await expect(page.locator('.org-strip-folder')).toHaveText('Retreat')
  await expect(folder).toContainText('1')

  // Collapse hides the folder's notes and survives a reload.
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await expect(
    sidebar(page).locator('.note-list-item', { hasText: 'Arrival day' })
  ).toHaveCount(0)
  await page.reload()
  await expect(
    sidebar(page).getByRole('button', { name: /^Retreat/ })
  ).toHaveAttribute('aria-expanded', 'false')
  await sidebar(page)
    .getByRole('button', { name: /^Retreat/ })
    .click()

  // Rename and recolour from the folder menu.
  await sidebar(page)
    .getByRole('button', { name: 'Actions for folder Retreat' })
    .click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const rename = sidebar(page).getByRole('textbox', { name: 'Folder name' })
  await rename.fill('Bramble retreat')
  await rename.press('Enter')
  await sidebar(page)
    .getByRole('button', { name: 'Actions for folder Bramble retreat' })
    .click()
  await page.getByRole('button', { name: 'Rose', exact: true }).click()
  await expect(sidebar(page).locator('.org-folder-row.org-rose')).toBeVisible()

  // Removing a folder keeps its notes.
  await sidebar(page)
    .getByRole('button', { name: 'Actions for folder Bramble retreat' })
    .click()
  await page.getByRole('menuitem', { name: /Remove folder/ }).click()
  await expect(sidebar(page).locator('.org-folder-row')).toHaveCount(0)
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(2)
  await expect(
    page.getByRole('status').filter({ hasText: 'Its notes moved' })
  ).toBeVisible()
})

test('folders nest, and a folder cannot move inside itself', async ({
  page,
}) => {
  await startNote(page, 'Deep')
  await sidebar(page)
    .getByRole('button', { name: 'New folder', exact: true })
    .click()
  await sidebar(page)
    .getByRole('textbox', { name: 'Folder name' })
    .fill('Projects')
  await page.keyboard.press('Enter')
  await sidebar(page)
    .getByRole('button', { name: 'Actions for folder Projects' })
    .click()
  await page.getByRole('menuitem', { name: 'New folder inside' }).click()
  await sidebar(page)
    .getByRole('textbox', { name: 'Folder name' })
    .fill('Garden')
  await page.keyboard.press('Enter')
  const garden = sidebar(page).locator('.org-folder-row', { hasText: 'Garden' })
  await expect(garden).toHaveAttribute('style', /--depth: 1/u)
  await sidebar(page)
    .getByRole('button', { name: 'Actions for folder Projects' })
    .click()
  await page.getByRole('menuitem', { name: 'Move to…' }).click()
  // Projects itself and Garden inside it are not offered.
  await expect(page.getByRole('menuitem', { name: /Garden/ })).toHaveCount(0)
  await expect(
    page.getByRole('menuitemradio', { name: 'Top level' })
  ).toBeVisible()
  await page.keyboard.press('Escape')
})

test('tags: create, attach, filter, rename to merge and delete', async ({
  page,
}) => {
  await startNote(page, 'Plan')
  await page.keyboard.type('Plan the week.')
  await page.getByRole('button', { name: 'Add a tag' }).click()
  const find = page.getByRole('combobox', { name: 'Find or create a tag' })
  await expect(find).toBeFocused()
  await page.keyboard.type('Draft')
  await expect(page.getByRole('option', { name: /Create Draft/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.type('#ideas')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  const strip = page.locator('.org-strip')
  await expect(strip.locator('.org-chip')).toHaveText(['Draft', 'ideas'])
  await expect(sidebar(page).locator('.org-mini-tag')).toHaveText([
    'Draft',
    'ideas',
  ])

  await startNote(page, 'Other')
  await page.keyboard.type('Unrelated.')
  await page.getByRole('button', { name: 'Add a tag' }).click()
  await page.keyboard.type('dra')
  // An existing tag comes first; Enter attaches it rather than a new one.
  await expect(page.getByRole('option').first()).toContainText('Draft')
  await expect(page.getByRole('option', { name: /Create dra/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.org-chip')).toHaveText('Draft')
  await page.keyboard.press('Escape')

  // Filter the sidebar by a tag.
  await sidebar(page).locator('.org-filter', { hasText: 'ideas' }).click()
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(1)
  await expect(sidebar(page).locator('.note-list-item')).toContainText('Plan')
  await sidebar(page).getByRole('button', { name: 'Show all notes' }).click()
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(2)

  // Rename "ideas" to "draft": the two merge.
  await sidebar(page).getByRole('button', { name: 'Manage tags' }).click()
  const manager = page.getByRole('dialog', { name: 'Tags' })
  await manager.getByRole('button', { name: 'ideas', exact: true }).click()
  await manager.getByRole('textbox', { name: 'Rename ideas' }).fill('draft')
  await expect(manager.getByRole('button', { name: /Merge/ })).toBeVisible()
  await manager.getByRole('button', { name: /Merge/ }).click()
  await expect(manager.locator('.org-manager-row')).toHaveCount(1)
  await expect(manager).toContainText('2 notes')
  await manager.getByRole('button', { name: 'Iris' }).click()
  await manager.getByRole('button', { name: 'Delete tag Draft' }).click()
  await manager.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(manager).toContainText('No tags yet')
  await page.keyboard.press('Escape')
  await expect(page.locator('.org-chip')).toHaveCount(0)
  await expect
    .poll(async () => {
      const value = await saved(page)
      return Boolean(
        value && !value.tags?.length && value.notes.every(note => !note.tags)
      )
    })
    .toBe(true)
})

test('tags and folders show in search and survive a reload', async ({
  page,
}) => {
  await startNote(page, 'Searchable')
  await page.keyboard.type('Body text.')
  await page.getByRole('button', { name: 'Add a tag' }).click()
  await page.keyboard.type('garden')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('.org-chip')).toHaveText('garden')
  await sidebar(page)
    .getByRole('textbox', { name: 'Search notes' })
    .fill('garden')
  await expect(sidebar(page).locator('.note-list-item')).toContainText(
    'Searchable'
  )
})

test('a folder can be live context for a note', async ({ page }) => {
  await startNote(page, 'Essay')
  await sidebar(page)
    .getByRole('button', { name: 'New folder', exact: true })
    .click()
  await sidebar(page)
    .getByRole('textbox', { name: 'Folder name' })
    .fill('Research')
  await page.keyboard.press('Enter')
  await sidebar(page)
    .getByRole('button', { name: 'New note in Research' })
    .click()
  await page.keyboard.type('Survey results: tea wins.')
  await sidebar(page).locator('.note-list-item', { hasText: 'Essay' }).click()
  await page.getByRole('button', { name: 'Context', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Note context' })
  await panel.getByRole('button', { name: 'Use a folder' }).click()
  await page
    .getByRole('button', { name: 'Use folder Research as context' })
    .click()
  const attached = panel.getByRole('list', { name: 'Attached folders' })
  await expect(attached).toContainText('Research')
  await expect(attached).toContainText('1 note · stays up to date')
  // A note added later joins.
  await sidebar(page)
    .getByRole('button', { name: 'New note in Research' })
    .click()
  await page.keyboard.type('Interview notes.')
  await sidebar(page).locator('.note-list-item', { hasText: 'Essay' }).click()
  // The context panel stays open from note to note.
  await expect(
    page.getByRole('list', { name: 'Attached folders' })
  ).toContainText('2 notes')
  await page.getByRole('button', { name: 'Detach folder Research' }).click()
  await expect(
    page.getByRole('list', { name: 'Attached folders' })
  ).toHaveCount(0)
})

test('revisions: save, compare, bring back one part, restore and undo', async ({
  page,
}) => {
  await startNote(page, 'Versions')
  const dialog = await openPreferences(page, 'History')
  await dialog
    .getByRole('switch', { name: /^Keep revisions of my notes/ })
    .check()
  await dialog.getByRole('radio', { name: 'Manual', exact: true }).click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'History', exact: true })
  ).toBeVisible()

  await noteEditor(page).click()
  await page.keyboard.type('First line.')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Second line.')
  await savedMarkdown(page, 'First line.\nSecond line.')
  await page.keyboard.press('ControlOrMeta+Alt+s')
  await expect(
    page.getByRole('status').filter({ hasText: 'Version saved.' })
  ).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.type(' Sharper.')
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Third line.')
  await savedMarkdown(page, 'First line. Sharper.\nSecond line.\nThird line.')

  await page.keyboard.press('ControlOrMeta+Alt+h')
  const history = page.getByRole('dialog', { name: 'History' })
  await expect(history).toBeVisible()
  const versions = history.getByRole('listbox', { name: 'Versions' })
  await expect(versions.getByRole('option')).toHaveCount(2)
  await expect(
    history.getByRole('heading', { name: 'First version' })
  ).toBeVisible()
  const hunks = history.locator('.history-hunk')
  await expect(hunks).toHaveCount(2)
  await expect(hunks.first().locator('ins')).toHaveText(' Sharper.')
  // Bring back only the first part: the third line stays.
  await hunks.first().getByRole('checkbox').check()
  await history.getByRole('button', { name: /Bring back 1 part/ }).click()
  await savedMarkdown(page, 'First line.\nSecond line.\nThird line.')
  await expect(history).toContainText('safety copy')
  // The merge and the safety copy are in the timeline.
  await expect(versions.getByRole('option')).toHaveCount(4)

  // Restore the first version entirely, then undo it in the editor.
  await versions.getByRole('option', { name: /First version/ }).click()
  await history.getByRole('button', { name: 'Restore this version' }).click()
  await savedMarkdown(page, /^First line\.\nSecond line\.$/u)
  await page.keyboard.press('Escape')
  await noteEditor(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await savedMarkdown(page, 'First line.\nSecond line.\nThird line.')
})

test('revisions: automatic versions follow the threshold, and versions can be named and pinned', async ({
  page,
}) => {
  await startNote(page, 'Automatic')
  const dialog = await openPreferences(page, 'History')
  await dialog
    .getByRole('switch', { name: /^Keep revisions of my notes/ })
    .check()
  await dialog.getByRole('slider', { name: 'Changed text' }).fill('20')
  await dialog
    .getByRole('slider', { name: 'Time between automatic versions' })
    .fill('0')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await noteEditor(page).click()
  await page.keyboard.type('Short.')
  // Below the threshold: nothing is kept after the pause.
  await page.waitForTimeout(4_600)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'History' })
  await expect(history).toContainText('No versions yet')
  await page.keyboard.press('Escape')
  await noteEditor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' A longer sentence passes the threshold.')
  await page.waitForTimeout(4_800)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(
    history.getByRole('listbox', { name: 'Versions' }).getByRole('option')
  ).toHaveCount(2)
  await history.getByRole('button', { name: 'Name this version' }).click()
  await history
    .getByRole('textbox', { name: 'Version name' })
    .fill('Opening draft')
  await history.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    history.getByRole('heading', { name: 'Opening draft' })
  ).toBeVisible()
  await history.getByRole('button', { name: 'Pin version' }).click()
  await expect(
    history.getByRole('button', { name: 'Unpin version' })
  ).toBeVisible()
  // The scrubber moves between versions.
  const scrubber = history.getByRole('slider', {
    name: 'Move through versions',
  })
  await scrubber.focus()
  await page.keyboard.press('End')
  await expect(
    history.getByRole('heading', { name: 'Your note as it is' })
  ).toBeVisible()
})

test('the Updates pane keeps clear space between its groups', async ({
  page,
}) => {
  await startNote(page, 'Updates')
  await openPreferences(page, 'Writing')
  // Show the desktop pane in the browser.
  await page.evaluate(() => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: async (command: string) =>
        command.includes('version') ? '0.3.0' : null,
      transformCallback: () => 0,
    }
  })
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: 'Updates', exact: true }).click()
  await expect(
    dialog.getByText('Check for updates automatically')
  ).toBeVisible()
  const gaps = await page.evaluate(() => {
    const group = [...document.querySelectorAll('.pref-group')].at(-1)!
    const callout = document.querySelector('.pref-callout')!
    const sections = [...document.querySelectorAll('.pref-section')]
    return {
      callout:
        callout.getBoundingClientRect().top -
        group.getBoundingClientRect().bottom,
      sections:
        sections[1]!.getBoundingClientRect().top -
        sections[0]!.getBoundingClientRect().bottom,
    }
  })
  expect(gaps.callout).toBeGreaterThanOrEqual(10)
  expect(gaps.sections).toBeGreaterThanOrEqual(20)
})
