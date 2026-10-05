import { createRef, useState } from 'react'
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
import type { DictationCapture } from '../components/notebook/dictation-anchor'
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
  devicesChanged: null as (() => void) | null,
  check: vi.fn(),
  download: vi.fn(),
  load: vi.fn(),
  remove: vi.fn(),
  unload: vi.fn(),
  transcribe: vi.fn(),
  record: vi.fn(),
  list: vi.fn(),
  unsubscribe: vi.fn(),
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
vi.mock('../services/whistle-microphones', () => ({
  listWhistleMicrophones: mock.list,
  subscribeWhistleMicrophoneChanges: (listener: () => void) => {
    mock.devicesChanged = listener
    return () => {
      mock.devicesChanged = null
      mock.unsubscribe()
    }
  },
}))
import { InlineDictation, type InlineDictationHandle } from './InlineDictation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (failure: unknown) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
function change(patch: Partial<WhistleState>) {
  mock.state = { ...mock.state, ...patch }
  mock.listeners.forEach(listener => listener())
}
let finished: ReturnType<typeof deferred<Float32Array>>
let session: WhistleRecording
let audio: Float32Array
let anchor: DictationCapture
function mount() {
  const handle = createRef<InlineDictationHandle>()
  const onCapture = vi.fn(() => anchor)
  const onRecoverInsert = vi.fn()
  const onActiveChange = vi.fn()
  const view = render(
    <>
      <textarea aria-label="Writing" />
      <button onClick={() => handle.current?.toggle()}>Dictate note</button>
      <InlineDictation
        ref={handle}
        onCapture={onCapture}
        onRecoverInsert={onRecoverInsert}
        onActiveChange={onActiveChange}
      />
    </>
  )
  return { ...view, handle, onCapture, onRecoverInsert, onActiveChange }
}
function ControlledRecovery({
  noteId,
  onRecoverInsert,
}: {
  noteId: string
  onRecoverInsert(text: string): void
}) {
  const [recoveryText, setRecoveryText] = useState<string | null>(null)
  const handle = createRef<InlineDictationHandle>()
  return (
    <>
      <button onClick={() => handle.current?.toggle()}>Dictate note</button>
      <InlineDictation
        key={noteId}
        ref={handle}
        onCapture={() => anchor}
        onRecoverInsert={onRecoverInsert}
        recoveryText={recoveryText}
        onRecoveryTextChange={setRecoveryText}
      />
    </>
  )
}
function shortcut(options: { meta?: boolean; repeat?: boolean } = {}) {
  return fireEvent.keyDown(window, {
    key: 'D',
    code: 'KeyD',
    ctrlKey: !options.meta,
    metaKey: !!options.meta,
    shiftKey: true,
    repeat: !!options.repeat,
    cancelable: true,
  })
}
async function start() {
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Dictate note' }))
  return screen.findByRole('button', { name: 'Stop' })
}

beforeEach(() => {
  localStorage.clear()
  mock.listeners.clear()
  mock.devicesChanged = null
  mock.state = {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 17_000_000,
  }
  mock.check.mockReset().mockResolvedValue(true)
  mock.download.mockReset().mockImplementation(async () => {
    change({ cached: true, status: 'ready' })
  })
  mock.load.mockReset().mockImplementation(async () => {
    change({ status: 'ready' })
  })
  mock.remove.mockReset().mockResolvedValue(undefined)
  mock.unload.mockReset().mockImplementation(() => {
    change({ status: 'idle' })
  })
  mock.transcribe.mockReset().mockResolvedValue({
    text: 'A spoken thought.',
    language: 'en',
  })
  mock.list.mockReset().mockResolvedValue([
    { deviceId: '', label: 'System default' },
    { deviceId: 'usb-1', label: 'USB microphone' },
  ])
  mock.unsubscribe.mockReset()
  finished = deferred<Float32Array>()
  audio = new Float32Array([0.1, -0.1])
  session = {
    finished: finished.promise,
    stop: vi.fn(() => finished.resolve(audio)),
    cancel: vi.fn(() =>
      finished.reject(new DOMException('Cancelled', 'AbortError'))
    ),
  }
  mock.record.mockReset().mockResolvedValue(session)
  anchor = {
    commit: vi.fn(),
    cancel: vi.fn(),
    transcribing: vi.fn(),
  }
})
afterEach(() => {
  cleanup()
  mock.listeners.clear()
  vi.restoreAllMocks()
})

describe('inline offline dictation', () => {
  it('checks only local model storage until a deliberate record or setup gesture', async () => {
    mock.state = { ...mock.state, cached: false, progress: 0 }
    const { onCapture } = mount()
    expect(mock.check).toHaveBeenCalledTimes(1)
    expect(mock.list).not.toHaveBeenCalled()
    expect(mock.record).not.toHaveBeenCalled()
    expect(mock.download).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('region', { name: 'Inline dictation' })
    ).toBeNull()
    act(() => {
      shortcut()
    })
    expect(
      await screen.findByRole('button', { name: 'Download Whistle · 17 MB' })
    ).toBeEnabled()
    expect(mock.list).toHaveBeenCalledWith(
      expect.objectContaining({ requestPermission: false })
    )
    expect(mock.download).not.toHaveBeenCalled()
    expect(mock.record).not.toHaveBeenCalled()
    expect(onCapture).not.toHaveBeenCalled()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Download Whistle · 17 MB' }))
    expect(mock.download).toHaveBeenCalledTimes(1)
    expect(mock.record).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeEnabled()
  })

  it('starts and stops with Ctrl/Command Shift D, commits directly, and wipes recorded audio', async () => {
    const { onCapture, onActiveChange } = mount()
    act(() => {
      expect(shortcut()).toBe(false)
    })
    await screen.findByRole('button', { name: 'Stop' })
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(mock.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deviceId: '' })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => {
      shortcut({ meta: true })
    })
    await waitFor(() =>
      expect(anchor.commit).toHaveBeenCalledExactlyOnceWith('A spoken thought.')
    )
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(anchor.transcribing).toHaveBeenCalledTimes(1)
    expect(mock.transcribe).toHaveBeenCalledTimes(1)
    expect(audio.every(value => value === 0)).toBe(true)
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    expect(
      screen.getByText('Added to your note. Undo with Ctrl / ⌘ Z.')
    ).toBeVisible()
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('ignores repeated shortcuts and shortcuts while another dialog is open', async () => {
    mount()
    act(() => {
      shortcut({ repeat: true })
    })
    expect(mock.record).not.toHaveBeenCalled()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    try {
      act(() => {
        shortcut()
      })
      expect(mock.record).not.toHaveBeenCalled()
    } finally {
      dialog.remove()
    }
    await start()
    act(() => {
      shortcut({ repeat: true })
    })
    expect(session.stop).not.toHaveBeenCalled()
    expect(mock.record).toHaveBeenCalledTimes(1)
  })

  it('uses recorder duration and level feedback without starting a UI interval', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    mount()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dictate note' }))
    })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    const options = mock.record.mock.calls[0]![0]
    act(() => {
      options.onDuration(12.8)
      options.onLevel(0.35)
    })
    expect(screen.getByText('12 / 30 s')).toBeVisible()
    expect(document.querySelector('.dictation-meter')).toHaveStyle(
      '--voice-level: 0.35'
    )
    expect(intervals).not.toHaveBeenCalled()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    act(() => {
      options.onLevel(0.9)
    })
    expect(document.querySelector('.dictation-meter')).toBeNull()
  })

  it('transcribes and commits automatically when the bounded recorder finishes at its duration cap', async () => {
    mount()
    await start()
    await act(async () => {
      finished.resolve(audio)
    })
    expect(session.stop).not.toHaveBeenCalled()
    expect(anchor.commit).toHaveBeenCalledExactlyOnceWith('A spoken thought.')
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeEnabled()
  })

  it('cancels microphone, anchor, and decoding with Escape without changing the note', async () => {
    mount()
    await start()
    const signal = mock.record.mock.calls[0]![0].signal as AbortSignal
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', cancelable: true })
    })
    expect(signal.aborted).toBe(true)
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(anchor.cancel).toHaveBeenCalledTimes(1)
    expect(mock.unload).toHaveBeenCalledTimes(1)
    expect(anchor.commit).not.toHaveBeenCalled()
    expect(mock.transcribe).not.toHaveBeenCalled()
    expect(
      screen.getByText('Dictation cancelled. Your writing is unchanged.')
    ).toBeVisible()
  })

  it('discards late transcription after cancellation and clears its captured PCM', async () => {
    const result = deferred<{ text: string; language: string }>()
    mock.transcribe.mockReturnValue(result.promise)
    mount()
    const stop = await start()
    fireEvent.click(stop)
    await screen.findByText('Transcribing on this device…')
    const signal = mock.transcribe.mock.calls[0]![1].signal as AbortSignal
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await act(async () => {
      result.resolve({ text: 'Late speech.', language: 'en' })
    })
    expect(signal.aborted).toBe(true)
    expect(anchor.commit).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    expect(audio.every(value => value === 0)).toBe(true)
  })

  it('cancels on note unmount and rejects late transcription from that note', async () => {
    const result = deferred<{ text: string; language: string }>()
    mock.transcribe.mockReturnValue(result.promise)
    const { unmount, onActiveChange } = mount()
    fireEvent.click(await start())
    await screen.findByText('Transcribing on this device…')
    unmount()
    const signal = mock.transcribe.mock.calls[0]![1].signal as AbortSignal
    expect(signal.aborted).toBe(true)
    expect(anchor.cancel).toHaveBeenCalledTimes(1)
    await act(async () => {
      result.resolve({ text: 'Old note speech.', language: 'en' })
    })
    expect(anchor.commit).not.toHaveBeenCalled()
    expect(audio.every(value => value === 0)).toBe(true)
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('cleans up a recording that arrives after startup was cancelled', async () => {
    const startup = deferred<WhistleRecording>()
    mock.record.mockReturnValue(startup.promise)
    mount()
    act(() => {
      shortcut()
    })
    expect(screen.getByText('Opening microphone…')).toBeVisible()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await act(async () => {
      startup.resolve(session)
    })
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(mock.transcribe).not.toHaveBeenCalled()
    expect(anchor.commit).not.toHaveBeenCalled()
  })

  it('keeps a rapid replacement recording handle when the cancelled earlier session finishes late', async () => {
    session.cancel = vi.fn()
    const old = session
    const oldFinished = finished
    const nextFinished = deferred<Float32Array>()
    const nextAudio = new Float32Array([0.2])
    const next: WhistleRecording = {
      finished: nextFinished.promise,
      stop: vi.fn(() => nextFinished.resolve(nextAudio)),
      cancel: vi.fn(() =>
        nextFinished.reject(new DOMException('Cancelled', 'AbortError'))
      ),
    }
    mock.record.mockResolvedValueOnce(old).mockResolvedValueOnce(next)
    const { handle } = mount()
    await start()
    act(() => {
      handle.current!.cancel()
      handle.current!.toggle()
    })
    await waitFor(() => expect(mock.record).toHaveBeenCalledTimes(2))
    await act(async () => {
      oldFinished.resolve(audio)
    })
    expect(audio.every(value => value === 0)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(next.stop).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(anchor.commit).toHaveBeenCalledTimes(1))
    expect(mock.transcribe).toHaveBeenCalledTimes(1)
  })

  it('shows denied microphone access, cancels its anchor, and allows a retry', async () => {
    mock.record.mockRejectedValueOnce(
      new Error(
        'Microphone access was denied. Allow it in system privacy settings.'
      )
    )
    mount()
    act(() => {
      shortcut()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Microphone access was denied'
    )
    expect(anchor.cancel).toHaveBeenCalledTimes(1)
    expect(mock.transcribe).not.toHaveBeenCalled()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Dictate' }))
    await screen.findByRole('button', { name: 'Stop' })
    expect(mock.record).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps failed insertion text editable and preserves it through a failed recovery retry', async () => {
    anchor.commit = vi.fn(() => {
      throw new Error('The note is too large to insert more text.')
    })
    const { onRecoverInsert } = mount()
    fireEvent.click(await start())
    const text = await screen.findByRole('textbox', { name: 'Your transcript' })
    expect(text).toHaveValue('A spoken thought.')
    expect(anchor.cancel).toHaveBeenCalledTimes(1)
    const user = userEvent.setup()
    await user.clear(text)
    expect(text).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Insert at cursor' })
    ).toBeDisabled()
    await user.type(text, 'Retain this edited thought.')
    onRecoverInsert.mockImplementationOnce(() => {
      throw new Error('Place the cursor in a writable note.')
    })
    await user.click(screen.getByRole('button', { name: 'Insert at cursor' }))
    expect(text).toHaveValue('Retain this edited thought.')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Place the cursor in a writable note.'
    )
    await user.click(screen.getByRole('button', { name: 'Insert at cursor' }))
    expect(onRecoverInsert).toHaveBeenLastCalledWith(
      'Retain this edited thought.'
    )
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('allows explicitly discarding a retained transcript before recording another thought', async () => {
    anchor.commit = vi.fn(() => {
      throw new Error('Choose a place to insert the transcript.')
    })
    mount()
    fireEvent.click(await start())
    await screen.findByRole('textbox', { name: 'Your transcript' })
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Discard transcript' }))
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps controlled edited recovery through rerenders and note remounts, then inserts only into the chosen note', async () => {
    anchor.commit = vi.fn(() => {
      throw new Error(
        'This note is full. Insert the transcript into a shorter note.'
      )
    })
    const firstInsert = vi.fn()
    const secondInsert = vi.fn()
    const { rerender } = render(
      <ControlledRecovery noteId="first" onRecoverInsert={firstInsert} />
    )
    fireEvent.click(await start())
    const user = userEvent.setup()
    const text = await screen.findByRole('textbox', { name: 'Your transcript' })
    await user.clear(text)
    await user.type(text, 'Keep these edited spoken words.')
    rerender(
      <ControlledRecovery noteId="first" onRecoverInsert={firstInsert} />
    )
    expect(
      screen.getByRole('textbox', { name: 'Your transcript' })
    ).toHaveValue('Keep these edited spoken words.')
    rerender(
      <ControlledRecovery noteId="second" onRecoverInsert={secondInsert} />
    )
    expect(
      screen.getByRole('region', { name: 'Inline dictation' })
    ).toBeVisible()
    expect(
      screen.getByRole('textbox', { name: 'Your transcript' })
    ).toHaveValue('Keep these edited spoken words.')
    expect(mock.record).toHaveBeenCalledTimes(1)
    expect(anchor.commit).toHaveBeenCalledTimes(1)
    expect(firstInsert).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Insert at cursor' }))
    expect(secondInsert).toHaveBeenCalledExactlyOnceWith(
      'Keep these edited spoken words.'
    )
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
    rerender(<ControlledRecovery noteId="third" onRecoverInsert={vi.fn()} />)
    expect(
      screen.queryByRole('region', { name: 'Inline dictation' })
    ).toBeNull()
    expect(mock.record).toHaveBeenCalledTimes(1)
  })

  it('cancels an active recording when the document becomes hidden', async () => {
    mount()
    await start()
    const signal = mock.record.mock.calls[0]![0].signal as AbortSignal
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(signal.aborted).toBe(true)
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(anchor.cancel).toHaveBeenCalledTimes(1)
    expect(anchor.commit).not.toHaveBeenCalled()
    expect(mock.transcribe).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('selects an explicit input and language without requesting permission while listing', async () => {
    mock.state = { ...mock.state, cached: false, progress: 0 }
    mount()
    act(() => {
      shortcut()
    })
    await screen.findByRole('option', { name: 'USB microphone' })
    expect(mock.list).toHaveBeenCalledTimes(1)
    expect(mock.list.mock.calls[0]![0].requestPermission).toBe(false)
    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Microphone' }),
      'usb-1'
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Dictation language' }),
      'fr'
    )
    await act(async () => {
      change({ cached: true })
    })
    await user.click(screen.getByRole('button', { name: 'Dictate' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(anchor.commit).toHaveBeenCalledTimes(1))
    expect(mock.record).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'usb-1' })
    )
    expect(mock.transcribe).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({ language: 'fr' })
    )
    expect(
      JSON.parse(localStorage.getItem('typenext:dictation-input:v1')!)
    ).toEqual({ deviceId: 'usb-1', language: 'fr' })
  })

  it('retains a disconnected selected input as unavailable rather than silently changing to default', async () => {
    localStorage.setItem(
      'typenext:dictation-input:v1',
      JSON.stringify({ deviceId: 'gone-input', language: '' })
    )
    mock.state = { ...mock.state, cached: false, progress: 0 }
    mount()
    act(() => {
      shortcut()
    })
    await screen.findByRole('option', { name: 'USB microphone' })
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toHaveValue(
      'gone-input'
    )
    expect(
      screen.getByRole('option', {
        name: 'Previously selected microphone · unavailable',
      })
    ).toBeVisible()
    await act(async () => {
      change({ cached: true })
    })
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Dictate' }))
    await screen.findByRole('button', { name: 'Stop' })
    expect(mock.record).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'gone-input' })
    )
  })

  it('requests microphone permission only from setup refresh and aborts it when the setup closes', async () => {
    mock.state = { ...mock.state, cached: false, progress: 0 }
    const permission = deferred<Array<{ deviceId: string; label: string }>>()
    mock.list
      .mockResolvedValueOnce([{ deviceId: '', label: 'System default' }])
      .mockReturnValueOnce(permission.promise)
    mount()
    act(() => {
      shortcut()
    })
    const refresh = await screen.findByRole('button', {
      name: 'Allow and refresh microphones',
    })
    await waitFor(() => expect(refresh).toBeEnabled())
    await userEvent.setup().click(refresh)
    const options = mock.list.mock.calls[1]![0]
    expect(options.requestPermission).toBe(true)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Choose microphone' }))
    expect(options.signal.aborted).toBe(true)
    expect(mock.unsubscribe).toHaveBeenCalledTimes(1)
    await act(async () => {
      permission.resolve([{ deviceId: 'late', label: 'Late device' }])
    })
    expect(screen.queryByRole('option', { name: 'Late device' })).toBeNull()
  })

  it('aborts an input setup permission prompt before starting a recording', async () => {
    mock.state = { ...mock.state, cached: false, progress: 0 }
    const permission = deferred<Array<{ deviceId: string; label: string }>>()
    mock.list
      .mockResolvedValueOnce([{ deviceId: '', label: 'System default' }])
      .mockReturnValueOnce(permission.promise)
    mount()
    act(() => {
      shortcut()
    })
    const refresh = await screen.findByRole('button', {
      name: 'Allow and refresh microphones',
    })
    await waitFor(() => expect(refresh).toBeEnabled())
    await userEvent.setup().click(refresh)
    const signal = mock.list.mock.calls[1]![0].signal as AbortSignal
    await act(async () => {
      change({ cached: true })
    })
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Dictate' }))
    await screen.findByRole('button', { name: 'Stop' })
    expect(signal.aborted).toBe(true)
    expect(mock.record).toHaveBeenCalledTimes(1)
    await act(async () => {
      permission.resolve([])
    })
  })

  it('keeps active model setup mounted when a shortcut is pressed before loading finishes', async () => {
    mock.state = { ...mock.state, cached: false, progress: 0 }
    const download = deferred<void>()
    let signal!: AbortSignal
    mock.download.mockImplementation(
      ({ signal: value }: { signal: AbortSignal }) => {
        signal = value
        return download.promise
      }
    )
    const { onCapture } = mount()
    act(() => {
      shortcut()
    })
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Download Whistle · 17 MB' }))
    await act(async () => {
      change({ cached: true, status: 'loading' })
    })
    act(() => {
      shortcut()
    })
    expect(signal.aborted).toBe(false)
    expect(
      screen.getByRole('region', { name: 'Offline dictation model' })
    ).toBeVisible()
    expect(mock.record).not.toHaveBeenCalled()
    expect(onCapture).not.toHaveBeenCalled()
    await act(async () => {
      change({ status: 'ready' })
      download.resolve()
    })
    expect(signal.aborted).toBe(false)
  })
})
