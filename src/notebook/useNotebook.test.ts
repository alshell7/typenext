import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspace, newNote, openNote } from './model'
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  useNotebook,
} from './useNotebook'

const storage = vi.hoisted(() => ({
  load: vi.fn(),
  persist: vi.fn(),
  flush: vi.fn(),
}))
vi.mock('../services/storage', () => ({
  loadWorkspace: storage.load,
  persistWorkspace: storage.persist,
  flushBrowserWorkspace: storage.flush,
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
  storage.load.mockReset()
  storage.persist.mockReset().mockResolvedValue(undefined)
  storage.flush.mockReset().mockReturnValue(false)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function loaded(autoSave = true) {
  const workspace = openNote(emptyWorkspace(), newNote('Draft', '', 'Original'))
  workspace.settings.autoSave = autoSave
  storage.load.mockResolvedValue(workspace)
  const hook = renderHook(() => useNotebook())
  await act(async () => {})
  expect(hook.result.current.loading).toBe(false)
  return hook
}

type Hook = Awaited<ReturnType<typeof loaded>>
function edit(hook: Hook, content: string) {
  act(() =>
    hook.result.current.setWorkspace(value => ({
      ...value,
      notes: value.notes.map(note => ({
        ...note,
        content,
        updatedAt: Date.now(),
      })),
    }))
  )
}
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

describe('notebook durability scheduling', () => {
  it('does not strand a new save requested in the microtask where the previous drain finishes', async () => {
    const hook = await loaded(false)
    let finish!: () => void
    storage.persist.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    edit(hook, 'First requested revision')
    let first!: Promise<void>
    act(() => {
      first = hook.result.current.saveNow()
    })
    await act(async () => {})
    await act(async () => {
      finish()
      await Promise.resolve()
      hook.result.current.setWorkspace(value => ({
        ...value,
        notes: value.notes.map(note => ({
          ...note,
          content: 'New request during completion',
        })),
      }))
      const second = hook.result.current.saveNow()
      await Promise.all([first, second])
    })
    expect(storage.persist).toHaveBeenCalledTimes(2)
    expect(storage.persist.mock.calls[1]![0].notes[0].content).toBe(
      'New request during completion'
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
  })

  it('does not serialize the notebook to detect edits or dirty close guards', async () => {
    const hook = await loaded()
    const stringify = vi.spyOn(JSON, 'stringify')
    for (let index = 0; index < 20; index++) edit(hook, `Writing ${index}`)
    expect(hook.result.current.hasUnsavedChanges()).toBe(true)
    expect(stringify).not.toHaveBeenCalled()
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('saves after a650 ms pause and acknowledges only the persisted revision', async () => {
    const hook = await loaded()
    edit(hook, 'Latest words')
    await advance(AUTOSAVE_IDLE_MS - 1)
    expect(storage.persist).not.toHaveBeenCalled()
    await advance(1)
    expect(storage.persist.mock.calls[0]![0].notes[0].content).toBe(
      'Latest words'
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
    expect(hook.result.current.saveStatus).toBe('saved')
  })

  it('persists continuous typing within the2 s request deadline instead of resetting forever', async () => {
    const hook = await loaded()
    edit(hook, 'Step0')
    for (let index = 1; index <= 7; index++) {
      await advance(250)
      edit(hook, `Step${index}`)
    }
    await advance(AUTOSAVE_MAX_WAIT_MS - 1750 - 1)
    expect(storage.persist).not.toHaveBeenCalled()
    await advance(1)
    expect(storage.persist).toHaveBeenCalledOnce()
    expect(storage.persist.mock.calls[0]![0].notes[0].content).toBe('Step7')
  })

  it('sees synchronous edits for immediate save and catches checked updater errors before rendering', async () => {
    const hook = await loaded(false)
    let saved: Promise<void> | undefined
    act(() => {
      hook.result.current.setWorkspace(value => ({
        ...value,
        notes: value.notes.map(note => ({
          ...note,
          content: 'Immediate edit',
        })),
      }))
      expect(hook.result.current.getWorkspace().notes[0]!.content).toBe(
        'Immediate edit'
      )
      expect(hook.result.current.hasUnsavedChanges()).toBe(true)
      saved = hook.result.current.saveNow()
    })
    await act(async () => {
      await saved
    })
    expect(storage.persist.mock.calls[0]![0].notes[0].content).toBe(
      'Immediate edit'
    )
    expect(() =>
      hook.result.current.setWorkspace(() => {
        throw new Error('Import too large')
      })
    ).toThrow('Import too large')
    expect(hook.result.current.workspace.notes[0]!.content).toBe(
      'Immediate edit'
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
  })

  it('coalesces a slow write into one latest pending snapshot without retaining obsolete drafts', async () => {
    const hook = await loaded(false)
    let finishFirst!: () => void
    storage.persist.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve
        })
    )
    edit(hook, 'First save')
    let first!: Promise<void>
    act(() => {
      first = hook.result.current.saveNow()
    })
    await act(async () => {})
    edit(hook, 'Obsolete queued draft')
    act(() => {
      void hook.result.current.saveNow()
    })
    edit(hook, 'Latest queued draft')
    let latest!: Promise<void>
    act(() => {
      latest = hook.result.current.saveNow()
    })
    expect(storage.persist).toHaveBeenCalledOnce()
    await act(async () => {
      finishFirst()
      await Promise.all([first, latest])
    })
    expect(storage.persist).toHaveBeenCalledTimes(2)
    expect(storage.persist.mock.calls[1]![0].notes[0].content).toBe(
      'Latest queued draft'
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
  })

  it('keeps autosave-off edits unsaved across deadlines and lifecycle events until explicit save', async () => {
    const hook = await loaded(false)
    edit(hook, 'Deliberately unsaved')
    await advance(5000)
    act(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('pagehide'))
    })
    const unload = new Event('beforeunload', { cancelable: true })
    act(() => {
      window.dispatchEvent(unload)
    })
    expect(unload.defaultPrevented).toBe(true)
    expect(storage.persist).not.toHaveBeenCalled()
    expect(storage.flush).not.toHaveBeenCalled()
    await act(async () => {
      await hook.result.current.saveNow()
    })
    expect(storage.persist).toHaveBeenCalledOnce()
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
  })

  it('does not silently include later autosave-off edits in an earlier manual save', async () => {
    const hook = await loaded(false)
    let finish!: () => void
    storage.persist.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    edit(hook, 'Requested manual save')
    let save!: Promise<void>
    act(() => {
      save = hook.result.current.saveNow()
    })
    await act(async () => {})
    edit(hook, 'Later unsaved edit')
    const alreadyRequested = hook.result.current.waitForPendingSave()
    await act(async () => {
      finish()
      await Promise.all([save, alreadyRequested])
    })
    expect(storage.persist).toHaveBeenCalledOnce()
    expect(storage.persist.mock.calls[0]![0].notes[0].content).toBe(
      'Requested manual save'
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(true)
    expect(hook.result.current.saveStatus).toBe('unsaved')
  })

  it('synchronously flushes browser pagehide and never regresses when an older save completes', async () => {
    const hook = await loaded()
    let finish!: () => void
    storage.persist.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    edit(hook, 'Earlier asynchronous save')
    let save!: Promise<void>
    act(() => {
      save = hook.result.current.saveNow()
    })
    await act(async () => {})
    edit(hook, 'Last edit before pagehide')
    storage.flush.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(storage.flush.mock.calls[0]![0].notes[0].content).toBe(
      'Last edit before pagehide'
    )
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
    await act(async () => {
      finish()
      await save
    })
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
    expect(hook.result.current.saveStatus).toBe('saved')
  })

  it('keeps unload protection and dirty status when synchronous browser persistence fails', async () => {
    const hook = await loaded()
    edit(hook, 'Keep these words')
    storage.flush.mockImplementation(() => {
      throw new Error('Storage is full')
    })
    const unload = new Event('beforeunload', { cancelable: true })
    act(() => {
      window.dispatchEvent(unload)
    })
    expect(unload.defaultPrevented).toBe(true)
    expect(hook.result.current.hasUnsavedChanges()).toBe(true)
    expect(hook.result.current.saveStatus).toBe('error')
    expect(hook.result.current.storageError).toBe('Storage is full')
  })

  it('reports failed writes without marking them saved, then permits an explicit retry', async () => {
    const hook = await loaded(false)
    edit(hook, 'Recoverable in memory')
    storage.persist.mockRejectedValueOnce(new Error('Disk is full'))
    await act(async () => {
      await expect(hook.result.current.saveNow()).rejects.toThrow(
        'Disk is full'
      )
    })
    expect(hook.result.current.hasUnsavedChanges()).toBe(true)
    expect(hook.result.current.saveStatus).toBe('error')
    await act(async () => {
      await hook.result.current.saveNow()
    })
    expect(hook.result.current.hasUnsavedChanges()).toBe(false)
    expect(hook.result.current.storageError).toBe('')
  })

  it('refuses writes after unreadable storage rather than replacing it with a new notebook', async () => {
    storage.load.mockRejectedValue(new Error('Neither copy can be read'))
    const hook = renderHook(() => useNotebook())
    await act(async () => {})
    expect(hook.result.current.loadError).toBe(true)
    await expect(hook.result.current.saveNow()).rejects.toThrow(
      'Restore or repair'
    )
    expect(storage.persist).not.toHaveBeenCalled()
    expect(storage.flush).not.toHaveBeenCalled()
  })
})
