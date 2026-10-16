import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { SetStateAction } from 'react'
import type { Workspace } from '../types/notebook'
import {
  applyRemoteChanges,
  commitMessage,
  gitSyncAvailable,
  loadSyncedVersions,
  pendingChanges,
  runGitSync,
  saveSyncedVersions,
  type GitSyncResult,
} from '../services/git-sync'

export interface GitSyncState {
  phase: 'off' | 'idle' | 'waiting' | 'syncing' | 'synced' | 'offline' | 'error'
  /** Time of the last finished sync. */
  at?: number
  message?: string
  last?: GitSyncResult
}

let state: GitSyncState = { phase: 'off' }
const listeners = new Set<() => void>()

function publish(next: GitSyncState) {
  state = next
  listeners.forEach(listener => listener())
}

export function getGitSyncState() {
  return state
}

export function subscribeGitSync(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const MAX_BACKOFF_MS = 10 * 60_000
let runner: ((pull?: boolean) => Promise<GitSyncResult | null>) | null = null

/** Sync now from anywhere in the interface (Preferences, the status line). */
export function syncNow(): Promise<GitSyncResult | null> {
  return runner ? runner(true) : Promise.resolve(null)
}

/**
 * Keep the notebook and its Git repository in step. A sync runs after writing
 * stops, on start, on a pull interval, and on request. Errors back off.
 */
export function useGitSync(
  workspace: Workspace,
  getWorkspace: () => Workspace,
  setWorkspace: (action: SetStateAction<Workspace>) => void,
  notify: (message: string) => void
) {
  const settings = workspace.settings.git
  const enabled =
    gitSyncAvailable() && settings.enabled && Boolean(settings.folder.trim())
  const running = useRef(false)
  const failures = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const again = useRef(false)
  // Callbacks are read through a ref so a sync never restarts on re-render.
  const callbacks = useRef({ getWorkspace, setWorkspace, notify })
  callbacks.current = { getWorkspace, setWorkspace, notify }

  const sync = useCallback(
    async (pull = true): Promise<GitSyncResult | null> => {
      const { getWorkspace, setWorkspace, notify } = callbacks.current
      const current = getWorkspace()
      const git = current.settings.git
      if (!gitSyncAvailable() || !git.enabled || !git.folder.trim()) return null
      if (running.current) {
        again.current = true
        return null
      }
      running.current = true
      const folder = git.folder.trim()
      const synced = loadSyncedVersions(folder)
      const { changed, deletedIds } = pendingChanges(current.notes, synced)
      publish({ ...state, phase: 'syncing', message: undefined })
      try {
        const result = await runGitSync({
          folder,
          notes: changed,
          deletedIds,
          knownIds: current.notes.map(note => note.id),
          message: commitMessage(changed, deletedIds.length),
          pull,
          push: git.push,
        })
        if (result.status === 'busy') {
          again.current = true
          publish({ ...state, phase: 'waiting' })
          return result
        }
        if (result.status === 'error')
          throw new Error(result.error ?? 'Git sync failed.')
        // What was sent is now in the repository, even when offline.
        const sent = { ...synced }
        for (const note of changed) sent[note.id] = note.updatedAt
        for (const id of deletedIds) delete sent[id]
        let next = sent
        if (
          result.remoteChanges.length ||
          result.remoteDeletedIds.length ||
          result.conflicts.length
        ) {
          let merged: ReturnType<typeof applyRemoteChanges> | null = null
          setWorkspace(value => {
            merged = applyRemoteChanges(value, result, sent)
            return merged.workspace
          })
          if (merged) {
            const done = merged as ReturnType<typeof applyRemoteChanges>
            next = done.synced
            const parts = [
              done.added && `${done.added} new`,
              done.updated && `${done.updated} updated`,
              done.copies && `${done.copies} kept as a separate copy`,
            ].filter(Boolean)
            if (parts.length) notify(`Git sync: ${parts.join(', ')}.`)
          }
        }
        saveSyncedVersions(folder, next)
        failures.current = 0
        publish({
          phase: result.status === 'offline' ? 'offline' : 'synced',
          at: Date.now(),
          last: result,
          message:
            result.status === 'offline'
              ? `Saved in the repository. ${result.error ?? 'The remote is not reachable.'}`
              : undefined,
        })
        return result
      } catch (error) {
        failures.current++
        publish({
          ...state,
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        return null
      } finally {
        running.current = false
        if (again.current) {
          again.current = false
          setTimeout(() => void sync(false), 2_000)
        }
      }
    },
    []
  )

  useEffect(() => {
    runner = sync
    return () => {
      if (runner === sync) runner = null
    }
  }, [sync])

  // Start, and look for remote changes on an interval.
  useEffect(() => {
    if (!enabled) {
      publish({ phase: 'off' })
      return
    }
    publish({ ...state, phase: state.phase === 'off' ? 'idle' : state.phase })
    void sync(true)
    if (!settings.pullMinutes) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void sync(true)
    }, settings.pullMinutes * 60_000)
    return () => clearInterval(interval)
  }, [enabled, settings.folder, settings.pullMinutes, sync])

  // After writing stops, commit what changed. Errors wait longer each time.
  useEffect(() => {
    if (!enabled || !settings.autoSync) return
    const synced = loadSyncedVersions(settings.folder.trim())
    const { changed, deletedIds } = pendingChanges(workspace.notes, synced)
    if (!changed.length && !deletedIds.length) return
    if (timer.current) clearTimeout(timer.current)
    const backoff = failures.current
      ? Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (failures.current - 1))
      : 0
    if (state.phase !== 'syncing' && state.phase !== 'waiting')
      publish({ ...state, phase: 'waiting' })
    timer.current = setTimeout(
      () => {
        timer.current = null
        void sync(false)
      },
      Math.max(settings.delaySeconds * 1000, backoff)
    )
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [
    workspace.notes,
    enabled,
    settings.autoSync,
    settings.delaySeconds,
    settings.folder,
    sync,
  ])

  return sync
}

/** Test-only reset. */
export function resetGitSyncForTests() {
  state = { phase: 'off' }
  listeners.clear()
}

export function useGitSyncState() {
  return useSyncExternalStore(
    subscribeGitSync,
    getGitSyncState,
    getGitSyncState
  )
}
