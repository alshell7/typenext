import { readFile } from 'node:fs/promises'

// Verify real packaging output. NSIS has its own default icon even when the
// application icon is configured, so configuration/source hashes alone cannot
// establish that the downloaded installer has the shared mark.
export async function assertEmbeddedWindowsIcon(executable, ico) {
  const [binary, source] = await Promise.all([
    readFile(executable),
    readFile(ico),
  ])
  if (source.length < 22 || source.readUInt32LE(0) !== 0x00010000)
    throw new Error('Expected a valid canonical Windows ICO.')
  const count = source.readUInt16LE(4)
  if (!count || count > 32 || source.length < 6 + count * 16)
    throw new Error('Invalid canonical Windows ICO directory.')
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16,
      bytes = source.readUInt32LE(entry + 8),
      offset = source.readUInt32LE(entry + 12)
    if (!bytes || offset < 6 + count * 16 || offset + bytes > source.length)
      throw new Error('Invalid canonical Windows ICO image bounds.')
    if (!binary.includes(source.subarray(offset, offset + bytes)))
      throw new Error(
        `The packaged Windows executable is missing shared icon frame ${index}: ${executable}`
      )
  }
}

export async function assertMacIcon(icon, canonical) {
  const [actual, source] = await Promise.all([
    readFile(icon),
    readFile(canonical),
  ])
  if (!actual.equals(source))
    throw new Error('The Mac application icon differs from the shared ICNS.')
}
