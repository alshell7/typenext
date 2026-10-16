// Copies React Bits components (TypeScript + plain CSS variants) from the
// public React Bits registry into src/components/reactbits/<Name>/.
//
//   npm run reactbits -- Aurora BlurText
//
// This is the same source that `npx shadcn@latest add
// https://reactbits.dev/r/<Name>-TS-CSS` installs. Each file receives the
// React Bits licence notice. Existing files are overwritten, so re-apply
// the local changes listed in site/README.md after an update.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('Usage: npm run reactbits -- <Name> [<Name> ...]')
  process.exit(1)
}

const notice = name => `/*
 * ${name} from React Bits (https://reactbits.dev, https://github.com/DavidHDev/react-bits)
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0.
 * Used as part of the TypeNext website. See ../LICENSE.md.
 */
`

for (const name of names) {
  const url = `https://reactbits.dev/r/${name}-TS-CSS.json`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const item = await response.json()
  const folder = join(root, 'src/components/reactbits', name)
  mkdirSync(folder, { recursive: true })
  for (const file of item.files) {
    const base = file.path.split('/').pop()
    const target = join(folder, base)
    const body = file.content.replace(/^'use client';\n\n?/, '')
    writeFileSync(target, `${notice(name)}\n${body}`)
    console.log(`Wrote ${target.slice(root.length + 1)}`)
  }
  if (item.dependencies?.length)
    console.log(`  ${name} needs: ${item.dependencies.join(', ')}`)
}
