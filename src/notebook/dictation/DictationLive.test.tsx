import { createRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import type { DictationRecordingOptions } from '../../services/whistle-recorder'

const mock = vi.hoisted(() => ({
  record: vi.fn(),
  transcribe: vi.fn(),
  // Stable snapshots, as the real stores return.
  whistle: { status: 'idle', cached: true, progress: 100, downloadedBytes: 1 },
  speech: {
    state: 'running',
    installed: { runtime: true, model: true },
    running: { endpoint: 'http://127.0.0.1:1' },
    diskBytes: 1,
  },
}))
vi.mock('../../services/whistle', () => ({
  getWhistleState: () => mock.whistle,
  subscribeWhistleState: () => () => undefined,
  checkWhistleCache: vi.fn(async () => true),
  downloadWhistleModel: vi.fn(),
  loadWhistleModel: vi.fn(async () => undefined),
  unloadWhistleModel: vi.fn(),
  transcribeWhistle: vi.fn(),
}))
vi.mock('../../services/whistle-recorder', () => ({
  startDictationRecording: mock.record,
}))
vi.mock('../../services/speech-runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/speech-runtime')>()),
  getSpeechRuntimeStatus: () => mock.speech,
  subscribeSpeechRuntime: () => () => undefined,
  refreshSpeechRuntime: vi.fn(async () => undefined),
  speechEndpoint: vi.fn(async () => 'http://127.0.0.1:1'),
  stopSpeechRuntime: vi.fn(),
}))
vi.mock('../../services/fluid-speech', () => ({
  transcribeFluid: mock.transcribe,
  downloadFluidSpeech: vi.fn(),
}))
import { InlineDictation, type InlineDictationHandle } from '../InlineDictation'
import {
  dictationAnchorDecoration,
  dictationAnchorField,
  startDictationCapture,
} from '../../components/notebook/dictation-anchor'
import { resetDictationEnginesForTests } from '../../services/dictation-engine'

const RATE = 16_000
let recorder: DictationRecordingOptions
let view: EditorView
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
async function flush() {
  await act(async () => {
    for (let index = 0; index < 6; index++) await settle()
  })
}
function push(samples: Float32Array) {
  act(() => {
    for (let at = 0; at < samples.length; at += 1_600)
      recorder.onChunk(samples.slice(at, at + 1_600))
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

beforeEach(() => {
  resetDictationEnginesForTests()
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
  mock.record.mockReset().mockImplementation(async options => {
    recorder = options
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const finished = new Promise<void>((done, failed) => {
      resolve = done
      reject = failed
    })
    return {
      finished,
      stop: () => resolve(),
      cancel: () => reject(new DOMException('x', 'AbortError')),
    }
  })
  view = new EditorView({
    state: EditorState.create({
      doc: 'Plan.',
      selection: EditorSelection.cursor(5),
      extensions: [history(), dictationAnchorField, dictationAnchorDecoration],
    }),
    parent: document.body,
  })
})
afterEach(() => {
  cleanup()
  view.destroy()
  document.body.innerHTML = ''
})

describe('live dictation in the editor', () => {
  it('shows the chip and phrase preview at the cursor and inserts phrases as they finish', async () => {
    const answers = ['guests arrive on Friday.', 'New paragraph.']
    mock.transcribe.mockImplementation(async (_pcm, options) => ({
      text: options?.timeoutMs ? 'guests arrive' : (answers.shift() ?? ''),
      duration: 1,
      segments: [],
    }))
    const handle = createRef<InlineDictationHandle>()
    render(
      <InlineDictation
        ref={handle}
        settings={{
          engine: 'fluid',
          silenceStopSeconds: 0,
          livePhrases: true,
          voiceCommands: true,
        }}
        onCapture={() => startDictationCapture(view)}
        onRecoverInsert={vi.fn()}
      />
    )
    act(() => handle.current!.toggle())
    await flush()
    const marker = view.dom.querySelector('.cm-dictation-anchor')!
    expect(marker.querySelector('.dictation-chip')).toHaveTextContent(
      'Waiting for speech…'
    )
    expect(marker).toHaveAttribute('data-live', 'true')
    speak(1.5)
    await flush()
    expect(marker.querySelector('.dictation-preview')).toHaveTextContent(
      'guests arrive'
    )
    // The preview is a decoration, never document text.
    expect(view.state.doc.toString()).toBe('Plan.')
    silence(1)
    await flush()
    expect(view.state.doc.toString()).toBe('Plan. Guests arrive on Friday.')
    speak(0.6)
    silence(1)
    await flush()
    expect(view.state.doc.toString()).toBe('Plan. Guests arrive on Friday.\n\n')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(view.state.field(dictationAnchorField)).toBeNull()
    expect(view.dom.querySelector('.dictation-chip')).toBeNull()
    // Inserted phrases stay after cancelling; each is one undo step.
    expect(view.state.doc.toString()).toBe('Plan. Guests arrive on Friday.\n\n')
    undo(view)
    expect(view.state.doc.toString()).toBe('Plan. Guests arrive on Friday.')
  })
})
