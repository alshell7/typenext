import type { CloudBackend } from '../../types/notebook'
import { isDesktop, requestText } from '../native'

/**
 * The database side of cloud sync: three small tables and a handful of
 * statements, the same for Neon Postgres and Cloudflare D1.
 *
 * - typenext_vaults: one row per encrypted notebook, holding its header.
 * - typenext_records: one row per item. `rev` rises with every write in a
 *   vault, so a device asks only for rows after the last one it saw. A write
 *   names the revision it was based on and fails if another device wrote
 *   first: no write ever overwrites one it has not seen.
 * - typenext_devices: one row per device, refreshed while it is open.
 *
 * Only ids, revision numbers, sizes, times and ciphertext reach the database.
 */

export interface VaultRow {
  vault: string
  header: string
  updated: number
}

export interface ChangeMeta {
  id: string
  rev: number
  size: number
}

export interface RemoteRecord {
  id: string
  rev: number
  device: string
  deleted: boolean
  body: string
}

export interface PushRecord {
  id: string
  /** The revision this write is based on; 0 for a new record. */
  base: number
  deleted: boolean
  body: string
}

/** rev is null when another device changed the record first. */
export interface PushResult {
  id: string
  rev: number | null
}

export interface DeviceRow {
  device: string
  seen: number
  body: string
}

export interface SyncTransport {
  readonly kind: CloudBackend
  /** Create the tables when they are missing. Safe to repeat. */
  setup(): Promise<void>
  vaults(): Promise<VaultRow[]>
  /** Compare-and-set: false when the header changed since `expected`. */
  putVault(
    vault: string,
    header: string,
    expected: number | null,
    updated: number
  ): Promise<boolean>
  head(vault: string): Promise<number>
  changes(vault: string, after: number, limit: number): Promise<ChangeMeta[]>
  records(vault: string, ids: string[]): Promise<RemoteRecord[]>
  push(
    vault: string,
    device: string,
    records: PushRecord[]
  ): Promise<PushResult[]>
  /** Refresh this device's row; returns the database clock. */
  presence(vault: string, device: string, body: string): Promise<number>
  devices(vault: string): Promise<{ now: number; rows: DeviceRow[] }>
  removeDevice(vault: string, device: string): Promise<void>
  /** Delete every row of a vault. */
  erase(vault: string): Promise<void>
}

/** Largest request body, below the 2 MB limit of the HTTP bridge. */
export const MAX_REQUEST_BYTES = 1_600_000
/** Largest single record. Bigger notes are skipped with a message. */
export const MAX_RECORD_BYTES = 1_400_000
/** Bodies fetched in one request, below the 8 MB response limit. */
export const MAX_FETCH_BYTES = 3_000_000

function number(value: unknown): number {
  const result = typeof value === 'string' ? Number(value) : value
  return typeof result === 'number' && Number.isFinite(result) ? result : 0
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === 't' || value === '1'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

type Row = Record<string, unknown>

/** Plain-language errors for the usual setup mistakes. */
function friendly(error: unknown, backend: CloudBackend): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /\b(401|403)\b|password authentication|authentication failed|Invalid API Token|Authentication error/iu.test(
      message
    )
  )
    return new Error(
      backend === 'neon'
        ? 'Neon refused the connection string. Copy it again from the Neon console.'
        : 'Cloudflare refused the API token. It needs D1 Edit permission for this account.'
    )
  if (
    /could not reach|Failed to fetch|NetworkError|timed out|took too long|offline/iu.test(
      message
    )
  )
    return new Error(
      `${backend === 'neon' ? 'Neon' : 'Cloudflare'} could not be reached. Check your connection.`
    )
  return error instanceof Error ? error : new Error(message)
}

// ------------------------------------------------------------------- Neon

export interface NeonConnection {
  host: string
  database: string
  user: string
}

/** Validates a postgres:// connection string without revealing it. */
export function parseNeonConnection(value: string): NeonConnection {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(
      'Paste the full connection string, starting with postgresql://.'
    )
  }
  if (!/^postgres(ql)?:$/u.test(url.protocol))
    throw new Error(
      'Paste the full connection string, starting with postgresql://.'
    )
  if (!url.username || !url.password)
    throw new Error('The connection string needs its user name and password.')
  if (!/\.neon\.tech$|\.neon\.build$|\.neon\.com$/u.test(url.hostname))
    throw new Error(
      'Use a Neon connection string (its host ends in neon.tech).'
    )
  const database = decodeURIComponent(url.pathname.slice(1)) || 'neondb'
  return {
    host: url.hostname,
    database,
    user: decodeURIComponent(url.username),
  }
}

interface SqlStatement {
  sql: string
  params: unknown[]
}

export class NeonTransport implements SyncTransport {
  readonly kind = 'neon' as const
  private readonly endpoint: string

  constructor(private readonly connection: string) {
    this.endpoint = `https://${parseNeonConnection(connection).host}/sql`
  }

  private async post(body: unknown): Promise<unknown> {
    try {
      const response = await requestText(this.endpoint, {
        method: 'POST',
        headers: {
          // Neon's CORS policy allows no Content-Type header, so the JSON
          // goes as plain text, which browsers send without asking first.
          'Content-Type': 'text/plain;charset=UTF-8',
          'Neon-Connection-String': this.connection,
          'Neon-Raw-Text-Output': 'true',
        },
        body,
      })
      return JSON.parse(response) as unknown
    } catch (error) {
      throw friendly(error, 'neon')
    }
  }

  private async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = (await this.post({ query: sql, params })) as { rows?: Row[] }
    return result.rows ?? []
  }

  /** One transaction. Results follow the statements. */
  private async batch(statements: SqlStatement[]): Promise<Row[][]> {
    const result = (await this.post({
      queries: statements.map(item => ({
        query: item.sql,
        params: item.params,
      })),
    })) as { results?: { rows?: Row[] }[] }
    return (result.results ?? []).map(item => item.rows ?? [])
  }

  async setup() {
    await this.batch([
      {
        sql: 'create table if not exists typenext_vaults (vault text primary key, header text not null, updated bigint not null)',
        params: [],
      },
      {
        sql: 'create table if not exists typenext_records (vault text not null, id text not null, rev bigint not null, device text not null, deleted boolean not null default false, body text not null, size integer not null, primary key (vault, id))',
        params: [],
      },
      {
        sql: 'create index if not exists typenext_records_rev on typenext_records (vault, rev)',
        params: [],
      },
      { sql: 'create sequence if not exists typenext_rev', params: [] },
      {
        sql: 'create table if not exists typenext_devices (vault text not null, device text not null, seen bigint not null, body text not null, primary key (vault, device))',
        params: [],
      },
    ])
  }

  async vaults() {
    const rows = await this.query(
      'select vault, header, updated from typenext_vaults order by updated desc limit 16'
    )
    return rows.map(row => ({
      vault: text(row.vault),
      header: text(row.header),
      updated: number(row.updated),
    }))
  }

  async putVault(
    vault: string,
    header: string,
    expected: number | null,
    updated: number
  ) {
    const rows =
      expected === null
        ? await this.query(
            'insert into typenext_vaults (vault, header, updated) values ($1, $2, $3) on conflict (vault) do nothing returning vault',
            [vault, header, updated]
          )
        : await this.query(
            'update typenext_vaults set header = $2, updated = $3 where vault = $1 and updated = $4 returning vault',
            [vault, header, updated, expected]
          )
    return rows.length > 0
  }

  async head(vault: string) {
    const rows = await this.query(
      'select coalesce(max(rev), 0) as head from typenext_records where vault = $1',
      [vault]
    )
    return number(rows[0]?.head)
  }

  async changes(vault: string, after: number, limit: number) {
    const rows = await this.query(
      'select id, rev, size from typenext_records where vault = $1 and rev > $2 order by rev limit $3',
      [vault, after, limit]
    )
    return rows.map(row => ({
      id: text(row.id),
      rev: number(row.rev),
      size: number(row.size),
    }))
  }

  async records(vault: string, ids: string[]) {
    if (!ids.length) return []
    // Record ids are base 64 URL text, which needs no quoting in an array.
    const rows = await this.query(
      'select id, rev, device, deleted, body from typenext_records where vault = $1 and id = any($2::text[])',
      [vault, `{${ids.join(',')}}`]
    )
    return rows.map(row => ({
      id: text(row.id),
      rev: number(row.rev),
      device: text(row.device),
      deleted: bool(row.deleted),
      body: text(row.body),
    }))
  }

  async push(vault: string, device: string, records: PushRecord[]) {
    if (!records.length) return []
    // The lock orders writers in a vault, so revisions become visible in
    // order and a reader never skips one committed late.
    const results = await this.batch([
      {
        sql: 'select pg_advisory_xact_lock(hashtext($1))::text as locked',
        params: [vault],
      },
      ...records.map(record => ({
        sql: `insert into typenext_records as r (vault, id, rev, device, deleted, body, size)
              values ($1, $2, nextval('typenext_rev'), $3, $4, $5, $6)
              on conflict (vault, id) do update set rev = nextval('typenext_rev'),
                device = excluded.device, deleted = excluded.deleted,
                body = excluded.body, size = excluded.size
              where r.rev = $7
              returning rev`,
        params: [
          vault,
          record.id,
          device,
          record.deleted,
          record.body,
          record.body.length,
          record.base,
        ],
      })),
    ])
    return records.map((record, index) => {
      const row = results[index + 1]?.[0]
      return { id: record.id, rev: row ? number(row.rev) : null }
    })
  }

  async presence(vault: string, device: string, body: string) {
    const rows = await this.query(
      `insert into typenext_devices (vault, device, seen, body)
       values ($1, $2, (extract(epoch from clock_timestamp()) * 1000)::bigint, $3)
       on conflict (vault, device) do update set seen = excluded.seen, body = excluded.body
       returning seen`,
      [vault, device, body]
    )
    return number(rows[0]?.seen) || Date.now()
  }

  async devices(vault: string) {
    const [now, rows] = await this.batch([
      {
        sql: 'select (extract(epoch from clock_timestamp()) * 1000)::bigint as now',
        params: [],
      },
      {
        sql: 'select device, seen, body from typenext_devices where vault = $1 order by seen desc limit 64',
        params: [vault],
      },
    ])
    return {
      now: number(now?.[0]?.now) || Date.now(),
      rows: (rows ?? []).map(row => ({
        device: text(row.device),
        seen: number(row.seen),
        body: text(row.body),
      })),
    }
  }

  async removeDevice(vault: string, device: string) {
    await this.query(
      'delete from typenext_devices where vault = $1 and device = $2',
      [vault, device]
    )
  }

  async erase(vault: string) {
    await this.batch([
      { sql: 'delete from typenext_records where vault = $1', params: [vault] },
      { sql: 'delete from typenext_devices where vault = $1', params: [vault] },
      { sql: 'delete from typenext_vaults where vault = $1', params: [vault] },
    ])
  }
}

// --------------------------------------------------------- Cloudflare D1

/**
 * The Cloudflare API does not answer browser requests from other origins.
 * The desktop app calls it from Rust. In development, Vite forwards
 * /__cloudflare to it so the browser build can be tested.
 */
let apiBaseOverride: string | null = null

/** Live tests call Cloudflare directly from Node. */
export function overrideCloudflareApiBase(base: string | null) {
  apiBaseOverride = base
}

export function cloudflareApiBase(): string | null {
  if (apiBaseOverride) return apiBaseOverride
  if (isDesktop()) return 'https://api.cloudflare.com/client/v4'
  if (import.meta.env.DEV && typeof location !== 'undefined')
    return `${location.origin}/__cloudflare/client/v4`
  return null
}

export function d1Available(): boolean {
  return cloudflareApiBase() !== null
}

interface CloudflareEnvelope<T> {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: T
}

async function cloudflare<T>(
  path: string,
  apiSecret: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<T> {
  const base = cloudflareApiBase()
  if (!base)
    throw new Error('Cloudflare D1 sync needs the TypeNext desktop app.')
  let response: string
  try {
    response = await requestText(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiSecret}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    })
  } catch (error) {
    throw friendly(error, 'd1')
  }
  const envelope = JSON.parse(response) as CloudflareEnvelope<T>
  if (envelope.success === false || envelope.result === undefined)
    throw friendly(
      new Error(
        envelope.errors?.map(item => item.message).join(' ') ||
          'Cloudflare D1 returned an error.'
      ),
      'd1'
    )
  return envelope.result
}

export interface D1Database {
  uuid: string
  name: string
  size?: number
}

export async function listD1Databases(accountId: string, apiSecret: string) {
  const result = await cloudflare<
    { uuid: string; name: string; file_size?: number }[]
  >(
    `/accounts/${encodeURIComponent(accountId)}/d1/database?per_page=100`,
    apiSecret,
    'GET'
  )
  return result.map(item => ({
    uuid: item.uuid,
    name: item.name,
    size: item.file_size,
  }))
}

export async function createD1Database(
  accountId: string,
  apiSecret: string,
  name: string
) {
  const result = await cloudflare<{ uuid: string; name: string }>(
    `/accounts/${encodeURIComponent(accountId)}/d1/database`,
    apiSecret,
    'POST',
    { name }
  )
  return { uuid: result.uuid, name: result.name }
}

interface D1Result {
  results?: Row[]
  success?: boolean
}

const NOW_MS = "cast((julianday('now') - 2440587.5) * 86400000 as integer)"

export class D1Transport implements SyncTransport {
  readonly kind = 'd1' as const
  private readonly path: string

  constructor(
    accountId: string,
    databaseId: string,
    private readonly apiSecret: string
  ) {
    this.path = `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`
  }

  private async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await cloudflare<D1Result[]>(
      this.path,
      this.apiSecret,
      'POST',
      {
        sql,
        params,
      }
    )
    return result[0]?.results ?? []
  }

  /** Statements run in order, in one transaction. */
  private async batch(statements: SqlStatement[]): Promise<Row[][]> {
    const result = await cloudflare<D1Result[]>(
      this.path,
      this.apiSecret,
      'POST',
      {
        batch: statements,
      }
    )
    return result.map(item => item.results ?? [])
  }

  async setup() {
    await this.batch([
      {
        sql: 'create table if not exists typenext_vaults (vault text primary key, header text not null, updated integer not null)',
        params: [],
      },
      {
        sql: 'create table if not exists typenext_records (vault text not null, id text not null, rev integer not null, device text not null, deleted integer not null default 0, body text not null, size integer not null, primary key (vault, id))',
        params: [],
      },
      {
        sql: 'create index if not exists typenext_records_rev on typenext_records (vault, rev)',
        params: [],
      },
      {
        sql: 'create table if not exists typenext_devices (vault text not null, device text not null, seen integer not null, body text not null, primary key (vault, device))',
        params: [],
      },
    ])
  }

  async vaults() {
    const rows = await this.query(
      'select vault, header, updated from typenext_vaults order by updated desc limit 16'
    )
    return rows.map(row => ({
      vault: text(row.vault),
      header: text(row.header),
      updated: number(row.updated),
    }))
  }

  async putVault(
    vault: string,
    header: string,
    expected: number | null,
    updated: number
  ) {
    const rows =
      expected === null
        ? await this.query(
            'insert into typenext_vaults (vault, header, updated) values (?1, ?2, ?3) on conflict (vault) do nothing returning vault',
            [vault, header, updated]
          )
        : await this.query(
            'update typenext_vaults set header = ?2, updated = ?3 where vault = ?1 and updated = ?4 returning vault',
            [vault, header, updated, expected]
          )
    return rows.length > 0
  }

  async head(vault: string) {
    const rows = await this.query(
      'select coalesce(max(rev), 0) as head from typenext_records where vault = ?1',
      [vault]
    )
    return number(rows[0]?.head)
  }

  async changes(vault: string, after: number, limit: number) {
    const rows = await this.query(
      'select id, rev, size from typenext_records where vault = ?1 and rev > ?2 order by rev limit ?3',
      [vault, after, limit]
    )
    return rows.map(row => ({
      id: text(row.id),
      rev: number(row.rev),
      size: number(row.size),
    }))
  }

  async records(vault: string, ids: string[]) {
    if (!ids.length) return []
    const rows = await this.query(
      'select id, rev, device, deleted, body from typenext_records where vault = ?1 and id in (select value from json_each(?2))',
      [vault, JSON.stringify(ids)]
    )
    return rows.map(row => ({
      id: text(row.id),
      rev: number(row.rev),
      device: text(row.device),
      deleted: bool(row.deleted),
      body: text(row.body),
    }))
  }

  async push(vault: string, device: string, records: PushRecord[]) {
    if (!records.length) return []
    // D1 runs one writer at a time, so the next revision is the largest
    // plus one, computed inside each statement.
    const results = await this.batch(
      records.map(record => ({
        sql: `insert into typenext_records (vault, id, rev, device, deleted, body, size)
              values (?1, ?2, (select coalesce(max(rev), 0) + 1 from typenext_records where vault = ?1), ?3, ?4, ?5, ?6)
              on conflict (vault, id) do update set rev = excluded.rev,
                device = excluded.device, deleted = excluded.deleted,
                body = excluded.body, size = excluded.size
              where typenext_records.rev = ?7
              returning rev`,
        params: [
          vault,
          record.id,
          device,
          record.deleted ? 1 : 0,
          record.body,
          record.body.length,
          record.base,
        ],
      }))
    )
    return records.map((record, index) => {
      const row = results[index]?.[0]
      return { id: record.id, rev: row ? number(row.rev) : null }
    })
  }

  async presence(vault: string, device: string, body: string) {
    const rows = await this.query(
      `insert into typenext_devices (vault, device, seen, body) values (?1, ?2, ${NOW_MS}, ?3)
       on conflict (vault, device) do update set seen = excluded.seen, body = excluded.body
       returning seen`,
      [vault, device, body]
    )
    return number(rows[0]?.seen) || Date.now()
  }

  async devices(vault: string) {
    const [now, rows] = await this.batch([
      { sql: `select ${NOW_MS} as now`, params: [] },
      {
        sql: 'select device, seen, body from typenext_devices where vault = ?1 order by seen desc limit 64',
        params: [vault],
      },
    ])
    return {
      now: number(now?.[0]?.now) || Date.now(),
      rows: (rows ?? []).map(row => ({
        device: text(row.device),
        seen: number(row.seen),
        body: text(row.body),
      })),
    }
  }

  async removeDevice(vault: string, device: string) {
    await this.query(
      'delete from typenext_devices where vault = ?1 and device = ?2',
      [vault, device]
    )
  }

  async erase(vault: string) {
    await this.batch([
      { sql: 'delete from typenext_records where vault = ?1', params: [vault] },
      { sql: 'delete from typenext_devices where vault = ?1', params: [vault] },
      { sql: 'delete from typenext_vaults where vault = ?1', params: [vault] },
    ])
  }
}
