import type { Keyring } from './crypto'
import type { Base, RecordKind } from './records'

/**
 * What one device remembers about each database, in IndexedDB beside the
 * notebook: the last revision it read, and for every record the version it
 * last agreed on (the base of the next three-way merge). Unlocked keys are
 * stored here too, as Web Crypto keys that cannot be exported: the device
 * opens the encrypted notebook without asking for the sync key again, and
 * nothing on disk holds the key's bytes. Without IndexedDB (tests, private
 * windows), a memory store keeps the same behaviour for the session.
 */

export interface StoredBase extends Base {
  kind: RecordKind
  itemId: string
}

export interface TargetState {
  vaultId: string
  /** The highest revision read. */
  cursor: number
  /** The selection the cursor belongs to; another selection reads again. */
  scope: string
  bases: Map<string, StoredBase>
}

interface BaseRow extends StoredBase {
  key: string
  target: string
  record: string
}

interface MetaRow {
  key: string
  vaultId: string
  cursor: number
  scope: string
}

interface KeyRow {
  vaultId: string
  epoch: number
  enc: CryptoKey
  mac: CryptoKey
}

interface Backend {
  load(target: string): Promise<TargetState | null>
  saveMeta(target: string, meta: Omit<MetaRow, 'key'>): Promise<void>
  saveBases(target: string, bases: [string, StoredBase][]): Promise<void>
  clear(target: string): Promise<void>
  loadKey(vaultId: string): Promise<Keyring | null>
  saveKey(keyring: Keyring): Promise<void>
  forgetKey(vaultId: string): Promise<void>
}

function memoryBackend(): Backend {
  const metas = new Map<string, MetaRow>()
  const bases = new Map<string, Map<string, StoredBase>>()
  const keys = new Map<string, Keyring>()
  return {
    async load(target) {
      const meta = metas.get(target)
      if (!meta) return null
      return {
        vaultId: meta.vaultId,
        cursor: meta.cursor,
        scope: meta.scope,
        bases: new Map(bases.get(target) ?? []),
      }
    },
    async saveMeta(target, meta) {
      metas.set(target, { key: target, ...meta })
    },
    async saveBases(target, entries) {
      const map = bases.get(target) ?? new Map<string, StoredBase>()
      for (const [record, base] of entries) map.set(record, base)
      bases.set(target, map)
    },
    async clear(target) {
      metas.delete(target)
      bases.delete(target)
    },
    async loadKey(vaultId) {
      return keys.get(vaultId) ?? null
    },
    async saveKey(keyring) {
      keys.set(keyring.vaultId, keyring)
    },
    async forgetKey(vaultId) {
      keys.delete(vaultId)
    },
  }
}

const DATABASE = 'typenext-cloud-sync'

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function indexedBackend(database: IDBDatabase): Backend {
  return {
    async load(target) {
      const transaction = database.transaction(['meta', 'bases'], 'readonly')
      const meta = await request<MetaRow | undefined>(
        transaction.objectStore('meta').get(target)
      )
      if (!meta) return null
      const rows = await request<BaseRow[]>(
        transaction.objectStore('bases').index('target').getAll(target)
      )
      return {
        vaultId: meta.vaultId,
        cursor: meta.cursor,
        scope: meta.scope,
        bases: new Map(
          rows.map(row => {
            const { key: _key, target: _target, record, ...base } = row
            void _key
            void _target
            return [record, base]
          })
        ),
      }
    },
    async saveMeta(target, meta) {
      const transaction = database.transaction('meta', 'readwrite')
      transaction.objectStore('meta').put({ key: target, ...meta })
      await done(transaction)
    },
    async saveBases(target, entries) {
      if (!entries.length) return
      const transaction = database.transaction('bases', 'readwrite')
      const store = transaction.objectStore('bases')
      for (const [record, base] of entries)
        store.put({ ...base, key: `${target}|${record}`, target, record })
      await done(transaction)
    },
    async clear(target) {
      const transaction = database.transaction(['meta', 'bases'], 'readwrite')
      transaction.objectStore('meta').delete(target)
      const bases = transaction.objectStore('bases')
      const keys = await request(bases.index('target').getAllKeys(target))
      for (const key of keys) bases.delete(key)
      await done(transaction)
    },
    async loadKey(vaultId) {
      const transaction = database.transaction('keys', 'readonly')
      const row = await request<KeyRow | undefined>(
        transaction.objectStore('keys').get(vaultId)
      )
      return row ?? null
    },
    async saveKey(keyring) {
      const transaction = database.transaction('keys', 'readwrite')
      transaction.objectStore('keys').put({ ...keyring })
      await done(transaction)
    },
    async forgetKey(vaultId) {
      const transaction = database.transaction('keys', 'readwrite')
      transaction.objectStore('keys').delete(vaultId)
      await done(transaction)
    },
  }
}

let backend: Promise<Backend> | null = null

function open(): Promise<Backend> {
  backend ??= new Promise<Backend>(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(memoryBackend())
      return
    }
    try {
      const opening = indexedDB.open(DATABASE, 1)
      opening.onupgradeneeded = () => {
        const database = opening.result
        database.createObjectStore('meta', { keyPath: 'key' })
        database
          .createObjectStore('bases', { keyPath: 'key' })
          .createIndex('target', 'target')
        database.createObjectStore('keys', { keyPath: 'vaultId' })
      }
      opening.onsuccess = () => resolve(indexedBackend(opening.result))
      opening.onerror = () => resolve(memoryBackend())
      opening.onblocked = () => resolve(memoryBackend())
    } catch {
      resolve(memoryBackend())
    }
  })
  return backend
}

export async function loadTargetState(
  target: string
): Promise<TargetState | null> {
  return (await open()).load(target)
}

export async function saveTargetMeta(
  target: string,
  meta: { vaultId: string; cursor: number; scope: string }
) {
  await (await open()).saveMeta(target, meta)
}

export async function saveBases(target: string, bases: [string, StoredBase][]) {
  await (await open()).saveBases(target, bases)
}

export async function clearTargetState(target: string) {
  await (await open()).clear(target)
}

export async function loadKeyring(vaultId: string): Promise<Keyring | null> {
  return (await open()).loadKey(vaultId)
}

export async function saveKeyring(keyring: Keyring) {
  await (await open()).saveKey(keyring)
}

export async function forgetKeyring(vaultId: string) {
  await (await open()).forgetKey(vaultId)
}

export function resetCloudStateForTests() {
  backend = Promise.resolve(memoryBackend())
}
