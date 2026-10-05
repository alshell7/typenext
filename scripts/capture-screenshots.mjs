import { chromium } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'

const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
  (process.platform === 'win32' &&
  existsSync(
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  )
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined)
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  colorScheme: 'light',
})
const page = await context.newPage()
const settled = async target => {
  await target.evaluate(() => document.fonts.ready)
  // Let React publish its new unsaved state before awaiting the next save.
  await target.waitForTimeout(750)
  await target
    .getByText('Saved locally', { exact: true })
    .waitFor({ state: 'visible' })
  await target.waitForTimeout(500)
}
mkdirSync('docs/screenshots', { recursive: true })
mkdirSync('artifacts/ui', { recursive: true })
try {
  await page.goto('http://127.0.0.1:1420/')
  await page.getByRole('button', { name: 'Start a note' }).click()
  await page.getByLabel('Title', { exact: true }).fill('On paying attention')
  await page
    .getByLabel('Context for suggestions')
    .fill(
      'A reflective essay about making room for thoughtful work. Keep the voice personal, clear, and unhurried.'
    )
  await page.getByRole('button', { name: 'Create note' }).click()
  await page.getByRole('button', { name: 'Context', exact: true }).click()
  await page
    .getByLabel('Objective', { exact: true })
    .fill('Find a gentler relationship with the tools we use to think.')
  await page.getByLabel('Attach reference files').setInputFiles({
    name: 'Field notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Attention, not interruption\n\nThe best tools leave room for attention and let the work find its own rhythm. They make the next action obvious, then get out of the way.\n\nA useful suggestion is small enough to consider and easy enough to ignore. The writer keeps the final say.\n\nWriting often begins before we know exactly what we mean. It helps to have a quiet page and a little patience.'
    ),
  })
  await page.getByLabel('Attach reference files').setInputFiles({
    name: 'Earlier draft.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'An earlier direction for this essay. Keep it close for reference, but leave its language out of suggestions.'
    ),
  })
  await page
    .getByRole('checkbox', {
      name: 'Use Earlier draft.txt as context',
      exact: true,
    })
    .uncheck()
  const editor = page.getByRole('textbox', { name: 'Note content' })
  await editor.fill(
    'Some mornings, the work begins with making a little space. A clear desk. A quiet page. Enough time to follow a thought without asking it to become something useful straight away.\n\n## A quieter kind of tool\n\nI keep returning to the same question: what would it feel like if our tools helped us stay with an idea, instead of pulling us away from it?\n\nThere is a difference between being offered a thought and being given room to finish your own. I want the second kind of help. Something small, at the moment I need it.\n\nThe best tools leave room for'
  )
  await editor.press('Control+End')
  await editor.press('Space')
  await page.locator('.cm-ghost-suggestion').waitFor({ state: 'visible' })
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/writing-light.png' })
  await page.getByRole('button', { name: 'Toggle light and dark mode' }).click()
  await editor.focus()
  await editor.press('Backspace')
  await page.locator('.cm-ghost-suggestion').waitFor({ state: 'visible' })
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/writing-dark.png' })
  await page.getByRole('button', { name: 'Preview Field notes.md' }).click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/context-preview.png' })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const paletteDialog = page.getByRole('dialog', {
    name: 'Make yourself at home',
  })
  await paletteDialog.getByRole('tab', { name: 'Writing', exact: true }).click()
  await paletteDialog.locator('.palette-picker').scrollIntoViewIfNeeded()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/palette-presets.png' })
  await paletteDialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle light and dark mode' }).click()
  await page.getByRole('button', { name: 'Enter focus mode' }).click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/focus.png' })
  await page
    .getByRole('button', { name: 'Leave focus mode', exact: true })
    .click()
  await page.getByRole('button', { name: /^New note/ }).click()
  await page.getByLabel('Title', { exact: true }).fill('Small observations')
  await page.getByRole('button', { name: 'Create note', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Note content', exact: true })
    .fill(
      'Useful tools make room for attention. The writer stays with the thought, and chooses when help is welcome.'
    )
  await page
    .getByRole('navigation', { name: 'Open notes', exact: true })
    .getByRole('button', { name: 'On paying attention', exact: true })
    .click()
  await page.getByRole('button', { name: 'Use a note', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Use a note as context', exact: true })
    .getByLabel('Search notes', { exact: true })
    .fill('small')
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/note-picker.png' })
  await page
    .getByRole('button', {
      name: 'Use Small observations as context',
      exact: true,
    })
    .click()
  await page
    .getByRole('button', { name: 'Preview Small observations', exact: true })
    .click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/linked-note.png' })
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
  })
  const mobile = await mobileContext.newPage()
  await mobile.goto('http://127.0.0.1:1420/')
  await mobile.getByRole('button', { name: 'Start a note' }).click()
  await mobile.getByLabel('Title', { exact: true }).fill('A small beginning')
  await mobile.getByRole('button', { name: 'Create note' }).click()
  await mobile
    .getByRole('textbox', { name: 'Note content' })
    .fill(
      'A place to put a thought before it slips away.\n\nThere is no need to know where it is going yet.'
    )
  await settled(mobile)
  await mobile.screenshot({ path: 'docs/screenshots/writing-narrow.png' })
  await mobile
    .getByRole('button', { name: 'Show note sidebar', exact: true })
    .click()
  await mobile.getByRole('button', { name: 'Preferences', exact: true }).click()
  const mobilePreferences = mobile.getByRole('dialog', {
    name: 'Make yourself at home',
  })
  await mobilePreferences
    .getByRole('group', { name: 'Dark palette', exact: true })
    .getByText('Custom', { exact: true })
    .click()
  await mobilePreferences.locator('.palette-custom').scrollIntoViewIfNeeded()
  await settled(mobile)
  await mobile.screenshot({ path: 'docs/screenshots/palette-narrow.png' })
  await mobileContext.close()
  for (const [name, viewport] of [
    ['suggestions-dark', { width: 1440, height: 960 }],
    ['suggestions-narrow', { width: 390, height: 844 }],
  ]) {
    const suggestionContext = await browser.newContext({
      viewport,
      colorScheme: 'dark',
    })
    const suggestionPage = await suggestionContext.newPage()
    await suggestionPage.goto('http://127.0.0.1:1420/')
    await suggestionPage.getByRole('button', { name: 'Start a note' }).click()
    await suggestionPage
      .getByLabel('Title', { exact: true })
      .fill('A slower morning')
    await suggestionPage.getByRole('button', { name: 'Create note' }).click()
    const writing = suggestionPage.getByRole('textbox', {
      name: 'Note content',
    })
    await writing.fill(
      'Some mornings, it helps to leave a little room for a thought to find its shape.\n\nI want to'
    )
    await writing.press('Control+End')
    await writing.press('Control+Space')
    await suggestionPage
      .getByRole('listbox', { name: 'Suggestions', exact: true })
      .waitFor()
    await settled(suggestionPage)
    await suggestionPage.screenshot({ path: `docs/screenshots/${name}.png` })
    if (name === 'suggestions-narrow') {
      await writing.press('Escape')
      await writing.press('Space')
      await suggestionPage.locator('.cm-ghost-suggestion').waitFor()
      await settled(suggestionPage)
      await suggestionPage.screenshot({
        path: 'artifacts/ui/suggestions-inline-narrow.png',
      })
    }
    await suggestionContext.close()
  }
  console.log(
    'Saved real app screenshots using synthetic writing in docs/screenshots.'
  )
} finally {
  await context.close()
  await browser.close()
}
