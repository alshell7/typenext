import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  TARGETS,
  ASSET_SUFFIXES,
  assertBinaryArchitecture,
  assertInside,
  assertInstallerContainer,
  assertManifestSet,
  assertRemoteAssets,
  loadMetadata,
  releaseVersion,
} from './lib.mjs'
import { collectNativeNotices } from './collect-rust-notices.mjs'

const tag = 'v0.1.0',
  commit = 'a'.repeat(40),
  sha256 = 'b'.repeat(64)
const digest = value => createHash('sha256').update(value).digest('hex')
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'typenext-release-tests-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function manifests() {
  return Object.entries(TARGETS).map(([target, info]) => ({
    schema: 1,
    target,
    platform: info.id,
    tag,
    version: '0.1.0',
    commit,
    assets: info.roles.map((role, index) => ({
      name: `TypeNext_0.1.0_${info.id.replace('-', '_')}${ASSET_SUFFIXES[role]}`,
      role,
      bytes: 100 + index,
      sha256,
    })),
  }))
}
test('only explicit stable semantic version tags are accepted', () => {
  assert.equal(releaseVersion(tag), '0.1.0')
  for (const value of [
    'main',
    'v01.0.0',
    'v0.1.0-beta',
    'v0.1.0\n',
    'v0.1.0; touch foo',
  ])
    assert.throws(() => releaseVersion(value))
})
test('all three native targets and every required asset are necessary', () => {
  assert.equal(assertManifestSet(manifests(), { tag, commit }).length, 7)
  assert.throws(
    () => assertManifestSet(manifests().slice(0, 2), { tag, commit }),
    /all required/u
  )
  const incomplete = manifests()
  incomplete[0].assets.pop()
  assert.throws(
    () => assertManifestSet(incomplete, { tag, commit }),
    /Incomplete/u
  )
})
test('an archive cannot impersonate a required installer or DMG', () => {
  const values = manifests()
  values[0].assets[0].name = 'TypeNext_0.1.0_windows_x64_wrong.zip'
  assert.throws(
    () => assertManifestSet(values, { tag, commit }),
    /wrong file type/u
  )
})
test('duplicate platforms cannot impersonate an absent architecture', () => {
  const values = manifests()
  values[2] = values[1]
  assert.throws(() => assertManifestSet(values, { tag, commit }), /Duplicate/u)
})
test('mixed commits and versions fail the release gate', () => {
  for (const field of ['tag', 'version', 'commit']) {
    const values = manifests()
    values[1][field] = 'different'
    assert.throws(
      () => assertManifestSet(values, { tag, commit }),
      /exact release/u
    )
  }
})
test('asset traversal, empty size and invalid hashes fail before upload', () => {
  for (const patch of [
    { name: '../unsafe.exe' },
    { bytes: 0 },
    { sha256: 'invalid' },
  ]) {
    const values = manifests()
    Object.assign(values[0].assets[0], patch)
    assert.throws(() => assertManifestSet(values, { tag, commit }))
  }
  assert.throws(() => assertInside('/release', '/elsewhere/file'))
  assert.throws(() => assertInside('/release', '/release'))
})
test('every remote asset must be complete with matching size and digest', () => {
  const expected = assertManifestSet(manifests(), { tag, commit })
  const actual = expected.map(asset => ({
    name: asset.name,
    size: asset.bytes,
    digest: `sha256:${asset.sha256}`,
    state: 'uploaded',
  }))
  assert.equal(assertRemoteAssets(expected, actual), 7)
  for (const patch of [
    { size: 1 },
    { state: 'new' },
    { digest: `sha256:${'c'.repeat(64)}` },
    { digest: null },
  ]) {
    const changed = structuredClone(actual)
    Object.assign(changed[0], patch)
    assert.throws(() => assertRemoteAssets(expected, changed))
  }
  assert.throws(() => assertRemoteAssets(expected, actual.slice(1)))
  assert.throws(() => assertRemoteAssets(expected, [...actual, actual[0]]))
})
function pe(machine) {
  const header = Buffer.alloc(128)
  header.write('MZ', 0)
  header.writeUInt32LE(80, 60)
  header.write('PE\0\0', 80)
  header.writeUInt16LE(machine, 84)
  return header
}
test('an i386 NSIS container is valid while the actual application must be x64', async t => {
  const root = await temporary(t),
    stub = join(root, 'setup.exe'),
    app = join(root, 'app.exe')
  await writeFile(stub, pe(0x014c))
  await writeFile(app, pe(0x8664))
  await assertInstallerContainer(stub)
  await assertBinaryArchitecture(app, 'x86_64-pc-windows-msvc')
  await assert.rejects(
    assertBinaryArchitecture(stub, 'x86_64-pc-windows-msvc'),
    /not x64/u
  )
  await writeFile(stub, 'not an installer')
  await assert.rejects(assertInstallerContainer(stub), /PE/u)
})
test('Apple Silicon and Intel executables cannot be swapped', async t => {
  const root = await temporary(t),
    binary = join(root, 'typenext')
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  await writeFile(binary, header)
  await assertBinaryArchitecture(binary, 'aarch64-apple-darwin')
  await assert.rejects(
    assertBinaryArchitecture(binary, 'x86_64-apple-darwin'),
    /thin x64/u
  )
  header.writeUInt32LE(0x01000007, 4)
  await writeFile(binary, header)
  await assertBinaryArchitecture(binary, 'x86_64-apple-darwin')
  await assert.rejects(
    assertBinaryArchitecture(binary, 'aarch64-apple-darwin'),
    /thin arm64/u
  )
})
async function crateFixture(t, license = 'MIT') {
  const root = await temporary(t),
    crate = join(root, 'crate'),
    output = join(root, 'notices'),
    fallbackRoot = join(root, 'fallback')
  await mkdir(crate)
  await writeFile(join(crate, 'Cargo.toml'), '[package]\nname="example"\n')
  const pkg = {
    id: 'example@1.0.0',
    name: 'example',
    version: '1.0.0',
    license,
    repository: 'https://github.com/example/example',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    authors: ['Example contributors'],
    manifest_path: join(crate, 'Cargo.toml'),
  }
  const metadata = { packages: [pkg], resolve: { nodes: [{ id: pkg.id }] } }
  return { root, crate, output, fallbackRoot, pkg, metadata }
}
test('published crate licenses and expressions are included', async t => {
  const fixture = await crateFixture(t)
  await writeFile(
    join(fixture.crate, 'LICENSE-MIT'),
    'Original upstream license'
  )
  const inventory = await collectNativeNotices(
    fixture.metadata,
    'x86_64-pc-windows-msvc',
    fixture.output
  )
  assert.equal(inventory[0].license, 'MIT')
  assert.equal(
    await readFile(join(fixture.output, inventory[0].files[0]), 'utf8'),
    'Original upstream license'
  )
})
test('missing full license files produce an inventory and fail', async t => {
  const fixture = await crateFixture(t)
  await assert.rejects(
    collectNativeNotices(
      fixture.metadata,
      'x86_64-pc-windows-msvc',
      fixture.output,
      fixture
    ),
    /without published full license/u
  )
  const inventory = JSON.parse(
    await readFile(join(fixture.output, 'inventory.json'), 'utf8')
  )
  assert.equal(inventory.missing.length, 1)
})
async function fallbackFixture(t) {
  const fixture = await crateFixture(t)
  const revision = 'd'.repeat(40),
    directory = join(fixture.fallbackRoot, 'example-1.0.0'),
    text = 'Pinned upstream MIT text'
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(fixture.crate, '.cargo_vcs_info.json'),
    JSON.stringify({ git: { sha1: revision }, path_in_vcs: 'example' })
  )
  await writeFile(join(directory, 'LICENSE'), text)
  const source = {
    name: fixture.pkg.name,
    version: fixture.pkg.version,
    repository: fixture.pkg.repository,
    cargoSource: fixture.pkg.source,
    revision,
    pathInVcs: 'example',
    files: [
      {
        path: 'LICENSE',
        url: `https://raw.githubusercontent.com/example/example/${revision}/LICENSE`,
        sha256: digest(text),
      },
    ],
  }
  await writeFile(join(directory, 'source.json'), JSON.stringify(source))
  return { ...fixture, directory, source }
}
test('reviewed fallback licenses match the locked revision and bytes', async t => {
  const fixture = await fallbackFixture(t)
  const inventory = await collectNativeNotices(
    fixture.metadata,
    'x86_64-pc-windows-msvc',
    fixture.output,
    fixture
  )
  assert.deepEqual(inventory[0].files, ['example-1.0.0/LICENSE'])
})
test('changed fallback bytes fail their pinned hash', async t => {
  const fixture = await fallbackFixture(t)
  await writeFile(join(fixture.directory, 'LICENSE'), 'Changed bytes')
  await assert.rejects(
    collectNativeNotices(
      fixture.metadata,
      'x86_64-pc-windows-msvc',
      fixture.output,
      fixture
    ),
    /changed bytes/u
  )
})
test('fallback revision drift and traversal fail closed', async t => {
  for (const patch of [
    { revision: 'e'.repeat(40) },
    { files: [{ path: '../outside', url: 'https://example.com', sha256 }] },
  ]) {
    const fixture = await fallbackFixture(t)
    Object.assign(fixture.source, patch)
    await writeFile(
      join(fixture.directory, 'source.json'),
      JSON.stringify(fixture.source)
    )
    await assert.rejects(
      collectNativeNotices(
        fixture.metadata,
        'x86_64-pc-windows-msvc',
        fixture.output,
        fixture
      )
    )
  }
})
test('MPL source is shipped while build and Git directories are excluded', async t => {
  const fixture = await crateFixture(t, 'MPL-2.0')
  await writeFile(join(fixture.crate, 'LICENSE'), 'Original MPL terms')
  await mkdir(join(fixture.crate, 'src'))
  await writeFile(join(fixture.crate, 'src/lib.rs'), 'pub fn original() {}')
  for (const excluded of ['target', '.git']) {
    await mkdir(join(fixture.crate, excluded))
    await writeFile(join(fixture.crate, excluded, 'build-data'), 'Excluded')
  }
  const inventory = await collectNativeNotices(
    fixture.metadata,
    'aarch64-apple-darwin',
    fixture.output
  )
  assert.equal(inventory[0].correspondingSource, 'example-1.0.0/source/')
  assert.equal(
    await readFile(
      join(fixture.output, inventory[0].correspondingSource, 'src/lib.rs'),
      'utf8'
    ),
    'pub fn original() {}'
  )
  await assert.rejects(
    readFile(
      join(
        fixture.output,
        inventory[0].correspondingSource,
        'target/build-data'
      )
    )
  )
})
test('declared license paths cannot copy data outside the published crate', async t => {
  const fixture = await crateFixture(t, 'MPL-2.0')
  await writeFile(join(fixture.root, 'outside'), 'Not a package license')
  fixture.pkg.license_file = '../outside'
  await assert.rejects(
    collectNativeNotices(
      fixture.metadata,
      'x86_64-pc-windows-msvc',
      fixture.output
    ),
    /outside/u
  )
})

async function standardFixture(t) {
  const fixture = await fallbackFixture(t)
  fixture.pkg.id = 'mac@0.1.1'
  fixture.pkg.name = 'mac'
  fixture.pkg.version = '0.1.1'
  fixture.pkg.license = 'MIT OR Apache-2.0'
  fixture.metadata.resolve.nodes[0].id = fixture.pkg.id
  const directory = join(fixture.fallbackRoot, 'mac-0.1.1')
  await mkdir(directory)
  const declaration = 'This published source declares MIT OR Apache-2.0.'
  const standardText = 'Apache License\nVersion 2.0, January 2004'
  await writeFile(join(directory, 'README.md'), declaration)
  await writeFile(join(directory, 'LICENSE-APACHE-2.0'), standardText)
  const source = {
    ...fixture.source,
    name: 'mac',
    version: '0.1.1',
    kind: 'referenced-standard-license',
    selectedLicense: 'Apache-2.0',
    files: [
      {
        path: 'README.md',
        url: `https://raw.githubusercontent.com/example/example/${fixture.source.revision}/README.md`,
        sha256: digest(declaration),
      },
    ],
    standardLicense: {
      path: 'LICENSE-APACHE-2.0',
      url: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
      sha256: digest(standardText),
    },
  }
  await writeFile(join(directory, 'source.json'), JSON.stringify(source))
  return { ...fixture, directory, source }
}
test('reviewed legacy Apache references preserve original declarations plus standard text', async t => {
  const fixture = await standardFixture(t)
  const inventory = await collectNativeNotices(
    fixture.metadata,
    'x86_64-pc-windows-msvc',
    fixture.output,
    fixture
  )
  assert.deepEqual(inventory[0].files, [
    'mac-0.1.1/README.md',
    'mac-0.1.1/LICENSE-APACHE-2.0',
  ])
})
test('standard-license references reject other packages or another canonical URL', async t => {
  for (const wrong of ['package', 'url']) {
    const fixture = await standardFixture(t)
    if (wrong === 'package') {
      fixture.pkg.license = 'MIT'
    } else {
      fixture.source.standardLicense.url = 'https://example.com/license.txt'
      await writeFile(
        join(fixture.directory, 'source.json'),
        JSON.stringify(fixture.source)
      )
    }
    await assert.rejects(
      collectNativeNotices(
        fixture.metadata,
        'x86_64-pc-windows-msvc',
        fixture.output,
        fixture
      )
    )
  }
})
test('missing VCS metadata requires the exact locked crate checksum', async t => {
  const fixture = await fallbackFixture(t)
  await rm(join(fixture.crate, '.cargo_vcs_info.json'))
  const lockFile = join(fixture.root, 'Cargo.lock')
  const checksum = 'f'.repeat(64)
  await writeFile(
    lockFile,
    `[[package]]\nname = "example"\nversion = "1.0.0"\nsource = "${fixture.pkg.source}"\nchecksum = "${checksum}"\n`
  )
  fixture.source.crateSha256 = checksum
  await writeFile(
    join(fixture.directory, 'source.json'),
    JSON.stringify(fixture.source)
  )
  const inventory = await collectNativeNotices(
    fixture.metadata,
    'x86_64-pc-windows-msvc',
    fixture.output,
    { ...fixture, lockFile }
  )
  assert.equal(inventory.length, 1)
  fixture.source.crateSha256 = 'a'.repeat(64)
  await writeFile(
    join(fixture.directory, 'source.json'),
    JSON.stringify(fixture.source)
  )
  await assert.rejects(
    collectNativeNotices(
      fixture.metadata,
      'x86_64-pc-windows-msvc',
      join(fixture.root, 'invalid-notices'),
      { ...fixture, lockFile }
    ),
    /locked published crate checksum/u
  )
})

test('reviewed MIT references retain placeholders and refuse unreviewed package versions', async t => {
  const fixture = await standardFixture(t)
  fixture.pkg.name = 'convert_case'
  fixture.pkg.version = '0.4.0'
  fixture.pkg.id = 'convert_case@0.4.0'
  fixture.pkg.license = 'MIT'
  fixture.metadata.resolve.nodes[0].id = fixture.pkg.id
  const directory = join(fixture.fallbackRoot, 'convert_case-0.4.0')
  await mkdir(directory)
  await writeFile(
    join(directory, 'README.md'),
    await readFile(join(fixture.directory, 'README.md'))
  )
  const standardText = 'MIT License\nCopyright <YEAR> <COPYRIGHT HOLDER>'
  await writeFile(join(directory, 'LICENSE-MIT-standard.txt'), standardText)
  const source = {
    ...fixture.source,
    name: 'convert_case',
    version: '0.4.0',
    selectedLicense: 'MIT',
    standardLicense: {
      path: 'LICENSE-MIT-standard.txt',
      url: 'https://opensource.org/license/mit',
      sha256: digest(standardText),
    },
  }
  await writeFile(join(directory, 'source.json'), JSON.stringify(source))
  const inventory = await collectNativeNotices(
    fixture.metadata,
    'x86_64-pc-windows-msvc',
    fixture.output,
    fixture
  )
  assert.equal(
    await readFile(
      join(fixture.output, 'convert_case-0.4.0/LICENSE-MIT-standard.txt'),
      'utf8'
    ),
    standardText
  )
  assert.equal(inventory[0].files.length, 2)
  fixture.pkg.name = 'unreviewed'
  fixture.pkg.id = 'unreviewed@0.4.0'
  fixture.metadata.resolve.nodes[0].id = fixture.pkg.id
  const invalidDirectory = join(fixture.fallbackRoot, 'unreviewed-0.4.0')
  await mkdir(invalidDirectory)
  await writeFile(
    join(invalidDirectory, 'README.md'),
    await readFile(join(directory, 'README.md'))
  )
  await writeFile(
    join(invalidDirectory, 'LICENSE-MIT-standard.txt'),
    standardText
  )
  await writeFile(
    join(invalidDirectory, 'source.json'),
    JSON.stringify({ ...source, name: 'unreviewed' })
  )
  await assert.rejects(
    collectNativeNotices(
      fixture.metadata,
      'x86_64-pc-windows-msvc',
      join(fixture.root, 'unreviewed-notices'),
      fixture
    ),
    /explicitly reviewed/u
  )
})
