import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'
import { textHash } from '../../services/vector-store'
import { countWords, wordChanges } from './diff'

/**
 * Revisions are snapshots of one note's Markdown. They live in IndexedDB,
 * beside the notebook and not inside it: the notebook file stays small and
 * fast to save, and clearing revisions never touches a note. Text is stored
 * deflated. In tests and without IndexedDB, a memory store keeps the same
 * behaviour for the session.
 */

export type RevisionKind = 'auto' | 'manual' | 'safety' | 'restore' | 'merge'

export interface RevisionMeta {
  id: string
  noteId: string
  createdAt: number
  title: string
  words: number
  characters: number
  kind: RevisionKind
  /** The writer's name for the revision. */
  label?: string
  /** Why TypeNext kept it: “Before polish”, “Before restoring 10:42”. */
  reason?: string
  pinned?: boolean
  /** What changed, in a few words: “Edited “The first guests…”” */
  summary: string
  /** Words added and removed since the revision before it. */
  added: number
  removed: number
  hash: string
}

interface RevisionRecord extends RevisionMeta {
  body: Uint8Array
}

const DATABASE = 'typenext-revisions'
const STORE = 'revisions'
/** Fewer revisions are kept when one note's history grows past this. */
const MAX_NOTE_BYTES = 48 * 1024 * 1024

type Listener = (noteId: string) => void
const listeners = new Set<Listener>()

export function subscribeRevisions(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(noteId: string) {
  for (const listener of listeners) listener(noteId)
}

// ------------------------------------------------------------------ Backend

interface Backend {
  all(noteId: string): Promise<RevisionRecord[]>
  get(id: string): Promise<RevisionRecord | undefined>
  put(record: RevisionRecord): Promise<void>
  remove(ids: string[]): Promise<void>
  clear(): Promise<void>
  every(): Promise<RevisionRecord[]>
}

function memoryBackend(): Backend {
  const records = new Map<string, RevisionRecord>()
  return {
    all: async noteId =>
      [...records.values()].filter(record => record.noteId === noteId),
    get: async id => records.get(id),
    put: async record => {
      records.set(record.id, record)
    },
    remove: async ids => {
      for (const id of ids) records.delete(id)
    },
    clear: async () => records.clear(),
    every: async () => [...records.values()],
  }
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('Storage failed.'))
  })
}

function indexedBackend(database: IDBDatabase): Backend {
  const store = (mode: IDBTransactionMode) =>
    database.transaction(STORE, mode).objectStore(STORE)
  const finished = (transaction: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('Storage failed.'))
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Storage is full.'))
    })
  return {
    all: noteId =>
      request(
        store('readonly').index('noteId').getAll(noteId) as IDBRequest<
          RevisionRecord[]
        >
      ),
    get: id => request(store('readonly').get(id) as IDBRequest<RevisionRecord>),
    put: async record => {
      const writable = store('readwrite')
      writable.put(record)
      await finished(writable.transaction)
    },
    remove: async ids => {
      if (!ids.length) return
      const writable = store('readwrite')
      for (const id of ids) writable.delete(id)
      await finished(writable.transaction)
    },
    clear: async () => {
      const writable = store('readwrite')
      writable.clear()
      await finished(writable.transaction)
    },
    every: () =>
      request(store('readonly').getAll() as IDBRequest<RevisionRecord[]>),
  }
}

let backend: Promise<Backend> | null = null

function open(): Promise<Backend> {
  backend ??= new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(memoryBackend())
    try {
      const opening = indexedDB.open(DATABASE, 1)
      opening.onupgradeneeded = () => {
        const store = opening.result.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('noteId', 'noteId')
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

/** Tests: start again with an empty memory store. */
export function resetRevisionStoreForTests() {
  backend = Promise.resolve(memoryBackend())
  latest.clear()
}

// ------------------------------------------------------------------ Helpers

function meta(record: RevisionRecord): RevisionMeta {
  const { body: _body, ...rest } = record
  void _body
  return rest
}

function pack(text: string): Uint8Array {
  return deflateSync(strToU8(text), { level: 6 })
}

function unpack(body: Uint8Array): string {
  return strFromU8(inflateSync(body))
}

function excerpt(text: string, length = 56) {
  const clean = text
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/u, '')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu,
      (_, target, label) => label ?? target
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return clean.length > length
    ? `${clean.slice(0, length - 1).trimEnd()}…`
    : clean
}

/** A few words for the timeline: what this revision changed. */
export function revisionSummary(before: string | null, after: string): string {
  if (before === null) return after.trim() ? 'First version' : 'Empty note'
  if (before === after) return 'No changes'
  const oldLines = new Set(before.split('\n').map(line => line.trim()))
  const newLines = new Set(after.split('\n').map(line => line.trim()))
  const added = after
    .split('\n')
    .filter(line => line.trim() && !oldLines.has(line.trim()))
  const removed = before
    .split('\n')
    .filter(line => line.trim() && !newLines.has(line.trim()))
  const heading = added.find(line => /^\s{0,3}#{1,6}\s/u.test(line))
  if (heading) return `Added “${excerpt(heading)}”`
  if (added.length && removed.length) return `Edited “${excerpt(added[0]!)}”`
  if (added.length) return `Added “${excerpt(added[0]!)}”`
  if (removed.length) return `Removed “${excerpt(removed[0]!)}”`
  return 'Rearranged lines'
}

/** The newest revision text per note, for change measures without a read. */
const latest = new Map<
  string,
  { createdAt: number; text: string; hash: string }
>()

export async function latestRevision(
  noteId: string
): Promise<{ createdAt: number; text: string; hash: string } | null> {
  const cached = latest.get(noteId)
  if (cached) return cached
  const records = await (await open()).all(noteId)
  const newest = records.sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!newest) return null
  const entry = {
    createdAt: newest.createdAt,
    text: unpack(newest.body),
    hash: newest.hash,
  }
  latest.set(noteId, entry)
  return entry
}

// ------------------------------------------------------------------ API

export async function listRevisions(noteId: string): Promise<RevisionMeta[]> {
  const records = await (await open()).all(noteId)
  return records.map(meta).sort((a, b) => b.createdAt - a.createdAt)
}

export async function revisionText(id: string): Promise<string | null> {
  const record = await (await open()).get(id)
  return record ? unpack(record.body) : null
}

export interface AddRevision {
  noteId: string
  title: string
  text: string
  kind: RevisionKind
  label?: string
  reason?: string
  /** Keep this many revisions for the note; older automatic ones thin out. */
  keep: number
  now?: number
}

/**
 * Store a revision. An unchanged text is not stored twice in a row; a named
 * or manual save of unchanged text names the newest revision instead.
 */
export async function addRevision(
  input: AddRevision
): Promise<RevisionMeta | null> {
  const store = await open()
  const hash = textHash(input.text)
  const previous = await latestRevision(input.noteId)
  const createdAt = Math.max(
    input.now ?? Date.now(),
    (previous?.createdAt ?? 0) + 1
  )
  if (previous?.hash === hash) {
    if (input.kind !== 'manual' && !input.label) return null
    const records = await store.all(input.noteId)
    const newest = records.sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!newest) return null
    const named: RevisionRecord = {
      ...newest,
      ...(input.label ? { label: input.label } : {}),
      kind: newest.kind === 'auto' ? input.kind : newest.kind,
    }
    await store.put(named)
    changed(input.noteId)
    return meta(named)
  }
  const counts = previous
    ? wordChanges(previous.text, input.text)
    : { added: countWords(input.text), removed: 0 }
  const record: RevisionRecord = {
    id: crypto.randomUUID(),
    noteId: input.noteId,
    createdAt,
    title: input.title.slice(0, 256),
    words: countWords(input.text),
    characters: input.text.length,
    kind: input.kind,
    ...(input.label ? { label: input.label.slice(0, 120) } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 120) } : {}),
    summary: revisionSummary(previous?.text ?? null, input.text),
    added: counts.added,
    removed: counts.removed,
    hash,
    body: pack(input.text),
  }
  await store.put(record)
  latest.set(input.noteId, { createdAt, text: input.text, hash })
  await prune(input.noteId, input.keep, createdAt)
  changed(input.noteId)
  return meta(record)
}

export async function updateRevision(
  id: string,
  patch: { label?: string | null; pinned?: boolean }
): Promise<void> {
  const store = await open()
  const record = await store.get(id)
  if (!record) return
  const next: RevisionRecord = { ...record }
  if (patch.label !== undefined) {
    const label = patch.label?.trim().slice(0, 120)
    if (label) next.label = label
    else delete next.label
  }
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinned = true
    else delete next.pinned
  }
  await store.put(next)
  changed(record.noteId)
}

export async function deleteRevision(id: string): Promise<void> {
  const store = await open()
  const record = await store.get(id)
  if (!record) return
  await store.remove([id])
  latest.delete(record.noteId)
  changed(record.noteId)
}

export async function deleteNoteRevisions(noteId: string): Promise<void> {
  const store = await open()
  const records = await store.all(noteId)
  await store.remove(records.map(record => record.id))
  latest.delete(noteId)
  changed(noteId)
}

export async function clearRevisions(): Promise<void> {
  await (await open()).clear()
  const notes = [...latest.keys()]
  latest.clear()
  for (const noteId of notes) changed(noteId)
  changed('*')
}

export async function revisionUsage(): Promise<{
  count: number
  bytes: number
}> {
  const records = await (await open()).every()
  return {
    count: records.length,
    bytes: records.reduce((total, record) => total + record.body.byteLength, 0),
  }
}

/** Revisions that are always kept: named, pinned and safety copies. */
function protectedRevision(record: RevisionMeta) {
  return Boolean(record.label || record.pinned)
}

/**
 * Keep a note's history useful as it grows: recent revisions stay; older
 * automatic ones thin to one an hour after a day and one a day after a week.
 * Above the limit the oldest unprotected revisions go first. The newest
 * revision is never removed.
 */
export function revisionsToPrune(
  records: readonly (RevisionMeta & { size?: number })[],
  keep: number,
  now: number
): string[] {
  const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt)
  const remove = new Set<string>()
  const day = 86_400_000
  const seenHour = new Set<number>()
  const seenDay = new Set<number>()
  sorted.forEach((record, index) => {
    if (index === 0 || protectedRevision(record) || record.kind !== 'auto')
      return
    const age = now - record.createdAt
    if (age > 7 * day) {
      const bucket = Math.floor(record.createdAt / day)
      if (seenDay.has(bucket)) remove.add(record.id)
      seenDay.add(bucket)
    } else if (age > day) {
      const bucket = Math.floor(record.createdAt / 3_600_000)
      if (seenHour.has(bucket)) remove.add(record.id)
      seenHour.add(bucket)
    }
  })
  let kept = sorted.filter(record => !remove.has(record.id))
  let bytes = kept.reduce((total, record) => total + (record.size ?? 0), 0)
  for (let index = kept.length - 1; index > 0; index--) {
    if (kept.length <= keep && bytes <= MAX_NOTE_BYTES) break
    const record = kept[index]!
    if (protectedRevision(record)) continue
    remove.add(record.id)
    bytes -= record.size ?? 0
    kept = kept.filter(item => item.id !== record.id)
  }
  return [...remove]
}

async function prune(noteId: string, keep: number, now: number) {
  const store = await open()
  const records = await store.all(noteId)
  const ids = revisionsToPrune(
    records.map(record => ({ ...meta(record), size: record.body.byteLength })),
    keep,
    now
  )
  await store.remove(ids)
}
