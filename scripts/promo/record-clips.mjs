// Record the real app scenes for the promo film, frame by frame.
// Needs the dev server (npm run dev -- --host 127.0.0.1) and the fixtures
// from make-fixtures.mjs. Frames go to artifacts/promo/clips/<scene>/.
//   node scripts/promo/record-clips.mjs [scene ...]
import { chromium } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const base = process.env.TYPENEXT_URL ?? 'http://127.0.0.1:1420/'
const F = 'artifacts/promo/fixtures'
const CLIPS = 'artifacts/promo/clips'
const only = process.argv.slice(2)
mkdirSync(CLIPS, { recursive: true })

const context = await chromium.launchPersistentContext('artifacts/promo/profile', {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  permissions: ['microphone'],
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve(F, 'dictation.wav')}`,
  ],
})
const page = context.pages()[0] ?? (await context.newPage())
page.on('pageerror', error => console.error('page error:', error.message))
const pause = ms => page.waitForTimeout(ms)
const editor = () => page.getByRole('textbox', { name: 'Note content', exact: true })
const title = () => page.getByRole('textbox', { name: 'Note title', exact: true })

/** Type like a person: an uneven rhythm, a little longer after words. */
async function write(text, speed = 1) {
  for (const character of text) {
    if (character === '\n') await page.keyboard.press('Enter')
    else await page.keyboard.type(character)
    const gap = character === ' ' ? 70 : character === '.' ? 160 : 38
    await pause((gap + Math.random() * 34) / speed)
  }
}

async function newNote(name, text = '') {
  const start = page.getByRole('button', { name: 'Start a note', exact: true })
  if (await start.isVisible()) await start.click()
  else await page.getByRole('button', { name: /^New note/ }).click()
  await title().fill(name)
  await editor().click()
  if (text) await page.keyboard.insertText(text)
  await pause(150)
}

async function openNote(name) {
  await page.getByRole('button', { name, exact: true }).first().click()
  await pause(300)
}

async function attach(files) {
  const panel = page.getByRole('complementary', { name: 'Note context', exact: true })
  if (!(await panel.isVisible())) await page.getByRole('button', { name: /^Context(?: \d+)?$/ }).click()
  await page.getByLabel('Attach reference files').setInputFiles(files.map(file => `${F}/${file}`))
  await pause(1500)
  await page.getByRole('button', { name: 'Close context panel' }).click()
  await pause(300)
}

/** Record one scene with the DevTools screencast: one frame per paint. */
async function scene(name, run) {
  if (only.length && !only.includes(name)) return
  const dir = `${CLIPS}/${name}`
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const cdp = await context.newCDPSession(page)
  const frames = []
  const marks = {}
  let first = null
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    first ??= metadata.timestamp
    const file = `${String(frames.length).padStart(5, '0')}.jpg`
    frames.push({ file, t: Number((metadata.timestamp - first).toFixed(4)) })
    writeFileSync(`${dir}/${file}`, Buffer.from(data, 'base64'))
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 2560, maxHeight: 1600 })
  await pause(250)
  const rects = {}
  // A mark notes the time, and optionally where an element is on screen
  // (in frame pixels), so the film can zoom to it.
  const mark = async (label, selector) => {
    marks[label] = Number((Date.now() / 1000 - first).toFixed(3))
    if (!selector) return
    const box = await page.evaluate(query => {
      const element = [...document.querySelectorAll(query)].at(-1)
      const rect = element?.getBoundingClientRect()
      return rect ? [rect.x, rect.y, rect.width, rect.height] : null
    }, selector)
    if (box) rects[label] = box.map(value => Math.round(value * 2))
  }
  await run(mark)
  await pause(300)
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  const duration = frames.at(-1)?.t ?? 0
  writeFileSync(`${dir}/index.json`, JSON.stringify({ width: 2560, height: 1600, duration, marks, rects, frames }))
  console.log(`${name}: ${frames.length} frames, ${duration.toFixed(1)} s`, marks)
}

try {
  await page.goto(base)
  // Keep the downloaded Whistle model; start every run with fresh notes.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (!/whistle/i.test(key)) localStorage.removeItem(key)
  })
  await page.reload()
  await page.getByRole('heading', { name: 'A little room to think.' }).waitFor()

  // A small, real workspace: an engineering decision and its neighbours,
  // and a novel in progress.
  await newNote('Capacity plan', 'Peak sales reach 2,400 orders per minute. The event store needs 9,000 writes per second.\n\nSee [[ADR-014: Event sourcing for orders]] and [[Kafka topics]].')
  await newNote('Kafka topics', 'order-events and refund-events. Consumers: [[Billing]] and [[Shipping]].')
  await newNote('Billing', 'Subscribes to order-events. Budget in [[Capacity plan]].')
  await newNote('Shipping', 'Subscribes to order-events. Labels print within one minute.')
  await newNote('Design review, 14 October', 'Replay the event log into a fresh projection. See [[ADR-014: Event sourcing for orders]].')
  await newNote('Chapter 3: The Salt Road', '')
  await attach(['characters.md'])
  await newNote('ADR-014: Event sourcing for orders', '')
  await attach(['order-service-requirements.md', 'design-review-notes.md', 'capacity-plan.pdf'])
  await editor().click()
  await page.keyboard.insertText('## Context\n\nOrders change often, and finance needs the full history.\n\n## Decision\n\n')
  await pause(800)

  // You write; a suggestion from your sources waits; Tab keeps it.
  await scene('write', async mark => {
    await pause(500)
    await write('We will store orders as an append-only event log. Every change to an order must keep')
    await mark('typed')
    await page.locator('.cm-ghost-suggestion').first().waitFor({ timeout: 8_000 }).catch(() => {})
    await mark('ghost', '.cm-ghost-suggestion')
    await mark('line', '.cm-line:has(.cm-ghost-suggestion)')
    await pause(1600)
    await page.keyboard.press('Tab')
    mark('accept')
    await pause(900)
    await write(' Refunds must be')
    await pause(300)
    await page.keyboard.press('ControlOrMeta+Space')
    await page.locator('.cm-suggestion-menu').waitFor({ timeout: 8_000 })
    await mark('choices', '.cm-suggestion-menu')
    await pause(1700)
    await page.keyboard.press('Tab')
    mark('accept2')
    await pause(1200)
  })

  // Speak; Whistle transcribes on this device.
  await scene('dictate', async mark => {
    await page.keyboard.press('ControlOrMeta+End')
    await write('\n\n')
    await page.keyboard.press('ControlOrMeta+Shift+d')
    const download = page.getByRole('button', { name: /Download Whistle/ })
    if (await download.isVisible().catch(() => false)) {
      await download.click()
      await page.getByRole('button', { name: 'Start dictating' }).waitFor({ timeout: 120_000 })
    }
    const start = page.getByRole('button', { name: 'Start dictating' })
    if (await start.isVisible().catch(() => false)) await start.click()
    await mark('listening', '.dictation-chip')
    await pause(4300)
    await page.keyboard.press('ControlOrMeta+Shift+d')
    mark('finish')
    await page.waitForFunction(() => /Snapshots/u.test(document.querySelector('.cm-content')?.textContent ?? ''), null, { timeout: 20_000 })
    await mark('text', '.cm-line')
    await pause(1500)
  })

  // The writer: a novel draft that remembers its own characters.
  await scene('novel', async mark => {
    await openNote('Chapter 3: The Salt Road')
    await editor().click()
    await pause(400)
    await write('The ferry left at dawn. Mara touched the brass compass')
    await page.locator('.cm-ghost-suggestion').first().waitFor({ timeout: 8_000 }).catch(() => {})
    await mark('typed', '.cm-line:has(.cm-ghost-suggestion)')
    await pause(2200)
    await page.keyboard.press('Tab')
    mark('accept')
    await pause(1400)
  })

  // The / menu: a comparison table in two keystrokes.
  await scene('table', async mark => {
    await openNote('ADR-014: Event sourcing for orders')
    await editor().click()
    await page.keyboard.press('ControlOrMeta+End')
    await write('\n\n## Options\n\n')
    await write('/tab', 0.7)
    await mark('menu', '.cm-insert-menu')
    await pause(700)
    await page.keyboard.press('Enter')
    await write('Option', 1.4)
    await page.keyboard.press('Tab')
    await write('Replay', 1.4)
    await page.keyboard.press('Tab')
    await write('Audit', 1.4)
    await page.keyboard.press('Tab')
    await write('Event log', 1.4)
    await page.keyboard.press('Tab')
    await write('Yes', 1.4)
    await page.keyboard.press('Tab')
    await write('Full', 1.4)
    await page.keyboard.press('ControlOrMeta+Home')
    await mark('rendered', '.cm-lp-table')
    await pause(1200)
  })

  // [[links]] with completion and a hover card.
  await scene('links', async mark => {
    await page.keyboard.press('ControlOrMeta+End')
    await write('\n\nPeak load is in [[Capa')
    mark('complete')
    await pause(700)
    await page.keyboard.press('Enter')
    await write('.')
    await pause(400)
    await page.locator('.cm-wikilink', { hasText: 'Capacity plan' }).last().hover()
    await mark('card', '.cm-link-card')
    await pause(2200)
    await page.mouse.move(60, 760)
    await pause(300)
  })

  // The note graph.
  await scene('graph', async mark => {
    await page.getByRole('button', { name: 'Open note graph' }).click()
    mark('open')
    await pause(3200)
    await page.keyboard.press('Escape')
    await pause(400)
  })

  // The command palette.
  await scene('palette', async mark => {
    await editor().click()
    await pause(300)
    await page.keyboard.press('ControlOrMeta+p')
    await pause(400)
    await mark('open', '.command-palette')
    await write('kafka', 0.8)
    await pause(900)
    await page.keyboard.press('Enter')
    mark('opened')
    await pause(1000)
  })

  // Zen: everything but the words steps back.
  await scene('zen', async mark => {
    await openNote('Chapter 3: The Salt Road')
    await editor().click()
    await page.keyboard.press('ControlOrMeta+End')
    await pause(300)
    await page.keyboard.press('ControlOrMeta+Shift+f')
    mark('zen')
    await pause(700)
    await write(' Behind her, Saltmere grew small and quiet.')
    await pause(900)
    // The first Escape dismisses a waiting suggestion; the next leaves zen.
    await page.keyboard.press('Escape')
    await pause(200)
    if (!(await page.getByRole('button', { name: 'Preferences', exact: true }).isVisible())) await page.keyboard.press('Escape')
    await pause(400)
  })

  // Preferences: on-device knowledge, dictation and models.
  await scene('settings', async mark => {
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
    await dialog.getByRole('tab', { name: 'Knowledge', exact: true }).click()
    mark('knowledge')
    await pause(1800)
    await dialog.getByRole('tab', { name: 'Dictation', exact: true }).click()
    mark('dictation')
    await pause(1800)
    await dialog.getByRole('tab', { name: 'Models', exact: true }).click()
    mark('models')
    await pause(1800)
    await page.keyboard.press('Escape')
    await pause(300)
  })

  // Dark appearance.
  await scene('dark', async mark => {
    await openNote('ADR-014: Event sourcing for orders')
    await page.getByRole('button', { name: 'Toggle light and dark mode' }).click()
    mark('dark')
    await pause(1600)
    await page.getByRole('button', { name: 'Toggle light and dark mode' }).click()
    await pause(300)
  })
} finally {
  await context.close()
}
