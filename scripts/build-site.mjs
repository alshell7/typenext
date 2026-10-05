import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('site-dist/assets', { recursive: true })
for (const file of ['index.html', 'style.css', 'site.js'])
  copyFileSync(`site/${file}`, `site-dist/${file}`)
for (const file of [
  'writing-light.png',
  'writing-dark.png',
  'context-preview.png',
])
  copyFileSync(`docs/screenshots/${file}`, `site-dist/assets/${file}`)
copyFileSync('public/Icon.svg', 'site-dist/assets/Icon.svg')
copyFileSync(
  'public/notices/Lucide-LICENSE.txt',
  'site-dist/assets/Lucide-LICENSE.txt'
)
copyFileSync(
  'node_modules/@fontsource/source-sans-pro/files/source-sans-pro-latin-400-normal.woff2',
  'site-dist/assets/source-sans-pro.woff2'
)
copyFileSync(
  'node_modules/@fontsource/source-sans-pro/files/source-sans-pro-latin-600-normal.woff2',
  'site-dist/assets/source-sans-pro-semibold.woff2'
)
cpSync(
  'node_modules/@fontsource/source-sans-pro/LICENSE',
  'site-dist/assets/Source-Sans-Pro-LICENSE.txt'
)
writeFileSync('site-dist/.nojekyll', '')
console.log('Built static GitHub Pages site in site-dist.')
