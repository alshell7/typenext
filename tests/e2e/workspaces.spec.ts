import { expect, test, type Page } from '@playwright/test'
import { noteEditor, startNote } from './support/notes'

async function fresh(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
}

const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: 'Notebook' })
const switcher = (page: Page) =>
  page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ })

async function createWorkspace(page: Page, name: string, shared = false) {
  await switcher(page).click()
  await page
    .getByRole('button', {
      name: shared ? 'New shared workspace' : 'New workspace',
      exact: true,
    })
    .click()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
}

async function switchTo(page: Page, name: string) {
  await switcher(page).click()
  await page
    .getByRole('menuitemradio', { name: new RegExp(`^${name}`) })
    .click()
  await expect(switcher(page)).toHaveAccessibleName(
    `Workspace: ${name}. Switch workspace`
  )
}

test.beforeEach(async ({ page }) => {
  await fresh(page)
})

test('workspaces keep their own notes and tabs, and switch instantly', async ({
  page,
}) => {
  await startNote(page, 'Diary')
  await page.keyboard.type('Personal thoughts.')
  await expect(switcher(page)).toHaveAccessibleName(
    'Workspace: Personal. Switch workspace'
  )
  await expect(switcher(page)).toContainText('Local by default')

  await createWorkspace(page, 'Work')
  // A new workspace opens empty, on the welcome page.
  await expect(switcher(page)).toHaveAccessibleName(
    'Workspace: Work. Switch workspace'
  )
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(0)
  await startNote(page, 'Quarterly plan')
  await page.keyboard.type('Work goals.')
  await expect(page.locator('.breadcrumb')).toContainText('Work')

  await switchTo(page, 'Personal')
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('Diary')
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(1)
  await expect(
    page.getByRole('navigation', { name: 'Open notes' })
  ).not.toContainText('Quarterly plan')
  // The keyboard switches in the switcher's order, and the choice survives a reload.
  await page.keyboard.press('ControlOrMeta+Alt+2')
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('Quarterly plan')
  await page.reload()
  await expect(switcher(page)).toHaveAccessibleName(
    'Workspace: Work. Switch workspace'
  )
  await expect(
    page.getByRole('textbox', { name: 'Note title', exact: true })
  ).toHaveValue('Quarterly plan')
})

test('a shared workspace appears inside every other workspace', async ({
  page,
}) => {
  await startNote(page, 'Diary')
  await createWorkspace(page, 'Team handbook', true)
  // Creating a shared workspace keeps you where you are.
  await expect(switcher(page)).toHaveAccessibleName(
    'Workspace: Personal. Switch workspace'
  )
  await sidebar(page)
    .getByRole('button', { name: 'New note in Team handbook' })
    .click()
  await expect(noteEditor(page)).toBeFocused()
  await page.keyboard.type('House rules')
  const section = sidebar(page).locator('.space-section', {
    hasText: 'Team handbook',
  })
  await expect(section.locator('.note-list-item')).toContainText('House rules')
  await expect(page.locator('.breadcrumb')).toContainText('Team handbook')

  await createWorkspace(page, 'Work')
  await expect(section.locator('.note-list-item')).toContainText('House rules')
  // Collapsing the section hides its notes.
  await section
    .getByRole('button', { name: /Team handbook/ })
    .first()
    .click()
  await expect(section.locator('.note-list-item')).toHaveCount(0)
})

test('notes move between workspaces, and a removed workspace hands its notes on', async ({
  page,
}) => {
  await startNote(page, 'Keep here')
  await startNote(page, 'Move me')
  await createWorkspace(page, 'Work')
  await switchTo(page, 'Personal')
  await sidebar(page)
    .getByRole('button', { name: 'Actions for Move me' })
    .click()
  await page.getByRole('menuitem', { name: 'Move to workspace…' }).click()
  await page.getByRole('menuitemradio', { name: 'Work' }).click()
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(1)
  await expect(
    page.getByRole('navigation', { name: 'Open notes' })
  ).not.toContainText('Move me')
  await switchTo(page, 'Work')
  await expect(sidebar(page).locator('.note-list-item')).toContainText(
    'Move me'
  )

  // Remove Work; its note moves to Personal.
  await switcher(page).click()
  await page.getByRole('button', { name: 'Manage workspaces' }).click()
  const manager = page.getByRole('dialog', { name: 'Workspaces' })
  await manager.getByRole('option', { name: /Work/ }).click()
  await manager.getByRole('button', { name: /Remove workspace/ }).click()
  await expect(manager.getByLabel('What happens to its notes')).toHaveValue(
    /.+/u
  )
  await manager.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(switcher(page)).toHaveAccessibleName(
    'Workspace: Personal. Switch workspace'
  )
  await expect(sidebar(page).locator('.note-list-item')).toHaveCount(2)
})

test('a workspace can be renamed, recoloured and shared from the manager', async ({
  page,
}) => {
  await startNote(page, 'Anything')
  await createWorkspace(page, 'Studio')
  await switcher(page).click()
  await page.getByRole('button', { name: 'Manage workspaces' }).click()
  const manager = page.getByRole('dialog', { name: 'Workspaces' })
  const name = manager.getByRole('textbox', { name: 'Workspace name' })
  await name.fill('Design studio')
  await name.press('Enter')
  await manager.getByRole('button', { name: 'Plum', exact: true }).click()
  await manager.getByRole('switch').check()
  await page.keyboard.press('Escape')
  await expect(switcher(page)).toHaveAccessibleName(
    'Workspace: Design studio. Switch workspace'
  )
  await expect(switcher(page).locator('.space-avatar.org-plum')).toBeVisible()
  await switcher(page).click()
  await expect(page.getByRole('menu', { name: 'Workspaces' })).toContainText(
    'Shared with every workspace'
  )
})

test('contexts choose the workspaces they belong to', async ({ page }) => {
  await startNote(page, 'Draft')
  await createWorkspace(page, 'Work')
  await switchTo(page, 'Personal')
  await sidebar(page)
    .getByRole('button', { name: /^Contexts/ })
    .click()
  const library = page.getByRole('dialog', { name: 'Contexts' })
  await library
    .getByRole('button', { name: 'New context', exact: true })
    .click()
  await library.getByLabel('Context name', { exact: true }).fill('Style guide')
  await library
    .getByRole('button', { name: 'Create context', exact: true })
    .click()
  const share = library.getByRole('group', {
    name: 'Workspaces that can use this context',
  })
  await expect(share.getByRole('button', { name: 'Personal' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(share.getByRole('button', { name: 'Work' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await page.keyboard.press('Escape')
  await switchTo(page, 'Work')
  await expect(
    sidebar(page).getByRole('button', { name: /^Contexts/ })
  ).toContainText('0')
  await switchTo(page, 'Personal')
  await sidebar(page)
    .getByRole('button', { name: /^Contexts/ })
    .click()
  await share.getByRole('button', { name: 'Work' }).click()
  await page.keyboard.press('Escape')
  await switchTo(page, 'Work')
  await expect(
    sidebar(page).getByRole('button', { name: /^Contexts/ })
  ).toContainText('1')
})
