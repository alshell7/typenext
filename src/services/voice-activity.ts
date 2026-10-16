/**
 * Energy-based voice activity detection for dictation. Pure and synchronous:
 * feed 16 kHz mono PCM in any block size and read events and a snapshot.
 *
 * - The first frames calibrate a noise floor from their quietest energy, so a
 *   steady hum is not mistaken for speech and early speech is not lost.
 * - Speech starts after a few consecutive frames above the floor-relative
 *   threshold, and ends after a hangover below a lower release threshold.
 * - A phrase ends once the pause after speech reaches `phrasePauseMs`.
 * - The floor keeps adapting: quickly down, slowly up, and very slowly while
 *   speech continues, so a room that gets louder does not stay "speaking".
 */
export interface VoiceActivityOptions {
  sampleRate?: number
  /** Analysis frame. 20 ms by default. */
  frameMs?: number
  /** Consecutive loud frames before speech starts. */
  onsetFrames?: number
  /** Quiet time before speech is considered over. */
  hangoverMs?: number
  /** Pause after speech that ends a phrase. */
  phrasePauseMs?: number
  /** Frames used to calibrate the starting noise floor. */
  calibrationFrames?: number
  /** RMS that always counts as quiet, whatever the floor. */
  minThreshold?: number
  /** Speech must be this many times louder than the floor. */
  ratio?: number
  /** Peak RMS below which the microphone counts as very quiet. */
  quietLevel?: number
  /** How long without speech before the quiet warning can appear. */
  quietAfterMs?: number
}

export type VoiceActivityEvent =
  | { type: 'speech-start'; sample: number }
  | { type: 'speech-end'; sample: number }
  /** `sample` is where the voiced audio of the phrase ended. */
  | { type: 'phrase-end'; sample: number }

export interface VoiceActivitySnapshot {
  speaking: boolean
  /** Speech was detected at least once. */
  heardSpeech: boolean
  /** A phrase started and has not ended with a pause yet. */
  phraseOpen: boolean
  /** Display level from 0 to 1 on a perceptual (dB) scale. */
  level: number
  noiseFloor: number
  /** Milliseconds since the last voiced frame, or since the start. */
  silenceMs: number
  elapsedMs: number
  /** Levels stayed near zero and no speech was heard. */
  quiet: boolean
  /** Samples processed so far. */
  samples: number
}

const DEFAULTS: Required<VoiceActivityOptions> = {
  sampleRate: 16_000,
  frameMs: 20,
  onsetFrames: 3,
  hangoverMs: 240,
  phrasePauseMs: 700,
  calibrationFrames: 10,
  minThreshold: 0.006,
  ratio: 3,
  quietLevel: 0.0025,
  quietAfterMs: 3_000,
}
const FLOOR_MIN = 0.0003
const FLOOR_MAX = 0.03

export function frameRms(samples: Float32Array, from = 0, to = samples.length) {
  const end = Math.min(samples.length, to)
  if (end <= from) return 0
  let energy = 0
  for (let index = from; index < end; index++) {
    const value = samples[index] ?? 0
    energy += value * value
  }
  return Math.sqrt(energy / (end - from))
}

/** Map RMS to 0..1 for a meter: -60 dBFS is empty, -10 dBFS is full. */
export function displayLevel(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 60) / 50))
}

export class VoiceActivityDetector {
  private readonly options: Required<VoiceActivityOptions>
  private readonly frame: number
  private remainder: Float32Array
  private remainderLength = 0
  private processed = 0
  private floor = 0
  private calibration: number[] = []
  private speaking = false
  private heardSpeech = false
  private phraseOpen = false
  private onset = 0
  private quietRun = 0
  private lastVoiced = 0
  private peak = 0
  private level = 0

  constructor(options: VoiceActivityOptions = {}) {
    this.options = { ...DEFAULTS, ...options }
    this.frame = Math.max(
      1,
      Math.round((this.options.sampleRate * this.options.frameMs) / 1000)
    )
    this.remainder = new Float32Array(this.frame)
  }

  private ms(samples: number) {
    return (samples * 1000) / this.options.sampleRate
  }

  push(samples: Float32Array): VoiceActivityEvent[] {
    const events: VoiceActivityEvent[] = []
    let offset = 0
    if (this.remainderLength > 0) {
      const take = Math.min(this.frame - this.remainderLength, samples.length)
      this.remainder.set(samples.subarray(0, take), this.remainderLength)
      this.remainderLength += take
      offset = take
      if (this.remainderLength === this.frame) {
        this.analyse(frameRms(this.remainder), events)
        this.remainderLength = 0
      }
    }
    while (samples.length - offset >= this.frame) {
      this.analyse(frameRms(samples, offset, offset + this.frame), events)
      offset += this.frame
    }
    if (offset < samples.length) {
      this.remainder.set(samples.subarray(offset), 0)
      this.remainderLength = samples.length - offset
    }
    return events
  }

  private analyse(rms: number, events: VoiceActivityEvent[]) {
    const options = this.options
    const start = this.processed
    this.processed += this.frame
    const end = this.processed
    this.peak = Math.max(this.peak, rms)
    // A short visual release keeps the meter readable at 10 updates/second.
    const shown = displayLevel(rms)
    this.level = shown >= this.level ? shown : this.level * 0.7 + shown * 0.3

    if (this.calibration.length < options.calibrationFrames) {
      this.calibration.push(rms)
      this.floor = clampFloor(Math.min(...this.calibration))
    }
    const threshold = Math.max(options.minThreshold, this.floor * options.ratio)
    const release = Math.max(
      options.minThreshold * 0.7,
      this.floor * options.ratio * 0.6
    )

    if (!this.speaking) {
      if (rms > threshold) {
        this.onset++
        if (this.onset >= options.onsetFrames) {
          this.speaking = true
          this.heardSpeech = true
          this.phraseOpen = true
          this.quietRun = 0
          this.lastVoiced = end
          events.push({
            type: 'speech-start',
            sample: Math.max(0, start - (options.onsetFrames - 1) * this.frame),
          })
        }
      } else {
        this.onset = 0
        this.adapt(rms)
      }
    } else if (rms > release) {
      this.lastVoiced = end
      this.quietRun = 0
      // Very slow rise so a constant loud room eventually releases speech.
      this.floor = clampFloor(this.floor * 0.9995 + rms * 0.0005)
    } else {
      this.quietRun += this.frame
      this.adapt(rms)
      if (this.ms(this.quietRun) >= options.hangoverMs) {
        this.speaking = false
        this.onset = 0
        events.push({ type: 'speech-end', sample: this.lastVoiced })
      }
    }
    if (
      this.phraseOpen &&
      !this.speaking &&
      this.ms(end - this.lastVoiced) >= options.phrasePauseMs
    ) {
      this.phraseOpen = false
      events.push({ type: 'phrase-end', sample: this.lastVoiced })
    }
  }

  private adapt(rms: number) {
    if (this.calibration.length < this.options.calibrationFrames) return
    this.floor = clampFloor(
      rms < this.floor
        ? this.floor * 0.9 + rms * 0.1
        : this.floor * 0.995 + rms * 0.005
    )
  }

  snapshot(): VoiceActivitySnapshot {
    const elapsedMs = this.ms(this.processed)
    return {
      speaking: this.speaking,
      heardSpeech: this.heardSpeech,
      phraseOpen: this.phraseOpen,
      level: this.level,
      noiseFloor: this.floor,
      silenceMs: this.heardSpeech
        ? this.ms(this.processed - this.lastVoiced)
        : elapsedMs,
      elapsedMs,
      quiet:
        !this.heardSpeech &&
        elapsedMs >= this.options.quietAfterMs &&
        this.peak < this.options.quietLevel,
      samples: this.processed + this.remainderLength,
    }
  }
}

function clampFloor(value: number) {
  return Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, value))
}
