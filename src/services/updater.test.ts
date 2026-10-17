import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({ value: true }))
const check = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())
vi.mock('./native', () => ({ isDesktop: () => desktop.value }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  checkForUpdates,
  dismissUpdate,
  getUpdateState,
  installUpdate,
  registerUpdateSaver,
  releaseHighlights,
  resetUpdatesForTests,
  updateErrorText,
} from './updater'
import { noticeVisible } from '../notebook/UpdateNotice'

type Event =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

function fakeUpdate(calls: string[] = []) {
  return {
    version: '0.3.0',
    date: '2026-11-01T10:00:00Z',
    body: '# TypeNext 0.3.0\n\nIntro.\n\n- **Faster** suggestions\n- Fix `dictation` and [links](https://x)\n',
    download: vi.fn(async (progress?: (event: Event) => void) => {
      calls.push('download')
      progress?.({ event: 'Started', data: { contentLength: 200 } })
      progress?.({ event: 'Progress', data: { chunkLength: 50 } })
      progress?.({ event: 'Progress', data: { chunkLength: 150 } })
      progress?.({ event: 'Finished' })
    }),
    install: vi.fn(async () => {
      calls.push('install')
    }),
  }
}

beforeEach(() => {
  desktop.value = true
  check.mockReset()
  invoke.mockReset().mockResolvedValue(undefined)
  resetUpdatesForTests()
  localStorage.clear()
})
afterEach(() => resetUpdatesForTests())

describe('checking for updates', () => {
  it('does nothing outside the desktop app', async () => {
    desktop.value = false
    await checkForUpdates({ manual: true })
    expect(check).not.toHaveBeenCalled()
    expect(getUpdateState().phase).toBe('idle')
  })

  it('reports the latest version and remembers when it checked', async () => {
    check.mockResolvedValue(null)
    await checkForUpdates({ manual: true })
    const state = getUpdateState()
    expect(state.phase).toBe('current')
    expect(state.checkedAt).toBeGreaterThan(0)
    expect(Number(localStorage.getItem('typenext.updates.checkedAt'))).toBe(
      state.checkedAt
    )
  })

  it('downloads a found version in the background with progress, then waits', async () => {
    const update = fakeUpdate()
    check.mockResolvedValue(update)
    const phases: string[] = []
    const progress: (number | null)[] = []
    const { subscribeUpdates } = await import('./updater')
    const stop = subscribeUpdates(() => {
      phases.push(getUpdateState().phase)
      progress.push(getUpdateState().progress)
    })
    await checkForUpdates({ download: true })
    stop()
    const state = getUpdateState()
    expect(state.phase).toBe('ready')
    expect(state.version).toBe('0.3.0')
    expect(phases).toContain('downloading')
    expect(progress).toContain(0.25)
    expect(update.install).not.toHaveBeenCalled()
    // A quiet automatic check is not a manual one: no restart is forced.
    expect(state.manual).toBe(false)
    expect(noticeVisible(state)).toBe(true)
  })

  it('keeps quiet about automatic failures but explains manual ones', async () => {
    check.mockRejectedValue(new Error('error sending request: dns error'))
    await checkForUpdates()
    expect(getUpdateState().phase).toBe('error')
    expect(noticeVisible(getUpdateState())).toBe(false)
    await checkForUpdates({ manual: true })
    expect(getUpdateState().error).toBe(
      'GitHub could not be reached. TypeNext will try again later.'
    )
  })

  it('names signature failures plainly', () => {
    expect(updateErrorText(new Error('signature verification failed'))).toMatch(
      /did not match TypeNext’s signature/u
    )
    expect(updateErrorText('weird')).toBe(
      'The update did not finish. Try again in a moment.'
    )
  })
})

describe('installing', () => {
  it('saves first, then prepares, installs and restarts', async () => {
    const calls: string[] = []
    const update = fakeUpdate(calls)
    check.mockResolvedValue(update)
    invoke.mockImplementation(async (command: string) => {
      calls.push(command)
    })
    await checkForUpdates({ download: true })
    calls.length = 0
    registerUpdateSaver(async () => {
      calls.push('save')
    })
    await installUpdate()
    expect(calls).toEqual([
      'save',
      'prepare_for_update',
      'install',
      'restart_for_update',
    ])
  })

  it('downloads first when the update was not downloaded yet', async () => {
    const calls: string[] = []
    check.mockResolvedValue(fakeUpdate(calls))
    await checkForUpdates({ manual: true })
    expect(getUpdateState().phase).toBe('available')
    await installUpdate(async () => {
      calls.push('save')
    })
    expect(calls).toEqual(['save', 'download', 'install'])
  })

  it('never installs when the notebook could not be saved', async () => {
    const update = fakeUpdate()
    check.mockResolvedValue(update)
    await checkForUpdates({ download: true })
    await installUpdate(async () => {
      throw new Error('disk full')
    })
    expect(update.install).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('cancel_update')
    expect(getUpdateState().phase).toBe('error')
  })

  it('refuses to install without a registered save', async () => {
    const update = fakeUpdate()
    check.mockResolvedValue(update)
    await checkForUpdates({ download: true })
    await installUpdate()
    expect(update.install).not.toHaveBeenCalled()
    expect(getUpdateState().error).toMatch(/could not be saved first/u)
  })

  it('"Later" hides the notice for this version only', async () => {
    check.mockResolvedValue(fakeUpdate())
    await checkForUpdates({ download: true })
    dismissUpdate()
    expect(noticeVisible(getUpdateState())).toBe(false)
  })
})

describe('release highlights', () => {
  it('keeps bullet lines as plain text', () => {
    expect(releaseHighlights(fakeUpdate().body)).toEqual([
      'Faster suggestions',
      'Fix dictation and links',
    ])
    expect(releaseHighlights('No bullets here.')).toEqual([])
  })
})
