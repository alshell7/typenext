import { invoke } from '@tauri-apps/api/core'
import type { Note, Workspace } from '../types/notebook'
import { isDesktop } from './native'

/**
 * Notes are mirrored as Markdown files in a Git repository the writer
 * chooses. All Git work runs in the Rust side with the system `git`, off the
 * interface thread, one sync at a time.
 */
export interface GitRepoStatus {
  gitInstalled: boolean
  gitVersion?: string
  folderExists: boolean
  isRepo: boolean
  branch?: string
  remote?: string
  upstream?: string
  ahead: number
  behind: number
  dirty: boolean
  lastCommit?: { hash: string; message: string; time: number }
}

export interface SyncNote {
  id: string
  title: string
  content: string
  updatedAt: number
}

export interface GitSyncResult {
  status: 'synced' | 'nothing' | 'busy' | 'offline' | 'error'
  committed: boolean
  pulled: boolean
  pushed: boolean
  remoteChanges: SyncNote[]
  remoteDeletedIds: string[]
  conflicts: SyncNote[]
  error?: string
}

export function checkGitRepository(folder: string): Promise<GitRepoStatus> {
  return invoke<GitRepoStatus>('git_sync_check', { request: { folder } })
}

export function initGitRepository(
  folder: string,
  remote?: string,
  branch?: string
): Promise<GitRepoStatus> {
  return invoke<GitRepoStatus>('git_sync_init', {
    request: {
      folder,
      ...(remote?.trim() ? { remote: remote.trim() } : {}),
      ...(branch?.trim() ? { branch: branch.trim() } : {}),
    },
  })
}

export function runGitSync(request: {
  folder: string
  notes: SyncNote[]
  deletedIds: string[]
  knownIds: string[]
  message: string
  pull: boolean
  push: boolean
}): Promise<GitSyncResult> {
  return invoke<GitSyncResult>('git_sync_run', { request })
}

// ---------------------------------------------------------------- Tracking

/** Last synced `updatedAt` per note, per repository folder. */
export type SyncedVersions = Record<string, number>

function storageKey(folder: string) {
  return `typenext.git.synced.${folder}`
}

// Read once per folder; the scheduler checks pending changes on every edit.
const syncedCache = new Map<string, SyncedVersions>()

export function loadSyncedVersions(folder: string): SyncedVersions {
  const cached = syncedCache.get(folder)
  if (cached) return cached
  let versions: SyncedVersions = {}
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey(folder)) ?? '{}'
    )
    if (value && typeof value === 'object' && !Array.isArray(value))
      versions = Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
  } catch {
    versions = {}
  }
  syncedCache.set(folder, versions)
  return versions
}

export function saveSyncedVersions(folder: string, versions: SyncedVersions) {
  syncedCache.set(folder, versions)
  try {
    localStorage.setItem(storageKey(folder), JSON.stringify(versions))
  } catch {
    // A full or blocked store only means the next sync sends more notes.
  }
}

export function resetGitSyncCacheForTests() {
  syncedCache.clear()
}

/** Only notes changed since their last sync travel to the Rust side. */
export function pendingChanges(notes: Note[], synced: SyncedVersions) {
  const ids = new Set(notes.map(note => note.id))
  return {
    changed: notes
      .filter(note => synced[note.id] !== note.updatedAt)
      .map(note => ({
        id: note.id,
        title: note.title,
        content: note.content,
        updatedAt: note.updatedAt,
      })),
    deletedIds: Object.keys(synced).filter(id => !ids.has(id)),
  }
}

export function commitMessage(changed: SyncNote[], deleted: number): string {
  const names = changed.slice(0, 3).map(note => note.title.trim() || 'Untitled')
  const parts = [
    changed.length
      ? `${changed.length === 1 ? 'Update' : `Update ${changed.length} notes:`} ${names.join(', ')}${changed.length > 3 ? ', …' : ''}`
      : '',
    deleted ? `remove ${deleted} ${deleted === 1 ? 'note' : 'notes'}` : '',
  ].filter(Boolean)
  return `TypeNext: ${parts.join('; ') || 'sync'}`
}

// ---------------------------------------------------------------- Merging

function copyTitle(title: string, label: string) {
  return `${title.trim() || 'Untitled'} (${label})`
}

/**
 * Merge what the repository brought back. Writing is never lost: a note
 * edited here since its last sync keeps its text, and the other version
 * arrives as a separate note next to it.
 */
export function applyRemoteChanges(
  workspace: Workspace,
  result: Pick<
    GitSyncResult,
    'remoteChanges' | 'remoteDeletedIds' | 'conflicts'
  >,
  synced: SyncedVersions,
  now = Date.now()
): {
  workspace: Workspace
  synced: SyncedVersions
  added: number
  updated: number
  copies: number
} {
  const notes = new Map(workspace.notes.map(note => [note.id, note]))
  const nextSynced = { ...synced }
  const created: Note[] = []
  let added = 0
  let updated = 0
  let copies = 0
  const copy = (remote: SyncNote, label: string) => {
    copies++
    const id = crypto.randomUUID()
    created.push({
      id,
      title: copyTitle(remote.title, label),
      objective: '',
      context: '',
      content: remote.content,
      sources: [],
      contextPackageIds: [],
      createdAt: now,
      updatedAt: now,
    })
  }
  for (const remote of result.remoteChanges) {
    const local = notes.get(remote.id)
    if (!local) {
      added++
      const note: Note = {
        id: remote.id,
        title: remote.title,
        objective: '',
        context: '',
        content: remote.content,
        sources: [],
        contextPackageIds: [],
        createdAt: remote.updatedAt || now,
        updatedAt: remote.updatedAt || now,
      }
      notes.set(note.id, note)
      nextSynced[note.id] = note.updatedAt
      continue
    }
    if (local.content === remote.content && local.title === remote.title) {
      nextSynced[local.id] = local.updatedAt
      continue
    }
    const editedHere = synced[local.id] !== local.updatedAt
    if (editedHere) {
      copy(remote, 'from Git')
      continue
    }
    updated++
    const next: Note = {
      ...local,
      title: remote.title,
      content: remote.content,
      autoTitle: undefined,
      updatedAt: Math.max(remote.updatedAt || now, local.updatedAt + 1),
    }
    notes.set(local.id, next)
    nextSynced[local.id] = next.updatedAt
  }
  for (const id of result.remoteDeletedIds) {
    const local = notes.get(id)
    if (!local) {
      delete nextSynced[id]
      continue
    }
    // A note edited here since its last sync survives a remote deletion.
    if (synced[id] === local.updatedAt) {
      notes.delete(id)
      delete nextSynced[id]
    }
  }
  for (const remote of result.conflicts) copy(remote, 'other version')
  const kept = workspace.notes
    .filter(note => notes.has(note.id))
    .map(note => notes.get(note.id)!)
  const fresh = [...notes.values()].filter(
    note => !workspace.notes.some(item => item.id === note.id)
  )
  const ids = new Set([...kept, ...fresh, ...created].map(note => note.id))
  const openNoteIds = workspace.openNoteIds.filter(id => ids.has(id))
  return {
    workspace: {
      ...workspace,
      notes: [...created, ...fresh, ...kept],
      openNoteIds,
      activeNoteId:
        workspace.activeNoteId && ids.has(workspace.activeNoteId)
          ? workspace.activeNoteId
          : (openNoteIds[0] ?? null),
    },
    synced: nextSynced,
    added,
    updated,
    copies,
  }
}

export function gitSyncAvailable() {
  return isDesktop()
}

/** How to install Git on this computer. */
export function gitInstallHint(): {
  text: string
  command?: string
  url: string
} {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  if (/Mac/iu.test(platform))
    return {
      text: 'Install the Apple command line tools, or Git from Homebrew.',
      command: 'xcode-select --install',
      url: 'https://git-scm.com/download/mac',
    }
  if (/Win/iu.test(platform))
    return {
      text: 'Install Git for Windows, then restart TypeNext.',
      command: 'winget install --id Git.Git -e',
      url: 'https://git-scm.com/download/win',
    }
  return {
    text: 'Install Git with your package manager, for example apt or dnf.',
    command: 'sudo apt install git',
    url: 'https://git-scm.com/download/linux',
  }
}
