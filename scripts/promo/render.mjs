// Render the film frame by frame and encode it with the soundtrack.
//   node scripts/promo/render.mjs --stills 2.1,4.2   # PNG stills to review
//   node scripts/promo/render.mjs                      # the full film
// Needs the clips (record-clips.mjs), the soundtrack (soundtrack.mjs) and ffmpeg.
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { DURATION, FPS, HEIGHT, WIDTH } from './timeline.mjs'

const root = resolve('.')
const out = 'artifacts/promo'
const args = process.argv.slice(2)
const stillsArg = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null
const fromArg = args.includes('--from') ? Number(args[args.indexOf('--from') + 1]) : 0
const toArg = args.includes('--to') ? Number(args[args.indexOf('--to') + 1]) : DURATION
mkdirSync(`${out}/stills`, { recursive: true })

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' }
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname))
  const file = join(root, path)
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' })
  createReadStream(file).pipe(response)
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/scripts/promo/film.html`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
page.on('pageerror', error => console.error('film error:', error.message))
page.on('console', message => message.type() === 'error' && console.error('film console:', message.text()))
await page.goto(url)
await page.waitForFunction(() => window.filmReady === true, null, { timeout: 60_000 })

try {
  if (stillsArg) {
    for (const value of stillsArg.split(',').map(Number)) {
      await page.evaluate(t => window.renderAt(t), value)
      await page.screenshot({ path: `${out}/stills/${value.toFixed(2)}.png` })
    }
    console.log(`stills in ${out}/stills`)
  } else {
    const audio = `${out}/soundtrack.wav`
    const partial = fromArg > 0 || toArg < DURATION
    const target = partial ? `${out}/preview.mp4` : `${out}/typenext-film.mp4`
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
        ...(existsSync(audio) ? ['-ss', String(fromArg), '-i', audio, '-map', '0:v', '-map', '1:a', '-af', 'volume=-3.6dB,alimiter=limit=0.89:level=false', '-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-movflags', '+faststart', target,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    )
    const done = new Promise((resolveDone, reject) => ffmpeg.on('close', code => (code === 0 ? resolveDone() : reject(new Error(`ffmpeg exited ${code}`)))))
    const first = Math.round(fromArg * FPS)
    const last = Math.round(toArg * FPS)
    const started = Date.now()
    for (let frame = first; frame < last; frame++) {
      await page.evaluate(t => window.renderAt(t), frame / FPS)
      const png = await page.screenshot({ type: 'png' })
      if (!ffmpeg.stdin.write(png)) await new Promise(next => ffmpeg.stdin.once('drain', next))
      if ((frame - first) % 120 === 0) console.log(`frame ${frame}/${last} · ${((Date.now() - started) / 1000).toFixed(0)} s`)
    }
    ffmpeg.stdin.end()
    await done
    console.log(target)
  }
} finally {
  await browser.close()
  server.close()
}
