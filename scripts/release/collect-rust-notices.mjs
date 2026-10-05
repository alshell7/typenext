import { execFileSync } from 'node:child_process'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT, assertInside, hashFile, targetInfo } from './lib.mjs'

const referencedLicenseOptions = Object.freeze({
  'fxhash@0.2.1': 'Apache-2.0',
  'mac@0.1.1': 'Apache-2.0',
  'dispatch2@0.3.0': 'Apache-2.0',
  'objc2-app-kit@0.3.1': 'Apache-2.0',
  'objc2-cloud-kit@0.3.1': 'Apache-2.0',
  'objc2-core-data@0.3.1': 'Apache-2.0',
  'objc2-core-foundation@0.3.1': 'Apache-2.0',
  'objc2-core-graphics@0.3.1': 'Apache-2.0',
  'objc2-core-image@0.3.1': 'Apache-2.0',
  'objc2-exception-helper@0.1.1': 'Apache-2.0',
  'objc2-io-surface@0.3.1': 'Apache-2.0',
  'objc2-javascript-core@0.3.1': 'Apache-2.0',
  'objc2-quartz-core@0.3.1': 'Apache-2.0',
  'objc2-security@0.3.1': 'Apache-2.0',
  'objc2-web-kit@0.3.1': 'Apache-2.0',
  'convert_case@0.4.0': 'MIT',
  'seahash@4.1.0': 'MIT',
  'block2@0.6.1': 'MIT',
  'dispatch@0.2.0': 'MIT',
  'objc2@0.6.1': 'MIT',
  'objc2-encode@4.1.0': 'MIT',
  'objc2-foundation@0.3.1': 'MIT',
})
const standardLicenseUrls = Object.freeze({
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0.txt',
  MIT: 'https://opensource.org/license/mit',
})

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function lockedRegistryChecksum(pkg, lockFile) {
  const text = await readFile(lockFile, 'utf8')
  for (const block of text.split('[[package]]').slice(1)) {
    if (
      block.match(/^name = "([^"]+)"/mu)?.[1] === pkg.name &&
      block.match(/^version = "([^"]+)"/mu)?.[1] === pkg.version &&
      block.match(/^source = "([^"]+)"/mu)?.[1] === pkg.source
    )
      return block.match(/^checksum = "([a-f0-9]{64})"/mu)?.[1]
  }
  return undefined
}

async function fallbackFiles(pkg, crateRoot, fallbackRoot, lockFile) {
  const directory = assertInside(
    fallbackRoot,
    resolve(fallbackRoot, `${pkg.name}-${pkg.version}`)
  )
  const source = await optionalJson(resolve(directory, 'source.json'))
  if (!source) return []
  const vcs = await optionalJson(resolve(crateRoot, '.cargo_vcs_info.json'))
  const checksum = await optionalJson(
    resolve(crateRoot, '.cargo-checksum.json')
  )
  if (
    source.name !== pkg.name ||
    source.version !== pkg.version ||
    source.repository !== pkg.repository ||
    source.cargoSource !== pkg.source ||
    !/^[a-f0-9]{40}$/u.test(source.revision ?? '')
  )
    throw new Error(
      `Fallback source identity differs from locked package ${pkg.name}@${pkg.version}.`
    )
  if (vcs?.git?.sha1) {
    if (
      source.revision !== vcs.git.sha1 ||
      (source.pathInVcs ?? '') !== (vcs.path_in_vcs ?? '')
    )
      throw new Error(
        `Fallback revision differs from the published VCS revision of ${pkg.name}.`
      )
  } else {
    const locked = await lockedRegistryChecksum(pkg, lockFile)
    if (
      !locked ||
      source.crateSha256 !== locked ||
      (checksum?.package && checksum.package !== locked)
    )
      throw new Error(
        `Fallback for ${pkg.name} needs the exact locked published crate checksum when VCS metadata is absent.`
      )
  }
  if (!Array.isArray(source.files) || !source.files.length)
    throw new Error(`Empty native license fallback for ${pkg.name}.`)
  const result = []
  for (const file of source.files) {
    const path = assertInside(directory, resolve(directory, file.path))
    assertInside(directory, await realpath(path))
    const url = new URL(file.url)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !url.pathname.includes(source.revision) ||
      !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '') ||
      (await hashFile(path)) !== file.sha256
    )
      throw new Error(
        `Native license fallback has unpinned provenance or changed bytes for ${pkg.name}.`
      )
    result.push({ source: path, name: file.path, root: directory })
  }
  if (source.kind === 'referenced-standard-license') {
    const selected = referencedLicenseOptions[`${pkg.name}@${pkg.version}`]
    if (
      !selected ||
      source.selectedLicense !== selected ||
      !new RegExp(
        `(?:^|[\\s(/])${selected.replaceAll('.', '\\.')}(?=$|[\\s)/])`,
        'u'
      ).test(pkg.license ?? '')
    )
      throw new Error(
        'Referenced standard-license copies require an explicitly reviewed package/version and declared license option.'
      )
    const standard = source.standardLicense
    if (
      standard?.url !== standardLicenseUrls[selected] ||
      !/^[a-f0-9]{64}$/u.test(standard.sha256 ?? '')
    )
      throw new Error(
        'A referenced standard license requires the exact reviewed Foundation/OSI URL and hash.'
      )
    const path = assertInside(directory, resolve(directory, standard.path))
    assertInside(directory, await realpath(path))
    if ((await hashFile(path)) !== standard.sha256)
      throw new Error('The referenced standard license bytes changed.')
    result.push({ source: path, name: standard.path, root: directory })
  } else if (source.kind && source.kind !== 'upstream-license') {
    throw new Error('Unknown native license fallback provenance kind.')
  }
  return result
}

async function copyCorrespondingSource(crateRoot, destination) {
  let bytes = 0,
    files = 0
  await cp(crateRoot, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async path => {
      if (['.git', 'target', '.cargo-ok'].includes(basename(path))) return false
      const entry = await lstat(path)
      if (entry.isSymbolicLink())
        throw new Error(
          'Refusing symlinks in published corresponding-source packages.'
        )
      if (entry.isFile()) {
        bytes += entry.size
        files += 1
      }
      if (files > 20_000 || bytes > 64 * 1024 * 1024)
        throw new Error(
          'Corresponding-source package exceeds the reviewed release budget.'
        )
      return true
    },
  })
}

export async function collectNativeNotices(
  metadata,
  target,
  output,
  {
    fallbackRoot = resolve(ROOT, 'public/notices/native-source-licenses'),
    lockFile = resolve(ROOT, 'src-tauri/Cargo.lock'),
  } = {}
) {
  targetInfo(target)
  const resolved = new Set(metadata.resolve?.nodes?.map(node => node.id) ?? [])
  const packages = metadata.packages
    .filter(pkg => resolved.has(pkg.id) && pkg.name !== 'typenext')
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`
      )
    )
  if (!packages.length)
    throw new Error(
      'Locked cargo metadata did not contain resolved native dependencies.'
    )
  await mkdir(output, { recursive: true })
  const inventory = [],
    missing = []
  for (const pkg of packages) {
    const crateRoot = await realpath(dirname(pkg.manifest_path))
    const candidates = new Set()
    for (const entry of await readdir(crateRoot, { withFileTypes: true })) {
      if (
        !/^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-]|$)/iu.test(
          entry.name
        )
      )
        continue
      if (entry.isFile()) candidates.add(resolve(crateRoot, entry.name))
      if (entry.isDirectory()) {
        for (const child of await readdir(resolve(crateRoot, entry.name), {
          withFileTypes: true,
        }))
          if (child.isFile())
            candidates.add(resolve(crateRoot, entry.name, child.name))
      }
    }
    if (pkg.license_file) candidates.add(resolve(crateRoot, pkg.license_file))
    const destination = resolve(output, `${pkg.name}-${pkg.version}`)
    assertInside(output, destination)
    await mkdir(destination, { recursive: true })
    const files = []
    const sources = [...candidates].sort().map(source => ({
      source,
      root: crateRoot,
      name:
        basename(dirname(source)) === basename(crateRoot)
          ? basename(source)
          : `${basename(dirname(source))}-${basename(source)}`,
    }))
    if (!sources.length)
      sources.push(
        ...(await fallbackFiles(pkg, crateRoot, fallbackRoot, lockFile))
      )
    for (const { source, root, name } of sources) {
      const actual = await realpath(source)
      assertInside(root, actual)
      const size = (await stat(actual)).size
      if (size === 0 || size > 8 * 1024 * 1024)
        throw new Error(`Invalid native license file size for ${pkg.name}.`)
      const copied = assertInside(destination, resolve(destination, name))
      await mkdir(dirname(copied), { recursive: true })
      await copyFile(actual, copied)
      files.push(`${pkg.name}-${pkg.version}/${name}`)
    }
    const correspondingSource = /MPL-2\.0/u.test(pkg.license ?? '')
      ? `${pkg.name}-${pkg.version}/source/`
      : undefined
    if (correspondingSource)
      await copyCorrespondingSource(crateRoot, resolve(destination, 'source'))
    inventory.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? null,
      authors: pkg.authors ?? [],
      repository: pkg.repository ?? null,
      source: pkg.source ?? null,
      files,
      ...(correspondingSource ? { correspondingSource } : {}),
    })
    if (!files.length)
      missing.push(
        `${pkg.name}@${pkg.version} (${pkg.license ?? 'no declared license'})`
      )
  }
  await writeFile(
    resolve(output, 'inventory.json'),
    JSON.stringify(
      { schema: 1, target, packages: inventory, missing },
      null,
      2
    ) + '\n'
  )
  await writeFile(
    resolve(output, 'README.md'),
    `# Native dependencies for ${target}\n\nGenerated from locked target-filtered Cargo metadata. Each folder contains the dependency's published or reviewed pinned upstream license and notice files; inventory.json retains declared authors, source, repository and license expressions. These dependencies retain their own licenses. Packages whose license expression includes MPL-2.0 also include their exact published corresponding source in the package's source/ folder, without changes by TypeNext.\n`
  )
  if (missing.length)
    throw new Error(
      `Native packages without published full license files: ${missing.join(', ')}. Supply reviewed upstream copies before release.`
    )
  return inventory
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const target = process.argv[2],
    info = targetInfo(target)
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--filter-platform',
        target,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    )
  )
  const inventory = await collectNativeNotices(
    metadata,
    target,
    resolve(ROOT, 'public/notices', `native-${info.id}`)
  )
  console.log(
    `Collected full native license files for ${inventory.length} resolved ${target} crates.`
  )
}
