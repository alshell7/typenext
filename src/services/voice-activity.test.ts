import { describe, expect, it } from 'vitest'
import {
  VoiceActivityDetector,
  displayLevel,
  frameRms,
  type VoiceActivityEvent,
} from './voice-activity'

const RATE = 16_000
function tone(seconds: number, amplitude: number, frequency = 220) {
  const samples = new Float32Array(Math.round(seconds * RATE))
  for (let index = 0; index < samples.length; index++)
    samples[index] =
      amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE)
  return samples
}
/** Deterministic pseudo-random noise. */
function noise(seconds: number, amplitude: number, seed = 7) {
  const samples = new Float32Array(Math.round(seconds * RATE))
  let state = seed
  for (let index = 0; index < samples.length; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    samples[index] = ((state / 0x7fffffff) * 2 - 1) * amplitude
  }
  return samples
}
function mix(...parts: Float32Array[]) {
  const out = new Float32Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  )
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
/** Feed in odd-sized blocks, as the recorder's chunks are not frame-aligned. */
function feed(
  vad: VoiceActivityDetector,
  samples: Float32Array,
  block = 1_337
) {
  const events: VoiceActivityEvent[] = []
  for (let at = 0; at < samples.length; at += block)
    events.push(...vad.push(samples.subarray(at, at + block)))
  return events
}

describe('voice activity detection', () => {
  it('measures RMS and maps it to a perceptual meter level', () => {
    expect(frameRms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5)
    expect(frameRms(new Float32Array(0))).toBe(0)
    expect(displayLevel(0)).toBe(0)
    expect(displayLevel(0.001)).toBe(0)
    expect(displayLevel(1)).toBe(1)
    expect(displayLevel(0.03)).toBeGreaterThan(0.4)
  })

  it('stays silent on digital silence and reports waiting, then very quiet', () => {
    const vad = new VoiceActivityDetector()
    expect(feed(vad, new Float32Array(RATE * 2))).toEqual([])
    expect(vad.snapshot()).toMatchObject({
      heardSpeech: false,
      speaking: false,
      quiet: false,
    })
    feed(vad, new Float32Array(RATE * 2))
    expect(vad.snapshot()).toMatchObject({ heardSpeech: false, quiet: true })
    expect(vad.snapshot().silenceMs).toBeCloseTo(4_000, -2)
  })

  it('detects a speech burst, backdates its start, and ends the phrase after the pause', () => {
    const vad = new VoiceActivityDetector()
    const events = feed(
      vad,
      mix(new Float32Array(RATE * 0.5), tone(1, 0.2), new Float32Array(RATE))
    )
    expect(events.map(event => event.type)).toEqual([
      'speech-start',
      'speech-end',
      'phrase-end',
    ])
    const start = events[0]!.sample / RATE
    expect(start).toBeGreaterThan(0.45)
    expect(start).toBeLessThan(0.52)
    const end = events[2]!.sample / RATE
    expect(end).toBeGreaterThan(1.45)
    expect(end).toBeLessThan(1.56)
    expect(vad.snapshot()).toMatchObject({
      heardSpeech: true,
      speaking: false,
      phraseOpen: false,
      quiet: false,
    })
  })

  it('keeps one phrase through short gaps between words', () => {
    const vad = new VoiceActivityDetector()
    const events = feed(
      vad,
      mix(
        tone(0.4, 0.2),
        new Float32Array(RATE * 0.15),
        tone(0.4, 0.15),
        new Float32Array(RATE * 0.4),
        tone(0.3, 0.2),
        new Float32Array(RATE)
      )
    )
    expect(events.filter(event => event.type === 'phrase-end')).toHaveLength(1)
  })

  it('splits two phrases separated by a natural pause', () => {
    const vad = new VoiceActivityDetector()
    const events = feed(
      vad,
      mix(
        tone(0.6, 0.2),
        new Float32Array(RATE * 0.9),
        tone(0.6, 0.2),
        new Float32Array(RATE)
      )
    )
    expect(events.filter(event => event.type === 'speech-start')).toHaveLength(
      2
    )
    expect(events.filter(event => event.type === 'phrase-end')).toHaveLength(2)
  })

  it('ignores a single click or pop', () => {
    const vad = new VoiceActivityDetector()
    const click = new Float32Array(RATE)
    click.fill(0.8, 8_000, 8_200)
    expect(feed(vad, click)).toEqual([])
    expect(vad.snapshot().heardSpeech).toBe(false)
  })

  it('learns a steady noise floor and still hears speech above it', () => {
    const vad = new VoiceActivityDetector()
    const room = noise(2, 0.02)
    expect(feed(vad, room)).toEqual([])
    expect(vad.snapshot().noiseFloor).toBeGreaterThan(0.008)
    expect(vad.snapshot().quiet).toBe(false)
    const speech = noise(1, 0.02, 3)
    const voice = tone(1, 0.25)
    for (let index = 0; index < speech.length; index++)
      speech[index] = speech[index]! + voice[index]!
    const events = feed(vad, mix(speech, noise(1.2, 0.02, 11)))
    expect(events.map(event => event.type)).toEqual([
      'speech-start',
      'speech-end',
      'phrase-end',
    ])
  })

  it('treats noise that only matches the floor as no speech', () => {
    const vad = new VoiceActivityDetector()
    expect(feed(vad, noise(5, 0.03))).toEqual([])
  })

  it('tracks silence since the last voiced frame for auto-stop', () => {
    const vad = new VoiceActivityDetector()
    feed(vad, mix(tone(0.5, 0.2), new Float32Array(RATE * 3)))
    expect(vad.snapshot().silenceMs).toBeGreaterThan(2_900)
    expect(vad.snapshot().silenceMs).toBeLessThan(3_100)
  })
})
