import { chromium } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
  await target.locator('.brand-mark').evaluateAll(async images => {
    await Promise.all(images.map(image => image.decode()))
  })
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
  await page
    .getByRole('button', { name: 'Manage contexts', exact: true })
    .click()
  const library = page.getByRole('dialog', { name: 'Contexts', exact: true })
  const createContext = async name => {
    await library
      .getByRole('button', { name: 'New context', exact: true })
      .click()
    await library.getByLabel('Context name', { exact: true }).fill(name)
    await library
      .getByRole('button', { name: 'Create context', exact: true })
      .click()
    await library
      .getByRole('checkbox', { name: `Use ${name} in this note`, exact: true })
      .check()
  }
  await createContext('Field research')
  await library
    .getByLabel('Add files to this context', { exact: true })
    .setInputFiles({
      name: 'Field notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '# Attention, not interruption\n\nThe best tools leave room for attention and let the work find its own rhythm. They make the next action obvious, then get out of the way.\n\nA useful suggestion is small enough to consider and easy enough to ignore. The writer keeps the final say.\n\nWriting often begins before we know exactly what we mean. It helps to have a quiet page and a little patience.'
      ),
    })
  await library
    .getByRole('button', { name: 'Preview Field notes.md', exact: true })
    .waitFor()
  await createContext('Voice & audience')
  await library
    .getByLabel('Add files to this context', { exact: true })
    .setInputFiles({
      name: 'A note on voice.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Write for people who want a little more room to think. Keep the voice personal, precise and unhurried. Let simple observations carry the thought.'
      ),
    })
  await library
    .getByRole('button', { name: 'Preview A note on voice.txt', exact: true })
    .waitFor()
  await library.getByRole('button', { name: 'Done', exact: true }).click()
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
  await page
    .getByRole('button', { name: 'Manage Field research', exact: true })
    .click()
  await library
    .getByRole('button', { name: 'Preview Field notes.md', exact: true })
    .click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/context-preview.png' })
  await library.getByRole('button', { name: 'Done', exact: true }).click()
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
  await page
    .getByRole('button', { name: 'Manage Field research', exact: true })
    .click()
  await library.getByRole('button', { name: 'Use a note', exact: true }).click()
  await library.getByLabel('Search notes', { exact: true }).fill('small')
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/note-picker.png' })
  await library
    .getByRole('button', {
      name: 'Add Small observations to Field research',
      exact: true,
    })
    .click()
  await library
    .getByRole('button', { name: 'Preview Small observations', exact: true })
    .click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/linked-note.png' })
  await library
    .getByRole('button', { name: 'Close source preview', exact: true })
    .click()
  const folder = path.resolve('artifacts/ui/context/Field research')
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    path.join(folder, 'Walking notes.md'),
    '# Walking notes\n\nA walk gives an unfinished thought a little room. The small details return when we leave enough space to notice them.'
  )
  writeFileSync(
    path.join(folder, 'Reading notes.txt'),
    'A quiet writing tool should make the next useful action easy to find, then leave the writer with the page.'
  )
  await library
    .getByLabel('Add folder to this context', { exact: true })
    .setInputFiles(folder)
  await library
    .getByRole('button', { name: 'Preview Walking notes.md', exact: true })
    .waitFor()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/context-library.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await library.locator('.context-library-content').evaluate(el => {
    el.scrollTop = 0
  })
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/context-library-narrow.png' })
  await library.getByRole('button', { name: 'Done', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/model-chooser.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/model-chooser-narrow.png' })
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  await page
    .getByRole('group', { name: 'Dark palette', exact: true })
    .getByText('Dark contrast', { exact: true })
    .click()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/contrast-presets.png' })
  await page
    .getByRole('tab', { name: 'Local suggestions', exact: true })
    .click()
  await page
    .getByRole('region', { name: 'Built-in offline model', exact: true })
    .scrollIntoViewIfNeeded()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/local-model-setup.png' })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page
    .getByRole('button', { name: 'Close context panel', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Dictate on this device', exact: true })
    .click()
  await page
    .getByRole('region', { name: 'Inline dictation', exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: 'Allow and refresh microphones', exact: true })
    .waitFor()
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/dictation-setup.png' })
  await page
    .getByRole('button', { name: 'Hide note sidebar', exact: true })
    .click()
  await page.setViewportSize({ width: 390, height: 844 })
  await settled(page)
  await page.screenshot({ path: 'docs/screenshots/dictation-setup-narrow.png' })
  await page
    .getByRole('button', { name: 'Hide dictation controls', exact: true })
    .click()
  await page.setViewportSize({ width: 1440, height: 960 })
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
