import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyRemoteChanges,
  commitMessage,
  loadSyncedVersions,
  pendingChanges,
  resetGitSyncCacheForTests,
  saveSyncedVersions,
} from './git-sync'
import { emptyWorkspace } from '../notebook/model'
import type { Note } from '../types/notebook'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./native', () => ({ isDesktop: () => true }))

const note = (
  id: string,
  content: string,
  updatedAt: number,
  title = id
): Note => ({
  id,
  title,
  objective: '',
  context: '',
  content,
  sources: [],
  createdAt: 0,
  updatedAt,
})

function workspace(notes: Note[]) {
  return {
    ...emptyWorkspace(),
    notes,
    openNoteIds: notes.map(item => item.id),
    activeNoteId: notes[0]?.id ?? null,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetGitSyncCacheForTests()
})

describe('Git sync tracking', () => {
  it('sends only notes changed since their last sync, and deletions', () => {
    const notes = [note('a', 'A', 10), note('b', 'B', 20)]
    expect(pendingChanges(notes, {}).changed.map(item => item.id)).toEqual([
      'a',
      'b',
    ])
    const synced = { a: 10, b: 15, gone: 3 }
    const pending = pendingChanges(notes, synced)
    expect(pending.changed.map(item => item.id)).toEqual(['b'])
    expect(pending.deletedIds).toEqual(['gone'])
  })

  it('remembers synced versions per folder', () => {
    saveSyncedVersions('/notes', { a: 1 })
    expect(loadSyncedVersions('/notes')).toEqual({ a: 1 })
    expect(loadSyncedVersions('/other')).toEqual({})
    localStorage.setItem('typenext.git.synced./bad', 'not json')
    expect(loadSyncedVersions('/bad')).toEqual({})
  })

  it('writes short commit messages', () => {
    expect(
      commitMessage([{ id: 'a', title: 'Plan', content: '', updatedAt: 1 }], 0)
    ).toBe('TypeNext: Update Plan')
    expect(
      commitMessage(
        ['A', 'B', 'C', 'D'].map(title => ({
          id: title,
          title,
          content: '',
          updatedAt: 1,
        })),
        2
      )
    ).toBe('TypeNext: Update 4 notes: A, B, C, …; remove 2 notes')
  })
})

describe('merging remote changes', () => {
  it('updates notes not edited here and adds new ones', () => {
    const local = workspace([note('a', 'old', 10)])
    const result = applyRemoteChanges(
      local,
      {
        remoteChanges: [
          { id: 'a', title: 'a', content: 'new from laptop', updatedAt: 50 },
          { id: 'n', title: 'New idea', content: 'Hello', updatedAt: 60 },
        ],
        remoteDeletedIds: [],
        conflicts: [],
      },
      { a: 10 }
    )
    expect(result.workspace.notes.find(item => item.id === 'a')?.content).toBe(
      'new from laptop'
    )
    expect(result.workspace.notes.find(item => item.id === 'n')?.title).toBe(
      'New idea'
    )
    expect(result.synced).toMatchObject({ a: 50, n: 60 })
    expect(result).toMatchObject({ added: 1, updated: 1, copies: 0 })
  })

  it('keeps local writing and adds the remote version as a copy when both changed', () => {
    const local = workspace([note('a', 'edited here', 30, 'Plan')])
    const result = applyRemoteChanges(
      local,
      {
        remoteChanges: [
          { id: 'a', title: 'Plan', content: 'edited there', updatedAt: 40 },
        ],
        remoteDeletedIds: [],
        conflicts: [
          { id: 'b', title: 'Draft', content: 'their draft', updatedAt: 41 },
        ],
      },
      { a: 10 },
      99
    )
    const titles = result.workspace.notes.map(item => item.title)
    expect(result.workspace.notes.find(item => item.id === 'a')?.content).toBe(
      'edited here'
    )
    expect(titles).toContain('Plan (from Git)')
    expect(titles).toContain('Draft (other version)')
    expect(result.copies).toBe(2)
  })

  it('deletes only notes that were not edited here since the last sync', () => {
    const local = workspace([
      note('a', 'unchanged', 10),
      note('b', 'edited', 25),
    ])
    const result = applyRemoteChanges(
      local,
      {
        remoteChanges: [],
        remoteDeletedIds: ['a', 'b', 'missing'],
        conflicts: [],
      },
      { a: 10, b: 20, missing: 1 }
    )
    expect(result.workspace.notes.map(item => item.id)).toEqual(['b'])
    expect(result.workspace.openNoteIds).toEqual(['b'])
    expect(result.workspace.activeNoteId).toBe('b')
    expect(result.synced).toEqual({ b: 20 })
  })

  it('treats an identical remote note as already synced', () => {
    const local = workspace([note('a', 'same', 30)])
    const result = applyRemoteChanges(
      local,
      {
        remoteChanges: [
          { id: 'a', title: 'a', content: 'same', updatedAt: 31 },
        ],
        remoteDeletedIds: [],
        conflicts: [],
      },
      {}
    )
    expect(result.copies).toBe(0)
    expect(result.synced.a).toBe(30)
  })
})
