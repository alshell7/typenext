import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = new URL('../', import.meta.url)
const files = [
  'START-HERE.md',
  'welcome-note.md',
  'details/house.md',
  'details/weekend-plan.txt',
  'details/coastal-walk.md',
  'voice/welcome-voice.md',
]
const entries = Object.fromEntries(
  await Promise.all(
    files.map(async file => [
      `bramble-house/${file}`,
      [
        new Uint8Array(
          await readFile(new URL(`examples/bramble-house/${file}`, root))
        ),
        { mtime: new Date(1980, 0, 1) },
      ],
    ])
  )
)
const destination = new URL('public/demo/typenext-sample.zip', root)
await mkdir(new URL('public/demo/', root), { recursive: true })
await writeFile(destination, zipSync(entries, { level: 9 }))
console.log(`Prepared six sample files: ${fileURLToPath(destination)}`)
