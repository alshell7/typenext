// Capture README screenshots of the current interface from the dev server.
//   npm run dev -- --host 127.0.0.1   (in another terminal)
//   node scripts/capture-feature-screenshots.mjs
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const base = process.env.TYPENEXT_URL ?? 'http://127.0.0.1:1420/'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
mkdirSync('docs/screenshots', { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  colorScheme: 'light',
  deviceScaleFactor: 1,
})
const page = await context.newPage()
const shot = async (name, target = page) => {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(450)
  await target.screenshot({ path: `docs/screenshots/${name}.png` })
  console.log(`docs/screenshots/${name}.png`)
}
const editor = () =>
  page.getByRole('textbox', { name: 'Note content', exact: true })
const newNote = async (title, text) => {
  const start = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await start.isVisible()) await start.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  await page
    .getByRole('textbox', { name: 'Note title', exact: true })
    .fill(title)
  await editor().click()
  if (text) await page.keyboard.insertText(text)
}

try {
  await page.goto(base)
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  // Linked notes for the graph and link cards.
  await newNote(
    'Garden plan',
    'Roses go by the south wall. Compost in spring. See [[Seed list]] and [[Watering]].'
  )
  await newNote(
    'Watering',
    'Water early. Deep soaks twice a week. Back to [[Garden plan]].'
  )
  await newNote(
    'Seed list',
    '- [ ] Basil\n- [x] Tomatoes\n- [ ] Sweet peas\n\nFor the [[Garden plan]].'
  )
  await newNote(
    'On paying attention',
    '# On paying attention\n\nA quiet desk changes how a morning begins. The tools we use to think should step back.\n\n## What helps\n\n- A single open note\n- Context close at hand\n  - [[Garden plan]] as a live reference\n- [ ] Write before reading\n\n| Habit | When | Why |\n| --- | --- | --- |\n| Short walk | Morning | Clears the head |\n| One page | Evening | Keeps the thread |\n\nWhen the page is ready, '
  )
  await shot('writing-light')

  // The / insert menu.
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await page.locator('.cm-insert-menu').waitFor()
  await shot('insert-menu')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Backspace')

  // A note link card.
  await page.locator('.cm-wikilink', { hasText: 'Garden plan' }).first().hover()
  await page.locator('.cm-link-card').waitFor()
  await shot('link-preview')
  await page.mouse.move(10, 500)

  // Connections board in the context panel.
  await page.getByRole('button', { name: 'Context', exact: true }).click()
  await page.waitForTimeout(300)
  await shot('context-board')
  await page.getByRole('button', { name: 'Close context panel' }).click()

  // Note graph.
  await page.getByRole('button', { name: 'Open note graph' }).click()
  await page.waitForTimeout(1600)
  await shot('note-graph')
  await page.keyboard.press('Escape')

  // Zen level menu.
  await page.getByRole('button', { name: 'Choose zen mode level' }).click()
  await shot('zen-levels')
  await page.keyboard.press('Escape')

  // The command palette.
  await editor().click()
  await page.keyboard.press(`${mod}+p`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor()
  await page.keyboard.type('gar')
  await page.waitForTimeout(250)
  await shot('command-palette')
  await page.keyboard.press('Escape')

  // Preferences: models with the catalog dropdown, knowledge, sync.
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: 'Models', exact: true }).click()
  await dialog
    .getByRole('region', { name: 'External providers' })
    .getByRole('radio', { name: 'Anthropic' })
    .click()
  await dialog
    .getByRole('region', { name: 'External providers' })
    .scrollIntoViewIfNeeded()
  await shot('preferences-models')
  await dialog.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  await shot('preferences-knowledge')
  await dialog.getByRole('tab', { name: 'Suggestions', exact: true }).click()
  await shot('preferences-timing')
  const dictation = dialog.getByRole('tab', { name: 'Dictation', exact: true })
  if (await dictation.count()) {
    await dictation.click()
    await shot('preferences-dictation')
  }
  await page.keyboard.press('Escape')

  // Dark appearance.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Toggle light and dark mode' }).click()
  await shot('writing-dark')
} finally {
  await browser.close()
}
