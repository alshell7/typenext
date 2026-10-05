import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ROOT, assertRemoteAssets, hashFile, releaseVersion } from './lib.mjs'

const tag = process.env.RELEASE_TAG,
  commit = process.env.RELEASE_COMMIT
releaseVersion(tag)
const repository = process.env.GH_REPO
if (
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') ||
  !process.env.GH_TOKEN ||
  !/^[a-f0-9]{40}$/u.test(commit ?? '')
)
  throw new Error(
    'Publishing requires the workflow repository, token and exact commit.'
  )
const directory = resolve(ROOT, 'artifacts/release-publish')
const verified = JSON.parse(
  await readFile(resolve(directory, 'verified-assets.json'), 'utf8')
)
if (
  verified.schema !== 1 ||
  verified.tag !== tag ||
  verified.commit !== commit ||
  !Array.isArray(verified.assets) ||
  verified.assets.length !== 8
)
  throw new Error('The complete validated release asset set is required.')
for (const asset of verified.assets)
  if ((await hashFile(resolve(directory, asset.name))) !== asset.sha256)
    throw new Error(`Asset changed after validation: ${asset.name}`)
const gh = args =>
  execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
const api = path => JSON.parse(gh(['api', path]))
function assertRemoteTagCommit() {
  let object = api(`repos/${repository}/git/ref/tags/${tag}`).object
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++)
    object = api(`repos/${repository}/git/tags/${object.sha}`).object
  if (object.type !== 'commit' || object.sha !== commit)
    throw new Error(
      'The remote release tag moved or points to a different commit.'
    )
}
assertRemoteTagCommit()

// A rerun may finish its own private draft. It must never modify an already
// public release or remove unexpected assets supplied outside this workflow.
let release
try {
  release = api(`repos/${repository}/releases/tags/${tag}`)
} catch (error) {
  if (!String(error.stderr).includes('404')) throw error
}
if (release && !release.draft)
  throw new Error('This release is already public; refusing to modify it.')
if (
  release?.assets?.some(
    asset => !verified.assets.some(expected => expected.name === asset.name)
  )
)
  throw new Error(
    'The existing draft contains unexpected assets; review it before rerunning.'
  )
if (!release) {
  gh([
    'release',
    'create',
    tag,
    '--draft',
    '--verify-tag',
    '--target',
    commit,
    '--title',
    `TypeNext ${tag}`,
    '--notes-file',
    `docs/release-notes/${tag}.md`,
  ])
}
gh([
  'release',
  'upload',
  tag,
  ...verified.assets.map(asset => resolve(directory, asset.name)),
  '--clobber',
])
release = api(`repos/${repository}/releases/tags/${tag}`)
if (!release.draft)
  throw new Error(
    'The release was published outside this job before validation.'
  )
assertRemoteAssets(verified.assets, release.assets)
assertRemoteTagCommit()
// This is the only operation that makes the complete release public.
gh(['release', 'edit', tag, '--draft=false', '--latest'])
console.log(
  `Published complete ${tag}: Windows x64, Apple Silicon and Intel Mac assets verified before publication.`
)
