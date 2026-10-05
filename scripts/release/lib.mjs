import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { resolve, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const ASSET_SUFFIXES = Object.freeze({
  'installer-exe': '_setup.exe',
  'installer-msi': '.msi',
  'portable-zip': '_portable.zip',
  dmg: '.dmg',
  'app-zip': '.app.zip',
})
export const TARGETS = Object.freeze({
  'x86_64-pc-windows-msvc': {
    id: 'windows-x64',
    os: 'win32',
    arch: 'x64',
    roles: ['installer-exe', 'installer-msi', 'portable-zip'],
  },
  'aarch64-apple-darwin': {
    id: 'macos-arm64',
    os: 'darwin',
    arch: 'arm64',
    roles: ['dmg', 'app-zip'],
  },
  'x86_64-apple-darwin': {
    id: 'macos-x64',
    os: 'darwin',
    arch: 'x64',
    roles: ['dmg', 'app-zip'],
  },
})

export function releaseVersion(tag) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag ?? ''))
    throw new Error(
      'A release must name an existing stable vMAJOR.MINOR.PATCH tag.'
    )
  return tag.slice(1)
}

export function targetInfo(target) {
  const info = TARGETS[target]
  if (!info) throw new Error(`Unsupported required release target: ${target}`)
  return info
}

export function assertInside(parent, child) {
  const part = relative(resolve(parent), resolve(child))
  if (
    !part ||
    isAbsolute(part) ||
    part === '..' ||
    part.startsWith(`..${sep}`) ||
    resolve(parent, part) !== resolve(child)
  )
    throw new Error('Refusing a path outside the intended release directory.')
  return child
}

export async function hashFile(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

export async function fileRecord(path, role) {
  const info = await stat(path)
  if (!info.isFile() || info.size === 0)
    throw new Error(`Missing or empty release asset: ${path}`)
  return {
    name: path.split(/[\\/]/u).at(-1),
    role,
    bytes: info.size,
    sha256: await hashFile(path),
  }
}

export function assertManifestSet(manifests, { tag, commit }) {
  const version = releaseVersion(tag)
  if (!/^[a-f0-9]{40}$/u.test(commit ?? ''))
    throw new Error('Expected release commit must be a full Git SHA.')
  const platforms = new Set(),
    names = new Set()
  for (const manifest of manifests) {
    const info = targetInfo(manifest.target)
    if (
      manifest.schema !== 1 ||
      manifest.platform !== info.id ||
      platforms.has(info.id)
    )
      throw new Error('Duplicate or malformed platform release manifest.')
    if (
      manifest.tag !== tag ||
      manifest.version !== version ||
      manifest.commit !== commit
    )
      throw new Error(
        'Every platform must match the exact release tag, version and commit.'
      )
    if (
      !Array.isArray(manifest.assets) ||
      manifest.assets.length !== info.roles.length
    )
      throw new Error(`Incomplete asset set for ${info.id}.`)
    const roles = new Set()
    for (const asset of manifest.assets) {
      if (!info.roles.includes(asset.role) || roles.has(asset.role))
        throw new Error(`Missing or repeated asset role for ${info.id}.`)
      if (!asset.name?.endsWith(ASSET_SUFFIXES[asset.role]))
        throw new Error(
          `The required asset role has the wrong file type: ${asset.role}.`
        )
      if (
        !/^TypeNext_[A-Za-z0-9_.-]+$/u.test(asset.name ?? '') ||
        !asset.name.startsWith(
          `TypeNext_${version}_${info.id.replace('-', '_')}`
        ) ||
        names.has(asset.name)
      )
        throw new Error(
          'Asset names must be unique flat names for the expected version and platform.'
        )
      if (
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes <= 0 ||
        !/^[a-f0-9]{64}$/u.test(asset.sha256 ?? '')
      )
        throw new Error(
          'Every release asset needs a nonempty size and SHA-256.'
        )
      names.add(asset.name)
      roles.add(asset.role)
    }
    platforms.add(info.id)
  }
  if (platforms.size !== Object.keys(TARGETS).length)
    throw new Error(
      'Windows x64, Apple Silicon and Intel Mac assets are all required before publication.'
    )
  return manifests.flatMap(manifest => manifest.assets)
}

export function assertRemoteAssets(expected, actual) {
  if (!Array.isArray(actual) || actual.length !== expected.length)
    throw new Error(
      'The draft must contain exactly the complete verified release asset set.'
    )
  const names = new Set()
  for (const asset of expected) {
    const matches = actual.filter(candidate => candidate.name === asset.name)
    if (
      matches.length !== 1 ||
      matches[0].size !== asset.bytes ||
      matches[0].state !== 'uploaded' ||
      matches[0].digest !== `sha256:${asset.sha256}`
    )
      throw new Error(
        `Remote asset is absent, incomplete or has a different digest: ${asset.name}`
      )
    names.add(asset.name)
  }
  return names.size
}

export async function assertBinaryArchitecture(path, target) {
  const info = targetInfo(target)
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (info.os === 'win32') {
      if (peMachine(header.subarray(0, bytesRead)) !== 0x8664)
        throw new Error('Windows executable is not x64.')
    } else {
      if (
        bytesRead < 8 ||
        header.readUInt32LE(0) !== 0xfeedfacf ||
        header.readUInt32LE(4) !==
          (info.arch === 'arm64' ? 0x0100000c : 0x01000007)
      )
        throw new Error(
          `Application executable is not a thin ${info.arch} Mach-O binary.`
        )
    }
  } finally {
    await handle.close()
  }
}

export function peMachine(header) {
  if (header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('Expected a Windows PE executable.')
  const offset = header.readUInt32LE(60)
  if (
    offset > header.length - 24 ||
    header.toString('ascii', offset, offset + 4) !== 'PE\0\0'
  )
    throw new Error('Malformed Windows PE header.')
  return header.readUInt16LE(offset + 4)
}

export async function assertInstallerContainer(path) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (![0x014c, 0x8664].includes(peMachine(header.subarray(0, bytesRead))))
      throw new Error('Unexpected NSIS executable container.')
  } finally {
    await handle.close()
  }
}

export async function loadMetadata(tag, root = ROOT) {
  const version = releaseVersion(tag)
  const [pkgText, lockText, configText, cargoText, cargoLock, licenseText] =
    await Promise.all([
      readFile(resolve(root, 'package.json'), 'utf8'),
      readFile(resolve(root, 'package-lock.json'), 'utf8'),
      readFile(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'),
      readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8'),
      readFile(resolve(root, 'src-tauri/Cargo.lock'), 'utf8'),
      readFile(resolve(root, 'LICENSE.md'), 'utf8'),
    ])
  const pkg = JSON.parse(pkgText),
    lock = JSON.parse(lockText),
    config = JSON.parse(configText)
  const cargoPackage =
    cargoText.match(/\[package\]([\s\S]*?)(?=\n\[|$)/u)?.[1] ?? ''
  const cargoVersion = cargoPackage.match(/^version\s*=\s*"([^"]+)"/mu)?.[1]
  const cargoLicense = cargoPackage.match(/^license\s*=\s*"([^"]+)"/mu)?.[1]
  const lockedPackage = cargoLock.match(
    /\[\[package\]\]\s*\nname = "typenext"\s*\nversion = "([^"]+)"/u
  )?.[1]
  if (
    [
      pkg.version,
      lock.version,
      lock.packages?.['']?.version,
      config.version,
      cargoVersion,
      lockedPackage,
    ].some(value => value !== version)
  )
    throw new Error(
      'Package, lock files, native crate and Tauri versions must match the release tag.'
    )
  if (
    pkg.license !== 'MIT' ||
    lock.packages?.['']?.license !== 'MIT' ||
    cargoLicense !== 'MIT' ||
    !licenseText.startsWith('MIT License')
  )
    throw new Error(
      'Project license metadata and LICENSE.md must agree on MIT before release.'
    )
  if (config.productName !== 'TypeNext')
    throw new Error('Unexpected desktop product name.')
  const resources = Object.keys(config.bundle?.resources ?? {})
  for (const required of [
    '../LICENSE.md',
    '../docs/licensing.md',
    '../public/notices/',
    '../public/fonts/licenses/',
    '../public/fonts/Miracode-LICENSE.txt',
    '../public/runtime/whistle/LICENSE',
    '../public/runtime/whistle/NOTICE',
  ])
    if (
      !resources.some(
        path => path.replace(/\/$/u, '') === required.replace(/\/$/u, '')
      )
    )
      throw new Error(
        `The installed app must include the licensing resource: ${required}`
      )
  for (const path of [
    'docs/licensing.md',
    'public/notices/THIRD-PARTY-NOTICES.md',
    `docs/release-notes/${tag}.md`,
  ])
    if ((await stat(resolve(root, path))).size === 0)
      throw new Error(`Missing release document: ${path}`)
  return { tag, version, config }
}
