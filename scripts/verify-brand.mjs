import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzlibSync } from 'fflate'

const root = new URL('../', import.meta.url)
const fail = message => {
  throw new Error(message)
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(
  await readFile(new URL('public/brand/icon-manifest.json', root), 'utf8')
)
const master = await readFile(new URL('public/brand/logo-master.png', root))
if (
  manifest.schema !== 1 ||
  manifest.master !== 'public/brand/logo-master.png' ||
  hash(master) !== manifest.masterSha256
)
  fail(
    'The logo master changed. Run node scripts/prepare-icons.mjs before releasing.'
  )
const uiIcon = await readFile(new URL('public/Icon.png', root))
if (
  manifest.uiIcon?.path !== 'public/Icon.png' ||
  hash(uiIcon) !== manifest.uiIcon.sha256 ||
  manifest.uiIcon.sha256 !== manifest.icons['src-tauri/icons/128x128@2x.png']
)
  fail(
    'The app and browser must use the verified 256px derivative of the same master.'
  )
const config = JSON.parse(
  await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8')
)
for (const file of config.bundle.icon)
  if (!Object.hasOwn(manifest.icons, `src-tauri/${file}`))
    fail(`Unverified bundle icon: ${file}`)
if (
  config.bundle.windows?.nsis?.installerIcon !== 'icons/icon.ico' ||
  config.bundle.windows?.nsis?.installerHooks !== 'icons/nsis-branding.nsh'
)
  fail('Windows installer and uninstaller must explicitly use the shared icon.')
const nsisBranding = await readFile(
  new URL('src-tauri/icons/nsis-branding.nsh', root),
  'utf8'
)
if (!nsisBranding.includes('!define MUI_UNICON "${__FILEDIR__}\\icon.ico"'))
  fail('The NSIS uninstaller must select the canonical icon beside its hook.')
for (const [file, expected] of Object.entries(manifest.icons)) {
  if (!/^src-tauri\/icons\/[\w@.]+$/u.test(file))
    fail('Invalid icon manifest path.')
  const bytes = await readFile(new URL(file, root))
  if (hash(bytes) !== expected)
    fail(`Icon differs from the generated master: ${file}`)
  if (file.endsWith('.ico') && bytes.readUInt32LE(0) !== 0x00010000)
    fail('Invalid Windows ICO.')
  if (file.endsWith('.icns') && bytes.toString('ascii', 0, 4) !== 'icns')
    fail('Invalid macOS ICNS.')
}

// Inspect the master without altering it: the two bright glyph components must
// align at their top/bottom edges. One-pixel antialiasing differences are allowed.
function pixels(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    fail('Logo must be PNG.')
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20)
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0
  if (
    width !== height ||
    width < 512 ||
    width > 4096 ||
    bytes[24] !== 8 ||
    bytes[28] !== 0 ||
    !channels
  )
    fail('Logo must be a square non-interlaced 8-bit RGB/RGBA PNG.')
  const compressed = []
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset),
      type = bytes.toString('ascii', offset + 4, offset + 8)
    if (offset + size + 12 > bytes.length) fail('Invalid PNG chunk.')
    if (type === 'IDAT')
      compressed.push(bytes.subarray(offset + 8, offset + 8 + size))
    offset += size + 12
  }
  const raw = unzlibSync(Buffer.concat(compressed)),
    stride = width * channels
  if (raw.length !== height * (stride + 1))
    fail('Unexpected PNG scanline size.')
  const decoded = new Uint8Array(width * height * channels)
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) fail('Unsupported PNG filter.')
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        a = x >= channels ? decoded[at - channels] : 0
      const b = y ? decoded[at - stride] : 0,
        c = y && x >= channels ? decoded[at - stride - channels] : 0
      const correction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][
        filter
      ]
      decoded[at] = (raw[y * (stride + 1) + x + 1] + correction) & 255
    }
  }
  return { width, height, channels, decoded }
}
const { width, height, channels, decoded } = pixels(master)
const columns = Array.from({ length: width }, () => ({ min: height, max: -1 }))
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const at = (y * width + x) * channels
    if (
      Math.min(decoded[at], decoded[at + 1], decoded[at + 2]) >= 200 &&
      (channels === 3 || decoded[at + 3] >= 200)
    ) {
      columns[x].min = Math.min(columns[x].min, y)
      columns[x].max = Math.max(columns[x].max, y)
    }
  }
const glyphs = []
for (let x = 0; x < width; x++) {
  if (columns[x].max < 0) continue
  const bounds = { left: x, right: x, top: height, bottom: -1 }
  while (x < width && columns[x].max >= 0) {
    bounds.right = x
    bounds.top = Math.min(bounds.top, columns[x].min)
    bounds.bottom = Math.max(bounds.bottom, columns[x].max)
    x++
  }
  glyphs.push(bounds)
}
if (glyphs.length !== 2)
  fail('The mark must contain exactly two separate white glyphs.')
if (
  Math.abs(glyphs[0].top - glyphs[1].top) > 1 ||
  Math.abs(glyphs[0].bottom - glyphs[1].bottom) > 1
)
  fail(`Glyph heights do not align: ${JSON.stringify(glyphs)}`)
for (const [x, y] of [
  [0, 0],
  [width - 1, 0],
  [0, height - 1],
  [width - 1, height - 1],
]) {
  const at = (y * width + x) * channels
  if (
    Math.max(decoded[at], decoded[at + 1], decoded[at + 2]) > 5 ||
    (channels === 4 && decoded[at + 3] !== 255)
  )
    fail('The icon background must be opaque black.')
}
console.log(
  JSON.stringify({
    status: 'passed',
    master: manifest.master,
    width,
    height,
    glyphs,
    verifiedIcons: Object.keys(manifest.icons).length,
  })
)
