import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { SetStateAction } from 'react'
import type { Workspace } from '../types/notebook'
import { spaceGitFolder, spaceList, spaceOf } from './spaces/spaces'

interface SyncTarget {
  spaceId: string
  /** Only the first workspace keeps notes without a workspace id. */
  home: boolean
  folder: string
}

/** Each workspace with a repository folder is synced on its own. */
export function syncTargets(workspace: Workspace): SyncTarget[] {
  const seen = new Set<string>()
  return spaceList(workspace)
    .map((space, index) => ({
      spaceId: space.id,
      home: index === 0,
      folder: spaceGitFolder(workspace, space),
    }))
    .filter(target => {
      // Two workspaces never share one repository.
      if (!target.folder || seen.has(target.folder)) return false
      seen.add(target.folder)
      return true
    })
}

function targetNotes(workspace: Workspace, target: SyncTarget) {
  return workspace.notes.filter(
    note => spaceOf(workspace, note) === target.spaceId
  )
}
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
  const targets = syncTargets(workspace)
  const targetKey = targets
    .map(target => `${target.spaceId}=${target.folder}`)
    .join('\n')
  const enabled = gitSyncAvailable() && settings.enabled && targets.length > 0
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
      const all = syncTargets(current)
      if (!gitSyncAvailable() || !git.enabled || !all.length) return null
      if (running.current) {
        again.current = true
        return null
      }
      running.current = true
      publish({ ...state, phase: 'syncing', message: undefined })
      try {
        let last: GitSyncResult | null = null
        let offline: string | undefined
        for (const target of all) {
          const latest = callbacks.current.getWorkspace()
          const folder = target.folder
          const notes = targetNotes(latest, target)
          const synced = loadSyncedVersions(folder)
          const { changed, deletedIds } = pendingChanges(notes, synced)
          const result = await runGitSync({
            folder,
            notes: changed,
            deletedIds,
            knownIds: notes.map(note => note.id),
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
              merged = applyRemoteChanges(
                value,
                result,
                sent,
                Date.now(),
                target.home ? undefined : target.spaceId
              )
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
          if (result.status === 'offline')
            offline = result.error ?? 'The remote is not reachable.'
          last = result
        }
        failures.current = 0
        publish({
          phase: offline ? 'offline' : 'synced',
          at: Date.now(),
          ...(last ? { last } : {}),
          message: offline ? `Saved in the repository. ${offline}` : undefined,
        })
        return last
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
  }, [enabled, targetKey, settings.pullMinutes, sync])

  // After writing stops, commit what changed. Errors wait longer each time.
  useEffect(() => {
    if (!enabled || !settings.autoSync) return
    const waiting = syncTargets(workspace).some(target => {
      const { changed, deletedIds } = pendingChanges(
        targetNotes(workspace, target),
        loadSyncedVersions(target.folder)
      )
      return changed.length > 0 || deletedIds.length > 0
    })
    if (!waiting) return
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
    workspace,
    enabled,
    settings.autoSync,
    settings.delaySeconds,
    targetKey,
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
