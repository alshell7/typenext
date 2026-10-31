import { invoke } from '@tauri-apps/api/core'
import type { CloudTarget } from '../../types/notebook'
import { getSecret, isDesktop, setSecret } from '../native'
import {
  WrongKeyError,
  createVault,
  decodeHeader,
  encodeHeader,
  open,
  openVault,
  randomId,
  replaceRecoveryKeys,
  seal,
  setSyncKey,
  type Keyring,
  type VaultHeader,
} from './crypto'
import { forgetKeyring, loadKeyring, saveKeyring } from './state'
import {
  D1Transport,
  NeonTransport,
  parseNeonConnection,
  type SyncTransport,
  type VaultRow,
} from './transport'

/**
 * Databases, keys and devices. Credentials stay in the credential vault (the
 * system keychain in the desktop app); the notebook keeps only what is safe
 * to save in it.
 */

export type SecretName = 'connection' | 'realtime' | 'api'

export function secretId(targetId: string, name: SecretName) {
  return `cloud:${targetId}:${name}`
}

export async function saveTargetSecret(
  targetId: string,
  name: SecretName,
  value: string
) {
  await setSecret(secretId(targetId, name), value.trim(), true)
}

export async function readTargetSecret(targetId: string, name: SecretName) {
  return getSecret(secretId(targetId, name))
}

export async function forgetTargetSecrets(targetId: string) {
  for (const name of ['connection', 'realtime', 'api'] as const)
    await setSecret(secretId(targetId, name), '', false).catch(() => {})
}

export function newTargetId() {
  return `t${randomId(6).replace(/[^a-zA-Z0-9]/gu, '')}`
}

export function targetLabel(kind: CloudTarget['kind'], detail: string) {
  return kind === 'neon' ? `Neon · ${detail}` : `Cloudflare D1 · ${detail}`
}

/** A transport for a configured database, or why there is none. */
export async function transportFor(
  target: CloudTarget
): Promise<SyncTransport> {
  if (target.kind === 'neon') {
    const connection = await readTargetSecret(target.id, 'connection')
    if (!connection)
      throw new MissingCredentialsError(
        'Enter the Neon connection string again to sync on this device.'
      )
    return new NeonTransport(connection)
  }
  const api = await readTargetSecret(target.id, 'api')
  if (!api || !target.accountId || !target.databaseId)
    throw new MissingCredentialsError(
      'Enter the Cloudflare API token again to sync on this device.'
    )
  return new D1Transport(target.accountId, target.databaseId, api)
}

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingCredentialsError'
  }
}

/** The Neon database name, for Realtime. */
export async function neonDatabase(target: CloudTarget): Promise<string> {
  const connection = await readTargetSecret(target.id, 'connection')
  return parseNeonConnection(connection).database
}

// ------------------------------------------------------------------ Vaults

export interface FoundVault {
  row: VaultRow
  header: VaultHeader
}

/** Set up the tables and list the encrypted notebooks a database holds. */
export async function discoverVaults(
  transport: SyncTransport
): Promise<FoundVault[]> {
  await transport.setup()
  return (await transport.vaults())
    .map(row => ({ row, header: decodeHeader(row.header) }))
    .filter((item): item is FoundVault => item.header !== null)
}

export async function readHeader(
  transport: SyncTransport,
  vaultId: string
): Promise<FoundVault | null> {
  return (
    (await discoverVaults(transport)).find(
      item => item.header.vaultId === vaultId
    ) ?? null
  )
}

/** A new encrypted notebook in this database. */
export async function createVaultIn(
  transport: SyncTransport,
  passphrase: string,
  options: { iterations?: number } = {}
): Promise<{ header: VaultHeader; keyring: Keyring; recoveryKeys: string[] }> {
  await transport.setup()
  const vault = await createVault(passphrase, options)
  const stored = await transport.putVault(
    vault.header.vaultId,
    encodeHeader(vault.header),
    null,
    vault.header.updatedAt
  )
  if (!stored)
    throw new Error('The database refused the new notebook. Try again.')
  await saveKeyring(vault.keyring)
  return {
    header: vault.header,
    keyring: vault.keyring,
    recoveryKeys: vault.recoveryKeys,
  }
}

/** Copy an existing notebook's header into another, empty database. */
export async function attachVault(
  transport: SyncTransport,
  header: VaultHeader
) {
  await transport.setup()
  const existing = await readHeader(transport, header.vaultId)
  if (existing) return
  await transport.putVault(
    header.vaultId,
    encodeHeader(header),
    null,
    header.updatedAt
  )
}

/** Open with the sync key or a recovery key, and remember on this device. */
export async function unlockVault(
  header: VaultHeader,
  secret: string,
  device: string
): Promise<{ keyring: Keyring; via: 'sync-key' | 'recovery-key' }> {
  if (header.revoked?.includes(device))
    throw new WrongKeyError(
      'This device was removed from sync. Remove the database here and add it again to rejoin.'
    )
  const opened = await openVault(header, secret.trim())
  await saveKeyring(opened.keyring)
  return { keyring: opened.keyring, via: opened.via }
}

export async function rememberedKeyring(vaultId: string) {
  return loadKeyring(vaultId)
}

export async function lockDevice(vaultId: string) {
  await forgetKeyring(vaultId)
}

/**
 * Change the header in every database that holds the notebook. Each write
 * is compare-and-set, so two devices changing keys at once cannot lose a
 * change: the slower one reads again and retries.
 */
async function updateHeaders(
  transports: SyncTransport[],
  vaultId: string,
  change: (header: VaultHeader) => Promise<VaultHeader>
): Promise<VaultHeader> {
  let result: VaultHeader | null = null
  for (const transport of transports) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await readHeader(transport, vaultId)
      if (!found) break
      const next = await change(found.header)
      if (
        await transport.putVault(
          vaultId,
          encodeHeader(next),
          found.row.updated,
          Math.max(next.updatedAt, found.row.updated + 1)
        )
      ) {
        result = next
        break
      }
    }
  }
  if (!result)
    throw new Error('The encrypted notebook could not be updated. Try again.')
  return result
}

/** A new sync key, proven by the current sync key or a recovery key. */
export async function changeSyncKey(
  transports: SyncTransport[],
  vaultId: string,
  current: string,
  next: string,
  options: { iterations?: number } = {}
): Promise<void> {
  await updateHeaders(transports, vaultId, async header => {
    const opened = await openVault(header, current.trim())
    return setSyncKey(header, opened.dataKey, next, options)
  })
}

/** New recovery keys; the old ones stop working. */
export async function renewRecoveryKeys(
  transports: SyncTransport[],
  vaultId: string,
  current: string
): Promise<string[]> {
  let keys: string[] = []
  await updateHeaders(transports, vaultId, async header => {
    const opened = await openVault(header, current.trim())
    const renewed = await replaceRecoveryKeys(header, opened.dataKey)
    keys = renewed.recoveryKeys
    return renewed.header
  })
  return keys
}

/** Remove a device: it forgets the key at its next sync. */
export async function revokeDevice(
  transports: SyncTransport[],
  vaultId: string,
  device: string
): Promise<void> {
  await updateHeaders(transports, vaultId, async header => ({
    ...header,
    revoked: [...new Set([...(header.revoked ?? []), device])].slice(-256),
    updatedAt: Date.now(),
  }))
  for (const transport of transports)
    await transport.removeDevice(vaultId, device).catch(() => {})
}

// ----------------------------------------------------------------- Devices

const DEVICE_STORAGE = 'typenext.cloud.device'

/** A random id for this device, kept with the app's local data. */
export function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_STORAGE)
    if (stored && /^[A-Za-z0-9_-]{8,40}$/u.test(stored)) return stored
    const id = randomId(9)
    localStorage.setItem(DEVICE_STORAGE, id)
    return id
  } catch {
    return (sessionDevice ??= randomId(9))
  }
}

let sessionDevice: string | undefined

export type Platform =
  'mac' | 'windows' | 'linux' | 'iphone' | 'ipad' | 'android' | 'web'

export function devicePlatform(): Platform {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/iPhone/u.test(agent)) return 'iphone'
  if (/iPad/u.test(agent)) return 'ipad'
  if (/Android/u.test(agent)) return 'android'
  if (!isDesktop()) return 'web'
  if (/Mac/u.test(agent)) return 'mac'
  if (/Windows/u.test(agent)) return 'windows'
  return 'linux'
}

export function defaultDeviceName(platform = devicePlatform()): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  switch (platform) {
    case 'mac':
      return 'Mac'
    case 'windows':
      return 'Windows PC'
    case 'linux':
      return 'Linux PC'
    case 'iphone':
      return 'iPhone'
    case 'ipad':
      return 'iPad'
    case 'android':
      return 'Android'
    case 'web': {
      const browser = /Edg\//u.test(agent)
        ? 'Edge'
        : /Firefox\//u.test(agent)
          ? 'Firefox'
          : /Chrome\//u.test(agent)
            ? 'Chrome'
            : /Safari\//u.test(agent)
              ? 'Safari'
              : 'Browser'
      return `${browser} on the web`
    }
  }
}

/** What a device shares with the others, encrypted. */
export interface PresenceBody {
  v: 1
  name: string
  platform: Platform
  app?: string
  /** The note on screen, and when it was last edited there. */
  noteId?: string | null
  spaceId?: string
  editingAt?: number
  /** When the device sent this, by its own clock, to compare with editingAt. */
  sentAt?: number
  /** The window is visible. */
  visible: boolean
}

export interface DevicePresence extends PresenceBody {
  id: string
  self: boolean
  /** Milliseconds since the device was last seen, by the database clock. */
  age: number
  active: boolean
  /** Typing on its note within the last moments. */
  editing: boolean
}

/** Seen within this long: shown as active. */
export const ACTIVE_MS = 75_000
export const EDITING_MS = 25_000

function presenceSlot(device: string) {
  return `device|${device}`
}

export async function publishPresence(
  transport: SyncTransport,
  keyring: Keyring,
  device: string,
  body: PresenceBody
): Promise<number> {
  return transport.presence(
    keyring.vaultId,
    device,
    await seal(keyring, presenceSlot(device), body)
  )
}

/** Decrypt the device list; rows that do not open are left out. */
export async function readPresence(
  rows: { device: string; seen: number; body: string }[],
  now: number,
  keyring: Keyring,
  self: string
): Promise<DevicePresence[]> {
  const result: DevicePresence[] = []
  for (const row of rows) {
    try {
      const body = await open<PresenceBody>(
        keyring,
        presenceSlot(row.device),
        row.body
      )
      if (body?.v !== 1 || typeof body.name !== 'string') continue
      const age = Math.max(0, now - row.seen)
      const active = age < ACTIVE_MS && body.visible !== false
      result.push({
        ...body,
        name: body.name.slice(0, 128),
        id: row.device,
        self: row.device === self,
        age,
        active,
        editing:
          active &&
          typeof body.editingAt === 'number' &&
          // Both times are by the sending device's clock.
          (body.sentAt ?? body.editingAt) - body.editingAt < EDITING_MS &&
          age < EDITING_MS,
      })
    } catch {
      // Another vault's device, or a damaged row.
    }
  }
  return result
}

/** Desktop only: which of these absolute paths exist here. */
export async function pathsExist(paths: string[]): Promise<boolean[]> {
  if (!isDesktop() || !paths.length) return paths.map(() => false)
  return invoke<boolean[]>('cloud_paths_exist', { paths })
}
