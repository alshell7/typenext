import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'

/**
 * End-to-end encryption for cloud sync. The database sees only opaque record
 * ids, revision numbers and ciphertext.
 *
 * - A random 256-bit data key encrypts everything. It never leaves a device
 *   unwrapped.
 * - The vault header stores the data key wrapped once by the sync key (a
 *   passphrase, PBKDF2-SHA256) and once by each recovery key (160 random bits,
 *   HKDF-SHA256). A recovery key can therefore set a new sync key without
 *   re-encrypting any record.
 * - Records are deflated, then sealed with AES-256-GCM. The associated data
 *   binds each ciphertext to its vault, record id and key epoch, so a
 *   database cannot swap or replay records between slots unnoticed.
 * - Record ids are HMAC-SHA256 of the item kind and id: the database cannot
 *   tell a note from a tag, or link a record to a note.
 */

export const DEFAULT_KDF_ITERATIONS = 600_000
export const RECOVERY_KEY_COUNT = 3
const RECOVERY_BYTES = 20
const FORMAT = 1
const FLAG_DEFLATED = 1
/** Deflating tiny payloads only adds bytes. */
const DEFLATE_FROM = 160

export interface VaultSlot {
  kind: 'master' | 'recovery'
  id: string
  createdAt: number
  /** Recovery slots: the HKDF salt. */
  salt?: string
  iv: string
  data: string
}

export interface VaultHeader {
  v: 1
  vaultId: string
  createdAt: number
  /** Raised when the data key is replaced; part of every record's AAD. */
  epoch: number
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
  slots: VaultSlot[]
  /** Devices removed from the vault. They forget the key at their next sync. */
  revoked?: string[]
  updatedAt: number
}

export interface Keyring {
  vaultId: string
  epoch: number
  enc: CryptoKey
  mac: CryptoKey
}

export class WrongKeyError extends Error {
  constructor(message = 'This key does not open the encrypted notebook.') {
    super(message)
    this.name = 'WrongKeyError'
  }
}

// ------------------------------------------------------------------ Bytes

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle)
    throw new Error('Encrypted sync needs Web Crypto, which is unavailable.')
  return globalThis.crypto.subtle
}

/** A copy backed by a plain ArrayBuffer, as Web Crypto expects. */
function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '')
}

/** Short random ids for vaults, devices and targets. */
export function randomId(bytes = 12): string {
  return toBase64Url(randomBytes(bytes))
}

const encoder = new TextEncoder()

function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

// --------------------------------------------------------------- Recovery

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += CROCKFORD[(value << (5 - bits)) & 31]
  return output
}

function fromBase32(text: string): Uint8Array | null {
  let bits = 0
  let value = 0
  const output: number[] = []
  for (const character of text) {
    const index = CROCKFORD.indexOf(character)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(output)
}

/** XXXX-XXXX-… in Crockford base 32: no I, L, O or U to misread. */
export function formatRecoveryKey(bytes: Uint8Array): string {
  return (base32(bytes).match(/.{1,4}/gu) ?? []).join('-')
}

/** Accepts any case, spaces or dashes, and the usual look-alikes. */
export function parseRecoveryKey(input: string): Uint8Array | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replace(/[IL]/gu, '1')
    .replace(/O/gu, '0')
  if (cleaned.length !== Math.ceil((RECOVERY_BYTES * 8) / 5)) return null
  const bytes = fromBase32(cleaned)
  return bytes && bytes.length === RECOVERY_BYTES ? bytes : null
}

export function looksLikeRecoveryKey(input: string): boolean {
  return parseRecoveryKey(input) !== null
}

// ------------------------------------------------------------------- Keys

async function passphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw',
    buffer(utf8(passphrase.normalize('NFKC'))),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function recoveryKek(
  code: Uint8Array,
  salt: Uint8Array
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    'raw',
    buffer(code),
    'HKDF',
    false,
    ['deriveKey']
  )
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: buffer(salt),
      info: buffer(utf8('typenext/recovery/v1')),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function slotAad(vaultId: string, slot: Pick<VaultSlot, 'kind' | 'id'>) {
  return utf8(`typenext/vault/v1|${vaultId}|${slot.kind}|${slot.id}`)
}

async function wrap(
  kek: CryptoKey,
  dataKey: Uint8Array,
  vaultId: string,
  slot: Pick<VaultSlot, 'kind' | 'id' | 'createdAt' | 'salt'>
): Promise<VaultSlot> {
  const iv = randomBytes(12)
  const data = await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: buffer(iv),
      additionalData: buffer(slotAad(vaultId, slot)),
    },
    kek,
    buffer(dataKey)
  )
  return {
    ...slot,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  }
}

async function unwrap(
  kek: CryptoKey,
  vaultId: string,
  slot: VaultSlot
): Promise<Uint8Array | null> {
  try {
    const data = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: buffer(fromBase64(slot.iv)),
        additionalData: buffer(slotAad(vaultId, slot)),
      },
      kek,
      buffer(fromBase64(slot.data))
    )
    return new Uint8Array(data)
  } catch {
    return null
  }
}

/** Separate record and id keys, both unusable outside Web Crypto. */
export async function keyringFromDataKey(
  vaultId: string,
  epoch: number,
  dataKey: Uint8Array
): Promise<Keyring> {
  const material = await subtle().importKey(
    'raw',
    buffer(dataKey),
    'HKDF',
    false,
    ['deriveKey']
  )
  const salt = buffer(utf8(`typenext/${vaultId}/${epoch}`))
  const enc = await subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: buffer(utf8('typenext/records/v1')),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  const mac = await subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: buffer(utf8('typenext/ids/v1')),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  )
  return { vaultId, epoch, enc, mac }
}

// ------------------------------------------------------------------ Vault

export interface OpenedVault {
  header: VaultHeader
  keyring: Keyring
  /** The raw data key, kept only while a key dialog needs it. */
  dataKey: Uint8Array
}

export async function createVault(
  passphrase: string,
  options: { iterations?: number; now?: number } = {}
): Promise<OpenedVault & { recoveryKeys: string[] }> {
  const now = options.now ?? Date.now()
  const vaultId = randomId(12)
  const dataKey = randomBytes(32)
  const base: VaultHeader = {
    v: 1,
    vaultId,
    createdAt: now,
    epoch: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: 0, salt: '' },
    slots: [],
    updatedAt: now,
  }
  const withMaster = await setSyncKey(base, dataKey, passphrase, options)
  const { header, recoveryKeys } = await replaceRecoveryKeys(
    withMaster,
    dataKey,
    now
  )
  return {
    header,
    keyring: await keyringFromDataKey(vaultId, header.epoch, dataKey),
    dataKey,
    recoveryKeys,
  }
}

/** Wrap the data key with a new sync key, replacing the old one. */
export async function setSyncKey(
  header: VaultHeader,
  dataKey: Uint8Array,
  passphrase: string,
  options: { iterations?: number; now?: number } = {}
): Promise<VaultHeader> {
  const problem = syncKeyProblem(passphrase)
  if (problem) throw new Error(problem)
  const now = options.now ?? Date.now()
  const iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS
  const salt = randomBytes(16)
  const kek = await passphraseKey(passphrase, salt, iterations)
  const slot = await wrap(kek, dataKey, header.vaultId, {
    kind: 'master',
    id: randomId(6),
    createdAt: now,
  })
  return {
    ...header,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt: toBase64(salt) },
    slots: [...header.slots.filter(item => item.kind !== 'master'), slot],
    updatedAt: now,
  }
}

/** New recovery keys. The old ones stop working. */
export async function replaceRecoveryKeys(
  header: VaultHeader,
  dataKey: Uint8Array,
  now = Date.now()
): Promise<{ header: VaultHeader; recoveryKeys: string[] }> {
  const recoveryKeys: string[] = []
  const slots: VaultSlot[] = []
  for (let index = 0; index < RECOVERY_KEY_COUNT; index++) {
    const code = randomBytes(RECOVERY_BYTES)
    const salt = randomBytes(16)
    slots.push(
      await wrap(await recoveryKek(code, salt), dataKey, header.vaultId, {
        kind: 'recovery',
        id: randomId(6),
        createdAt: now,
        salt: toBase64(salt),
      })
    )
    recoveryKeys.push(formatRecoveryKey(code))
  }
  return {
    header: {
      ...header,
      slots: [
        ...header.slots.filter(item => item.kind !== 'recovery'),
        ...slots,
      ],
      updatedAt: now,
    },
    recoveryKeys,
  }
}

/** Open with the sync key or any recovery key. */
export async function openVault(
  header: VaultHeader,
  secret: string
): Promise<OpenedVault & { via: 'sync-key' | 'recovery-key' }> {
  const recovery = parseRecoveryKey(secret)
  if (recovery) {
    for (const slot of header.slots) {
      if (slot.kind !== 'recovery' || !slot.salt) continue
      const kek = await recoveryKek(recovery, fromBase64(slot.salt))
      const dataKey = await unwrap(kek, header.vaultId, slot)
      if (dataKey)
        return {
          header,
          dataKey,
          keyring: await keyringFromDataKey(
            header.vaultId,
            header.epoch,
            dataKey
          ),
          via: 'recovery-key',
        }
    }
  }
  const master = header.slots.find(slot => slot.kind === 'master')
  if (master && secret) {
    const kek = await passphraseKey(
      secret,
      fromBase64(header.kdf.salt),
      header.kdf.iterations
    )
    const dataKey = await unwrap(kek, header.vaultId, master)
    if (dataKey)
      return {
        header,
        dataKey,
        keyring: await keyringFromDataKey(
          header.vaultId,
          header.epoch,
          dataKey
        ),
        via: 'sync-key',
      }
  }
  throw new WrongKeyError(
    recovery
      ? 'This recovery key does not open the encrypted notebook. It may have been replaced.'
      : undefined
  )
}

/** Why a sync key is too weak, or an empty string. */
export function syncKeyProblem(passphrase: string): string {
  const text = passphrase.normalize('NFKC')
  if (text.trim().length < 10) return 'Use at least 10 characters.'
  if (new Set(text).size < 5) return 'Use more varied characters.'
  return ''
}

/** A rough strength estimate for the meter: 0 (weak) to 4 (strong). */
export function syncKeyStrength(passphrase: string): number {
  const text = passphrase.normalize('NFKC')
  if (syncKeyProblem(text)) return 0
  let pool = 0
  if (/[a-z]/u.test(text)) pool += 26
  if (/[A-Z]/u.test(text)) pool += 26
  if (/\d/u.test(text)) pool += 10
  if (/[^a-zA-Z\d]/u.test(text)) pool += 33
  const bits =
    Math.log2(Math.max(pool, 2)) * new Set(text).size * 0.6 +
    Math.log2(Math.max(text.length, 1)) * 4
  if (bits < 40) return 1
  if (bits < 60) return 2
  if (bits < 80) return 3
  return 4
}

const WORDS =
  'amber,anchor,apple,arrow,aspen,atlas,autumn,badge,bamboo,basil,beacon,birch,bloom,breeze,brook,cabin,cactus,canyon,cedar,cello,cherry,cider,clover,cobalt,comet,coral,cotton,crane,crystal,dahlia,delta,denim,dune,ember,falcon,fern,fjord,flint,forest,garnet,ginger,glacier,granite,harbor,hazel,heron,honey,indigo,iris,ivory,jasper,juniper,kestrel,lagoon,lantern,lemon,lilac,linen,lotus,maple,marble,meadow,mint,mosaic,nectar,nimbus,oasis,olive,onyx,orchid,otter,pebble,pepper,pine,plum,prairie,quartz,quill,raven,reef,ripple,river,saffron,sage,sequoia,sierra,slate,sparrow,spruce,summit,tango,thistle,tide,timber,topaz,tulip,velvet,violet,walnut,willow,winter,zephyr'.split(
    ','
  )

/** Five random words and a number: about 39 bits plus the number. */
export function suggestSyncKey(): string {
  const picks = randomBytes(6)
  const words = Array.from(
    picks.subarray(0, 5),
    byte => WORDS[byte % WORDS.length]
  )
  return `${words.join('-')}-${10 + (picks[5]! % 90)}`
}

// ---------------------------------------------------------------- Records

const idCache = new WeakMap<CryptoKey, Map<string, string>>()

/** The opaque database id of one item. */
export async function recordId(
  keyring: Keyring,
  kind: string,
  itemId: string
): Promise<string> {
  let cache = idCache.get(keyring.mac)
  if (!cache) {
    cache = new Map()
    idCache.set(keyring.mac, cache)
  }
  const name = `${kind}:${itemId}`
  const cached = cache.get(name)
  if (cached) return cached
  const signature = await subtle().sign('HMAC', keyring.mac, buffer(utf8(name)))
  const value = toBase64Url(new Uint8Array(signature).subarray(0, 18))
  cache.set(name, value)
  return value
}

function recordAad(keyring: Keyring, slot: string, epoch: number) {
  return utf8(`typenext/record/v1|${keyring.vaultId}|${slot}|${epoch}`)
}

/** Deflate when it helps, then AES-256-GCM. The result is base 64 text. */
export async function seal(
  keyring: Keyring,
  slot: string,
  value: unknown
): Promise<string> {
  const plain = strToU8(JSON.stringify(value))
  const deflated = plain.length >= DEFLATE_FROM ? deflateSync(plain) : null
  const useDeflated = deflated !== null && deflated.length < plain.length
  const body = useDeflated ? deflated : plain
  const iv = randomBytes(12)
  const cipher = new Uint8Array(
    await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: buffer(iv),
        additionalData: buffer(recordAad(keyring, slot, keyring.epoch)),
      },
      keyring.enc,
      buffer(body)
    )
  )
  const output = new Uint8Array(6 + 12 + cipher.length)
  output[0] = FORMAT
  output[1] = useDeflated ? FLAG_DEFLATED : 0
  new DataView(output.buffer).setUint32(2, keyring.epoch)
  output.set(iv, 6)
  output.set(cipher, 18)
  return toBase64(output)
}

/** Opens what seal() made for the same slot. Throws on any tampering. */
export async function open<T = unknown>(
  keyring: Keyring,
  slot: string,
  text: string
): Promise<T> {
  const bytes = fromBase64(text)
  if (bytes.length < 18 + 16 || bytes[0] !== FORMAT)
    throw new Error('This record was written by a newer version of TypeNext.')
  const epoch = new DataView(bytes.buffer, bytes.byteOffset).getUint32(2)
  if (epoch !== keyring.epoch)
    throw new WrongKeyError('This record uses a different encryption key.')
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: buffer(bytes.subarray(6, 18)),
          additionalData: buffer(recordAad(keyring, slot, epoch)),
        },
        keyring.enc,
        buffer(bytes.subarray(18))
      )
    )
  } catch {
    throw new WrongKeyError(
      'A record could not be decrypted. It may be damaged.'
    )
  }
  const body = bytes[1]! & FLAG_DEFLATED ? inflateSync(plain) : plain
  return JSON.parse(strFromU8(body)) as T
}

// ----------------------------------------------------------------- Header

export function encodeHeader(header: VaultHeader): string {
  return JSON.stringify(header)
}

/** Reads a header from the database; null when it is not one of ours. */
export function decodeHeader(text: string): VaultHeader | null {
  try {
    const value = JSON.parse(text) as Partial<VaultHeader>
    if (
      value.v !== 1 ||
      typeof value.vaultId !== 'string' ||
      typeof value.epoch !== 'number' ||
      value.kdf?.name !== 'PBKDF2-SHA256' ||
      typeof value.kdf.iterations !== 'number' ||
      value.kdf.iterations < 100_000 ||
      !Array.isArray(value.slots)
    )
      return null
    return value as VaultHeader
  } catch {
    return null
  }
}
