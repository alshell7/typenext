// Synthesize the film's soundtrack from the shared timeline: no samples,
// no licences. Writes artifacts/promo/soundtrack.wav and the voice
// envelope that drives the on-screen meter.
//   node scripts/promo/soundtrack.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { BEAT, DURATION, RISER, STOMPS, TABS, TICKS, VOICE, WHOOSHES, hookKeys } from './timeline.mjs'

const SR = 48_000
const N = Math.round(DURATION * SR)
const L = new Float32Array(N)
const R = new Float32Array(N)
const send = new Float32Array(N) // reverb bus
const spoken = new Float32Array(N) // the voice, kept out of the ducking
const kicks = [] // for sidechain ducking
const out = 'artifacts/promo'
mkdirSync(out, { recursive: true })

// --------------------------------------------------------------- basics

let seed = 0x9e3779b9
const random = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return ((seed >>> 0) / 4294967296) * 2 - 1
}
const TABLE = new Float32Array(8192)
for (let index = 0; index < TABLE.length; index++) TABLE[index] = Math.sin((index / TABLE.length) * Math.PI * 2)
const sine = phase => TABLE[Math.floor((phase - Math.floor(phase)) * 8192) & 8191]
const note = name => {
  const [, letter, octave] = /^([A-G]#?)(-?\d)$/u.exec(name)
  const steps = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 }[letter]
  return 440 * 2 ** ((steps + (Number(octave) - 4) * 12) / 12)
}

function add(t0, length, fn, { gain = 1, pan = 0, wet = 0 } = {}) {
  const start = Math.max(0, Math.round(t0 * SR))
  const end = Math.min(N, start + Math.round(length * SR))
  const left = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2
  const right = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2
  for (let index = start; index < end; index++) {
    const value = fn((index - start) / SR, index)
    L[index] += value * left
    R[index] += value * right
    send[index] += value * wet * gain
  }
}

/** One-pole filters, as small closures. */
const lowpass = cutoff => {
  let y = 0
  return (x, fc = cutoff) => {
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SR)
    y += a * (x - y)
    return y
  }
}
const highpass = cutoff => {
  const low = lowpass(cutoff)
  return (x, fc) => x - low(x, fc)
}
/** A resonant state-variable band-pass, for claps and whooshes. */
const bandpass = (q = 1.4) => {
  let low = 0
  let band = 0
  return (x, fc) => {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 6)) / SR)
    low += f * band
    const high = x - low - band / q
    band += f * high
    return band
  }
}

// --------------------------------------------------------------- voices

function kick(t0, gain = 1, { top = 160, bottom = 44, decay = 0.3, click = 0.5 } = {}) {
  kicks.push(t0)
  let phase = 0
  const hp = highpass(2500)
  add(t0, decay * 4, x => {
    const f = bottom + (top - bottom) * Math.exp(-x * 28)
    phase += f / SR
    const body = sine(phase) * Math.exp(-x / decay)
    const tick = x < 0.004 ? hp(random()) * click * (1 - x / 0.004) : 0
    return Math.tanh((body + tick) * 1.6) * 0.9
  }, { gain })
}

function clap(t0, gain = 1, wet = 0.35) {
  const bp = bandpass(1.1)
  add(t0, 0.5, x => {
    const bursts = [0, 0.011, 0.022, 0.034].reduce((sum, at) => sum + (x >= at ? Math.exp(-(x - at) * (at === 0.034 ? 22 : 160)) : 0), 0)
    return bp(random(), 1500) * bursts * 1.4
  }, { gain, wet })
}

function hat(t0, gain = 0.2, open = false, pan = 0.25) {
  const hp = highpass(7000)
  add(t0, open ? 0.25 : 0.06, x => hp(random()) * Math.exp(-x * (open ? 14 : 70)), { gain, pan })
}

function boom(t0, gain = 1) {
  let phase = 0
  add(t0, 2.4, x => {
    phase += (38 + 30 * Math.exp(-x * 6)) / SR
    return sine(phase) * Math.exp(-x * 1.6) * Math.min(1, x * 200)
  }, { gain, wet: 0.2 })
}

function stomp(t0, power) {
  kick(t0, 0.95 * Math.min(1.2, power), { top: 190, bottom: 42, decay: 0.42, click: 0.9 })
  clap(t0, 0.55 * power, 0.55)
  boom(t0, 0.5 * power)
  // A short, dark impact layer of filtered noise.
  const lp = lowpass(900)
  add(t0, 0.35, x => lp(random()) * Math.exp(-x * 14) * 2.2, { gain: 0.35 * power, wet: 0.4 })
}

function whoosh(t0, length = 0.5, gain = 0.32) {
  const bp = bandpass(0.9)
  add(t0 - length * 0.7, length, x => {
    const k = x / length
    const fc = 300 + 7000 * Math.sin(Math.PI * k) ** 2
    return bp(random(), fc) * Math.sin(Math.PI * k) ** 1.5 * 1.8
  }, { gain, pan: 0, wet: 0.3 })
}

function key(t0, gain = 0.16) {
  const bp = bandpass(2.2)
  const pitch = 2600 + random() * 900
  let phase = 0
  add(t0, 0.06, x => {
    phase += 140 / SR
    return bp(random(), pitch) * Math.exp(-x * 180) * 1.5 + sine(phase) * Math.exp(-x * 90) * 0.35
  }, { gain, pan: random() * 0.3 })
}

function thock(t0, gain = 0.5) {
  let phase = 0
  const bp = bandpass(1.6)
  add(t0, 0.25, x => {
    phase += (210 - 60 * Math.min(1, x * 20)) / SR
    return sine(phase) * Math.exp(-x * 30) + bp(random(), 1100) * Math.exp(-x * 120) * 1.2
  }, { gain, wet: 0.15 })
}

function tick(t0, gain = 0.14) {
  let a = 0
  let b = 0
  add(t0, 0.12, x => {
    a += 1760 / SR
    b += 2637 / SR
    return (sine(a) * 0.6 + sine(b) * 0.4) * Math.exp(-x * 45)
  }, { gain, pan: 0.2, wet: 0.25 })
}

function snareRoll(t0, t1, gainStart, gainEnd, rateStart, rateEnd) {
  let t = t0
  while (t < t1) {
    const k = (t - t0) / (t1 - t0)
    clap(t, gainStart + (gainEnd - gainStart) * k * k, 0.25)
    t += 1 / (rateStart + (rateEnd - rateStart) * k)
  }
}

function riser(t0, t1) {
  const bp = bandpass(2)
  let phase = 0
  add(t0, t1 - t0, x => {
    const k = x / (t1 - t0)
    phase += (180 + 1400 * k * k) / SR
    return bp(random(), 400 + 9000 * k * k) * k * k * 1.6 + sine(phase) * 0.18 * k ** 3
  }, { gain: 0.42, wet: 0.35 })
}

function shimmer(t0) {
  const partials = ['A5', 'E6', 'A6', 'C#7', 'E7'].map(note)
  const phases = partials.map(() => 0)
  add(t0, 3, x => {
    let sum = 0
    partials.forEach((f, index) => {
      phases[index] += (f * (1 + 0.0007 * Math.sin(x * 5 + index))) / SR
      sum += sine(phases[index]) * Math.exp(-x * (1.2 + index * 0.35)) / (index + 1.5)
    })
    return sum * Math.min(1, x * 80)
  }, { gain: 0.3, wet: 0.7 })
}

/** Soft additive pad: three detuned voices per note, gently filtered. */
function pad(t0, length, names, { gain = 0.1, bright = 1800, attack = 0.6, release = 0.8 } = {}) {
  const voices = []
  for (const name of names) for (const detune of [-0.006, 0, 0.0055]) voices.push({ f: note(name) * (1 + detune), phase: (random() + 1) / 2 })
  add(t0, length + release, x => {
    const env = Math.min(1, x / attack) * (x > length ? Math.max(0, 1 - (x - length) / release) : 1)
    if (env <= 0) return 0
    let sum = 0
    for (const voice of voices) {
      for (let harmonic = 1; harmonic <= 7; harmonic++) {
        const freq = voice.f * harmonic
        const weight = 1 / harmonic / (1 + (freq / bright) ** 4)
        sum += sine(voice.phase * harmonic) * weight
      }
      voice.phase += voice.f / SR
    }
    return (sum / voices.length) * env
  }, { gain, wet: 0.45, pan: 0 })
}

function bass(t0, length, name, gain = 0.32) {
  let phase = 0
  const f = note(name)
  add(t0, length, x => {
    phase += f / SR
    const env = Math.min(1, x * 60) * Math.exp(-x * 2.2)
    return Math.tanh((sine(phase) + 0.25 * sine(phase * 2)) * 1.4) * env
  }, { gain })
}

// --------------------------------------------------------------- arrangement

// Typing in the hook, then the stomps.
for (const at of hookKeys()) key(at)
for (const { t, power } of STOMPS) stomp(t, power)
for (const at of WHOOSHES) whoosh(at)
for (const at of TABS) thock(at)
for (const at of TICKS) tick(at)

// A low drone under the hook, then the chord pad.
pad(0, 2.0, ['A1', 'E2'], { gain: 0.16, bright: 500, attack: 1.2 })
pad(1.9, 4.0, ['A2', 'C4', 'E4'], { gain: 0.09, bright: 1200, attack: 0.15 })
const chords = [
  [5.5, 2.75, ['F2', 'A3', 'C4', 'E4']],
  [8.25, 2.75, ['C3', 'E3', 'G3', 'B3']],
  [11.0, 3.0, ['G2', 'B3', 'D4', 'G4']],
  [14.0, 4.0, ['A2', 'C4', 'E4', 'B4']],
  [18.0, 2.5, ['F2', 'A3', 'C4', 'G4']],
  [20.5, 2.0, ['C3', 'E3', 'G3', 'B3']],
  [22.5, 2.0, ['G2', 'B3', 'D4', 'F#4']],
  [24.5, 2.9, ['F2', 'A3', 'C4', 'E4']],
  [27.5, 2.5, ['A2', 'E3', 'A3', 'C4', 'E4', 'B4']],
]
for (const [at, length, names] of chords) pad(at, length, names, { gain: at >= 27.5 ? 0.14 : 0.1, bright: at >= 20.5 ? 2600 : 1800 })

// Light pulse while the first real scene plays.
for (let t = 5.5; t < 11; t += BEAT) {
  kick(t, 0.42, { decay: 0.22, click: 0.3 })
  hat(t + BEAT / 2, 0.1)
}
// Multimodal: stomps already land on each beat; a roll into the core.
snareRoll(13.0, 13.45, 0.08, 0.3, 12, 24)
shimmer(13.7)
// Dictation: half time and quiet, so the voice is clear.
for (const t of [15.0, 16.0, 17.0]) kick(t, 0.38, { decay: 0.25 })
for (let t = 14.75; t < 17.4; t += BEAT) hat(t, 0.06)
// Privacy: a steady pulse under the checklist.
for (let t = 19.0; t < 20.4; t += BEAT) kick(t, 0.5, { decay: 0.24 })
// Montage: the full groove.
const roots = { 20.5: 'C2', 22.5: 'G1' }
for (let t = 20.5; t < 24.5 - 1e-6; t += BEAT) {
  kick(t, 0.62, { decay: 0.26, click: 0.6 })
  if (Math.round((t - 20.5) / BEAT) % 2 === 1) clap(t, 0.32)
  for (let s = 0; s < 4; s++) hat(t + (s * BEAT) / 4, s === 2 ? 0.12 : 0.05, false, 0.35)
  const root = t < 22.5 ? roots[20.5] : roots[22.5]
  bass(t, BEAT * 0.48, root)
  bass(t + BEAT / 2, BEAT * 0.45, root, 0.22)
}
// The build into the mark.
snareRoll(RISER[0], RISER[1] - 0.08, 0.04, 0.42, 4, 32)
riser(RISER[0], RISER[1] - 0.04)
shimmer(27.5)
bass(27.5, 2.4, 'A1', 0.4)

// --------------------------------------------------------------- the voice

const voiceFile = `${out}/voice.wav`
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', VOICE.file, '-af', `atempo=${VOICE.tempo},silenceremove=start_periods=1:start_threshold=-45dB,highpass=f=90`, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', voiceFile])
const voice = readWav(voiceFile)
let voiceEnd = VOICE.at
{
  const start = Math.round(VOICE.at * SR)
  for (let index = 0; index < voice.length && start + index < N; index++) {
    spoken[start + index] = voice[index] * VOICE.gain
    send[start + index] += voice[index] * 0.08
  }
  let last = voice.length - 1
  while (last > 0 && Math.abs(voice[last]) < 0.01) last--
  voiceEnd = VOICE.at + last / SR
  // The meter follows the real voice, sixty values a second.
  const rate = 60
  const window = SR / rate
  const values = []
  for (let frame = 0; frame * window < last; frame++) {
    let sum = 0
    for (let index = frame * window; index < (frame + 1) * window; index++) sum += (voice[index] ?? 0) ** 2
    values.push(Math.sqrt(sum / window))
  }
  const peak = Math.max(...values)
  writeFileSync(`${out}/voice-envelope.json`, JSON.stringify({ at: VOICE.at, rate, values: values.map(value => Number(Math.min(1, Math.sqrt(value / peak) * 1.1).toFixed(3))) }))
}

function readWav(file) {
  const buffer = readFileSync(file)
  let offset = 12
  while (buffer.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + buffer.readUInt32LE(offset + 4)
  const length = buffer.readUInt32LE(offset + 4) / 2
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index++) samples[index] = buffer.readInt16LE(offset + 8 + index * 2) / 32768
  return samples
}

// --------------------------------------------------------------- mix

// Reverb: a small Freeverb (four combs, two all-passes) per side.
function reverb(input, spread) {
  const combs = [1557, 1617, 1491, 1422].map(length => ({ buffer: new Float32Array(Math.round(length * 1.09) + spread), index: 0, store: 0 }))
  const passes = [556, 441].map(length => ({ buffer: new Float32Array(Math.round(length * 1.09) + spread), index: 0 }))
  const output = new Float32Array(N)
  for (let n = 0; n < N; n++) {
    let sum = 0
    for (const comb of combs) {
      const value = comb.buffer[comb.index]
      comb.store = value * 0.75 + comb.store * 0.25
      comb.buffer[comb.index] = input[n] * 0.5 + comb.store * 0.86
      comb.index = (comb.index + 1) % comb.buffer.length
      sum += value
    }
    for (const pass of passes) {
      const value = pass.buffer[pass.index]
      pass.buffer[pass.index] = sum + value * 0.5
      pass.index = (pass.index + 1) % pass.buffer.length
      sum = value - sum
    }
    output[n] = sum
  }
  return output
}
const wetL = reverb(send, 0)
const wetR = reverb(send, 23)

// Duck everything but the voice while it speaks, and pump the pad on kicks.
kicks.sort((a, b) => a - b)
let kickIndex = 0
let peak = 0
for (let n = 0; n < N; n++) {
  const t = n / SR
  while (kickIndex + 1 < kicks.length && kicks[kickIndex + 1] <= t) kickIndex++
  const since = kicks[kickIndex] <= t ? t - kicks[kickIndex] : 9
  const pump = 1 - 0.35 * Math.exp(-since / 0.11)
  const speaking = Math.min(1, Math.max(0, (t - VOICE.at + 0.15) / 0.15), Math.max(0, (voiceEnd + 0.25 - t) / 0.25))
  const duck = 1 - 0.5 * speaking
  L[n] = (L[n] * (0.65 + 0.35 * pump) + wetL[n] * 0.32) * duck + spoken[n]
  R[n] = (R[n] * (0.65 + 0.35 * pump) + wetR[n] * 0.32) * duck + spoken[n]
  const fadeIn = Math.min(1, t / 0.05)
  const fadeOut = t > DURATION - 0.9 ? Math.max(0, (DURATION - t) / 0.9) : 1
  L[n] = Math.tanh(L[n] * 1.1) * fadeIn * fadeOut
  R[n] = Math.tanh(R[n] * 1.1) * fadeIn * fadeOut
  peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]))
}
const scale = 0.89 / peak
const wav = Buffer.alloc(44 + N * 4)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + N * 4, 4)
wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(2, 22)
wav.writeUInt32LE(SR, 24)
wav.writeUInt32LE(SR * 4, 28)
wav.writeUInt16LE(4, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(N * 4, 40)
for (let n = 0; n < N; n++) {
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[n] * scale)) * 32767), 44 + n * 4)
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[n] * scale)) * 32767), 46 + n * 4)
}
writeFileSync(`${out}/soundtrack.wav`, wav)
console.log(`${out}/soundtrack.wav · voice ${VOICE.at.toFixed(2)}–${voiceEnd.toFixed(2)} s`)
