// Record the README demo: the sample note, a suggestion, the / menu, the
// command palette and the note graph. Needs the dev server and ffmpeg.
//   npm run dev -- --host 127.0.0.1
//   node scripts/record-demo.mjs
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

const base = process.env.TYPENEXT_URL ?? 'http://127.0.0.1:1420/'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const videoDir = 'artifacts/demo-video'
rmSync(videoDir, { recursive: true, force: true })
mkdirSync(videoDir, { recursive: true })
mkdirSync('docs/media', { recursive: true })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1280, height: 780 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 780 } },
  colorScheme: 'light',
})
const page = await context.newPage()
const pause = ms => page.waitForTimeout(ms)
const typeSlowly = async text => {
  for (const character of text) {
    await page.keyboard.type(character)
    await pause(55 + Math.random() * 45)
  }
}

try {
  await page.goto(base)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await pause(900)
  await page.getByRole('button', { name: 'Try a sample', exact: true }).click()
  await pause(1100)
  // A second note to link to. The first line becomes its title.
  await page.keyboard.press(`${mod}+n`)
  await pause(500)
  await page.getByRole('textbox', { name: 'Note title', exact: true }).click()
  await typeSlowly('Garden walk')
  await pause(300)
  await page.locator('.cm-content').click()
  await typeSlowly('The path runs past the old greenhouse.')
  await pause(700)
  // The command palette finds the sample again.
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await page.keyboard.press(`${mod}+p`)
  await palette.waitFor({ timeout: 4_000 })
  await pause(500)
  await typeSlowly('bramble')
  await pause(900)
  await page.keyboard.press('Enter')
  await pause(900)
  // A suggestion from the attached context, then accept it.
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${mod}+End`)
  await pause(400)
  await page.keyboard.press(`${mod}+Space`)
  await page.locator('.cm-suggestion-menu').waitFor({ timeout: 8_000 })
  await pause(1300)
  await page.keyboard.press('Tab')
  await pause(900)
  // A note link with completion and a hover card.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await typeSlowly('After lunch, take the [[Gar')
  await pause(800)
  await page.keyboard.press('Enter')
  await typeSlowly('.')
  await pause(300)
  await page.locator('.cm-wikilink', { hasText: 'Garden walk' }).hover()
  await pause(1800)
  await page.mouse.move(40, 700)
  // The insert menu makes a table.
  await page.locator('.cm-content').click()
  await page.keyboard.press(`${mod}+End`)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await typeSlowly('/tab')
  await pause(1000)
  await page.keyboard.press('Enter')
  await typeSlowly('Room')
  await page.keyboard.press('Tab')
  await typeSlowly('Guests')
  await page.keyboard.press('Tab')
  await typeSlowly('Floor')
  await pause(500)
  // Leave the table so it renders.
  await page.keyboard.press(`${mod}+Home`)
  await pause(900)
  // Zen from the palette.
  await page.keyboard.press(`${mod}+p`)
  await palette.waitFor({ timeout: 4_000 })
  await typeSlowly('>zen tool')
  await pause(900)
  await page.keyboard.press('Enter')
  await pause(1800)
  await page.keyboard.press('Escape')
  await pause(700)
  // The note graph.
  await page.getByRole('button', { name: 'Open note graph' }).click()
  await pause(2600)
  await page.keyboard.press('Escape')
  await pause(700)
} finally {
  await context.close()
  await browser.close()
}

const video = readdirSync(videoDir).find(file => file.endsWith('.webm'))
if (!video) throw new Error('No video was recorded.')
const source = path.join(videoDir, video)
renameSync(source, path.join(videoDir, 'demo.webm'))
const webm = path.join(videoDir, 'demo.webm')
const palette = path.join(videoDir, 'palette.png')
const filters = 'fps=12,scale=960:-1:flags=lanczos'
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-vf', `${filters},palettegen=stats_mode=diff`, palette])
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-i',
  webm,
  '-i',
  palette,
  '-lavfi',
  `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  'docs/media/demo.gif',
])
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart', '-vf', 'scale=1280:-2', 'docs/media/demo.mp4'])
console.log('docs/media/demo.gif and docs/media/demo.mp4')
