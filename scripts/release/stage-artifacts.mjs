import { execFileSync } from 'node:child_process'
import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { assertEmbeddedWindowsIcon, assertMacIcon } from './native-icons.mjs'
import {
  ROOT,
  assertBinaryArchitecture,
  assertInside,
  assertInstallerContainer,
  fileRecord,
  loadMetadata,
  targetInfo,
} from './lib.mjs'

const target = process.argv[2],
  info = targetInfo(target)
if (process.platform !== info.os || process.arch !== info.arch)
  throw new Error(
    'Release tests and packaging must run on the matching native operating system and architecture.'
  )
const { tag, version, config } = await loadMetadata(process.env.RELEASE_TAG)
const commit = process.env.RELEASE_COMMIT
if (!/^[a-f0-9]{40}$/u.test(commit ?? ''))
  throw new Error('A full release commit SHA is required.')
const base = resolve(ROOT, 'artifacts/release')
await mkdir(base, { recursive: true })
const stage = assertInside(base, resolve(base, info.id))
await mkdir(stage) // A fresh directory avoids mixing an old release into this one.
const upload = join(stage, 'upload'),
  payload = join(stage, `TypeNext_${version}_${info.id.replace('-', '_')}`)
await mkdir(upload)
await mkdir(payload)
for (const [source, name] of Object.entries(config.bundle.resources)) {
  const from = assertInside(ROOT, resolve(ROOT, 'src-tauri', source))
  const to = assertInside(payload, resolve(payload, name))
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  })
}
const nativeInventory = JSON.parse(
  await readFile(
    resolve(ROOT, `public/notices/native-${info.id}/inventory.json`),
    'utf8'
  )
)
if (
  nativeInventory.target !== target ||
  nativeInventory.missing?.length ||
  !nativeInventory.packages?.length
)
  throw new Error(
    'The packaged native license inventory is missing or belongs to another target.'
  )
const assets = [],
  prefix = `TypeNext_${version}_${info.id.replace('-', '_')}`
const release = resolve(ROOT, 'src-tauri/target', target, 'release')

async function bundleFile(directory, extension) {
  const candidates = (await readdir(directory)).filter(
    name => name.endsWith(extension) && name.includes(version)
  )
  if (candidates.length !== 1)
    throw new Error(
      `Expected exactly one ${version} ${extension} bundle in ${directory}.`
    )
  return join(directory, candidates[0])
}
async function add(source, name, role) {
  const destination = join(upload, name)
  await copyFile(source, destination)
  assets.push(await fileRecord(destination, role))
}

if (info.os === 'win32') {
  const executable = join(release, 'typenext.exe')
  await assertBinaryArchitecture(executable, target)
  await assertEmbeddedWindowsIcon(
    executable,
    join(ROOT, 'src-tauri/icons/icon.ico')
  )
  await copyFile(executable, join(payload, 'TypeNext.exe'))
  await writeFile(
    join(payload, 'START-HERE.txt'),
    'Run TypeNext.exe on Windows x64. Microsoft WebView2 Runtime is required. The setup.exe installs TypeNext and provisions WebView2 when needed. Local model weights are optional explicit downloads.\n'
  )
  const installer = await bundleFile(join(release, 'bundle/nsis'), '.exe')
  // NSIS commonly uses an i386 launcher even for a verified x64 application.
  await assertInstallerContainer(installer)
  await assertEmbeddedWindowsIcon(
    installer,
    join(ROOT, 'src-tauri/icons/icon.ico')
  )
  await add(installer, `${prefix}_setup.exe`, 'installer-exe')
  await add(
    await bundleFile(join(release, 'bundle/msi'), '.msi'),
    `${prefix}.msi`,
    'installer-msi'
  )
  const zip = join(upload, `${prefix}_portable.zip`)
  execFileSync(
    'tar.exe',
    ['-a', '-c', '-f', zip, '-C', stage, basename(payload)],
    { stdio: 'inherit' }
  )
  assets.push(await fileRecord(zip, 'portable-zip'))
} else {
  const app = join(release, 'bundle/macos/TypeNext.app')
  const executable = join(app, 'Contents/MacOS/typenext')
  await assertBinaryArchitecture(executable, target)
  await assertMacIcon(
    join(app, 'Contents/Resources/icon.icns'),
    join(ROOT, 'src-tauri/icons/icon.icns')
  )
  const bundleVersion = execFileSync(
    '/usr/libexec/PlistBuddy',
    [
      '-c',
      'Print :CFBundleShortVersionString',
      join(app, 'Contents/Info.plist'),
    ],
    { encoding: 'utf8' }
  ).trim()
  if (bundleVersion !== version)
    throw new Error(
      'The Mac application bundle version differs from the release tag.'
    )
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], {
    stdio: 'inherit',
  })
  // ditto preserves application permissions, symlinks and extended attributes.
  execFileSync('ditto', [app, join(payload, 'TypeNext.app')], {
    stdio: 'inherit',
  })
  const dmg = await bundleFile(join(release, 'bundle/dmg'), '.dmg')
  execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit' })
  await add(dmg, `${prefix}.dmg`, 'dmg')
  const zip = join(upload, `${prefix}.app.zip`)
  execFileSync(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', payload, zip],
    { stdio: 'inherit' }
  )
  assets.push(await fileRecord(zip, 'app-zip'))
}
await writeFile(
  join(upload, `manifest-${info.id}.json`),
  JSON.stringify(
    { schema: 1, tag, version, commit, target, platform: info.id, assets },
    null,
    2
  ) + '\n'
)
console.log(
  `Staged ${assets.length} ${info.id} assets with project and target-specific dependency notices.`
)
