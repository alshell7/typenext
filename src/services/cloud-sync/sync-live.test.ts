/**
 * Opt-in checks against real databases. Credentials come from the
 * environment and stay in this test process. Each run uses a fresh
 * encrypted notebook and erases its rows afterwards; nothing else in the
 * database is touched.
 *
 *   set -a; . ./.env; set +a
 *   TYPENEXT_LIVE_SYNC=1 npx vitest run src/services/cloud-sync/sync-live.test.ts
 *
 * Neon: NEON_POSTGRES_CONN_STRING, and for Live updates NEON_REALTIME_URL
 * and NEON_REALTIME_SECRET. D1: CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_D1_API_KEY; the database "typenext-sync" is created if missing.
 */
import { afterAll, describe, expect, it } from 'vitest'
import NodeWebSocket from 'ws'
import { emptyWorkspace, newNote } from '../../notebook/model'
import type { Workspace } from '../../types/notebook'
import { TargetSync } from './engine'
import { watchVault } from './realtime'
import { resetCloudStateForTests } from './state'
import {
  createVaultIn,
  discoverVaults,
  publishPresence,
  readPresence,
  unlockVault,
} from './session'
import {
  D1Transport,
  NeonTransport,
  createD1Database,
  listD1Databases,
  overrideCloudflareApiBase,
  parseNeonConnection,
  type SyncTransport,
} from './transport'

const enabled = process.env.TYPENEXT_LIVE_SYNC === '1'
const neon = process.env.NEON_POSTGRES_CONN_STRING ?? ''
const realtimeUrl = process.env.NEON_REALTIME_URL ?? ''
const realtimeSecret = process.env.NEON_REALTIME_SECRET ?? ''
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
const d1Secret = process.env.CLOUDFLARE_D1_API_KEY ?? ''
const SCOPE = {
  include: { notes: true, organize: true, contexts: true, settings: true },
  spaceIds: [],
}

const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  // Last in, first out: data is erased before its connection goes.
  for (const step of cleanup.reverse()) await step().catch(() => {})
})

async function scenario(transport: SyncTransport) {
  resetCloudStateForTests()
  const created = await createVaultIn(transport, 'live test passphrase 42', {
    iterations: 100_000,
  })
  cleanup.push(() => transport.erase(created.header.vaultId))
  const found = await discoverVaults(transport)
  const header = found.find(
    item => item.header.vaultId === created.header.vaultId
  )!.header
  // A second device opens the notebook with a recovery key.
  const second = await unlockVault(header, created.recoveryKeys[0]!, 'pc')

  let mac: Workspace = emptyWorkspace()
  let pc: Workspace = emptyWorkspace()
  const engine = (name: 'mac' | 'pc', keyring = created.keyring) =>
    new TargetSync({
      targetId: `${transport.kind}-${name}-${created.header.vaultId}`,
      transport,
      keyring,
      device: { id: name, name },
      getWorkspace: () => (name === 'mac' ? mac : pc),
      updateWorkspace: apply => {
        if (name === 'mac') mac = apply(mac)
        else pc = apply(pc)
      },
      scope: () => SCOPE,
      deviceName: id => id,
    })
  const macSync = engine('mac')
  const pcSync = engine('pc', second.keyring)

  const note = { ...newNote('Live'), content: 'one\n\ntwo\n\nthree' }
  mac = { ...mac, notes: [note], settings: { ...mac.settings, theme: 'dark' } }
  expect((await macSync.sync()).pushed).toBeGreaterThan(20)
  await pcSync.sync()
  expect(pc.notes[0]?.content).toBe('one\n\ntwo\n\nthree')
  expect(pc.settings.theme).toBe('dark')

  const edit = (workspace: Workspace, content: string): Workspace => ({
    ...workspace,
    notes: workspace.notes.map(item =>
      item.id === note.id
        ? { ...item, content, updatedAt: item.updatedAt + 1 }
        : item
    ),
  })
  mac = edit(mac, 'one, from the Mac\n\ntwo\n\nthree')
  pc = edit(pc, 'one\n\ntwo\n\nthree, from the PC')
  await macSync.sync()
  // The PC's write is refused, merged with the Mac's and sent again.
  await pcSync.sync()
  await macSync.sync()
  const merged = 'one, from the Mac\n\ntwo\n\nthree, from the PC'
  expect(mac.notes.find(item => item.id === note.id)?.content).toBe(merged)
  expect(pc.notes.find(item => item.id === note.id)?.content).toBe(merged)
  expect(await macSync.pending()).toBe(0)

  // A compare-and-set header write fails on a stale version.
  const stale = await transport.putVault(
    created.header.vaultId,
    JSON.stringify(created.header),
    1,
    Date.now()
  )
  expect(stale).toBe(false)

  // Presence round trip, encrypted.
  await publishPresence(transport, created.keyring, 'mac', {
    v: 1,
    name: 'Mac',
    platform: 'mac',
    noteId: note.id,
    editingAt: Date.now(),
    visible: true,
  })
  const { now, rows } = await transport.devices(created.header.vaultId)
  const devices = await readPresence(rows, now, second.keyring, 'pc')
  expect(devices).toHaveLength(1)
  expect(devices[0]).toMatchObject({
    name: 'Mac',
    noteId: note.id,
    active: true,
  })
  return {
    created,
    transport,
    macSync,
    note,
    getMac: () => mac,
    setMac: (value: Workspace) => (mac = value),
  }
}

describe.skipIf(!enabled || !neon)('live Neon sync', () => {
  it('syncs, merges and shares presence', async () => {
    const transport = new NeonTransport(neon)
    const { created, macSync, getMac, setMac, note } = await scenario(transport)
    if (!realtimeUrl || !realtimeSecret) return
    // Live updates: a write elsewhere reaches a watcher within seconds.
    const heads: number[] = []
    const live = await watchVault(
      {
        url: realtimeUrl,
        secret: realtimeSecret,
        database: parseNeonConnection(neon).database,
        vaultId: created.header.vaultId,
        // jsdom's WebSocket stands in for the browser's poorly here.
        webSocketFactory: (url, protocols) =>
          new NodeWebSocket(url, protocols) as unknown as WebSocket,
      },
      {
        onHead: head => heads.push(head),
        onDevices: () => {},
        onStatus: (live, message) => console.log('STATUS', live, message ?? ''),
      }
    )
    cleanup.push(async () => live.stop())
    await new Promise(resolve => setTimeout(resolve, 2_500))
    const before = Math.max(0, ...heads)
    setMac({
      ...getMac(),
      notes: getMac().notes.map(item =>
        item.id === note.id
          ? { ...item, content: 'changed live', updatedAt: item.updatedAt + 1 }
          : item
      ),
    })
    await macSync.sync()
    const deadline = Date.now() + 10_000
    while (Math.max(0, ...heads) <= before && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 200))
    expect(Math.max(0, ...heads)).toBeGreaterThan(before)
    live.stop()
  }, 60_000)
})

describe.skipIf(!enabled || !account || !d1Secret)(
  'live Cloudflare D1 sync',
  () => {
    it('syncs, merges and shares presence', async () => {
      overrideCloudflareApiBase('https://api.cloudflare.com/client/v4')
      cleanup.push(async () => overrideCloudflareApiBase(null))
      const databases = await listD1Databases(account, d1Secret)
      const database =
        databases.find(item => item.name === 'typenext-sync') ??
        (await createD1Database(account, d1Secret, 'typenext-sync'))
      await scenario(new D1Transport(account, database.uuid, d1Secret))
    }, 90_000)
  }
)
