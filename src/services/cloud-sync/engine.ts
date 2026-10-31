import type { Workspace } from '../../types/notebook'
import { open, recordId, seal, type Keyring } from './crypto'
import { stableJson } from './merge'
import {
  KIND_ORDER,
  applyChanges,
  itemHash,
  itemKey,
  snapshot,
  valueHash,
  type DeviceLinks,
  type IncomingChange,
  type RecordKind,
  type SyncScope,
} from './records'
import {
  loadTargetState,
  saveBases,
  saveTargetMeta,
  type StoredBase,
  type TargetState,
} from './state'
import {
  MAX_FETCH_BYTES,
  MAX_RECORD_BYTES,
  MAX_REQUEST_BYTES,
  type RemoteRecord,
  type SyncTransport,
} from './transport'

/**
 * One sync with one database: read what other devices wrote since the last
 * read, merge it into the notebook, then send what changed here. A write is
 * accepted only when it is based on the latest version in the database;
 * otherwise the newer version is read, merged, and the write is tried again.
 */

/** The record body before encryption. */
interface Payload {
  k: RecordKind
  i: string
  v?: unknown
  /** When the writing device first saw this change (its clock). */
  t: number
  d?: 1
  dev: string
}

export interface SyncConflict {
  noteId: string
  copyId: string
  device: string
}

export interface SyncReport {
  pulled: number
  pushed: number
  conflicts: SyncConflict[]
  /** Records this version could not read. */
  skipped: number
  /** Notes too large to send, by title. */
  tooLarge: string[]
}

export interface EngineOptions {
  targetId: string
  transport: SyncTransport
  keyring: Keyring
  device: { id: string; name: string }
  getWorkspace(): Workspace
  /** Apply a change to the latest notebook, synchronously. */
  updateWorkspace(apply: (workspace: Workspace) => Workspace): void
  scope(): SyncScope
  deviceName(device: string): string
  now?(): number
  newId?(): string
}

const PAGE = 500
const MAX_ROUNDS = 4

function included(scope: SyncScope, kind: RecordKind) {
  switch (kind) {
    case 'note':
      return scope.include.notes
    case 'folder':
    case 'tag':
    case 'space':
    case 'layout':
      return scope.include.organize
    case 'source':
    case 'package':
      return scope.include.contexts
    case 'setting':
      return scope.include.settings
    case 'links':
      return true
  }
}

/** Items of workspaces outside the selection are left alone. */
function selected(scope: SyncScope, payload: Payload) {
  if (!included(scope, payload.k)) return false
  if (!scope.spaceIds.length) return true
  if (payload.k === 'layout') return false
  if (payload.k === 'space') return scope.spaceIds.includes(payload.i)
  if (payload.k === 'note' || payload.k === 'folder' || payload.k === 'tag') {
    const space = (payload.v as { spaceId?: string } | undefined)?.spaceId
    // A deletion carries no value; it applies only to what is here.
    return space === undefined || scope.spaceIds.includes(space)
  }
  return true
}

export class TargetSync {
  private state: TargetState | null = null
  /** When this device first changed an item that is not yet sent. */
  private readonly changedAt = new Map<string, number>()
  private readonly options: EngineOptions
  private readonly now: () => number
  private running: Promise<SyncReport> | null = null

  constructor(options: EngineOptions) {
    this.options = options
    this.now = options.now ?? Date.now
  }

  get vaultId() {
    return this.options.keyring.vaultId
  }

  /** The newest revision read from the database. */
  get cursor() {
    return this.state?.cursor ?? 0
  }

  private async load(): Promise<TargetState> {
    if (this.state) return this.state
    const stored = await loadTargetState(this.options.targetId)
    this.state =
      stored && stored.vaultId === this.vaultId
        ? stored
        : { vaultId: this.vaultId, cursor: 0, scope: '', bases: new Map() }
    return this.state
  }

  /** Items changed here and not yet sent. Cheap: hashes are cached. */
  async pending(): Promise<number> {
    const state = await this.load()
    const byKey = new Map<string, StoredBase>()
    for (const base of state.bases.values())
      byKey.set(itemKey(base.kind, base.itemId), base)
    let count = 0
    const items = snapshot(
      this.options.getWorkspace(),
      this.options.scope(),
      this.options.device
    )
    for (const [key, item] of items) {
      if (!item.inScope || item.kind === 'links') continue
      const base = byKey.get(key)
      if (!base || base.deleted || base.hash !== itemHash(item.value)) count++
    }
    for (const [key, base] of byKey)
      if (
        !base.deleted &&
        base.kind !== 'links' &&
        !items.has(key) &&
        included(this.options.scope(), base.kind)
      )
        count++
    return count
  }

  /** File paths other devices published, for mapping to folders here. */
  async peerLinks(): Promise<{ device: string; links: DeviceLinks }[]> {
    const state = await this.load()
    return [...state.bases.values()]
      .filter(
        base =>
          base.kind === 'links' &&
          !base.deleted &&
          base.itemId !== this.options.device.id &&
          base.value
      )
      .map(base => ({ device: base.itemId, links: base.value as DeviceLinks }))
  }

  /** One sync at a time; a request during a sync waits for it. */
  sync(): Promise<SyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<SyncReport> {
    const state = await this.load()
    const scope = this.options.scope()
    const scopeKey = stableJson(scope)
    if (state.scope !== scopeKey) {
      // A wider selection must read what it skipped before.
      state.cursor = 0
      state.scope = scopeKey
    }
    const report: SyncReport = {
      pulled: 0,
      pushed: 0,
      conflicts: [],
      skipped: 0,
      tooLarge: [],
    }
    await this.pull(state, scope, report)
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const conflicted = await this.push(state, scope, report)
      if (!conflicted.length) break
      // Another device wrote first: read its version, merge, send again.
      const records = await this.options.transport.records(
        this.vaultId,
        conflicted
      )
      await this.ingest(state, scope, records, report, true)
    }
    await saveTargetMeta(this.options.targetId, {
      vaultId: this.vaultId,
      cursor: state.cursor,
      scope: state.scope,
    })
    return report
  }

  private async pull(state: TargetState, scope: SyncScope, report: SyncReport) {
    const { transport } = this.options
    for (;;) {
      const metas = await transport.changes(this.vaultId, state.cursor, PAGE)
      if (!metas.length) break
      // Our own writes come back too; skip what is already known.
      const wanted = metas.filter(meta => {
        const base = state.bases.get(meta.id)
        return !base || base.rev < meta.rev
      })
      let batch: string[] = []
      let bytes = 0
      const flush = async () => {
        if (!batch.length) return
        const records = await transport.records(this.vaultId, batch)
        await this.ingest(state, scope, records, report, false)
        batch = []
        bytes = 0
      }
      for (const meta of wanted) {
        if (
          batch.length &&
          (bytes + meta.size > MAX_FETCH_BYTES || batch.length >= 200)
        )
          await flush()
        batch.push(meta.id)
        bytes += meta.size
      }
      await flush()
      state.cursor = Math.max(state.cursor, metas.at(-1)!.rev)
      if (metas.length < PAGE) break
    }
  }

  /**
   * Decrypt, merge and remember remote records. After a refused write the
   * record is the base whatever happens, so the next write can succeed.
   */
  private async ingest(
    state: TargetState,
    scope: SyncScope,
    records: RemoteRecord[],
    report: SyncReport,
    force: boolean
  ) {
    const { keyring } = this.options
    const changes: (IncomingChange & { record: string; rev: number })[] = []
    const unreadable: RemoteRecord[] = []
    for (const record of records) {
      let payload: Payload
      try {
        payload = await open<Payload>(keyring, record.id, record.body)
      } catch {
        unreadable.push(record)
        continue
      }
      if ((await recordId(keyring, payload.k, payload.i)) !== record.id) {
        unreadable.push(record)
        continue
      }
      if (!selected(scope, payload)) continue
      changes.push({
        record: record.id,
        rev: record.rev,
        kind: payload.k,
        itemId: payload.i,
        deleted: record.deleted || payload.d === 1,
        value: payload.v,
        device: payload.dev || record.device,
        time: payload.t,
        base: state.bases.get(record.id),
      })
    }
    report.skipped += unreadable.length
    const updates: [string, StoredBase][] = []
    if (force)
      for (const record of unreadable) {
        const known = state.bases.get(record.id)
        if (known)
          updates.push([record.id, { ...known, rev: record.rev, hash: '' }])
      }
    if (changes.length) {
      let outcomes: ReturnType<typeof applyChanges>['outcomes'] = []
      this.options.updateWorkspace(workspace => {
        const result = applyChanges(workspace, changes, {
          localTime: (kind, itemId) =>
            this.changedAt.get(itemKey(kind, itemId)),
          deviceName: this.options.deviceName,
          now: this.now(),
          newId: this.options.newId ?? (() => crypto.randomUUID()),
        })
        outcomes = result.outcomes
        return result.workspace
      })
      const byItem = new Map(
        outcomes.map(outcome => [
          itemKey(outcome.kind, outcome.itemId),
          outcome,
        ])
      )
      for (const change of changes) {
        const outcome = byItem.get(itemKey(change.kind, change.itemId))
        if (!outcome) continue
        if (outcome.outcome === 'skipped') {
          report.skipped++
          const known = state.bases.get(change.record)
          if (force && known)
            updates.push([
              change.record,
              { ...known, rev: change.rev, hash: '' },
            ])
          continue
        }
        report.pulled++
        if (outcome.outcome === 'conflict-copy' && outcome.copyId)
          report.conflicts.push({
            noteId: change.itemId,
            copyId: outcome.copyId,
            device: change.device,
          })
        updates.push([
          change.record,
          {
            kind: change.kind,
            itemId: change.itemId,
            rev: change.rev,
            deleted: change.deleted,
            hash: change.deleted ? '' : valueHash(outcome.value),
            ...(change.deleted ? {} : { value: outcome.value }),
          },
        ])
      }
    }
    for (const [record, base] of updates) state.bases.set(record, base)
    await saveBases(this.options.targetId, updates)
  }

  /** Send changes. Returns the records another device changed first. */
  private async push(
    state: TargetState,
    scope: SyncScope,
    report: SyncReport
  ): Promise<string[]> {
    const { keyring, device, transport } = this.options
    const workspace = this.options.getWorkspace()
    const items = snapshot(workspace, scope, device)
    const now = this.now()
    interface Outgoing {
      record: string
      key: string
      kind: RecordKind
      itemId: string
      base: number
      deleted: boolean
      value?: unknown
      hash: string
      body: string
    }
    const outgoing: Omit<Outgoing, 'body'>[] = []
    for (const [key, item] of items) {
      if (!item.inScope) continue
      if (item.kind === 'links' && item.itemId !== device.id) continue
      const record = await recordId(keyring, item.kind, item.itemId)
      const base = state.bases.get(record)
      const hash = itemHash(item.value)
      if (base && !base.deleted && base.hash === hash) {
        this.changedAt.delete(key)
        continue
      }
      // A device's own empty link list need not be sent until it has one.
      if (
        !base &&
        item.kind === 'links' &&
        !Object.keys((item.value as DeviceLinks).notes).length &&
        !Object.keys((item.value as DeviceLinks).spaces).length &&
        !(item.value as DeviceLinks).git
      )
        continue
      if (!this.changedAt.has(key)) this.changedAt.set(key, now)
      outgoing.push({
        record,
        key,
        kind: item.kind,
        itemId: item.itemId,
        base: base?.rev ?? 0,
        deleted: false,
        value: item.value,
        hash,
      })
    }
    for (const [record, base] of state.bases) {
      if (base.deleted || base.kind === 'links') continue
      const key = itemKey(base.kind, base.itemId)
      if (items.has(key) || !included(scope, base.kind)) continue
      outgoing.push({
        record,
        key,
        kind: base.kind,
        itemId: base.itemId,
        base: base.rev,
        deleted: true,
        hash: '',
      })
    }
    if (!outgoing.length) return []
    outgoing.sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    )
    const sealed: Outgoing[] = []
    for (const item of outgoing) {
      const payload: Payload = item.deleted
        ? { k: item.kind, i: item.itemId, t: now, d: 1, dev: device.id }
        : {
            k: item.kind,
            i: item.itemId,
            v: item.value,
            t: this.changedAt.get(item.key) ?? now,
            dev: device.id,
          }
      const body = await seal(keyring, item.record, payload)
      if (body.length > MAX_RECORD_BYTES) {
        const title =
          item.kind === 'note'
            ? (item.value as { title?: string }).title || 'Untitled'
            : `${item.kind} ${item.itemId}`
        report.tooLarge.push(title)
        continue
      }
      sealed.push({ ...item, body })
    }
    const conflicted: string[] = []
    let batch: Outgoing[] = []
    let bytes = 0
    const flush = async () => {
      if (!batch.length) return
      const results = await transport.push(
        this.vaultId,
        device.id,
        batch.map(item => ({
          id: item.record,
          base: item.base,
          deleted: item.deleted,
          body: item.body,
        }))
      )
      const updates: [string, StoredBase][] = []
      results.forEach((result, index) => {
        const item = batch[index]!
        if (result.rev === null) {
          conflicted.push(item.record)
          return
        }
        report.pushed++
        this.changedAt.delete(item.key)
        updates.push([
          item.record,
          {
            kind: item.kind,
            itemId: item.itemId,
            rev: result.rev,
            deleted: item.deleted,
            hash: item.hash,
            ...(item.deleted ? {} : { value: item.value }),
          },
        ])
      })
      for (const [record, base] of updates) state.bases.set(record, base)
      await saveBases(this.options.targetId, updates)
      batch = []
      bytes = 0
    }
    for (const item of sealed) {
      if (
        batch.length &&
        (bytes + item.body.length > MAX_REQUEST_BYTES || batch.length >= 100)
      )
        await flush()
      batch.push(item)
      bytes += item.body.length + 200
    }
    await flush()
    return conflicted
  }
}
