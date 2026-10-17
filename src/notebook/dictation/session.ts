import type { DictationCapture } from '../../components/notebook/dictation-anchor'
import type {
  DictationEngine,
  DictationEngineId,
} from '../../services/dictation-engine'
import { isFillerOnly, plainDictation } from '../../services/dictation-text'
import { VoiceActivityDetector } from '../../services/voice-activity'
import {
  hasScratch,
  parseVoiceCommands,
  type DictationPiece,
} from '../../services/voice-commands'
import type {
  DictationRecording,
  DictationRecordingOptions,
} from '../../services/whistle-recorder'
import type { WhistleLanguage } from '../../services/whistle-model'
import type { DictationSettings } from '../../types/notebook'

/**
 * One dictation session: microphone chunks feed voice activity detection,
 * phrases are cut at natural pauses and transcribed in order, and finished
 * text goes to the editor capture. React only renders snapshots.
 */
export const SAMPLE_RATE = 16_000
/** Audio kept before detected speech so its first sound is not clipped. */
const PREROLL = Math.round(0.3 * SAMPLE_RATE)
/** Audio kept after the last voiced frame of a phrase. */
const TAIL = Math.round(0.25 * SAMPLE_RATE)
/** Without live phrases, long dictation is still sent in parts this long. */
const SEGMENT = 25 * SAMPLE_RATE
/** One request never carries more than this. */
const HARD_CAP = 110 * SAMPLE_RATE
/** Silence kept while waiting for the first words. */
const WAITING_KEEP = 30 * SAMPLE_RATE
const MIN_PHRASE = Math.round(0.35 * SAMPLE_RATE)
const INTERIM_MIN = SAMPLE_RATE
const INTERIM_EVERY = Math.round(1.2 * SAMPLE_RATE)
const QUIET_PEAK = 0.003

export type SessionPhase = 'starting' | 'listening' | 'finishing' | 'ended'
export type AutoStop = 'silence' | 'limit' | 'no-speech'

export interface DictationSnapshot {
  phase: SessionPhase
  engine: DictationEngineId
  seconds: number
  maxSeconds: number
  /** Meter level, 0 to 1. */
  level: number
  speech: 'waiting' | 'speaking' | 'pause'
  quiet: boolean
  /** Faint text at the position: the phrase in progress or held text. */
  preview: string
  /** Words inserted in this session. */
  words: number
  /** Phrases waiting for their text. */
  pending: number
  /** Whole seconds until silence ends the session, when close. */
  stopIn: number | null
  live: boolean
  /** A problem that did not end the session. */
  warning: string
}

export interface SessionEnd {
  reason: 'finished' | 'cancelled' | 'failed'
  auto: AutoStop | null
  words: number
  /** Words that could not be inserted, for the recovery box. */
  recovery: string | null
  error: string
}

export interface SessionOptions {
  engine: DictationEngine
  /** Stands in when the engine fails, for audio within its limit. */
  fallback?: DictationEngine | null
  capture: DictationCapture
  settings: DictationSettings
  language: WhistleLanguage
  deviceId: string
  record(options: DictationRecordingOptions): Promise<DictationRecording>
  onUpdate(snapshot: DictationSnapshot): void
  onAnnounce?(message: string): void
  onEnd(end: SessionEnd): void
}

class PcmStore {
  private chunks: Float32Array[] = []
  /** Absolute index of the first kept sample. */
  private base = 0
  private size = 0
  get end() {
    return this.base + this.size
  }
  append(samples: Float32Array) {
    this.chunks.push(samples)
    this.size += samples.length
  }
  slice(from: number, to: number) {
    const start = Math.max(from, this.base)
    const stop = Math.min(to, this.end)
    const out = new Float32Array(Math.max(0, stop - start))
    let at = this.base
    let written = 0
    for (const chunk of this.chunks) {
      const chunkEnd = at + chunk.length
      if (chunkEnd > start && at < stop) {
        const part = chunk.subarray(
          Math.max(0, start - at),
          Math.min(chunk.length, stop - at)
        )
        out.set(part, written)
        written += part.length
      }
      at = chunkEnd
      if (at >= stop) break
    }
    return out
  }
  peak(from: number) {
    let peak = 0
    let at = this.base
    for (const chunk of this.chunks) {
      for (let index = Math.max(0, from - at); index < chunk.length; index++)
        peak = Math.max(peak, Math.abs(chunk[index]!))
      at += chunk.length
    }
    return peak
  }
  dropBefore(position: number) {
    while (this.chunks.length) {
      const first = this.chunks[0]!
      if (this.base + first.length > position) break
      first.fill(0)
      this.chunks.shift()
      this.base += first.length
      this.size -= first.length
    }
  }
  clear() {
    this.chunks.forEach(chunk => chunk.fill(0))
    this.chunks = []
    this.base += this.size
    this.size = 0
  }
}

function aborted(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export class DictationSession {
  private readonly options: SessionOptions
  private engine: DictationEngine
  private readonly controller = new AbortController()
  private readonly vad = new VoiceActivityDetector()
  private readonly store = new PcmStore()
  private recording: DictationRecording | null = null
  private phase: SessionPhase = 'starting'
  private phraseStart = 0
  private phraseSpeech = false
  private phraseSerial = 0
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private interim: AbortController | null = null
  private interimFrom = 0
  private preview = ''
  private held: DictationPiece[] = []
  private recovery: DictationPiece[] = []
  private stack: number[] = []
  private words = 0
  private insertBroken = false
  private warning = ''
  private failure = ''
  private prepared: Promise<void> | null = null
  private prepareFailed = false
  private announcedQuiet = false
  private lastSnapshot: DictationSnapshot | null = null

  constructor(options: SessionOptions) {
    this.options = options
    this.engine = options.engine
  }

  /** Live phrases need an engine that is fast enough and a capture API. */
  get live() {
    return (
      this.options.settings.livePhrases &&
      this.engine.capabilities.livePhrases &&
      typeof this.options.capture.insert === 'function'
    )
  }

  get active() {
    return this.phase !== 'ended'
  }

  get state(): SessionPhase {
    return this.phase
  }

  snapshot(): DictationSnapshot {
    const vad = this.vad.snapshot()
    const silence = this.options.settings.silenceStopSeconds
    const stopIn =
      this.phase === 'listening' &&
      silence > 0 &&
      vad.heardSpeech &&
      !vad.speaking &&
      vad.silenceMs >= 1_000 &&
      vad.silenceMs >= (silence - 3) * 1_000
        ? Math.max(1, Math.ceil(silence - vad.silenceMs / 1_000))
        : null
    return {
      phase: this.phase,
      engine: this.engine.id,
      seconds: this.store.end / SAMPLE_RATE,
      maxSeconds: this.engine.capabilities.maxSeconds,
      level: this.phase === 'listening' ? vad.level : 0,
      speech: !vad.heardSpeech
        ? 'waiting'
        : vad.speaking
          ? 'speaking'
          : 'pause',
      quiet: vad.quiet,
      preview: this.preview,
      words: this.words,
      pending: this.pending,
      stopIn,
      live: this.live,
      warning: this.warning,
    }
  }

  private emit() {
    if (this.phase === 'ended') return
    this.lastSnapshot = this.snapshot()
    this.options.onUpdate(this.lastSnapshot)
  }

  private announce(text: string) {
    if (this.phase !== 'ended') this.options.onAnnounce?.(text)
  }

  async start(): Promise<void> {
    const signal = this.controller.signal
    this.emit()
    // Warm the engine while the microphone opens; audio is buffered.
    this.prepared = this.engine.prepare(signal).catch(error => {
      if (!aborted(error)) {
        this.prepareFailed = true
        this.warning = message(error, `${this.engine.name} did not start.`)
      }
    })
    let recording: DictationRecording
    try {
      recording = await this.options.record({
        signal,
        deviceId: this.options.deviceId,
        maxSeconds: this.engine.capabilities.maxSeconds,
        onChunk: samples => this.chunk(samples),
      })
    } catch (error) {
      if (signal.aborted || aborted(error)) return this.end('cancelled')
      this.failure = message(error, 'The microphone could not start.')
      return this.end('failed')
    }
    if (signal.aborted || this.phase !== 'starting') {
      void recording.finished.catch(() => undefined)
      recording.cancel()
      return
    }
    this.recording = recording
    this.phase = 'listening'
    this.announce('Listening')
    this.emit()
    recording.finished.then(
      () => {
        if (this.phase === 'listening') void this.finish('limit')
      },
      error => {
        if (this.phase === 'ended' || signal.aborted) return
        if (aborted(error)) {
          this.cancel()
          return
        }
        // Keep what was said before the microphone stopped.
        this.failure = message(error, 'The microphone stopped.')
        void this.finish(null, true)
      }
    )
  }

  private chunk(samples: Float32Array) {
    if (this.phase !== 'listening' && this.phase !== 'finishing') return
    this.store.append(samples)
    for (const event of this.vad.push(samples)) {
      if (event.type === 'speech-start' && !this.phraseSpeech) {
        this.phraseSpeech = true
        this.phraseStart = Math.max(this.phraseStart, event.sample - PREROLL)
        this.store.dropBefore(this.phraseStart)
        this.interimFrom = this.phraseStart
      } else if (event.type === 'phrase-end' && this.phraseSpeech) {
        const at = event.sample + TAIL
        const length = at - this.phraseStart
        const cut = this.live
          ? length >= MIN_PHRASE
          : this.engine.capabilities.livePhrases && length >= SEGMENT
        if (cut) this.cut(at)
      }
    }
    const end = this.store.end
    if (!this.phraseSpeech && end - this.phraseStart > WAITING_KEEP) {
      this.phraseStart = end - WAITING_KEEP
      this.store.dropBefore(this.phraseStart)
    }
    if (
      this.phraseSpeech &&
      this.engine.capabilities.livePhrases &&
      end - this.phraseStart >= HARD_CAP
    )
      this.cut(end)
    if (this.phase !== 'listening') return
    this.maybeInterim()
    const vad = this.vad.snapshot()
    if (vad.quiet && !this.announcedQuiet) {
      this.announcedQuiet = true
      this.announce('The microphone is very quiet.')
    }
    const silence = this.options.settings.silenceStopSeconds
    if (silence > 0) {
      if (
        vad.heardSpeech &&
        !vad.speaking &&
        vad.silenceMs >= silence * 1_000
      ) {
        void this.finish('silence')
        return
      }
      if (
        !vad.heardSpeech &&
        vad.elapsedMs >= Math.max(15, silence * 4) * 1_000
      ) {
        void this.finish('no-speech')
        return
      }
    }
    this.emit()
  }

  private cut(at: number) {
    const to = Math.min(at, this.store.end)
    if (to <= this.phraseStart) return
    const pcm = this.store.slice(this.phraseStart, to)
    this.phraseStart = to
    this.phraseSpeech = false
    this.phraseSerial++
    this.store.dropBefore(to)
    this.interim?.abort()
    this.interim = null
    this.enqueue(pcm)
  }

  private enqueue(pcm: Float32Array) {
    this.pending++
    this.emit()
    this.queue = this.queue.then(async () => {
      try {
        const text = await this.transcribe(pcm)
        if (this.controller.signal.aborted) return
        this.deliver(text)
      } catch (error) {
        if (this.controller.signal.aborted || aborted(error)) return
        this.warning = message(error, 'A phrase could not be transcribed.')
        this.failure ||= this.warning
        this.announce(this.warning)
      } finally {
        pcm.fill(0)
        this.pending--
        if (!this.pending && this.live) this.preview = ''
        this.emit()
      }
    })
  }

  private async transcribe(pcm: Float32Array): Promise<string> {
    const signal = this.controller.signal
    await this.prepared
    const fallback = this.options.fallback
    const fits =
      fallback && pcm.length <= fallback.capabilities.maxSeconds * SAMPLE_RATE
    if (this.prepareFailed && fallback && fits)
      return fallback.transcribe(pcm, {
        signal,
        language: this.options.language,
      })
    try {
      return await this.engine.transcribe(pcm, {
        signal,
        language: this.options.language,
      })
    } catch (error) {
      if (signal.aborted || aborted(error) || !fallback || !fits) throw error
      this.warning = `${this.engine.name} did not answer, so Whistle transcribed this part.`
      return fallback.transcribe(pcm, {
        signal,
        language: this.options.language,
      })
    }
  }

  private maybeInterim() {
    if (!this.live || !this.engine.capabilities.interim) return
    if (
      !this.phraseSpeech ||
      this.pending ||
      this.interim ||
      this.prepareFailed
    )
      return
    const end = this.store.end
    if (end - this.phraseStart < INTERIM_MIN) return
    if (end - this.interimFrom < INTERIM_EVERY) return
    const controller = new AbortController()
    const serial = this.phraseSerial
    const stop = () => controller.abort()
    this.controller.signal.addEventListener('abort', stop, { once: true })
    this.interim = controller
    this.interimFrom = end
    const pcm = this.store.slice(this.phraseStart, end)
    void this.engine
      .transcribe(pcm, { signal: controller.signal, interim: true })
      .then(
        text => {
          if (
            controller.signal.aborted ||
            serial !== this.phraseSerial ||
            this.phase === 'ended'
          )
            return
          const words = text.trim()
          if (words && !isFillerOnly(words)) {
            this.preview = words
            this.emit()
          }
        },
        () => undefined
      )
      .finally(() => {
        pcm.fill(0)
        this.controller.signal.removeEventListener('abort', stop)
        if (this.interim === controller) this.interim = null
      })
  }

  private deliver(raw: string) {
    const text = raw.trim()
    if (!text || isFillerOnly(text)) return
    let piece: DictationPiece = this.options.settings.voiceCommands
      ? parseVoiceCommands(text)
      : { lead: [], words: text, trail: [] }
    if (hasScratch(piece)) {
      if (piece.trail.includes('scratchThat')) {
        // "…arrived on Friday, scratch that": these words never land.
        this.announce('Scratched that phrase.')
        return
      }
      this.scratch()
      piece = {
        ...piece,
        lead: piece.lead.filter(command => command !== 'scratchThat'),
      }
      if (!piece.words && !piece.lead.length && !piece.trail.length) return
    }
    const capture = this.options.capture
    if (this.live && !this.insertBroken) {
      try {
        const count = capture.insert!([piece])
        this.words += count
        this.stack.push(count)
        this.preview = ''
        if (count)
          this.announce(`Inserted ${count} word${count === 1 ? '' : 's'}`)
        return
      } catch (error) {
        this.insertBroken = true
        this.warning = message(
          error,
          'The words could not be inserted here. They are kept for you.'
        )
        this.failure ||= this.warning
        this.announce(this.warning)
      }
    }
    if (this.insertBroken) this.recovery.push(piece)
    else {
      this.held.push(piece)
      this.preview = plainDictation(this.held)
    }
  }

  private scratch() {
    if (this.live && !this.insertBroken) {
      const count = this.stack.pop() ?? 0
      if (this.options.capture.undoLast?.()) {
        this.words = Math.max(0, this.words - count)
        this.announce('Removed the last phrase.')
      } else this.announce('The last phrase was edited, so it stays.')
      return
    }
    const list = this.insertBroken ? this.recovery : this.held
    if (list.pop()) this.announce('Removed the last phrase.')
    this.preview = this.insertBroken ? this.preview : plainDictation(this.held)
  }

  /** Stop listening and insert what is still on its way. */
  async finish(auto: AutoStop | null = null, failed = false): Promise<void> {
    if (this.phase === 'starting') return this.cancel()
    if (this.phase !== 'listening') return
    this.phase = 'finishing'
    try {
      this.options.capture.transcribing()
    } catch {
      // The position may be gone; held words go to recovery below.
    }
    this.emit()
    const recording = this.recording
    if (recording) {
      recording.stop()
      await recording.finished.catch(() => undefined)
    }
    if (this.controller.signal.aborted) return
    const end = this.store.end
    if (this.phraseSpeech) this.cut(end)
    else if (
      !this.vad.snapshot().heardSpeech &&
      this.held.length === 0 &&
      this.store.peak(this.phraseStart) > QUIET_PEAK
    )
      // Detection heard nothing clear, but the clip is not silent: let the
      // model decide rather than lose quiet words.
      this.cut(end)
    await this.queue
    if (this.controller.signal.aborted) return
    this.complete(auto, failed)
  }

  private complete(auto: AutoStop | null, failed: boolean) {
    const capture = this.options.capture
    if (this.held.length && !this.insertBroken) {
      try {
        if (capture.insert) {
          const count = capture.insert(this.held)
          this.words += count
        } else {
          const text = plainDictation(this.held)
          capture.commit(text)
          this.words += text.split(/\s+/u).filter(Boolean).length
        }
        this.held = []
      } catch (error) {
        this.insertBroken = true
        this.failure ||= message(
          error,
          'The words could not be inserted here. They are kept for you.'
        )
        this.recovery.push(...this.held)
        this.held = []
      }
    }
    // Ending with words lets the editor suggest, as it does after typing.
    capture.cancel(this.words > 0)
    const recovery = this.recovery.length ? plainDictation(this.recovery) : ''
    if (recovery)
      this.failure ||= 'Place the cursor and insert your transcript below.'
    if (!this.words && !recovery && !this.failure)
      this.failure =
        auto === 'no-speech'
          ? 'No speech was heard, so dictation stopped. Check the microphone in Preferences → Dictation.'
          : 'No words were heard. Check your microphone and try again.'
    this.end(
      failed || (this.failure && !this.words) ? 'failed' : 'finished',
      auto,
      recovery || null
    )
  }

  /** Discard what has not been inserted. Inserted phrases stay. */
  cancel() {
    if (this.phase === 'ended') return
    this.controller.abort()
    this.interim?.abort()
    const recording = this.recording
    this.recording = null
    if (recording) {
      void recording.finished.catch(() => undefined)
      recording.cancel()
    }
    try {
      this.options.capture.cancel()
    } catch {
      // A destroyed editor has no anchor left to remove.
    }
    this.end('cancelled')
  }

  private end(
    reason: SessionEnd['reason'],
    auto: AutoStop | null = null,
    recovery: string | null = null
  ) {
    if (this.phase === 'ended') return
    this.phase = 'ended'
    this.store.clear()
    this.held = []
    this.engine.release(reason === 'cancelled')
    if (reason !== 'finished') {
      try {
        this.options.capture.cancel()
      } catch {
        // Already gone.
      }
    }
    this.options.onEnd({
      reason,
      auto,
      words: this.words,
      recovery,
      error: reason === 'cancelled' ? '' : this.failure,
    })
  }
}
