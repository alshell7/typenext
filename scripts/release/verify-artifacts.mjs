import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  ROOT,
  TARGETS,
  UPDATER_FEED,
  assertInside,
  assertManifestSet,
  buildUpdaterFeed,
  hashFile,
} from './lib.mjs'

const tag = process.env.RELEASE_TAG,
  commit = process.env.RELEASE_COMMIT
const downloaded = resolve(ROOT, 'artifacts/release-downloads')
const manifests = [],
  directories = new Map()
for (const info of Object.values(TARGETS)) {
  const directory = join(downloaded, `release-${info.id}`)
  const manifest = JSON.parse(
    await readFile(join(directory, `manifest-${info.id}.json`), 'utf8')
  )
  manifests.push(manifest)
  for (const asset of manifest.assets ?? [])
    directories.set(asset.name, directory)
}
const assets = assertManifestSet(manifests, { tag, commit })
const publish = resolve(ROOT, 'artifacts/release-publish')
await mkdir(publish) // Never merge stale assets from another validation run.
for (const asset of assets) {
  const source = assertInside(
    directories.get(asset.name),
    join(directories.get(asset.name), asset.name)
  )
  if (
    (await stat(source)).size !== asset.bytes ||
    (await hashFile(source)) !== asset.sha256
  )
    throw new Error(
      `Downloaded artifact failed its size or SHA-256 check: ${asset.name}`
    )
  if (asset.role.endsWith('zip')) {
    const entries = execFileSync('unzip', ['-Z', '-1', source], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }).split('\n')
    for (const suffix of [
      '/LICENSE.md',
      '/licensing.md',
      '/third-party-notices/THIRD-PARTY-NOTICES.md',
      '/font-licenses/Miracode-LICENSE.txt',
      '/cactus-runtime/LICENSE',
      '/cactus-runtime/NOTICE',
    ])
      if (!entries.some(entry => entry.endsWith(suffix)))
        throw new Error(
          `License payload is missing from ${asset.name}: ${suffix}`
        )
    if (
      asset.role === 'portable-zip' &&
      !entries.some(entry => entry.endsWith('/TypeNext.exe'))
    )
      throw new Error('The Windows portable ZIP must contain the executable.')
    if (
      asset.role === 'app-zip' &&
      !entries.some(entry =>
        entry.endsWith('/TypeNext.app/Contents/MacOS/typenext')
      )
    )
      throw new Error(
        'Each Mac app ZIP must contain the application executable.'
      )
  }
  await copyFile(source, join(publish, asset.name))
}
const { fileRecord } = await import('./lib.mjs')
// The in-app updater reads this feed from the latest release.
const feed = buildUpdaterFeed({
  manifests,
  tag,
  repository: process.env.GH_REPO,
  notes: await readFile(resolve(ROOT, `docs/release-notes/${tag}.md`), 'utf8'),
})
await writeFile(
  join(publish, UPDATER_FEED),
  JSON.stringify(feed, null, 2) + '\n'
)
assets.push(await fileRecord(join(publish, UPDATER_FEED), 'updater-feed'))
const checksum =
  assets
    .map(asset => `${asset.sha256}  ${asset.name}`)
    .sort()
    .join('\n') + '\n'
await writeFile(join(publish, 'SHA256SUMS.txt'), checksum)
assets.push(await fileRecord(join(publish, 'SHA256SUMS.txt'), 'checksums'))
await writeFile(
  join(publish, 'verified-assets.json'),
  JSON.stringify({ schema: 1, tag, commit, assets }, null, 2) + '\n'
)
console.log(
  `Verified all three platforms and ${assets.length - 2} executable/installer/archive assets; ${UPDATER_FEED} and SHA256SUMS.txt added.`
)
