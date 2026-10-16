import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { DictationCapture } from '../../components/notebook/dictation-anchor'
import type {
  DictationEngine,
  DictationTranscribeOptions,
} from '../../services/dictation-engine'
import { plainDictation } from '../../services/dictation-text'
import type { DictationPiece } from '../../services/voice-commands'
import type {
  DictationRecording,
  DictationRecordingOptions,
} from '../../services/whistle-recorder'
import type { DictationSettings } from '../../types/notebook'
import {
  DictationSession,
  type DictationSnapshot,
  type SessionEnd,
} from './session'

const RATE = 16_000
const CHUNK = 1_600

function makeEngine(
  id: 'fluid' | 'whistle',
  answer: (
    pcm: Float32Array,
    options: DictationTranscribeOptions
  ) => string | Promise<string>
): DictationEngine & {
  transcribe: Mock<DictationEngine['transcribe']>
  release: Mock<DictationEngine['release']>
} {
  return {
    id,
    name: id === 'fluid' ? 'Fluid Speech Mini' : 'Whistle',
    capabilities:
      id === 'fluid'
        ? {
            maxSeconds: 1_800,
            livePhrases: true,
            interim: true,
            languages: ['en'],
          }
        : {
            maxSeconds: 30,
            livePhrases: false,
            interim: false,
            languages: [''],
          },
    readiness: () => ({ state: 'ready' }),
    prepare: vi.fn(async () => undefined),
    transcribe: vi.fn<DictationEngine['transcribe']>(
      async (pcm, options = {}) => answer(pcm.slice(), options)
    ),
    release: vi.fn<DictationEngine['release']>(),
  }
}

function makeCapture(live = true) {
  const doc: string[] = []
  const capture = {
    commit: vi.fn((text: string) => {
      doc.push(text)
    }),
    cancel: vi.fn(),
    transcribing: vi.fn(),
    listening: vi.fn(),
    insert: vi.fn((pieces: readonly DictationPiece[]) => {
      const text = plainDictation(pieces)
      doc.push(text)
      return text.split(/\s+/u).filter(Boolean).length
    }),
    undoLast: vi.fn(() => doc.pop() !== undefined),
  }
  if (!live) {
    delete (capture as Partial<typeof capture>).insert
    delete (capture as Partial<typeof capture>).undoLast
  }
  return { capture: capture as DictationCapture & typeof capture, doc }
}

function harness(
  engine: DictationEngine,
  settings: Partial<DictationSettings> = {},
  options: { live?: boolean; fallback?: DictationEngine } = {}
) {
  const { capture, doc } = makeCapture(options.live ?? true)
  let recorder!: DictationRecordingOptions
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const recording: DictationRecording & {
    stop: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  } = {
    finished: new Promise<void>((done, failed) => {
      resolve = done
      reject = failed
    }),
    stop: vi.fn(() => resolve()),
    cancel: vi.fn(() => reject(new DOMException('Cancelled', 'AbortError'))),
  }
  const snapshots: DictationSnapshot[] = []
  const announcements: string[] = []
  const ends: SessionEnd[] = []
  const session = new DictationSession({
    engine,
    fallback: options.fallback ?? null,
    capture,
    settings: {
      engine: engine.id,
      silenceStopSeconds: 0,
      livePhrases: true,
      voiceCommands: true,
      ...settings,
    },
    language: '',
    deviceId: '',
    record: async value => {
      recorder = value
      return recording
    },
    onUpdate: value => snapshots.push(value),
    onAnnounce: value => announcements.push(value),
    onEnd: value => ends.push(value),
  })
  const push = (samples: Float32Array) => {
    for (let at = 0; at < samples.length; at += CHUNK)
      recorder.onChunk(samples.slice(at, at + CHUNK))
  }
  const speak = (seconds: number, amplitude = 0.2) => {
    const samples = new Float32Array(Math.round(seconds * RATE))
    for (let index = 0; index < samples.length; index++)
      samples[index] = amplitude * Math.sin((2 * Math.PI * 220 * index) / RATE)
    push(samples)
  }
  const silence = (seconds: number) =>
    push(new Float32Array(Math.round(seconds * RATE)))
  return {
    session,
    capture,
    doc,
    recording,
    snapshots,
    announcements,
    ends,
    speak,
    silence,
    fail: (error: unknown) => reject(error),
    last: () => snapshots[snapshots.length - 1]!,
    recorder: () => recorder,
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
async function flush() {
  for (let index = 0; index < 6; index++) await settle()
}

let answers: string[]
beforeEach(() => {
  answers = []
})
const next = () => answers.shift() ?? ''

describe('dictation session', () => {
  it('inserts each phrase at a natural pause while listening continues', async () => {
    answers = ['Guests arrive on Friday.', 'They leave on Sunday.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? 'Guests arrive' : next()
    )
    const h = harness(engine)
    await h.session.start()
    expect(h.session.state).toBe('listening')
    expect(h.announcements).toContain('Listening')
    expect(h.recorder().maxSeconds).toBe(1_800)
    h.speak(1)
    h.silence(1)
    await flush()
    expect(h.capture.insert).toHaveBeenCalledTimes(1)
    expect(h.doc).toEqual(['Guests arrive on Friday.'])
    expect(h.session.state).toBe('listening')
    expect(h.announcements).toContain('Inserted 4 words')
    h.speak(0.8)
    h.silence(1)
    await flush()
    expect(h.doc).toEqual(['Guests arrive on Friday.', 'They leave on Sunday.'])
    await h.session.finish()
    expect(h.recording.stop).toHaveBeenCalledTimes(1)
    expect(h.capture.transcribing).toHaveBeenCalled()
    expect(h.capture.cancel).toHaveBeenCalled()
    expect(h.ends).toEqual([
      { reason: 'finished', auto: null, words: 8, recovery: null, error: '' },
    ])
    expect(engine.release).toHaveBeenCalledWith(false)
  })

  it('ignores silence before the first words', async () => {
    answers = ['Hello there.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine)
    await h.session.start()
    h.silence(3)
    expect(h.last().speech).toBe('waiting')
    h.speak(0.6)
    h.silence(1)
    await flush()
    const finals = engine.transcribe.mock.calls.filter(
      ([, options]) => !options?.interim
    )
    expect(finals).toHaveLength(1)
    const seconds = (finals[0]![0] as Float32Array).length / RATE
    expect(seconds).toBeGreaterThan(0.8)
    expect(seconds).toBeLessThan(1.4)
  })

  it('shows the phrase in progress as a preview and clears it once inserted', async () => {
    const gate: Array<(text: string) => void> = []
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim
        ? 'Guests arrive at'
        : new Promise<string>(resolve => gate.push(resolve))
    )
    const h = harness(engine)
    await h.session.start()
    h.speak(1.5)
    await flush()
    expect(
      engine.transcribe.mock.calls.some(([, options]) => options?.interim)
    ).toBe(true)
    expect(h.last().preview).toBe('Guests arrive at')
    h.silence(1)
    await flush()
    expect(h.last()).toMatchObject({ pending: 1, preview: 'Guests arrive at' })
    gate[0]!('Guests arrive at noon.')
    await flush()
    expect(h.last()).toMatchObject({ pending: 0, preview: '' })
    expect(h.doc).toEqual(['Guests arrive at noon.'])
  })

  it('stops by itself after the chosen silence once speech was heard', async () => {
    answers = ['All done.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine, { silenceStopSeconds: 3 })
    await h.session.start()
    h.speak(0.6)
    h.silence(1.2)
    expect(h.last().stopIn).toBe(2)
    h.silence(2)
    await flush()
    expect(h.recording.stop).toHaveBeenCalledTimes(1)
    expect(h.ends[0]).toMatchObject({
      reason: 'finished',
      auto: 'silence',
      words: 2,
    })
  })

  it('never stops for silence when the setting is off, and warns about a quiet microphone', async () => {
    const engine = makeEngine('fluid', () => '')
    const h = harness(engine, { silenceStopSeconds: 0 })
    await h.session.start()
    h.silence(20)
    expect(h.session.state).toBe('listening')
    expect(h.last()).toMatchObject({ quiet: true, speech: 'waiting' })
    expect(h.announcements).toContain('The microphone is very quiet.')
  })

  it('ends when no speech is heard at all', async () => {
    const engine = makeEngine('fluid', () => '')
    const h = harness(engine, { silenceStopSeconds: 4 })
    await h.session.start()
    h.silence(16)
    await flush()
    expect(h.ends[0]).toMatchObject({ reason: 'failed', auto: 'no-speech' })
    expect(h.ends[0]!.error).toContain('No speech was heard')
    expect(engine.transcribe).not.toHaveBeenCalled()
  })

  it('holds phrases without live insertion and inserts them together at the end', async () => {
    answers = ['First thought.', 'Second thought.']
    const engine = makeEngine('fluid', () => next())
    const h = harness(engine, { livePhrases: false })
    await h.session.start()
    h.speak(1)
    h.silence(1)
    h.speak(1)
    await flush()
    // Without live phrases, short pauses do not split a request.
    expect(engine.transcribe).not.toHaveBeenCalled()
    await h.session.finish()
    expect(engine.transcribe).toHaveBeenCalledTimes(1)
    expect(h.capture.insert).toHaveBeenCalledTimes(1)
    expect(h.doc).toEqual(['First thought.'])
  })

  it('records one clip for Whistle, trimmed to the speech', async () => {
    answers = ['A spoken thought.']
    const engine = makeEngine('whistle', () => next())
    const h = harness(engine)
    await h.session.start()
    expect(h.recorder().maxSeconds).toBe(30)
    h.silence(2)
    h.speak(1)
    h.silence(1)
    h.speak(1)
    await flush()
    expect(engine.transcribe).not.toHaveBeenCalled()
    expect(h.last().live).toBe(false)
    await h.session.finish()
    expect(engine.transcribe).toHaveBeenCalledTimes(1)
    const seconds =
      (engine.transcribe.mock.calls[0]![0] as Float32Array).length / RATE
    expect(seconds).toBeGreaterThan(3)
    expect(seconds).toBeLessThan(3.5)
    expect(h.doc).toEqual(['A spoken thought.'])
  })

  it('finishes by itself at the recording limit', async () => {
    answers = ['Thirty seconds of thought.']
    const engine = makeEngine('whistle', () => next())
    const h = harness(engine)
    await h.session.start()
    h.speak(1)
    h.recording.stop()
    await flush()
    expect(h.ends[0]).toMatchObject({ reason: 'finished', auto: 'limit' })
  })

  it('follows scratch that', async () => {
    answers = [
      'Guests arrive on Friday.',
      'Scratch that.',
      'They come on Sunday, scratch that.',
      'Saturday.',
    ]
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine)
    await h.session.start()
    for (let index = 0; index < 4; index++) {
      h.speak(0.6)
      h.silence(1)
      await flush()
    }
    expect(h.capture.undoLast).toHaveBeenCalledTimes(1)
    expect(h.doc).toEqual(['Saturday.'])
    expect(h.announcements).toContain('Removed the last phrase.')
    expect(h.announcements).toContain('Scratched that phrase.')
  })

  it('keeps words for recovery when inserting fails, including later phrases', async () => {
    answers = ['First part.', 'Second part.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine)
    h.capture.insert.mockImplementation(() => {
      throw new Error('The dictation position changed.')
    })
    await h.session.start()
    h.speak(0.6)
    h.silence(1)
    await flush()
    expect(h.last().warning).toBe('The dictation position changed.')
    h.speak(0.6)
    h.silence(1)
    await flush()
    expect(h.capture.insert).toHaveBeenCalledTimes(1)
    await h.session.finish()
    expect(h.ends[0]).toMatchObject({
      reason: 'failed',
      recovery: 'First part. Second part.',
      error: 'The dictation position changed.',
    })
  })

  it('uses the single commit of an older editor capture', async () => {
    answers = ['One.', 'Two.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine, {}, { live: false })
    await h.session.start()
    expect(h.last().live).toBe(false)
    h.speak(1)
    h.silence(1)
    await h.session.finish()
    expect(h.capture.commit).toHaveBeenCalledExactlyOnceWith('One.')
  })

  it('cancels: stops the microphone, drops pending work and keeps inserted phrases', async () => {
    answers = ['Kept phrase.']
    let late!: (text: string) => void
    let signal!: AbortSignal
    const engine = makeEngine('fluid', (_pcm, options) => {
      if (options.interim) return ''
      if (!answers.length) {
        signal = options.signal!
        return new Promise<string>(resolve => {
          late = resolve
        })
      }
      return next()
    })
    const h = harness(engine)
    await h.session.start()
    h.speak(0.6)
    h.silence(1)
    await flush()
    h.speak(0.6)
    h.silence(1)
    await flush()
    h.session.cancel()
    expect(signal.aborted).toBe(true)
    expect(h.recording.cancel).toHaveBeenCalledTimes(1)
    expect(h.capture.cancel).toHaveBeenCalled()
    late('Too late.')
    await flush()
    expect(h.doc).toEqual(['Kept phrase.'])
    expect(h.ends).toEqual([
      { reason: 'cancelled', auto: null, words: 2, recovery: null, error: '' },
    ])
    expect(engine.release).toHaveBeenCalledWith(true)
  })

  it('cancels a session whose microphone was still opening', async () => {
    const engine = makeEngine('fluid', () => '')
    const { capture } = makeCapture()
    let open!: (recording: DictationRecording) => void
    const ends: SessionEnd[] = []
    const session = new DictationSession({
      engine,
      capture,
      settings: {
        engine: 'fluid',
        silenceStopSeconds: 4,
        livePhrases: true,
        voiceCommands: true,
      },
      language: '',
      deviceId: '',
      record: () => new Promise(resolve => (open = resolve)),
      onUpdate: () => undefined,
      onEnd: value => ends.push(value),
    })
    const started = session.start()
    session.cancel()
    const late = {
      finished: new Promise<void>(() => undefined),
      stop: vi.fn(),
      cancel: vi.fn(),
    }
    open(late)
    await started
    expect(late.cancel).toHaveBeenCalledTimes(1)
    expect(ends).toHaveLength(1)
  })

  it('lets Whistle transcribe a phrase that Fluid could not', async () => {
    const fluid = makeEngine('fluid', (_pcm, options) => {
      if (options.interim) return ''
      throw new Error('Fluid Speech Mini did not answer.')
    })
    const whistle = makeEngine('whistle', () => 'Saved by Whistle.')
    const h = harness(fluid, {}, { fallback: whistle })
    await h.session.start()
    h.speak(0.6)
    h.silence(1)
    await flush()
    expect(h.doc).toEqual(['Saved by Whistle.'])
    expect(h.last().warning).toContain('Whistle transcribed this part')
  })

  it('reports a phrase that could not be transcribed', async () => {
    const engine = makeEngine('fluid', (_pcm, options) => {
      if (options.interim) return ''
      throw new Error('Fluid Speech Mini returned HTTP 500.')
    })
    const h = harness(engine)
    await h.session.start()
    h.speak(0.6)
    h.silence(1)
    await flush()
    await h.session.finish()
    expect(h.ends[0]).toMatchObject({
      reason: 'failed',
      error: 'Fluid Speech Mini returned HTTP 500.',
    })
  })

  it('keeps what was said when the microphone disconnects', async () => {
    answers = ['Before the cable came out.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine, { livePhrases: false })
    await h.session.start()
    h.speak(1)
    h.fail(
      new Error('The microphone disconnected. Connect it and record again.')
    )
    await flush()
    expect(h.doc).toEqual(['Before the cable came out.'])
    expect(h.ends[0]).toMatchObject({
      reason: 'failed',
      words: 5,
      error: 'The microphone disconnected. Connect it and record again.',
    })
  })

  it('reports a microphone that could not open', async () => {
    const engine = makeEngine('fluid', () => '')
    const { capture } = makeCapture()
    const ends: SessionEnd[] = []
    const session = new DictationSession({
      engine,
      capture,
      settings: {
        engine: 'fluid',
        silenceStopSeconds: 4,
        livePhrases: true,
        voiceCommands: true,
      },
      language: '',
      deviceId: '',
      record: async () => {
        throw new Error('Microphone access was denied.')
      },
      onUpdate: () => undefined,
      onEnd: value => ends.push(value),
    })
    await session.start()
    expect(ends[0]).toMatchObject({
      reason: 'failed',
      error: 'Microphone access was denied.',
    })
    expect(capture.cancel).toHaveBeenCalled()
    expect(engine.release).toHaveBeenCalled()
  })

  it('treats voice command words as text when commands are off', async () => {
    answers = ['New paragraph.']
    const engine = makeEngine('fluid', (_pcm, options) =>
      options.interim ? '' : next()
    )
    const h = harness(engine, { voiceCommands: false })
    await h.session.start()
    h.speak(0.6)
    h.silence(1)
    await flush()
    expect(h.capture.insert.mock.calls[0]![0]).toEqual([
      { lead: [], words: 'New paragraph.', trail: [] },
    ])
  })
})

const liveServer = process.env.TYPENEXT_SPEECH_URL
describe.skipIf(!liveServer)(
  'live phrases against a real Fluid Speech Mini server (TYPENEXT_SPEECH_URL)',
  () => {
    it('cuts real speech at the pause and inserts each phrase', async () => {
      const { readWav, useNodeMultipart } = await import('./live-audio')
      const { transcribeFluid } = await import('../../services/fluid-speech')
      useNodeMultipart()
      const speech = readWav(
        process.env.TYPENEXT_SPEECH_WAV ??
          `${process.env.TMPDIR ?? '/tmp'}/speech.wav`
      )
      const engine = makeEngine('fluid', async (pcm, options) =>
        options.interim
          ? ''
          : (
              await transcribeFluid(pcm, {
                endpoint: liveServer!,
                transport: 'http',
              })
            ).text
      )
      const h = harness(engine, { silenceStopSeconds: 3 })
      await h.session.start()
      const push = (samples: Float32Array) => {
        for (let at = 0; at < samples.length; at += CHUNK)
          h.recorder().onChunk(samples.slice(at, at + CHUNK))
      }
      push(speech)
      h.silence(1.2)
      await vi.waitFor(() => expect(h.doc).toHaveLength(1), { timeout: 10_000 })
      push(speech)
      h.silence(3.2)
      await vi.waitFor(() => expect(h.ends).toHaveLength(1), {
        timeout: 10_000,
      })
      expect(h.ends[0]).toMatchObject({ reason: 'finished', auto: 'silence' })
      expect(h.doc).toHaveLength(2)
      const expected = process.env.TYPENEXT_SPEECH_EXPECT
      if (expected)
        for (const phrase of h.doc) expect(phrase).toContain(expected)
    }, 30_000)
  }
)
