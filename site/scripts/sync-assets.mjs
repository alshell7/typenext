// Copies the app screenshots, icon and licence notices that the site uses
// into public/assets/. The files stay in their source folders in the
// repository; this folder is generated and ignored by Git.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(site, '..')
const out = join(site, 'public/assets')
mkdirSync(out, { recursive: true })

export const screenshots = [
  'writing-light.png',
  'writing-dark.png',
  'insert-menu.png',
  'link-preview.png',
  'context-board.png',
  'note-graph.png',
  'zen-levels.png',
  'preferences-models.png',
  'preferences-knowledge.png',
]

const copies = [
  ...screenshots.map(name => [join(repo, 'docs/screenshots', name), name]),
  [join(repo, 'docs/media/typenext-film.mp4'), 'typenext-film.mp4'],
  [join(repo, 'docs/media/typenext-film-poster.jpg'), 'typenext-film-poster.jpg'],
  [join(repo, 'public/Icon.png'), 'Icon.png'],
  [join(repo, 'public/Icon512.png'), 'Icon512.png'],
  [join(site, 'src/components/reactbits/LICENSE.md'), 'React-Bits-LICENSE.txt'],
  [join(site, 'node_modules/@fontsource/source-sans-pro/LICENSE'), 'Source-Sans-Pro-LICENSE.txt'],
  [join(site, 'node_modules/@fontsource/merriweather/LICENSE'), 'Merriweather-LICENSE.txt'],
]

let missing = 0
for (const [from, name] of copies) {
  if (!existsSync(from)) {
    console.error(`Missing site asset: ${from}`)
    missing++
    continue
  }
  copyFileSync(from, join(out, name))
}
if (missing) process.exit(1)
console.log(`Copied ${copies.length} site assets to public/assets.`)
