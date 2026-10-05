import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, assertRemoteAssets, hashFile, releaseVersion } from './lib.mjs'

const runGh = args =>
  execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
// GitHub's by-tag REST endpoint returns published releases only. Authenticated
// list discovery includes private drafts. Numeric ID reads and the final PATCH
// keep verification and publication tied to the exact draft that was found.
export function selectDraftRelease(pages, tag) {
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page)))
    throw new Error('Malformed paginated release list.')
  const matches = pages.flat().filter(release => release?.tag_name === tag)
  if (matches.length > 1)
    throw new Error(
      'Multiple releases use this tag; review them before publishing.'
    )
  if (!matches.length) return null
  assertDraftRelease(matches[0], tag)
  return matches[0]
}

function assertDraftRelease(release, tag, id) {
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    release.tag_name !== tag ||
    (id && release.id !== id) ||
    !Array.isArray(release.assets)
  )
    throw new Error('The draft identity or asset list changed.')
  if (release.draft !== true)
    throw new Error('This release is already public; refusing to modify it.')
}

export async function publishRelease({
  tag,
  commit,
  repository,
  token,
  directory = resolve(ROOT, 'artifacts/release-publish'),
  gh = runGh,
}) {
  releaseVersion(tag)
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') ||
    !token ||
    !/^[a-f0-9]{40}$/u.test(commit ?? '')
  )
    throw new Error(
      'Publishing requires the workflow repository, token and exact commit.'
    )
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
  const api = (path, ...args) => JSON.parse(gh(['api', path, ...args]))
  const discover = () =>
    selectDraftRelease(
      api(`repos/${repository}/releases?per_page=100`, '--paginate', '--slurp'),
      tag
    )
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
  let release = discover()
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
      '--repo',
      repository,
      '--target',
      commit,
      '--title',
      `TypeNext ${tag}`,
      '--notes-file',
      `docs/release-notes/${tag}.md`,
    ])
    release = discover()
    if (!release) throw new Error('The newly created draft is missing.')
  }
  const releaseId = release.id
  release = api(`repos/${repository}/releases/${releaseId}`)
  assertDraftRelease(release, tag, releaseId)
  if (
    release.assets.some(
      asset => !verified.assets.some(expected => expected.name === asset.name)
    )
  )
    throw new Error(
      'The existing draft contains unexpected assets; review it before rerunning.'
    )
  gh([
    'release',
    'upload',
    tag,
    '--repo',
    repository,
    ...verified.assets.map(asset => resolve(directory, asset.name)),
    '--clobber',
  ])
  release = api(`repos/${repository}/releases/${releaseId}`)
  assertDraftRelease(release, tag, releaseId)
  assertRemoteAssets(verified.assets, release.assets)
  if (discover()?.id !== releaseId)
    throw new Error('The draft identity changed before publication.')
  assertRemoteTagCommit()
  // This is the only operation that makes the complete release public.
  const published = api(
    `repos/${repository}/releases/${releaseId}`,
    '--method',
    'PATCH',
    '--field',
    'draft=false',
    '--raw-field',
    'make_latest=true'
  )
  if (
    published.id !== releaseId ||
    published.tag_name !== tag ||
    published.draft !== false
  )
    throw new Error(
      'GitHub did not confirm publication of the verified release.'
    )
  return releaseId
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const tag = process.env.RELEASE_TAG
  await publishRelease({
    tag,
    commit: process.env.RELEASE_COMMIT,
    repository: process.env.GH_REPO,
    token: process.env.GH_TOKEN,
  })
  console.log(
    `Published complete ${tag}: Windows x64, Apple Silicon and Intel Mac assets verified before publication.`
  )
}
