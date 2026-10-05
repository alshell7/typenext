import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const files = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  '1024x1024.png',
  'icon.png',
  'icon.ico',
  'icon.icns',
]
for (const extra of [[], ['--png', '1024']])
  execFileSync(
    process.execPath,
    [
      'node_modules/@tauri-apps/cli/tauri.js',
      'icon',
      'public/brand/logo-master.png',
      '--output',
      'src-tauri/icons',
      ...extra,
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  )
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// UI marks never exceed 40 CSS pixels; a 256px derivative avoids decoding the
// full-resolution generated image during startup, while preserving one design.
await copyFile(
  new URL('src-tauri/icons/128x128@2x.png', root),
  new URL('public/Icon.png', root)
)
const manifest = {
  schema: 1,
  master: 'public/brand/logo-master.png',
  masterSha256: hash(
    await readFile(new URL('public/brand/logo-master.png', root))
  ),
  uiIcon: {
    path: 'public/Icon.png',
    sha256: hash(await readFile(new URL('public/Icon.png', root))),
  },
  icons: Object.fromEntries(
    await Promise.all(
      files.map(async file => [
        `src-tauri/icons/${file}`,
        hash(await readFile(new URL(`src-tauri/icons/${file}`, root))),
      ])
    )
  ),
}
await mkdir(new URL('public/brand/', root), { recursive: true })
await writeFile(
  new URL('public/brand/icon-manifest.json', root),
  JSON.stringify(manifest, null, 2) + '\n'
)
console.log('Recorded the master and generated Windows/macOS icon hashes.')
