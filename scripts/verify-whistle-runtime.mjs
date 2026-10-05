import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const base = new URL('../public/runtime/whistle/', import.meta.url)
const suffix = Buffer.from('\nexport default createNeedle;\n')
const artifacts = [
  {
    name: 'needle.js',
    bytes: 62_823,
    hash: 'f3f7366dcad9555b792ee519d2518f3c506038bcb2ffd179e76e850000749359',
  },
  {
    name: 'needle.wasm',
    bytes: 903_655,
    hash: 'c19b9ddf9c7de4eb4f37e5f1811c5bbea9f099041d2a27284daf89789ee8523d',
  },
]
for (const artifact of artifacts) {
  let bytes = await readFile(new URL(artifact.name, base))
  if (artifact.name.endsWith('.js')) {
    if (!bytes.subarray(-suffix.length).equals(suffix))
      throw new Error('Whistle ES module adapter has changed.')
    bytes = bytes.subarray(0, -suffix.length)
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== artifact.bytes || hash !== artifact.hash)
    throw new Error(
      `Bundled ${artifact.name} does not match its pinned upstream artifact.`
    )
}
const license = await readFile(new URL('LICENSE', base), 'utf8')
const notice = await readFile(new URL('NOTICE', base), 'utf8')
if (
  !license.includes('Apache License') ||
  !license.includes('Version 2.0') ||
  !notice.includes('c7c415a3d1b3d929014bc6e866d51ebb971f7089')
)
  throw new Error('Whistle upstream attribution is missing.')
process.stdout.write(
  'Pinned Whistle JS/WASM and Apache-2.0 attribution verified.\n'
)
