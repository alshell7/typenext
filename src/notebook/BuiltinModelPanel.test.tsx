import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltinState } from '../services/builtin-engine'
import { BUILTIN_DOWNLOAD_BYTES } from '../services/builtin-model'
import { BuiltinModelPanel } from './BuiltinModelPanel'

const mocked = vi.hoisted(() => ({
  state: null as BuiltinState | null,
  listeners: new Set<() => void>(),
  check: vi.fn(async () => false),
  download: vi.fn(async () => {}),
  load: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  unload: vi.fn(),
}))
vi.mock('../services/builtin-engine', () => ({
  getBuiltinState: () => mocked.state!,
  getBuiltinBackendPreference: () => 'wasm',
  subscribeBuiltinState: (listener: () => void) => {
    mocked.listeners.add(listener)
    return () => mocked.listeners.delete(listener)
  },
  checkBuiltinCache: mocked.check,
  downloadBuiltinModel: mocked.download,
  loadBuiltinModel: mocked.load,
  removeBuiltinModel: mocked.remove,
  unloadBuiltinModel: mocked.unload,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocked.state = {
    status: 'idle',
    cached: false,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: BUILTIN_DOWNLOAD_BYTES,
    backend: null,
    identity: 'fixture',
  }
})
afterEach(cleanup)

describe('built-in model preferences', () => {
  it('checks local storage on mount and defaults to CPU without starting a download', () => {
    render(<BuiltinModelPanel active={false} onUse={vi.fn()} />)
    expect(mocked.check).toHaveBeenCalledOnce()
    expect(mocked.download).not.toHaveBeenCalled()
    expect(mocked.load).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Run the offline model with')).toHaveValue(
      'wasm'
    )
  })

  it('finishing a download does not activate stale preferences; using the model is a fresh click', async () => {
    let finish!: () => void
    mocked.download.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const oldUse = vi.fn()
    const newUse = vi.fn()
    const { rerender } = render(
      <BuiltinModelPanel active={false} onUse={oldUse} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download model' }))
    expect(mocked.download).toHaveBeenCalledWith({
      backend: 'wasm',
      signal: expect.any(AbortSignal),
    })
    rerender(<BuiltinModelPanel active={false} onUse={newUse} />)
    await act(async () => {
      mocked.state = {
        ...mocked.state!,
        status: 'ready',
        cached: true,
        backend: 'wasm',
      }
      mocked.listeners.forEach(listener => listener())
      finish()
    })
    expect(oldUse).not.toHaveBeenCalled()
    expect(newUse).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use this model' }))
    expect(newUse).toHaveBeenCalledOnce()
    expect(oldUse).not.toHaveBeenCalled()
  })

  it('disables on the remove click and does not later overwrite a changed preference', async () => {
    let finish!: () => void
    mocked.remove.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    mocked.state = { ...mocked.state!, cached: true }
    const oldDisable = vi.fn()
    const newDisable = vi.fn()
    const { rerender } = render(
      <BuiltinModelPanel active={true} onUse={vi.fn()} onDisable={oldDisable} />
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove downloaded offline model' })
    )
    expect(oldDisable).toHaveBeenCalledOnce()
    rerender(
      <BuiltinModelPanel
        active={false}
        onUse={vi.fn()}
        onDisable={newDisable}
      />
    )
    await act(async () => {
      finish()
    })
    expect(oldDisable).toHaveBeenCalledOnce()
    expect(newDisable).not.toHaveBeenCalled()
  })
})
