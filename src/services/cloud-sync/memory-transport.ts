import type {
  ChangeMeta,
  DeviceRow,
  PushRecord,
  PushResult,
  RemoteRecord,
  SyncTransport,
  VaultRow,
} from './transport'

/**
 * A database in memory with the same rules as the SQL transports: rising
 * revisions per write and compare-and-set writes. Tests use it to play
 * several devices against one database.
 */
export class MemoryTransport implements SyncTransport {
  readonly kind = 'neon' as const
  vaultRows = new Map<string, VaultRow>()
  rows = new Map<string, RemoteRecord & { vault: string; size: number }>()
  deviceRows = new Map<string, DeviceRow & { vault: string }>()
  private rev = 0
  clock = 1_000_000
  /** Requests made, for tests that count round trips. */
  calls = 0

  async setup() {
    this.calls++
  }

  async vaults() {
    this.calls++
    return [...this.vaultRows.values()]
  }

  async putVault(
    vault: string,
    header: string,
    expected: number | null,
    updated: number
  ) {
    this.calls++
    const existing = this.vaultRows.get(vault)
    if (expected === null ? existing : existing?.updated !== expected)
      return false
    this.vaultRows.set(vault, { vault, header, updated })
    return true
  }

  async head(vault: string) {
    this.calls++
    let head = 0
    for (const row of this.rows.values())
      if (row.vault === vault) head = Math.max(head, row.rev)
    return head
  }

  async changes(
    vault: string,
    after: number,
    limit: number
  ): Promise<ChangeMeta[]> {
    this.calls++
    return [...this.rows.values()]
      .filter(row => row.vault === vault && row.rev > after)
      .sort((a, b) => a.rev - b.rev)
      .slice(0, limit)
      .map(row => ({ id: row.id, rev: row.rev, size: row.size }))
  }

  async records(vault: string, ids: string[]): Promise<RemoteRecord[]> {
    this.calls++
    return ids
      .map(id => this.rows.get(`${vault}|${id}`))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map(({ id, rev, device, deleted, body }) => ({
        id,
        rev,
        device,
        deleted,
        body,
      }))
  }

  async push(
    vault: string,
    device: string,
    records: PushRecord[]
  ): Promise<PushResult[]> {
    this.calls++
    return records.map(record => {
      const key = `${vault}|${record.id}`
      const existing = this.rows.get(key)
      if ((existing?.rev ?? 0) !== record.base)
        return { id: record.id, rev: null }
      const rev = ++this.rev
      this.rows.set(key, {
        vault,
        id: record.id,
        rev,
        device,
        deleted: record.deleted,
        body: record.body,
        size: record.body.length,
      })
      return { id: record.id, rev }
    })
  }

  async presence(vault: string, device: string, body: string) {
    this.calls++
    this.deviceRows.set(`${vault}|${device}`, {
      vault,
      device,
      seen: this.clock,
      body,
    })
    return this.clock
  }

  async devices(vault: string) {
    this.calls++
    return {
      now: this.clock,
      rows: [...this.deviceRows.values()]
        .filter(row => row.vault === vault)
        .map(({ device, seen, body }) => ({ device, seen, body })),
    }
  }

  async removeDevice(vault: string, device: string) {
    this.calls++
    this.deviceRows.delete(`${vault}|${device}`)
  }

  async erase(vault: string) {
    this.calls++
    for (const [key, row] of this.rows)
      if (row.vault === vault) this.rows.delete(key)
    for (const [key, row] of this.deviceRows)
      if (row.vault === vault) this.deviceRows.delete(key)
    this.vaultRows.delete(vault)
  }
}
