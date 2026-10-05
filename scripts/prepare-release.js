#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { ROOT, loadMetadata } from './release/lib.mjs'

const metadata = await loadMetadata(process.argv[2])
execFileSync(process.execPath, ['scripts/verify-brand.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
})
console.log(`Local metadata and icon checks passed for ${metadata.tag}.`)
console.log(
  'This check changes no versions, files, commits, tags or remote state.'
)
console.log(
  'Commit the reviewed release, then push its existing semantic-version tag to start the gated release workflow.'
)
console.log(
  'Publication still requires successful Windows x64, Apple Silicon and Intel Mac builds/tests, all licensed assets and remote checksum verification.'
)
