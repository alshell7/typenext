// Builds the project website (site/, a Vite + React app) into site-dist/.
//
//   node scripts/build-site.mjs         install site dependencies and build
//   node scripts/build-site.mjs --dev   start the site dev server
//
// The site has its own package.json and lockfile, so the app's dependencies
// are not needed. Screenshots come from docs/screenshots (see
// site/scripts/sync-assets.mjs).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const dev = process.argv.includes('--dev')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const run = (args) => {
  const result = spawnSync(npm, ['--prefix', 'site', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (dev) {
  if (!existsSync('site/node_modules')) run(['ci', '--no-audit', '--no-fund'])
  run(['run', 'dev'])
} else {
  run(['ci', '--no-audit', '--no-fund'])
  run(['run', 'build'])
  writeFileSync('site-dist/.nojekyll', '')

  let total = 0
  let gzip = 0
  for (const name of readdirSync('site-dist/static')) {
    if (!/\.(js|css)$/.test(name)) continue
    const file = join('site-dist/static', name)
    total += statSync(file).size
    gzip += gzipSync(readFileSync(file)).length
  }
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
  console.log(`Built the project site in site-dist (JS and CSS: ${kb(total)}, ${kb(gzip)} gzip).`)
}
