import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSyncSettings, Workspace } from '../../types/notebook'
import { defaultCloudSettings, emptyWorkspace, newNote } from '../model'
import {
  createVault,
  type Keyring,
  type VaultHeader,
} from '../../services/cloud-sync/crypto'
import { MemoryTransport } from '../../services/cloud-sync/memory-transport'
import { TargetSync } from '../../services/cloud-sync/engine'
import { resetCloudStateForTests } from '../../services/cloud-sync/state'

const database = new MemoryTransport()
let keyring: Keyring | null = null
let header: VaultHeader | null = null
let credentials = true

vi.mock('../../services/cloud-sync/session', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../services/cloud-sync/session')>()
  return {
    ...actual,
    transportFor: async () => {
      if (!credentials)
        throw new actual.MissingCredentialsError('Enter the credentials again.')
      return database
    },
    rememberedKeyring: async () => keyring,
    readHeader: async () =>
      header
        ? { row: { vault: header.vaultId, header: '', updated: 1 }, header }
        : null,
    lockDevice: async () => {
      keyring = null
    },
  }
})

const { CloudController, getCloudSyncState, resetCloudSyncForTests } =
  await import('./controller')

function settings(patch: Partial<CloudSyncSettings> = {}): CloudSyncSettings {
  return {
    ...defaultCloudSettings(),
    enabled: true,
    targets: [
      {
        id: 'neon1',
        kind: 'neon',
        label: 'Neon',
        enabled: true,
        vaultId: keyring?.vaultId ?? 'vault',
        addedAt: 1,
      },
    ],
    ...patch,
  }
}

function harness(initial = emptyWorkspace()) {
  let workspace: Workspace = initial
  const notify = vi.fn()
  const controller = new CloudController(
    {
      getWorkspace: () => workspace,
      setWorkspace: action => {
        workspace = typeof action === 'function' ? action(workspace) : action
      },
      notify,
    },
    settings()
  )
  return {
    controller,
    notify,
    get workspace() {
      return workspace
    },
    set workspace(value: Workspace) {
      workspace = value
    },
  }
}

beforeEach(async () => {
  resetCloudStateForTests()
  resetCloudSyncForTests()
  database.rows.clear()
  database.deviceRows.clear()
  credentials = true
  const vault = await createVault('controller test key', {
    iterations: 100_000,
  })
  keyring = vault.keyring
  header = vault.header
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cloud sync controller', () => {
  it('syncs on start, publishes this device and counts nothing pending', async () => {
    const note = { ...newNote('Hello'), content: 'world' }
    const device = harness({ ...emptyWorkspace(), notes: [note] })
    await device.controller.configure(settings())
    expect(await device.controller.syncAll()).toBe(true)
    expect(getCloudSyncState().phase).toBe('synced')
    expect(getCloudSyncState().targets.neon1?.phase).toBe('synced')
    expect(getCloudSyncState().pending).toBe(0)

    // Another device reads what this one sent.
    let other = emptyWorkspace()
    await new TargetSync({
      targetId: 'other',
      transport: database,
      keyring: keyring!,
      device: { id: 'other', name: 'Other' },
      getWorkspace: () => other,
      updateWorkspace: apply => {
        other = apply(other)
      },
      scope: () => ({ include: settings().include, spaceIds: [] }),
      deviceName: id => id,
    }).sync()
    expect(other.notes[0]?.content).toBe('world')

    await device.controller.readDevices()
    await (
      device.controller as unknown as { sendPresence(): Promise<void> }
    ).sendPresence()
    const devices = getCloudSyncState().devices
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ self: true, active: true, noteId: null })
    device.controller.dispose()
  })

  it('sends changes moments after writing pauses in Live mode', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const device = harness()
    await device.controller.configure(settings())
    const note = { ...newNote('Draft'), content: 'one' }
    device.workspace = {
      ...device.workspace,
      notes: [note],
      activeNoteId: note.id,
      openNoteIds: [note.id],
    }
    device.controller.noteChanged(device.workspace)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.waitFor(() =>
      expect([...database.rows.values()].length).toBeGreaterThan(20)
    )
    device.controller.dispose()
  })

  it('waits for Sync now in manual mode', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const device = harness()
    await device.controller.configure(settings({ cadence: 'manual' }))
    await vi.advanceTimersByTimeAsync(1_000)
    const written = database.rows.size
    device.workspace = {
      ...device.workspace,
      notes: [{ ...newNote('Draft'), content: 'x' }],
    }
    device.controller.noteChanged(device.workspace)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(database.rows.size).toBe(written)
    await vi.waitFor(() => expect(getCloudSyncState().pending).toBe(1))
    await device.controller.syncAll()
    expect(database.rows.size).toBeGreaterThan(written)
    device.controller.dispose()
  })

  it('asks for the key when this device does not have it', async () => {
    keyring = null
    const device = harness()
    await device.controller.configure(settings())
    expect(getCloudSyncState().targets.neon1?.phase).toBe('locked')
    expect(getCloudSyncState().phase).toBe('attention')
    expect(await device.controller.syncAll()).toBe(false)
  })

  it('asks for credentials that are missing on this device', async () => {
    credentials = false
    const device = harness()
    await device.controller.configure(settings())
    expect(getCloudSyncState().targets.neon1).toMatchObject({
      phase: 'credentials',
      message: 'Enter the credentials again.',
    })
  })

  it('forgets the key when another device removed this one', async () => {
    const device = harness()
    header = { ...header!, revoked: [device.controller.device] }
    await device.controller.configure(settings())
    expect(getCloudSyncState().targets.neon1?.phase).toBe('revoked')
    expect(keyring).toBeNull()
  })

  it('turns off cleanly', async () => {
    const device = harness()
    await device.controller.configure(settings())
    await device.controller.configure(settings({ enabled: false }))
    expect(getCloudSyncState().phase).toBe('off')
  })
})
