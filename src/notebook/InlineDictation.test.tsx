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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import type { DictationCapture } from '../components/notebook/dictation-anchor'
import type { WhistleState } from '../services/whistle'
import type { SpeechRuntimeStatus } from '../services/speech-runtime'
import type {
  DictationRecording,
  DictationRecordingOptions,
} from '../services/whistle-recorder'
import type { DictationSettings } from '../types/notebook'
import { plainDictation } from '../services/dictation-text'
import type { DictationPiece } from '../services/voice-commands'

const mock = vi.hoisted(() => ({
  whistle: {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 17_000_000,
  } as WhistleState,
  speech: {
    state: 'idle',
    installed: { runtime: true, model: true },
    diskBytes: 1,
  } as SpeechRuntimeStatus,
  whistleListeners: new Set<() => void>(),
  speechListeners: new Set<() => void>(),
  host: null as HTMLElement | null,
  check: vi.fn(),
  download: vi.fn(),
  load: vi.fn(),
  unload: vi.fn(),
  transcribeWhistle: vi.fn(),
  transcribeFluid: vi.fn(),
  downloadFluid: vi.fn(),
  refresh: vi.fn(),
  endpoint: vi.fn(),
  stop: vi.fn(),
  record: vi.fn(),
}))
vi.mock('../services/whistle', () => ({
  getWhistleState: () => mock.whistle,
  subscribeWhistleState: (listener: () => void) => {
    mock.whistleListeners.add(listener)
    return () => {
      mock.whistleListeners.delete(listener)
    }
  },
  checkWhistleCache: mock.check,
  downloadWhistleModel: mock.download,
  loadWhistleModel: mock.load,
  removeWhistleModel: vi.fn(),
  unloadWhistleModel: mock.unload,
  transcribeWhistle: mock.transcribeWhistle,
}))
vi.mock('../services/whistle-recorder', () => ({
  startDictationRecording: mock.record,
}))
vi.mock('../services/speech-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/speech-runtime')>()),
  getSpeechRuntimeStatus: () => mock.speech,
  subscribeSpeechRuntime: (listener: () => void) => {
    mock.speechListeners.add(listener)
    return () => {
      mock.speechListeners.delete(listener)
    }
  },
  refreshSpeechRuntime: mock.refresh,
  speechEndpoint: mock.endpoint,
  stopSpeechRuntime: mock.stop,
}))
vi.mock('../services/fluid-speech', () => ({
  transcribeFluid: mock.transcribeFluid,
  downloadFluidSpeech: mock.downloadFluid,
}))
vi.mock('../components/notebook/dictation-anchor', () => ({
  getDictationChipHost: () => mock.host,
  subscribeDictationChipHost: () => () => undefined,
}))
import { InlineDictation, type InlineDictationHandle } from './InlineDictation'
import { resetDictationEnginesForTests } from '../services/dictation-engine'
import { resetDictationInputForTests } from './dictation/input-preference'

const RATE = 16_000
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (failure: unknown) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}
function changeWhistle(patch: Partial<WhistleState>) {
  mock.whistle = { ...mock.whistle, ...patch }
  mock.whistleListeners.forEach(listener => listener())
}

let recorder: DictationRecordingOptions | null
let finished: ReturnType<typeof deferred<void>>
let session: DictationRecording & {
  stop: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}
let doc: string[]
let anchor: DictationCapture & {
  insert: Mock<NonNullable<DictationCapture['insert']>>
  cancel: Mock<() => void>
  commit: Mock<(text: string) => void>
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
async function flush() {
  await act(async () => {
    for (let index = 0; index < 6; index++) await settle()
  })
}
function push(samples: Float32Array) {
  act(() => {
    for (let at = 0; at < samples.length; at += 1_600)
      recorder!.onChunk(samples.slice(at, at + 1_600))
  })
}
function speak(seconds: number) {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (let index = 0; index < samples.length; index++)
    samples[index] = 0.2 * Math.sin((2 * Math.PI * 220 * index) / RATE)
  push(samples)
}
const silence = (seconds: number) =>
  push(new Float32Array(Math.round(seconds * RATE)))

const WHISTLE: DictationSettings = {
  engine: 'whistle',
  silenceStopSeconds: 0,
  livePhrases: true,
  voiceCommands: true,
}
const FLUID: DictationSettings = { ...WHISTLE, engine: 'fluid' }

function mount(
  settings: DictationSettings = WHISTLE,
  onOpenSettings?: () => void
) {
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
        settings={settings}
        onOpenSettings={onOpenSettings}
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
        settings={WHISTLE}
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
  act(() => {
    shortcut()
  })
  await flush()
  expect(recorder).not.toBeNull()
}
const status = () => screen.getByRole('status').textContent ?? ''

beforeEach(() => {
  localStorage.clear()
  resetDictationInputForTests()
  resetDictationEnginesForTests()
  mock.whistleListeners.clear()
  mock.speechListeners.clear()
  mock.host = null
  mock.whistle = {
    status: 'idle',
    cached: true,
    progress: 100,
    downloadedBytes: 17_000_000,
  }
  mock.speech = {
    state: 'idle',
    installed: { runtime: true, model: true },
    diskBytes: 1,
  }
  mock.check.mockReset().mockResolvedValue(true)
  mock.download.mockReset().mockImplementation(async () => {
    changeWhistle({ cached: true, status: 'ready' })
  })
  mock.load.mockReset().mockResolvedValue(undefined)
  mock.unload.mockReset()
  mock.transcribeWhistle
    .mockReset()
    .mockResolvedValue({ text: 'A spoken thought.', language: 'en' })
  mock.transcribeFluid
    .mockReset()
    .mockResolvedValue({ text: 'A fluid thought.', duration: 1, segments: [] })
  mock.downloadFluid.mockReset().mockResolvedValue({})
  mock.refresh.mockReset().mockImplementation(async () => mock.speech)
  mock.endpoint.mockReset().mockResolvedValue('http://127.0.0.1:1')
  mock.stop.mockReset()
  recorder = null
  finished = deferred<void>()
  session = {
    finished: finished.promise,
    stop: vi.fn(() => finished.resolve()),
    cancel: vi.fn(() =>
      finished.reject(new DOMException('Cancelled', 'AbortError'))
    ),
  }
  mock.record.mockReset().mockImplementation(async options => {
    recorder = options
    return session
  })
  doc = []
  anchor = {
    commit: vi.fn((text: string) => {
      doc.push(text)
    }),
    cancel: vi.fn<() => void>(),
    transcribing: vi.fn(),
    listening: vi.fn(),
    insert: vi.fn((pieces: readonly DictationPiece[]) => {
      const text = plainDictation(pieces)
      doc.push(text)
      return text.split(/\s+/u).filter(Boolean).length
    }),
    undoLast: vi.fn(() => doc.pop() !== undefined),
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('inline dictation', () => {
  it('stays out of the way until the writer dictates', () => {
    const { onCapture } = mount()
    expect(mock.check).toHaveBeenCalledTimes(1)
    expect(mock.record).not.toHaveBeenCalled()
    expect(onCapture).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('region', { name: 'Inline dictation' })
    ).toBeNull()
  })

  it('starts with the shortcut, shows a passive chip, and finishes with the shortcut', async () => {
    mock.transcribeWhistle.mockResolvedValue({
      text: 'Guests arrive on Friday.',
      language: 'en',
    })
    const { onCapture, onActiveChange } = mount()
    act(() => {
      expect(shortcut()).toBe(false)
    })
    await flush()
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    expect(mock.record).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: '', maxSeconds: 30 })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Waiting for speech…')).toBeVisible()
    expect(screen.getByText('0:00 / 0:30')).toBeVisible()
    expect(status()).toBe('Listening')
    // The chip never takes focus from the writing.
    screen.getByRole('textbox', { name: 'Writing' }).focus()
    speak(1.2)
    expect(
      screen.getByText('Listening', { selector: '.dictation-chip-label' })
    ).toBeVisible()
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Writing' })
    )
    act(() => {
      shortcut({ meta: true })
    })
    await flush()
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(mock.transcribeWhistle).toHaveBeenCalledTimes(1)
    expect(doc).toEqual(['Guests arrive on Friday.'])
    expect(status()).toBe(
      'Dictation finished. Inserted 4 words. Undo with Ctrl / ⌘ Z.'
    )
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
    expect(
      screen.queryByRole('region', { name: 'Inline dictation' })
    ).toBeNull()
  })

  it('ignores repeated shortcuts and shortcuts while a dialog is open', async () => {
    mount()
    act(() => {
      shortcut({ repeat: true })
    })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    act(() => {
      shortcut()
    })
    dialog.remove()
    await flush()
    expect(mock.record).not.toHaveBeenCalled()
    await start()
    act(() => {
      shortcut({ repeat: true })
    })
    expect(session.stop).not.toHaveBeenCalled()
  })

  it('inserts Fluid phrases at natural pauses and stops after the chosen silence', async () => {
    mock.transcribeFluid.mockImplementation(async () => ({
      text: 'Unused.',
      duration: 1,
      segments: [],
    }))
    const answers = ['Guests arrive on Friday.', 'They leave on Sunday.']
    mock.transcribeFluid.mockImplementation(async (_pcm, options) => ({
      text: options?.timeoutMs ? 'Guests arrive' : (answers.shift() ?? ''),
      duration: 1,
      segments: [],
    }))
    mount({ ...FLUID, silenceStopSeconds: 2 })
    await start()
    expect(recorder!.maxSeconds).toBeGreaterThan(600)
    expect(screen.getByText(/^0:00$/)).toBeVisible()
    speak(1.5)
    await flush()
    // A faint preview of the phrase in progress.
    expect(screen.getByText('Guests arrive')).toHaveClass('dictation-preview')
    silence(1)
    await flush()
    expect(anchor.insert).toHaveBeenCalledTimes(1)
    expect(doc).toEqual(['Guests arrive on Friday.'])
    expect(status()).toBe('Inserted 4 words')
    expect(session.stop).not.toHaveBeenCalled()
    speak(0.8)
    silence(1)
    await flush()
    expect(doc).toEqual(['Guests arrive on Friday.', 'They leave on Sunday.'])
    silence(1.2)
    await flush()
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(status()).toBe(
      'Dictation finished. Inserted 8 words. Undo with Ctrl / ⌘ Z.'
    )
  })

  it('renders the chip at the writing position when the editor offers a host', async () => {
    const host = document.createElement('span')
    const marker = document.createElement('span')
    marker.append(host)
    document.body.append(marker)
    mock.host = host
    mount()
    await start()
    expect(host).toHaveTextContent('Waiting for speech…')
    expect(marker.dataset.live).toBe('true')
    expect(
      screen.queryByRole('region', { name: 'Inline dictation' })
    ).toBeNull()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(host).toBeEmptyDOMElement()
    expect(marker.dataset.live).toBeUndefined()
    marker.remove()
  })

  it('cancels with Escape without changing the note', async () => {
    mount()
    await start()
    const signal = recorder!.signal!
    speak(1)
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape', cancelable: true })
    })
    await flush()
    expect(signal.aborted).toBe(true)
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(anchor.cancel).toHaveBeenCalled()
    expect(mock.unload).toHaveBeenCalledTimes(1)
    expect(mock.transcribeWhistle).not.toHaveBeenCalled()
    expect(doc).toEqual([])
    expect(status()).toBe('Dictation cancelled. Your writing is unchanged.')
  })

  it('discards a transcription that arrives after cancelling', async () => {
    const result = deferred<{ text: string; language: string }>()
    mock.transcribeWhistle.mockReturnValue(result.promise)
    mount()
    await start()
    speak(1)
    act(() => {
      shortcut()
    })
    await flush()
    expect(screen.getByText('Writing it down…')).toBeVisible()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await act(async () => {
      result.resolve({ text: 'Late speech.', language: 'en' })
    })
    await flush()
    expect(doc).toEqual([])
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
  })

  it('cancels when the note unmounts or the window hides', async () => {
    const first = mount()
    await start()
    first.unmount()
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(first.onActiveChange).toHaveBeenLastCalledWith(false)
    finished = deferred<void>()
    session = {
      finished: finished.promise,
      stop: vi.fn(() => finished.resolve()),
      cancel: vi.fn(() => finished.reject(new DOMException('x', 'AbortError'))),
    }
    mount()
    await start()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(doc).toEqual([])
  })

  it('cleans up a microphone that opens after cancelling', async () => {
    const opening = deferred<DictationRecording>()
    mock.record.mockReturnValueOnce(opening.promise)
    mount()
    act(() => {
      shortcut()
    })
    await flush()
    expect(screen.getByText('Opening microphone…')).toBeVisible()
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await act(async () => {
      opening.resolve(session)
    })
    await flush()
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(mock.transcribeWhistle).not.toHaveBeenCalled()
  })

  it('shows denied microphone access and allows a retry', async () => {
    mock.record.mockRejectedValueOnce(
      new Error(
        'Microphone access was denied. Allow it in system privacy settings.'
      )
    )
    mount()
    act(() => {
      shortcut()
    })
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Microphone access was denied'
    )
    expect(anchor.cancel).toHaveBeenCalled()
    await start()
    expect(mock.record).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the transcript for recovery when insertion fails', async () => {
    anchor.insert.mockImplementation(() => {
      throw new Error('This note is full.')
    })
    const { onRecoverInsert } = mount()
    await start()
    speak(1)
    act(() => {
      shortcut()
    })
    await flush()
    const text = screen.getByRole('textbox', { name: 'Your transcript' })
    expect(text).toHaveValue('A spoken thought.')
    expect(screen.getByRole('alert')).toHaveTextContent('This note is full.')
    const user = userEvent.setup()
    await user.clear(text)
    expect(
      screen.getByRole('button', { name: 'Insert at cursor' })
    ).toBeDisabled()
    await user.type(text, 'Edited thought.')
    onRecoverInsert.mockImplementationOnce(() => {
      throw new Error('Place the cursor in a writable note.')
    })
    await user.click(screen.getByRole('button', { name: 'Insert at cursor' }))
    expect(text).toHaveValue('Edited thought.')
    expect(screen.getByRole('alert')).toHaveTextContent('Place the cursor')
    await user.click(screen.getByRole('button', { name: 'Insert at cursor' }))
    expect(onRecoverInsert).toHaveBeenLastCalledWith('Edited thought.')
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
  })

  it('keeps live phrases that could not be inserted and lets the writer discard them', async () => {
    let calls = 0
    anchor.insert.mockImplementation((pieces: readonly DictationPiece[]) => {
      if (++calls > 1) throw new Error('The dictation position changed.')
      doc.push(plainDictation(pieces))
      return 2
    })
    const answers = ['First part.', 'Second part.', 'Third part.']
    mock.transcribeFluid.mockImplementation(async (_pcm, options) => ({
      text: options?.timeoutMs ? '' : (answers.shift() ?? ''),
      duration: 1,
      segments: [],
    }))
    mount(FLUID)
    await start()
    for (let index = 0; index < 3; index++) {
      speak(0.6)
      silence(1)
      await flush()
    }
    act(() => {
      shortcut()
    })
    await flush()
    expect(doc).toEqual(['First part.'])
    expect(
      screen.getByRole('textbox', { name: 'Your transcript' })
    ).toHaveValue('Second part. Third part.')
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Discard transcript' }))
    expect(
      screen.queryByRole('textbox', { name: 'Your transcript' })
    ).toBeNull()
  })

  it('keeps controlled recovery through note remounts and inserts into the chosen note', async () => {
    anchor.insert.mockImplementation(() => {
      throw new Error('This note is full.')
    })
    const firstInsert = vi.fn()
    const secondInsert = vi.fn()
    const { rerender } = render(
      <ControlledRecovery noteId="first" onRecoverInsert={firstInsert} />
    )
    await start()
    speak(1)
    act(() => {
      shortcut()
    })
    await flush()
    const user = userEvent.setup()
    const text = screen.getByRole('textbox', { name: 'Your transcript' })
    await user.clear(text)
    await user.type(text, 'Keep these words.')
    rerender(
      <ControlledRecovery noteId="second" onRecoverInsert={secondInsert} />
    )
    expect(
      screen.getByRole('textbox', { name: 'Your transcript' })
    ).toHaveValue('Keep these words.')
    await user.click(screen.getByRole('button', { name: 'Insert at cursor' }))
    expect(secondInsert).toHaveBeenCalledExactlyOnceWith('Keep these words.')
    expect(firstInsert).not.toHaveBeenCalled()
  })

  it('offers the Whistle download when it is not on this device yet', async () => {
    mock.whistle = { ...mock.whistle, cached: false, progress: 0 }
    const { onCapture } = mount()
    act(() => {
      shortcut()
    })
    await flush()
    const download = screen.getByRole('button', {
      name: 'Download Whistle · 17 MB',
    })
    expect(onCapture).not.toHaveBeenCalled()
    expect(mock.download).not.toHaveBeenCalled()
    expect(status()).toContain('Dictation needs Whistle')
    await userEvent.setup().click(download)
    expect(mock.download).toHaveBeenCalledTimes(1)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Start dictating' }))
    await flush()
    expect(onCapture).toHaveBeenCalledTimes(1)
  })

  it('offers Fluid Speech Mini setup and Whistle as a quick fallback', async () => {
    mock.speech = {
      ...mock.speech,
      installed: { runtime: false, model: false },
    }
    const openSettings = vi.fn()
    const { onCapture } = mount(FLUID, openSettings)
    act(() => {
      shortcut()
    })
    await flush()
    expect(mock.refresh).toHaveBeenCalled()
    expect(onCapture).not.toHaveBeenCalled()
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', {
        name: 'Download Fluid Speech Mini (347 MB)',
      })
    )
    expect(openSettings).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Dictation settings' }))
    expect(openSettings).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Use Whistle now' }))
    await flush()
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(recorder!.maxSeconds).toBe(30)
    expect(screen.getByText('Whistle')).toHaveClass('dictation-chip-engine')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    // The fallback holds for the rest of this note's session.
    await start()
    expect(onCapture).toHaveBeenCalledTimes(2)
  })

  it('downloads Fluid Speech Mini inline without a settings callback', async () => {
    mock.speech = {
      ...mock.speech,
      installed: { runtime: false, model: false },
    }
    mock.downloadFluid.mockResolvedValue({
      error: 'Hugging Face asked for a token. Follow the guide to continue.',
    })
    mount(FLUID)
    act(() => {
      shortcut()
    })
    await flush()
    await userEvent.setup().click(
      screen.getByRole('button', {
        name: 'Download Fluid Speech Mini (347 MB)',
      })
    )
    await flush()
    expect(mock.downloadFluid).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Hugging Face asked for a token'
    )
  })

  it('uses the chosen microphone and Whistle language', async () => {
    localStorage.setItem(
      'typenext:dictation-input:v1',
      JSON.stringify({ deviceId: 'usb-1', language: 'fr' })
    )
    resetDictationInputForTests()
    mount()
    await start()
    expect(mock.record).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'usb-1' })
    )
    speak(1)
    act(() => {
      shortcut()
    })
    await flush()
    expect(mock.transcribeWhistle).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ language: 'fr' })
    )
  })

  it('warns when the microphone stays very quiet', async () => {
    mount()
    await start()
    silence(3.2)
    expect(screen.getByText('Microphone is very quiet')).toBeVisible()
    expect(status()).toBe('The microphone is very quiet.')
  })

  it('finishes and cancels from the chip buttons', async () => {
    mount()
    await start()
    speak(1)
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Finish dictation' }))
    await flush()
    expect(doc).toEqual(['A spoken thought.'])
    await waitFor(() => expect(mock.record).toHaveBeenCalledTimes(1))
  })
})
