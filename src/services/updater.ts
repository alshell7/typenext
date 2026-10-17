import { useSyncExternalStore } from 'react'
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'
import { isDesktop } from './native'

/**
 * Updates come from the GitHub release feed (latest.json). The plugin
 * verifies every download with TypeNext's signing key before it installs.
 * Nothing restarts without the writer's choice.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** The new version, while one is known. */
  version: string | null
  notes: string
  date: string | null
  /** Download progress from 0 to 1, or null when the size is unknown. */
  progress: number | null
  error: string
  /** The writer asked for this check or download, so show its result. */
  manual: boolean
  /** "Later" hides the notice for this version until the next launch. */
  dismissed: string | null
  checkedAt: number | null
}

const CHECKED_KEY = 'typenext.updates.checkedAt'

function storedCheck(): number | null {
  try {
    return Number(localStorage.getItem(CHECKED_KEY)) || null
  } catch {
    return null
  }
}

const initial: UpdateState = {
  phase: 'idle',
  version: null,
  notes: '',
  date: null,
  progress: null,
  error: '',
  manual: false,
  dismissed: null,
  checkedAt: storedCheck(),
}

let state = initial
let update: Update | null = null
let saveBeforeInstall: (() => Promise<void>) | null = null

/** The app registers how to save the notebook before an install. */
export function registerUpdateSaver(save: (() => Promise<void>) | null) {
  saveBeforeInstall = save
}
const listeners = new Set<() => void>()

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}

export function getUpdateState(): UpdateState {
  return state
}

export function subscribeUpdates(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdates, getUpdateState, getUpdateState)
}

export function updatesAvailable(): boolean {
  return isDesktop()
}

const busy = (phase: UpdatePhase) =>
  phase === 'checking' || phase === 'downloading' || phase === 'installing'

/** Short, writer-facing messages for network and signature failures. */
export function updateErrorText(error: unknown): string {
  const text = String(
    error instanceof Error ? error.message : (error ?? '')
  ).toLowerCase()
  if (/signature|verify|minisign|pubkey|public key/u.test(text))
    return 'The download did not match TypeNext’s signature, so it was not installed.'
  if (
    /network|dns|connect|timed? ?out|offline|request|tls|certificate|fetch|404|5\d\d/u.test(
      text
    )
  )
    return 'GitHub could not be reached. TypeNext will try again later.'
  if (/space|disk|permission|denied|access/u.test(text))
    return 'The update could not be saved on this computer. Check free space and try again.'
  return 'The update did not finish. Try again in a moment.'
}

/** Look for a newer release. Automatic checks stay quiet unless one exists. */
export async function checkForUpdates({
  manual = false,
  download = false,
}: { manual?: boolean; download?: boolean } = {}): Promise<void> {
  if (!isDesktop() || busy(state.phase)) return
  // A version that is ready or waiting needs no new check.
  if (
    !manual &&
    update &&
    (state.phase === 'ready' || state.phase === 'available')
  ) {
    if (download && state.phase === 'available') await downloadUpdate(false)
    return
  }
  set({ phase: 'checking', manual, error: '' })
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const found = await check({ timeout: 30_000 })
    const checkedAt = Date.now()
    try {
      localStorage.setItem(CHECKED_KEY, String(checkedAt))
    } catch {
      // Only the "last checked" note is lost.
    }
    if (!found) {
      update = null
      set({ phase: 'current', version: null, notes: '', checkedAt })
      return
    }
    update = found
    set({
      phase: 'available',
      version: found.version,
      notes: found.body ?? '',
      date: found.date ?? null,
      progress: null,
      checkedAt,
    })
    if (download) await downloadUpdate(manual)
  } catch (error) {
    // A release without an update feed is not a failure: nothing to install.
    if (/404|not found|valid release json/iu.test(String(error))) {
      update = null
      set({ phase: 'current', version: null, checkedAt: Date.now() })
      return
    }
    set({ phase: 'error', error: updateErrorText(error) })
  }
}

/** Download and verify the found version, ready for a restart. */
export async function downloadUpdate(manual = true): Promise<void> {
  if (!update || busy(state.phase) || state.phase === 'ready') return
  set({ phase: 'downloading', progress: 0, manual, error: '' })
  let total = 0
  let received = 0
  try {
    await update.download((event: DownloadEvent) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      else if (event.event === 'Progress') {
        received += event.data.chunkLength
        set({ progress: total ? Math.min(1, received / total) : null })
      }
    })
    set({ phase: 'ready', progress: 1 })
  } catch (error) {
    set({ phase: 'error', manual: true, error: updateErrorText(error) })
  }
}

/**
 * Save, then install and restart. `beforeInstall` must leave the notebook
 * saved: on Windows the installer closes TypeNext at once.
 */
export async function installUpdate(
  beforeInstall: (() => Promise<void>) | null = saveBeforeInstall
): Promise<void> {
  if (!update || busy(state.phase)) return
  if (!beforeInstall) {
    set({
      phase: 'error',
      manual: true,
      error: 'Your notebook could not be saved first, so the update waits.',
    })
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  set({ phase: 'installing', manual: true, error: '' })
  try {
    await beforeInstall()
    if (state.progress !== 1) {
      // Not downloaded yet: download now, then install.
      await update.download()
    }
    await invoke('prepare_for_update')
    await update.install()
    await invoke('restart_for_update')
  } catch (error) {
    await invoke('cancel_update').catch(() => {})
    set({ phase: 'error', manual: true, error: updateErrorText(error) })
  }
}

export function dismissUpdate() {
  set({ dismissed: state.version, manual: false })
}

/** Plain lines from Markdown release notes, for a short "What's new". */
export function releaseHighlights(notes: string, limit = 6): string[] {
  const lines = notes
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/u.test(line))
    .map(line =>
      line
        .replace(/^[-*]\s+/u, '')
        .replace(/\*\*([^*]+)\*\*/gu, '$1')
        .replace(/`([^`]+)`/gu, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    )
  return lines.slice(0, limit)
}

/** For tests: forget the module state. */
export function resetUpdatesForTests() {
  state = { ...initial, checkedAt: null }
  update = null
  saveBeforeInstall = null
  listeners.forEach(listener => listener())
}

/** For tests: pretend a check found this update. */
export function setUpdateForTests(found: Update | null) {
  update = found
}
