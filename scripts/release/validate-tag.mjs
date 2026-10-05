import { execFileSync } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { ROOT, loadMetadata } from './lib.mjs'

const tag = process.env.RELEASE_TAG ?? process.argv[2]
const metadata = await loadMetadata(tag)
const git = args =>
  execFileSync('git', ['-c', `safe.directory=${ROOT}`, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
const commit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])
if (git(['rev-parse', 'HEAD']) !== commit)
  throw new Error(
    'The checked-out commit is different from the requested release tag.'
  )
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `tag=${tag}\nversion=${metadata.version}\ncommit=${commit}\n`
  )
console.log(
  `Verified ${tag} at ${commit}; MIT metadata and notice resources are present.`
)
