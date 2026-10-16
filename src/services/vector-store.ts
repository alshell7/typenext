/**
 * Derived chunk vectors are a cache, never notebook data. They live in
 * IndexedDB keyed by model, width and a hash of the exact text, so unchanged
 * passages are never embedded twice and a cleared cache only costs time.
 */
const DATABASE = 'typenext-vectors'
const STORE = 'chunks'
const MAX_MEMORY_VECTORS = 12_000
/** About 120 MB at 512 dimensions. Above this the cache starts again. */
export const MAX_STORED_VECTORS = 60_000
const memory = new Map<string, Float32Array>()
let database: Promise<IDBDatabase | null> | null = null

/** 53-bit string hash (cyrb53). Collisions only cost one stale vector. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function open(): Promise<IDBDatabase | null> {
  database ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return database
}

function remember(key: string, vector: Float32Array) {
  memory.delete(key)
  memory.set(key, vector)
  while (memory.size > MAX_MEMORY_VECTORS) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

/** Read cached vectors. Missing keys are absent from the result. */
export async function getVectors(
  keys: string[]
): Promise<Map<string, Float32Array>> {
  const found = new Map<string, Float32Array>()
  const missing: string[] = []
  for (const key of keys) {
    const vector = memory.get(key)
    if (vector) found.set(key, vector)
    else missing.push(key)
  }
  if (!missing.length) return found
  const db = await open()
  if (!db) return found
  await new Promise<void>(resolve => {
    try {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE)
      let pending = missing.length
      for (const key of missing) {
        const request = store.get(key)
        request.onsuccess = () => {
          const value: unknown = request.result
          if (value instanceof Float32Array) {
            found.set(key, value)
            remember(key, value)
          }
          if (--pending === 0) resolve()
        }
        request.onerror = () => {
          if (--pending === 0) resolve()
        }
      }
    } catch {
      resolve()
    }
  })
  return found
}

export async function putVectors(entries: [string, Float32Array][]) {
  for (const [key, vector] of entries) remember(key, vector)
  const db = await open()
  if (!db || !entries.length) return
  await new Promise<void>(resolve => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      // Vectors are derived data. When the cache is full, clear it and keep
      // only this batch; the next index rebuild fills it again.
      const count = store.count()
      count.onsuccess = () => {
        if (count.result + entries.length > MAX_STORED_VECTORS) store.clear()
        for (const [key, vector] of entries) store.put(vector, key)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/** Remove every cached vector, for example after a model change. */
export async function clearVectors() {
  memory.clear()
  const db = await open()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export function resetVectorStoreForTests() {
  memory.clear()
  database = null
}
