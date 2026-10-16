import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { Workspace } from '../types/notebook'
import { emptyWorkspace } from './model'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))
vi.mock('../services/native', () => ({ isDesktop: () => true }))

const { useGitSync, getGitSyncState, resetGitSyncForTests } =
  await import('./useGitSync')
const { resetGitSyncCacheForTests } = await import('../services/git-sync')

function seed(): Workspace {
  const base = emptyWorkspace()
  return {
    ...base,
    notes: [
      {
        id: 'a',
        title: 'Plan',
        objective: '',
        context: '',
        content: 'Draft',
        sources: [],
        createdAt: 1,
        updatedAt: 10,
      },
    ],
    openNoteIds: ['a'],
    activeNoteId: 'a',
    settings: {
      ...base.settings,
      git: {
        ...base.settings.git,
        enabled: true,
        folder: '/repo',
        delaySeconds: 10,
        pullMinutes: 0,
      },
    },
  }
}

function harness() {
  return renderHook(() => {
    const [workspace, setState] = useState(seed)
    const ref = useRef(workspace)
    ref.current = workspace
    const setWorkspace = (
      action: Workspace | ((value: Workspace) => Workspace)
    ) => {
      const next = typeof action === 'function' ? action(ref.current) : action
      ref.current = next
      setState(next)
    }
    const sync = useGitSync(
      workspace,
      () => ref.current,
      setWorkspace,
      () => undefined
    )
    return { workspace, setWorkspace, sync }
  })
}

const result = (patch: Record<string, unknown> = {}) => ({
  status: 'synced',
  committed: true,
  pulled: true,
  pushed: true,
  remoteChanges: [],
  remoteDeletedIds: [],
  conflicts: [],
  ...patch,
})

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  localStorage.clear()
  resetGitSyncCacheForTests()
  resetGitSyncForTests()
})
afterEach(() => vi.useRealTimers())

describe('Git sync scheduler', () => {
  it('syncs on start, then commits only the edited note after writing pauses', async () => {
    invoke.mockResolvedValue(result())
    const { result: hook } = harness()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]![1].request).toMatchObject({
      folder: '/repo',
      pull: true,
      deletedIds: [],
    })
    expect(
      invoke.mock.calls[0]![1].request.notes.map(
        (note: { id: string }) => note.id
      )
    ).toEqual(['a'])
    expect(getGitSyncState().phase).toBe('synced')
    act(() => {
      hook.current.setWorkspace(value => ({
        ...value,
        notes: value.notes.map(note => ({
          ...note,
          content: 'Draft two',
          updatedAt: 20,
        })),
      }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000)
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })
    expect(invoke).toHaveBeenCalledTimes(2)
    const request = invoke.mock.calls[1]![1].request
    expect(request.pull).toBe(false)
    expect(request.notes).toEqual([
      { id: 'a', title: 'Plan', content: 'Draft two', updatedAt: 20 },
    ])
    expect(request.message).toBe('TypeNext: Update Plan')
  })

  it('brings remote notes into the notebook', async () => {
    invoke.mockResolvedValue(
      result({
        remoteChanges: [
          { id: 'b', title: 'From laptop', content: 'Hello', updatedAt: 30 },
        ],
      })
    )
    const { result: hook } = harness()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.current.workspace.notes.map(note => note.title)).toContain(
      'From laptop'
    )
  })

  it('shows errors and keeps the notes unchanged', async () => {
    invoke.mockRejectedValue(new Error('fatal: not a git repository'))
    const { result: hook } = harness()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getGitSyncState()).toMatchObject({
      phase: 'error',
      message: 'fatal: not a git repository',
    })
    expect(hook.current.workspace.notes).toHaveLength(1)
  })

  it('stays off when sync is disabled', async () => {
    const base = seed()
    renderHook(() =>
      useGitSync(
        {
          ...base,
          settings: {
            ...base.settings,
            git: { ...base.settings.git, enabled: false },
          },
        },
        () => base,
        () => undefined,
        () => undefined
      )
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(getGitSyncState().phase).toBe('off')
  })
})
