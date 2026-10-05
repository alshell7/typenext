import { useState } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhistleState } from '../services/whistle'
import type { WhistleRecording } from '../services/whistle-recorder'

const mock = vi.hoisted(() => ({
  state: {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 17_000_000,
  } as WhistleState,
  listeners: new Set<() => void>(),
  check: vi.fn(),
  download: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
  unload: vi.fn(),
  transcribe: vi.fn(),
  record: vi.fn(),
}))
vi.mock('../services/whistle', () => ({
  getWhistleState: () => mock.state,
  subscribeWhistleState: (listener: () => void) => {
    mock.listeners.add(listener)
    return () => {
      mock.listeners.delete(listener)
    }
  },
  checkWhistleCache: mock.check,
  downloadWhistleModel: mock.download,
  loadWhistleModel: mock.load,
  removeWhistleModel: mock.remove,
  unloadWhistleModel: mock.unload,
  transcribeWhistle: mock.transcribe,
}))
vi.mock('../services/whistle-recorder', () => ({
  startWhistleRecording: mock.record,
}))
import { DictationDialog } from './DictationDialog'

function change(patch: Partial<WhistleState>) {
  mock.state = { ...mock.state, ...patch }
  mock.listeners.forEach(listener => listener())
}
let capture: WhistleRecording
let audio: Float32Array
let finish!: (value: Float32Array) => void
let fail!: (error: unknown) => void
function Harness({ onInsert }: { onInsert(text: string): void }) {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen(true)}>Dictate</button>
      <DictationDialog open={open} onOpenChange={setOpen} onInsert={onInsert} />
    </>
  )
}
beforeEach(() => {
  mock.listeners.clear()
  mock.state = {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 17_000_000,
  }
  mock.check.mockReset().mockResolvedValue(true)
  mock.download.mockReset().mockImplementation(async () => {
    change({ cached: true, status: 'idle' })
  })
  mock.load.mockReset().mockImplementation(async () => {
    change({ status: 'ready' })
  })
  mock.remove.mockReset().mockResolvedValue(undefined)
  mock.unload.mockReset().mockImplementation(() => {
    change({ status: 'idle' })
  })
  mock.transcribe
    .mockReset()
    .mockResolvedValue({ text: 'A spoken thought.', language: 'en' })
  audio = new Float32Array([0.1, -0.1])
  capture = {
    finished: new Promise<Float32Array>((resolve, reject) => {
      finish = resolve
      fail = reject
    }),
    stop: vi.fn(() => finish(audio)),
    cancel: vi.fn(() => fail(new DOMException('Cancelled', 'AbortError'))),
  }
  mock.record.mockReset().mockResolvedValue(capture)
})
afterEach(() => {
  cleanup()
  mock.listeners.clear()
  vi.restoreAllMocks()
})

async function preview() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Record' }))
  await user.click(
    await screen.findByRole('button', { name: 'Stop & transcribe' })
  )
  return {
    user,
    text: await screen.findByRole('textbox', { name: 'Your transcript' }),
  }
}

describe('explicit offline dictation dialog', () => {
  it('checks local storage on opening and requires a separate gesture for download and recording', async () => {
    mock.state = { ...mock.state, cached: false, progress: 0 }
    render(<Harness onInsert={vi.fn()} />)
    expect(mock.check).toHaveBeenCalled()
    expect(mock.download).not.toHaveBeenCalled()
    expect(mock.record).not.toHaveBeenCalled()
    expect(mock.transcribe).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Download Whistle · 17 MB' }))
    expect(mock.download).toHaveBeenCalledTimes(1)
    expect(mock.record).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled()
    expect(screen.getByText('Microphone is off')).toBeVisible()
  })

  it('keeps its setup panel mounted when loading completes so it cannot cancel a just-loaded engine', async () => {
    let signal!: AbortSignal
    let loaded!: () => void
    mock.load.mockImplementation(
      ({ signal: value }: { signal: AbortSignal }) => {
        signal = value
        return new Promise<void>(resolve => {
          loaded = resolve
        })
      }
    )
    render(<Harness onInsert={vi.fn()} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load downloaded model' }))
    await act(async () => {
      change({ status: 'ready' })
      loaded()
    })
    expect(signal.aborted).toBe(false)
    expect(screen.getByText('Model details')).toBeVisible()
    expect(
      screen.getAllByRole('region', {
        name: 'Offline dictation model',
        hidden: true,
      })
    ).toHaveLength(1)
  })

  it('stops, previews and edits before explicit insertion, then inserts after the modal focus trap closes', async () => {
    const onInsert = vi.fn(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    render(<Harness onInsert={onInsert} />)
    const { user, text } = await preview()
    expect(capture.stop).toHaveBeenCalledTimes(1)
    expect(mock.transcribe).toHaveBeenCalledTimes(1)
    expect(audio.every(value => value === 0)).toBe(true)
    expect(onInsert).not.toHaveBeenCalled()
    await user.clear(text)
    await user.type(text, 'My edited thought.')
    fireEvent.click(screen.getByRole('button', { name: 'Insert transcript' }))
    expect(onInsert).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(onInsert).toHaveBeenCalledExactlyOnceWith('My edited thought.')
    )
    expect(mock.unload).toHaveBeenCalled()
  })

  it('reopens after a failed deferred insertion with the same edited transcript and actionable error', async () => {
    const onInsert = vi.fn(() => {
      throw new Error('The original note is no longer open.')
    })
    render(<Harness onInsert={onInsert} />)
    const { user, text } = await preview()
    await user.clear(text)
    await user.type(text, 'Retain these edited words.')
    await user.click(screen.getByRole('button', { name: 'Insert transcript' }))
    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Your transcript' })
      ).toHaveValue('Retain these edited words.')
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The original note is no longer open.'
    )
    expect(
      screen.getByRole('button', { name: 'Insert transcript' })
    ).toBeEnabled()
    expect(onInsert).toHaveBeenCalledTimes(1)
  })

  it('cancels the capture and worker when closed during recording without inserting anything', async () => {
    const onInsert = vi.fn()
    render(<Harness onInsert={onInsert} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Record' }))
    await screen.findByRole('button', { name: 'Stop & transcribe' })
    const signal = mock.record.mock.calls[0]![0].signal as AbortSignal
    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(signal.aborted).toBe(true)
    expect(capture.cancel).toHaveBeenCalledTimes(1)
    expect(mock.unload).toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
    expect(mock.transcribe).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Dictate' }))
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    expect(screen.getByText('Microphone is off')).toBeVisible()
  })

  it('discards late transcription after cancellation and does not reopen its preview', async () => {
    let resolveTranscript!: (value: { text: string; language: string }) => void
    mock.transcribe.mockReturnValue(
      new Promise(resolve => {
        resolveTranscript = resolve
      })
    )
    const onInsert = vi.fn()
    render(<Harness onInsert={onInsert} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Record' }))
    await user.click(
      await screen.findByRole('button', { name: 'Stop & transcribe' })
    )
    await user.click(
      await screen.findByRole('button', { name: 'Cancel dictation' })
    )
    await act(async () => {
      resolveTranscript({ text: 'Stale speech.', language: 'en' })
    })
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    expect(screen.getByText('Microphone is off')).toBeVisible()
    expect(audio.every(value => value === 0)).toBe(true)
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('shows permission denial and permits a retry without invoking transcription', async () => {
    mock.record.mockRejectedValue(
      new Error(
        'Microphone access was denied. Allow it in system privacy settings.'
      )
    )
    render(<Harness onInsert={vi.fn()} />)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Record' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Microphone access was denied'
    )
    expect(screen.getByRole('button', { name: 'Record' })).toBeEnabled()
    expect(mock.transcribe).not.toHaveBeenCalled()
  })
})
