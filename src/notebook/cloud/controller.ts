import type { SetStateAction } from 'react'
import type {
  CloudSyncSettings,
  CloudTarget,
  Workspace,
} from '../../types/notebook'
import { TargetSync, type SyncConflict } from '../../services/cloud-sync/engine'
import type { Keyring } from '../../services/cloud-sync/crypto'
import { watchVault, type LiveWatch } from '../../services/cloud-sync/realtime'
import type { DeviceLinks } from '../../services/cloud-sync/records'
import {
  MissingCredentialsError,
  defaultDeviceName,
  deviceId,
  devicePlatform,
  lockDevice,
  neonDatabase,
  publishPresence,
  readHeader,
  readPresence,
  readTargetSecret,
  rememberedKeyring,
  transportFor,
  type DevicePresence,
  type PresenceBody,
} from '../../services/cloud-sync/session'
import type { SyncTransport } from '../../services/cloud-sync/transport'

/**
 * Runs cloud sync for the open notebook: one runtime per database, a
 * scheduler that follows the chosen cadence, Live updates where Neon
 * Realtime is set up, polling elsewhere, device presence, and back-off
 * after errors. The interface reads its state from a small external store.
 */

export type TargetPhase =
  | 'connecting'
  | 'credentials'
  | 'setup'
  | 'locked'
  | 'revoked'
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'error'

export interface TargetStatus {
  phase: TargetPhase
  at?: number
  message?: string
  live?: boolean
}

export interface PeerLinks {
  device: string
  name: string
  links: DeviceLinks
}

export interface CloudSyncState {
  phase:
    'off' | 'attention' | 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  at?: number
  message?: string
  /** Changes made here and not yet sent. */
  pending: number
  targets: Record<string, TargetStatus>
  /** Every device of the notebook, this one included. */
  devices: DevicePresence[]
  conflicts: SyncConflict[]
  peerLinks: PeerLinks[]
}

const OFF: CloudSyncState = {
  phase: 'off',
  pending: 0,
  targets: {},
  devices: [],
  conflicts: [],
  peerLinks: [],
}

let state: CloudSyncState = OFF
const listeners = new Set<() => void>()

export function getCloudSyncState() {
  return state
}

export function subscribeCloudSync(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(patch: Partial<CloudSyncState>) {
  state = { ...state, ...patch }
  const statuses = Object.values(state.targets)
  if (state.phase !== 'off' && patch.phase === undefined && patch.targets) {
    // The overall phase follows the most important database state.
    const phases = statuses.map(status => status.phase)
    state.phase = phases.includes('syncing')
      ? 'syncing'
      : phases.some(phase =>
            ['credentials', 'setup', 'locked', 'revoked'].includes(phase)
          )
        ? 'attention'
        : phases.includes('error')
          ? 'error'
          : phases.includes('offline')
            ? 'offline'
            : phases.includes('synced')
              ? 'synced'
              : 'idle'
    const times = statuses.map(status => status.at ?? 0)
    state.at = Math.max(0, ...times) || state.at
  }
  listeners.forEach(listener => listener())
}

function setTarget(id: string, status: Partial<TargetStatus>) {
  publish({
    targets: {
      ...state.targets,
      [id]: { ...(state.targets[id] ?? { phase: 'idle' }), ...status },
    },
  })
}

export function resetCloudSyncForTests() {
  state = OFF
  listeners.clear()
}

interface Runtime {
  target: CloudTarget
  transport: SyncTransport
  keyring: Keyring
  engine: TargetSync
  live: LiveWatch | null
  /** The newest revision the database reported. */
  head: number
  cursor: number
}

export interface ControllerIo {
  getWorkspace(): Workspace
  setWorkspace(action: SetStateAction<Workspace>): void
  notify(message: string): void
  appVersion?: string
}

const MAX_BACKOFF_MS = 10 * 60_000
const PRESENCE_MS = 25_000
const POLL_VISIBLE_MS = 20_000
const POLL_HIDDEN_MS = 120_000
/** Another device is on the same note: share edits within moments. */
const PAIRED_PUSH_MS = 900
const PAIRED_POLL_MS = 4_000
const PUSH_MS = 3_500

function visible() {
  return (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  )
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function offlineError(message: string) {
  return /could not be reached|Check your connection|offline|took too long/iu.test(
    message
  )
}

export class CloudController {
  private runtimes = new Map<string, Runtime>()
  private io: ControllerIo
  private settings: CloudSyncSettings
  private generation = 0
  private running = false
  private again = false
  private failures = 0
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private devicesTimer: ReturnType<typeof setTimeout> | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private lastPresence = 0
  private lastPresenceKey = ''
  private editingAt = 0
  private lastActive: { id: string | null; updatedAt: number } = {
    id: null,
    updatedAt: 0,
  }
  private readonly revocationChecks = new Map<string, number>()
  readonly device = deviceId()
  private readonly deviceRef = Object.defineProperty(
    { id: this.device } as { id: string; name: string },
    'name',
    { get: () => this.deviceName, enumerable: true }
  )

  constructor(io: ControllerIo, settings: CloudSyncSettings) {
    this.io = io
    this.settings = settings
  }

  get deviceName() {
    return this.settings.deviceName.trim() || defaultDeviceName()
  }

  setIo(io: ControllerIo) {
    this.io = io
  }

  /** Rebuild the runtimes after the database list or keys change. */
  async configure(settings: CloudSyncSettings) {
    const generation = ++this.generation
    this.settings = settings
    this.stopRuntimes()
    const targets = settings.enabled
      ? settings.targets.filter(target => target.enabled)
      : []
    if (!targets.length) {
      publish({ ...OFF })
      return
    }
    publish({
      phase: 'idle',
      targets: Object.fromEntries(
        targets.map(target => [target.id, { phase: 'connecting' as const }])
      ),
      devices: [],
      conflicts: state.conflicts,
    })
    await Promise.all(targets.map(target => this.start(target, generation)))
    if (generation !== this.generation) return
    this.scheduleSync(300)
    this.schedulePresence(500)
    this.schedulePoll()
    this.applyCadence()
  }

  /** Only the cadence or the selection changed: no reconnect. */
  update(settings: CloudSyncSettings) {
    const cadenceChanged =
      settings.cadence !== this.settings.cadence ||
      settings.intervalMinutes !== this.settings.intervalMinutes
    const presenceChanged = settings.presence !== this.settings.presence
    const renamed = settings.deviceName !== this.settings.deviceName
    const sharing = this.settings.presence
    this.settings = settings
    // Stopped sharing: tell the others at once that this device is away.
    if (presenceChanged && sharing) void this.sendPresence(true)
    else if (presenceChanged || renamed)
      this.schedulePresence(renamed ? 1_500 : 100)
    if (cadenceChanged) {
      this.applyCadence()
      this.schedulePoll()
      for (const runtime of this.runtimes.values())
        void this.startLive(runtime, this.generation)
    }
  }

  private async start(target: CloudTarget, generation: number) {
    try {
      const transport = await transportFor(target)
      if (!target.vaultId) {
        setTarget(target.id, {
          phase: 'setup',
          message: 'Finish setting up this database.',
        })
        return
      }
      const keyring = await rememberedKeyring(target.vaultId)
      if (generation !== this.generation) return
      if (!keyring) {
        setTarget(target.id, {
          phase: 'locked',
          message:
            'Enter your sync key to open the encrypted notebook on this device.',
        })
        return
      }
      const runtime: Runtime = {
        target,
        transport,
        keyring,
        live: null,
        head: 0,
        cursor: 0,
        engine: new TargetSync({
          targetId: target.id,
          transport,
          keyring,
          // The name is read at each sync, so renaming needs no reconnect.
          device: this.deviceRef,
          getWorkspace: () => this.io.getWorkspace(),
          updateWorkspace: apply => this.io.setWorkspace(apply),
          scope: () => ({
            include: this.settings.include,
            spaceIds: this.settings.spaceIds,
          }),
          deviceName: id => this.nameOf(id),
        }),
      }
      this.runtimes.set(target.id, runtime)
      setTarget(target.id, { phase: 'idle', message: undefined })
      if (await this.checkRevoked(runtime)) return
      void this.startLive(runtime, generation)
    } catch (error) {
      if (generation !== this.generation) return
      setTarget(target.id, {
        phase:
          error instanceof MissingCredentialsError ? 'credentials' : 'error',
        message: messageOf(error),
      })
    }
  }

  private async startLive(runtime: Runtime, generation: number) {
    runtime.live?.stop()
    runtime.live = null
    const { target } = runtime
    if (
      target.kind !== 'neon' ||
      !target.realtimeUrl ||
      this.settings.cadence === 'manual'
    ) {
      setTarget(target.id, { live: false })
      return
    }
    try {
      const secret = await readTargetSecret(target.id, 'realtime')
      if (!secret) return
      const live = await watchVault(
        {
          url: target.realtimeUrl,
          secret,
          database: await neonDatabase(target),
          vaultId: runtime.keyring.vaultId,
        },
        {
          onHead: head => {
            runtime.head = head
            if (head > runtime.cursor && this.settings.cadence === 'live')
              this.scheduleSync(250)
          },
          onDevices: () => this.scheduleDevices(400),
          onStatus: (isLive, message) => {
            setTarget(target.id, {
              live: isLive,
              ...(message ? { message } : {}),
            })
            this.schedulePoll()
          },
        }
      )
      if (generation !== this.generation || !this.runtimes.has(target.id))
        live.stop()
      else runtime.live = live
    } catch (error) {
      setTarget(target.id, {
        live: false,
        message: `Live updates are off: ${messageOf(error)}`,
      })
    }
  }

  private stopRuntimes() {
    for (const runtime of this.runtimes.values()) runtime.live?.stop()
    this.runtimes.clear()
    for (const timer of [
      this.syncTimer,
      this.pollTimer,
      this.presenceTimer,
      this.devicesTimer,
      this.pendingTimer,
    ])
      if (timer) clearTimeout(timer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.syncTimer =
      this.pollTimer =
      this.presenceTimer =
      this.devicesTimer =
      this.pendingTimer =
        null
    this.intervalTimer = null
  }

  dispose() {
    this.generation++
    this.stopRuntimes()
  }

  private nameOf(id: string) {
    if (id === this.device) return this.deviceName
    return (
      state.devices.find(device => device.id === id)?.name ?? 'another device'
    )
  }

  // ------------------------------------------------------------- Schedule

  private applyCadence() {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.intervalTimer = null
    if (this.settings.cadence === 'interval')
      this.intervalTimer = setInterval(
        () => this.scheduleSync(0),
        this.settings.intervalMinutes * 60_000
      )
  }

  /** Another device is open on the note shown here. */
  private paired() {
    const active = this.io.getWorkspace().activeNoteId
    return Boolean(
      active &&
      state.devices.some(
        device => !device.self && device.active && device.noteId === active
      )
    )
  }

  scheduleSync(delay: number) {
    if (!this.runtimes.size) return
    if (this.syncTimer) clearTimeout(this.syncTimer)
    const backoff = this.failures
      ? Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (this.failures - 1))
      : 0
    this.syncTimer = setTimeout(
      () => {
        this.syncTimer = null
        void this.syncAll()
      },
      Math.max(delay, backoff)
    )
  }

  /** Called on every notebook change. Cheap: only timers. */
  noteChanged(workspace: Workspace) {
    if (!this.runtimes.size) return
    const active = workspace.notes.find(
      note => note.id === workspace.activeNoteId
    )
    if (
      active &&
      active.id === this.lastActive.id &&
      active.updatedAt !== this.lastActive.updatedAt
    ) {
      this.editingAt = Date.now()
      if (Date.now() - this.lastPresence > 8_000) this.schedulePresence(400)
    }
    if ((active?.id ?? null) !== this.lastActive.id) this.schedulePresence(300)
    this.lastActive = {
      id: active?.id ?? null,
      updatedAt: active?.updatedAt ?? 0,
    }
    if (this.settings.cadence === 'live')
      this.scheduleSync(this.paired() ? PAIRED_PUSH_MS : PUSH_MS)
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = setTimeout(() => void this.countPending(), 1_200)
  }

  private async countPending() {
    const runtime = this.runtimes.values().next().value as Runtime | undefined
    if (!runtime) return
    try {
      publish({ pending: await runtime.engine.pending() })
    } catch {
      // Counting is advisory.
    }
  }

  /** Ask the database for news when Live updates are not running. */
  schedulePoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (!this.runtimes.size || this.settings.cadence !== 'live') return
    const needsPoll = [...this.runtimes.values()].some(
      runtime => !state.targets[runtime.target.id]?.live
    )
    if (!needsPoll) return
    const delay = !visible()
      ? POLL_HIDDEN_MS
      : this.paired()
        ? PAIRED_POLL_MS
        : POLL_VISIBLE_MS
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      for (const runtime of this.runtimes.values()) {
        if (state.targets[runtime.target.id]?.live) continue
        try {
          runtime.head = await runtime.transport.head(runtime.keyring.vaultId)
          if (runtime.head > runtime.cursor) this.scheduleSync(0)
        } catch {
          // The next sync reports connection problems.
        }
      }
      this.schedulePoll()
    }, delay)
  }

  /** The window became visible or the network returned. */
  wake() {
    if (!this.runtimes.size) return
    if (this.settings.cadence !== 'manual') this.scheduleSync(200)
    this.schedulePresence(200)
    this.schedulePoll()
  }

  // ----------------------------------------------------------------- Sync

  async syncAll(): Promise<boolean> {
    if (!this.runtimes.size) return false
    if (this.running) {
      this.again = true
      return false
    }
    this.running = true
    const generation = this.generation
    let ok = true
    try {
      for (const runtime of [...this.runtimes.values()]) {
        if (generation !== this.generation) break
        setTarget(runtime.target.id, { phase: 'syncing' })
        try {
          await this.checkRevoked(runtime)
          if (!this.runtimes.has(runtime.target.id)) continue
          const report = await runtime.engine.sync()
          runtime.cursor = runtime.engine.cursor
          setTarget(runtime.target.id, {
            phase: 'synced',
            at: Date.now(),
            message: undefined,
          })
          if (report.conflicts.length) {
            publish({
              conflicts: [...report.conflicts, ...state.conflicts].slice(0, 20),
            })
            const note = this.io
              .getWorkspace()
              .notes.find(item => item.id === report.conflicts[0]!.noteId)
            this.io.notify(
              `${note?.title || 'A note'} changed on ${this.nameOf(report.conflicts[0]!.device)} and here at once. Both versions are kept.`
            )
          }
          if (report.tooLarge.length)
            this.io.notify(
              `Too large to sync: ${report.tooLarge.slice(0, 3).join(', ')}.`
            )
        } catch (error) {
          ok = false
          const message = messageOf(error)
          setTarget(runtime.target.id, {
            phase: offlineError(message) ? 'offline' : 'error',
            message,
          })
        }
      }
      this.failures = ok ? 0 : this.failures + 1
      await this.countPending()
      void this.refreshLinks()
      if (!ok) this.scheduleSync(0)
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        this.scheduleSync(800)
      }
    }
    return ok
  }

  /** A device removed from the vault forgets its key. */
  private async checkRevoked(runtime: Runtime): Promise<boolean> {
    const last = this.revocationChecks.get(runtime.target.id) ?? 0
    if (Date.now() - last < 5 * 60_000) return false
    this.revocationChecks.set(runtime.target.id, Date.now())
    try {
      const found = await readHeader(runtime.transport, runtime.keyring.vaultId)
      if (!found?.header.revoked?.includes(this.device)) return false
    } catch {
      return false
    }
    await lockDevice(runtime.keyring.vaultId)
    runtime.live?.stop()
    this.runtimes.delete(runtime.target.id)
    setTarget(runtime.target.id, {
      phase: 'revoked',
      message: 'This device was removed from sync on another device.',
    })
    return true
  }

  private async refreshLinks() {
    const seen = new Map<string, PeerLinks>()
    for (const runtime of this.runtimes.values())
      for (const peer of await runtime.engine.peerLinks().catch(() => []))
        seen.set(peer.device, {
          device: peer.device,
          name: peer.links.name,
          links: peer.links,
        })
    publish({ peerLinks: [...seen.values()] })
  }

  // ------------------------------------------------------------- Presence

  schedulePresence(delay: number) {
    if (!this.runtimes.size) return
    if (this.presenceTimer) clearTimeout(this.presenceTimer)
    if (!this.settings.presence) {
      // Not sharing where this device is; still show the others.
      this.presenceTimer = setTimeout(async () => {
        this.presenceTimer = null
        await this.readDevices()
        if (visible()) this.schedulePresence(PRESENCE_MS * 2)
      }, delay)
      return
    }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      void this.sendPresence()
    }, delay)
  }

  private presenceBody(away = false): PresenceBody {
    const workspace = this.io.getWorkspace()
    if (away)
      return {
        v: 1,
        name: this.deviceName,
        platform: devicePlatform(),
        noteId: null,
        visible: false,
        sentAt: Date.now(),
      }
    return {
      v: 1,
      name: this.deviceName,
      platform: devicePlatform(),
      ...(this.io.appVersion ? { app: this.io.appVersion } : {}),
      noteId: workspace.activeNoteId,
      ...(workspace.activeSpaceId ? { spaceId: workspace.activeSpaceId } : {}),
      ...(this.editingAt ? { editingAt: this.editingAt } : {}),
      visible: visible(),
      sentAt: Date.now(),
    }
  }

  private async sendPresence(away = false) {
    const body = this.presenceBody(away)
    this.lastPresence = Date.now()
    this.lastPresenceKey = `${body.noteId}|${body.visible}`
    for (const runtime of this.runtimes.values()) {
      try {
        await publishPresence(
          runtime.transport,
          runtime.keyring,
          this.device,
          body
        )
      } catch {
        // Presence is best effort.
      }
    }
    await this.readDevices()
    if (visible() && !away) this.schedulePresence(PRESENCE_MS)
  }

  private scheduleDevices(delay: number) {
    if (this.devicesTimer) clearTimeout(this.devicesTimer)
    this.devicesTimer = setTimeout(() => {
      this.devicesTimer = null
      void this.readDevices()
    }, delay)
  }

  async readDevices() {
    const byId = new Map<string, DevicePresence>()
    for (const runtime of this.runtimes.values()) {
      try {
        const { now, rows } = await runtime.transport.devices(
          runtime.keyring.vaultId
        )
        for (const device of await readPresence(
          rows,
          now,
          runtime.keyring,
          this.device
        )) {
          const known = byId.get(device.id)
          if (!known || device.age < known.age) byId.set(device.id, device)
        }
      } catch {
        // Shown again at the next refresh.
      }
    }
    const devices = [...byId.values()].sort(
      (a, b) =>
        Number(b.self) - Number(a.self) ||
        Number(b.active) - Number(a.active) ||
        a.age - b.age
    )
    publish({ devices })
    this.schedulePoll()
  }

  /** Visible state changed: tell the others at once. */
  visibilityChanged() {
    const key = `${this.io.getWorkspace().activeNoteId}|${visible()}`
    if (key !== this.lastPresenceKey) this.schedulePresence(100)
    if (visible()) this.wake()
  }
}
