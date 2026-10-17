// The film's score and sound design, synthesized from the shared timeline:
// no samples, no licences. 100 BPM in A minor. Writes
// artifacts/promo/soundtrack.wav (mastered to -14 LUFS, -1 dBTP) and the
// voice envelope that drives the on-screen meter.
//   node scripts/promo/soundtrack.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { BEAT, CHECKS, DURATION, LOGO, MONTAGE, RISERS, SPARKLES, STOMPS, TABS, VOICE, WHOOSHES, b, hookKeys } from './timeline.mjs'

const SR = 48_000
const N = Math.round((DURATION + 0.2) * SR)
const out = 'artifacts/promo'
mkdirSync(out, { recursive: true })

// --------------------------------------------------------------- buses

const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) })
const drums = bus()
const music = bus()
const sfx = bus()
const sends = bus() // reverb input
const voiceBus = bus()
const kicks = []

let seed = 0x2f6b9a1d
const noise = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return ((seed >>> 0) / 4294967296) * 2 - 1
}
const TAU = Math.PI * 2
const midi = n => 440 * 2 ** ((n - 69) / 12)
const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }
const hz = name => {
  const [, letter, octave] = /^([A-G]#?)(-?\d)$/u.exec(name)
  return midi(NOTE[letter] + (Number(octave) + 1) * 12)
}

/** Write a mono voice into a bus, panned, with an optional reverb send. */
function play(target, t0, seconds, fn, { gain = 1, pan = 0, wet = 0 } = {}) {
  const start = Math.max(0, Math.round(t0 * SR))
  const end = Math.min(N, start + Math.round(seconds * SR))
  const left = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2 * gain
  const right = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2 * gain
  for (let i = start; i < end; i++) {
    const v = fn((i - start) / SR)
    target.L[i] += v * left
    target.R[i] += v * right
    if (wet) {
      sends.L[i] += v * left * wet
      sends.R[i] += v * right * wet
    }
  }
}

/** Zero-delay-feedback state-variable filter (Simper). */
function svf() {
  let ic1 = 0, ic2 = 0
  return (x, cutoff, q = 0.7) => {
    const g = Math.tan((Math.PI * Math.min(cutoff, SR * 0.45)) / SR)
    const k = 1 / q
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2
    const v3 = x - ic2
    const v1 = a1 * ic1 + a2 * v3
    const v2 = ic2 + a2 * ic1 + a3 * v3
    ic1 = 2 * v1 - ic1
    ic2 = 2 * v2 - ic2
    return { low: v2, band: v1, high: x - k * v1 - v2 }
  }
}
const env = (x, attack, decay) => (x < attack ? x / attack : Math.exp(-(x - attack) / decay))
const sat = (x, drive = 1) => Math.tanh(x * drive) / Math.tanh(drive)
/** Band-limited sawtooth (PolyBLEP). */
function saw() {
  let phase = (noise() + 1) / 2
  return f => {
    const dt = f / SR
    phase += dt
    if (phase >= 1) phase -= 1
    let v = 2 * phase - 1
    if (phase < dt) {
      const x = phase / dt
      v -= x + x - x * x - 1
    } else if (phase > 1 - dt) {
      const x = (phase - 1) / dt
      v -= x * x + x + x + 1
    }
    return v
  }
}

// --------------------------------------------------------------- drums

function kick(t0, gain = 1, { punch = 1, decay = 0.32, top = 155 } = {}) {
  kicks.push(t0)
  let phase = 0
  const hp = svf()
  play(drums, t0, decay * 5, x => {
    const f = 46 + (top - 46) * Math.exp(-x * 30) + 30 * Math.exp(-x * 160)
    phase += f / SR
    const body = Math.sin(TAU * phase) * env(x, 0.002, decay)
    const click = x < 0.006 ? hp(noise(), 3000).high * (1 - x / 0.006) * 0.6 * punch : 0
    return sat(body * 1.2 + click, 1.6) * 0.9
  }, { gain })
}

function clap(t0, gain = 0.5, { wet = 0.3, tone = 1300 } = {}) {
  const bp = svf()
  const bursts = [0, 0.009, 0.019, 0.03]
  play(drums, t0, 0.6, x => {
    let e = 0
    for (const at of bursts) if (x >= at) e += at === 0.03 ? Math.exp(-(x - at) * 17) : Math.exp(-(x - at) * 190)
    return bp(noise(), tone, 1.3).band * e * 1.6
  }, { gain, wet, pan: 0.04 })
}

/** 808 hat: six detuned square waves, band-passed high. */
function hat(t0, gain = 0.12, { open = false, pan = 0.22 } = {}) {
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * 1.62)
  const phases = freqs.map(() => (noise() + 1) / 2)
  const bp = svf(), hp = svf()
  play(drums, t0, open ? 0.45 : 0.09, x => {
    let v = 0
    freqs.forEach((f, i) => {
      phases[i] += f / SR
      v += phases[i] % 1 < 0.5 ? 1 : -1
    })
    const y = hp(bp(v / 6, 10_000, 1.2).band, 7200).high
    return y * Math.exp(-x * (open ? 8 : 55)) * 1.8
  }, { gain, pan })
}

function shaker(t0, gain = 0.05, pan = -0.25) {
  const bp = svf()
  play(drums, t0, 0.08, x => bp(noise(), 7800, 1.6).band * env(x, 0.008, 0.025) * 2, { gain, pan })
}

// --------------------------------------------------------------- music

/** DX-style FM electric piano. */
function ep(t0, note, seconds, gain = 0.12, pan = 0) {
  const f = hz(note)
  let pc = 0, pm = 0, pt = 0
  play(music, t0, seconds + 1.2, x => {
    pm += f / SR
    pt += (f * 14) / SR
    const index = 1.6 * Math.exp(-x * 2.2) + 0.35
    const tine = 0.9 * Math.exp(-x * 30)
    pc += f / SR
    const v = Math.sin(TAU * pc + index * Math.sin(TAU * pm) + tine * Math.sin(TAU * pt))
    const release = x > seconds ? Math.exp(-(x - seconds) * 5) : 1
    return v * env(x, 0.004, 1.6) * release
  }, { gain, pan, wet: 0.28 })
}

/** Karplus-Strong plucked string. */
function pluck(t0, note, gain = 0.1, pan = 0, bright = 0.5) {
  const f = hz(note)
  const length = Math.max(2, Math.round(SR / f))
  const line = new Float32Array(length)
  for (let i = 0; i < length; i++) line[i] = noise()
  let index = 0, last = 0
  const lp = svf()
  play(music, t0, 1.4, x => {
    const current = line[index]
    const next = 0.5 * (current + last) * (0.993 - (1 - bright) * 0.01)
    last = current
    line[index] = next
    index = (index + 1) % length
    return lp(current, 1800 + 5000 * bright * Math.exp(-x * 3), 0.6).low * env(x, 0.002, 0.6)
  }, { gain, pan, wet: 0.22 })
}

/** Supersaw pad: seven detuned saws per note, a slow filter sweep. */
function pad(t0, notes, seconds, { gain = 0.07, cutoff = 1400, attack = 0.8, release = 1.2, sweep = 0.5 } = {}) {
  const voices = notes.flatMap(note => [-0.11, -0.06, -0.025, 0, 0.025, 0.06, 0.11].map((detune, i) => ({ f: hz(note) * 2 ** (detune / 12), osc: saw(), side: i % 2 ? 1 : -1 })))
  const fl = svf(), fr = svf()
  const start = Math.round(t0 * SR)
  const total = seconds + release
  for (let n = 0; n < Math.round(total * SR); n++) {
    const i = start + n
    if (i >= N) break
    const x = n / SR
    const e = Math.min(1, x / attack) * (x > seconds ? Math.max(0, 1 - (x - seconds) / release) : 1)
    if (e <= 0) continue
    let l = 0, r = 0
    for (const voice of voices) {
      const v = voice.osc(voice.f)
      if (voice.side < 0) l += v
      else r += v
    }
    const c = cutoff * (1 + sweep * Math.sin((TAU * x) / 9))
    const yl = fl(l / voices.length, c, 0.9).low * e * gain * 2
    const yr = fr(r / voices.length, c, 0.9).low * e * gain * 2
    music.L[i] += yl
    music.R[i] += yr
    sends.L[i] += yl * 0.35
    sends.R[i] += yr * 0.35
  }
}

function bass(t0, note, seconds, gain = 0.28) {
  const f = hz(note)
  let phase = 0
  const lp = svf()
  const osc = saw()
  play(music, t0, seconds + 0.05, x => {
    phase += f / SR
    const sub = Math.sin(TAU * phase)
    const grit = lp(osc(f), 420 + 900 * Math.exp(-x * 12), 0.9).low
    return sat(sub * 0.9 + grit * 0.35, 1.3) * env(x, 0.004, seconds * 0.9) * (x > seconds ? Math.exp(-(x - seconds) * 40) : 1)
  }, { gain })
}

/** Bell for sparkles, ticks and the end shimmer. */
function bell(t0, note, gain = 0.08, decay = 1.6, pan = 0.1) {
  const f = typeof note === 'number' ? note : hz(note)
  let pc = 0, pm = 0
  play(sfx, t0, decay * 4, x => {
    pm += (f * 3.5) / SR
    pc += f / SR
    return Math.sin(TAU * pc + 2.2 * Math.exp(-x * 3) * Math.sin(TAU * pm)) * env(x, 0.002, decay)
  }, { gain, pan, wet: 0.5 })
}

// --------------------------------------------------------------- SFX

function impact(t0, power = 1) {
  kick(t0, 0.8 * Math.min(1.25, power), { punch: 1.3, decay: 0.38, top: 175 })
  clap(t0, 0.32 * power, { wet: 0.55, tone: 1100 })
  let phase = 0
  play(drums, t0, 2.4, x => {
    phase += (44 + 30 * Math.exp(-x * 3.2)) / SR
    return Math.sin(TAU * phase) * env(x, 0.004, 0.7)
  }, { gain: 0.3 * power, wet: 0.15 })
  const lp = svf()
  play(sfx, t0, 0.9, x => lp(noise(), 2400 * Math.exp(-x * 4) + 200, 0.8).low * env(x, 0.002, 0.22) * 2.4, { gain: 0.32 * power, wet: 0.6 })
}

function whoosh(t0, length = 0.55, gain = 0.3, fromPan = -0.8) {
  const bp = svf()
  const start = t0 - length * 0.72
  play(sfx, start, length, x => {
    const k = x / length
    return bp(noise(), 260 + 7200 * Math.sin(Math.PI * k) ** 2, 1.1).band * Math.sin(Math.PI * k) ** 1.6 * 2.2
  }, { gain: gain * 0.7, pan: fromPan, wet: 0.35 })
  play(sfx, start + 0.01, length, x => {
    const k = x / length
    return bp(noise(), 300 + 6800 * Math.sin(Math.PI * k) ** 2, 1.1).band * Math.sin(Math.PI * k) ** 1.6 * 2.2
  }, { gain: gain * 0.7, pan: -fromPan, wet: 0.35 })
}

function riser(t0, t1, gain = 0.4) {
  const length = t1 - t0
  const bp = svf(), hp = svf()
  const osc = saw()
  play(sfx, t0, length, x => {
    const k = x / length
    const air = bp(noise(), 300 + 9000 * k * k, 1 + 3 * k).band * k ** 2 * 2
    const tone = hp(osc(110 * 2 ** (k * 1.5)), 400).high * 0.12 * k ** 3
    return air + tone
  }, { gain, wet: 0.4 })
  // A reverse cymbal: bright noise swelling into the hit.
  const bright = svf()
  play(sfx, t1 - 1.1, 1.1, x => bright(noise(), 6000, 0.7).high * (x / 1.1) ** 3.5 * 1.6, { gain: gain * 0.8, pan: 0.15, wet: 0.3 })
}

function crash(t0, gain = 0.3) {
  const hp = svf()
  play(sfx, t0, 3.5, x => hp(noise(), 5200, 0.6).high * env(x, 0.003, 0.9) * 1.4, { gain, pan: -0.1, wet: 0.6 })
}

function key(t0, gain = 0.2) {
  const body = svf(), click = svf()
  const pitch = 1900 + noise() * 500
  let phase = 0
  play(sfx, t0, 0.07, x => {
    phase += 125 / SR
    return click(noise(), 6000).high * Math.exp(-x * 900) * 0.6 + body(noise(), pitch, 7).band * Math.exp(-x * 160) * 1.6 + Math.sin(TAU * phase) * Math.exp(-x * 120) * 0.35
  }, { gain, pan: noise() * 0.25, wet: 0.05 })
}

function thock(t0, gain = 0.5) {
  const body = svf()
  let phase = 0
  play(sfx, t0, 0.3, x => {
    phase += (190 - 60 * Math.min(1, x * 25)) / SR
    return Math.sin(TAU * phase) * Math.exp(-x * 26) + body(noise(), 900, 2).band * Math.exp(-x * 110) * 1.4
  }, { gain, wet: 0.12 })
}

function lockClick(t0) {
  for (const [dt, f] of [[0, 3400], [0.07, 2600]]) {
    const bp = svf()
    let phase = 0
    play(sfx, t0 + dt, 0.12, x => {
      phase += 1800 / SR
      return bp(noise(), f, 6).band * Math.exp(-x * 140) * 1.5 + Math.sin(TAU * phase) * Math.exp(-x * 70) * 0.25
    }, { gain: 0.32, wet: 0.2 })
  }
}

// --------------------------------------------------------------- arrangement

const BAR = BEAT * 4
const CHORDS = {
  Am: { root: 'A1', pad: ['A3', 'C4', 'E4', 'B4'], arp: ['A4', 'C5', 'E5', 'B4', 'E5', 'C5'] },
  F: { root: 'F1', pad: ['F3', 'A3', 'C4', 'E4'], arp: ['F4', 'A4', 'C5', 'E5', 'C5', 'A4'] },
  C: { root: 'C2', pad: ['C3', 'E3', 'G3', 'D4'], arp: ['C5', 'E5', 'G4', 'D5', 'G4', 'E5'] },
  G: { root: 'G1', pad: ['G3', 'B3', 'D4', 'A4'], arp: ['G4', 'B4', 'D5', 'A4', 'D5', 'B4'] },
}
const progression = ['Am', 'F', 'C', 'G']
const chordAt = t => CHORDS[progression[Math.floor(t / BAR) % 4]]

// Intro: a quiet pad, a few EP notes, the typing.
pad(0, CHORDS.Am.pad, 4.6, { gain: 0.08, cutoff: 1200, attack: 1.6 })
for (const [t, note] of [[1.2, 'E5'], [1.8, 'C5'], [2.4, 'B4'], [3.0, 'A4']]) ep(t, note, 0.5, 0.1, 0.2)
for (const t of hookKeys()) key(t)
riser(2.6, b(6), 0.22)

// Bars from the first stomp: pads and EP chords follow the progression.
for (let bar = 2; bar * BAR < 41.4; bar++) {
  const t = bar * BAR
  const chord = CHORDS[progression[bar % 4]]
  const breakdown = t >= 22.2 && t < 28.2
  pad(t, chord.pad, BAR, { gain: breakdown ? 0.11 : 0.085, cutoff: t >= 31.8 ? 3200 : 2000, attack: 0.4, release: 0.8 })
  if (t >= 4.8) for (const beat of [0, 1.5, 2.5]) ep(t + beat * BEAT, chord.pad[(beat * 2) % 4].replace(/\d/u, d => String(Number(d) + 1)), BEAT * 0.9, 0.09, -0.2)
}

// The groove: kick, clap, hats, bass and a plucked arpeggio, by section.
for (let beat = 8; b(beat) < 41.4; beat++) {
  const t = b(beat)
  const inBar = beat % 4
  const chord = chordAt(t)
  const media = t >= 17.4 && t < 21.0
  const breakdown = t >= 22.2 && t < 28.2
  const drop = t >= 31.8 && t < 38.4
  const sparse = t < 9.0
  if (media || (t >= 20.1 && t < 21.6)) continue
  if (!breakdown) {
    if (inBar === 0 || inBar === 2 || (drop && inBar === 3)) kick(t, sparse ? 0.38 : drop ? 0.6 : 0.5)
    if (drop && inBar === 1) kick(t + BEAT * 0.5, 0.45)
    if (!sparse && (inBar === 1 || inBar === 3)) clap(t, drop ? 0.42 : 0.32)
    if (sparse && (inBar === 1 || inBar === 3)) shaker(t, 0.08)
  } else if (inBar === 0) kick(t, 0.32, { decay: 0.4 })
  // Hats: eighths, sixteenths in the drop; open hat on the off-beat.
  const steps = drop ? 4 : sparse || breakdown ? 1 : 2
  for (let s = 0; s < steps; s++) {
    const ht = t + (s * BEAT) / steps
    const accent = s % 2 === 1 || steps === 1
    hat(ht, (accent ? 0.14 : 0.08) * (breakdown ? 0.5 : 1))
  }
  if (drop && inBar % 2 === 1) hat(t + BEAT * 0.5, 0.07, { open: true, pan: -0.25 })
  // Bass in eighths, with an octave lift in the drop.
  if (!sparse && !breakdown) {
    bass(t, chord.root, BEAT * 0.45, 0.19)
    bass(t + BEAT / 2, drop && inBar % 2 ? chord.root.replace(/\d/u, d => String(Number(d) + 1)) : chord.root, BEAT * 0.4, 0.13)
  } else if (breakdown && inBar === 0) bass(t, chord.root, BAR * 0.9, 0.15)
  // Arpeggio in sixteenths from the first real scene on.
  if (t >= 9.0 && !breakdown) {
    for (let s = 0; s < 4; s++) {
      const step = (beat * 4 + s) % chord.arp.length
      pluck(t + (s * BEAT) / 4, chord.arp[step], drop ? 0.13 : 0.11, s % 2 ? 0.35 : -0.35, drop ? 0.75 : 0.55)
    }
  }
}

// Impacts on every stomp; the core and the mark get the biggest.
for (const { t, power } of STOMPS) impact(t, power)
crash(b(35), 0.22)
bell(b(35), 'E6', 0.06, 2.2)
bell(b(35) + 0.02, 'B6', 0.04, 2)
for (const [t0, t1] of RISERS) riser(t0, t1, 0.38)
for (const t of WHOOSHES) whoosh(t, 0.6, 0.26, Math.round(t * 10) % 2 ? -0.8 : 0.8)
for (const t of TABS) thock(t, 0.5)
for (const t of SPARKLES) {
  bell(t + 0.03, 'E6', 0.05, 0.9, 0.25)
  bell(t + 0.09, 'B6', 0.035, 0.8, -0.2)
}
for (const t of CHECKS) bell(t + 0.1, 'A6', 0.045, 0.5, 0.15)
bell(b(52), 'E6', 0.035, 0.7)
for (const cut of MONTAGE.slice(1)) whoosh(cut.at + 0.05, 0.28, 0.14, cut.at % 1.2 < 0.6 ? -0.6 : 0.6)
lockClick(28.1 + 34 / 60)

// The mark: silence just before, then the hit, a crash and the final chord.
crash(LOGO.slam, 0.3)
pad(LOGO.slam, ['A2', 'E3', 'A3', 'C4', 'E4', 'B4'], 2.4, { gain: 0.12, cutoff: 2800, attack: 0.05, release: 1.2, sweep: 0.2 })
bass(LOGO.slam, 'A1', 2.6, 0.22)
for (const [dt, note] of [[0, 'A5'], [0.3, 'E6'], [0.6, 'B5'], [1.2, 'C6'], [1.8, 'E6']]) bell(LOGO.slam + dt, note, 0.045, 1.8, dt * 0.2 - 0.2)

// --------------------------------------------------------------- the voice

const voiceFile = `${out}/voice.wav`
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', VOICE.file, '-af', `atempo=${VOICE.tempo},silenceremove=start_periods=1:start_threshold=-45dB,highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,equalizer=f=3000:t=q:w=1:g=2`, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', voiceFile])
const voice = readWav(voiceFile)
let voiceEnd = VOICE.at
{
  const start = Math.round(VOICE.at * SR)
  for (let i = 0; i < voice.length && start + i < N; i++) {
    voiceBus.L[start + i] = voice[i] * VOICE.gain
    voiceBus.R[start + i] = voice[i] * VOICE.gain
    sends.L[start + i] += voice[i] * 0.05
    sends.R[start + i] += voice[i] * 0.05
  }
  let last = voice.length - 1
  while (last > 0 && Math.abs(voice[last]) < 0.01) last--
  voiceEnd = VOICE.at + last / SR
  const rate = 60
  const window = SR / rate
  const values = []
  for (let frame = 0; frame * window < last; frame++) {
    let sum = 0
    for (let i = frame * window; i < (frame + 1) * window; i++) sum += (voice[i] ?? 0) ** 2
    values.push(Math.sqrt(sum / window))
  }
  const peak = Math.max(...values)
  writeFileSync(`${out}/voice-envelope.json`, JSON.stringify({ at: VOICE.at, rate, values: values.map(v => Number(Math.min(1, Math.sqrt(v / peak) * 1.1).toFixed(3))) }))
}

function readWav(file) {
  const buffer = readFileSync(file)
  let offset = 12
  while (buffer.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + buffer.readUInt32LE(offset + 4)
  const length = buffer.readUInt32LE(offset + 4) / 2
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i++) samples[i] = buffer.readInt16LE(offset + 8 + i * 2) / 32768
  return samples
}

// --------------------------------------------------------------- reverb

/** In-place iterative radix-2 FFT on separate real/imaginary arrays. */
function fft(re, im, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(angle), wi = Math.sin(angle)
    for (let start = 0; start < n; start += size) {
      let cr = 1, ci = 0
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b2 = a + size / 2
        const tr = re[b2] * cr - im[b2] * ci
        const ti = re[b2] * ci + im[b2] * cr
        re[b2] = re[a] - tr
        im[b2] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] /= n), (im[i] /= n)
}

/** A synthetic hall: early reflections, then a darkening exponential tail. */
function impulse(side) {
  const length = Math.round(2.6 * SR)
  const ir = new Float32Array(length)
  const pre = Math.round(0.018 * SR)
  const lp = svf()
  for (let i = pre; i < length; i++) {
    const x = (i - pre) / SR
    const decay = Math.exp((-6.9 * x) / 2.3) // RT60 2.3 s
    ir[i] = lp(noise(), 9000 * Math.exp(-x * 1.6) + 600, 0.6).low * decay
  }
  for (const [ms, g] of [[11, 0.5], [19, 0.35], [27, 0.3], [37, 0.22], [53, 0.16]]) ir[Math.round(((ms + side * 3) / 1000) * SR)] += g * (side ? -1 : 1)
  return ir
}

function convolve(signal, ir) {
  let size = 1
  while (size < signal.length + ir.length) size <<= 1
  const ar = new Float64Array(size), ai = new Float64Array(size)
  const br = new Float64Array(size), bi = new Float64Array(size)
  ar.set(signal)
  br.set(ir)
  fft(ar, ai)
  fft(br, bi)
  for (let i = 0; i < size; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i]
    ai[i] = ar[i] * bi[i] + ai[i] * br[i]
    ar[i] = r
  }
  fft(ar, ai, true)
  return ar.subarray(0, signal.length)
}

const irL = impulse(0), irR = impulse(1)
let irEnergy = 0
for (const v of irL) irEnergy += v * v
const irScale = 1 / Math.sqrt(irEnergy)
const wetL = convolve(sends.L, irL)
const wetR = convolve(sends.R, irR)

// --------------------------------------------------------------- mix

kicks.sort((a, z) => a - z)
const L = new Float32Array(N), R = new Float32Array(N)
const hpL = svf(), hpR = svf()
let k = 0, level = 0
const attack = Math.exp(-1 / (0.012 * SR)), release = Math.exp(-1 / (0.16 * SR))
for (let i = 0; i < N; i++) {
  const t = i / SR
  while (k + 1 < kicks.length && kicks[k + 1] <= t) k++
  const since = kicks[k] <= t ? t - kicks[k] : 9
  const pump = 1 - 0.38 * Math.exp(-since / 0.12)
  const speaking = Math.min(1, Math.max(0, (t - VOICE.at + 0.2) / 0.2), Math.max(0, (voiceEnd + 0.35 - t) / 0.35))
  const duck = 1 - 0.55 * speaking
  let l0 = (drums.L[i] * 0.8 + music.L[i] * pump * 1.25 + sfx.L[i] * 0.85 + wetL[i] * irScale * 0.32) * duck + voiceBus.L[i]
  let r0 = (drums.R[i] * 0.8 + music.R[i] * pump * 1.25 + sfx.R[i] * 0.85 + wetR[i] * irScale * 0.32) * duck + voiceBus.R[i]
  // Clean the sub-rumble below 30 Hz.
  let l = hpL(l0, 30, 0.7).high
  let r = hpR(r0, 30, 0.7).high
  // Glue compressor: stereo-linked, gentle.
  const peak = Math.max(Math.abs(l), Math.abs(r))
  level = peak > level ? attack * level + (1 - attack) * peak : release * level + (1 - release) * peak
  const over = Math.max(0, 20 * Math.log10(level + 1e-9) + 10)
  const gain = 10 ** ((-over * (1 - 1 / 2.4)) / 20)
  l *= gain
  r *= gain
  const fadeIn = Math.min(1, t / 0.04)
  const fadeOut = t > DURATION - 1.4 ? Math.max(0, (DURATION - t) / 1.4) ** 1.5 : 1
  L[i] = sat(l, 1.15) * fadeIn * fadeOut
  R[i] = sat(r, 1.15) * fadeIn * fadeOut
}

function writeWav(path, left, right) {
  let peak = 0
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  const scale = 0.89 / peak
  const frames = Math.round(DURATION * SR)
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + frames * 4, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(SR, 24)
  wav.writeUInt32LE(SR * 4, 28)
  wav.writeUInt16LE(4, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i++) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] * scale)) * 32767), 44 + i * 4)
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] * scale)) * 32767), 46 + i * 4)
  }
  writeFileSync(path, wav)
}

// Master: two-pass loudness normalisation to -14 LUFS, -1 dBTP.
const mixPath = `${out}/soundtrack-mix.wav`
writeWav(mixPath, L, R)
const stats = JSON.parse(/\{[\s\S]*\}/u.exec(execFileSync('sh', ['-c', `ffmpeg -hide_banner -i ${mixPath} -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null - 2>&1`], { encoding: 'utf8' }))[0])
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-i', mixPath,
  '-af', `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true,aresample=${SR}`,
  '-c:a', 'pcm_s24le', `${out}/soundtrack.tmp.wav`,
])
renameSync(`${out}/soundtrack.tmp.wav`, `${out}/soundtrack.wav`)
console.log(`${out}/soundtrack.wav · voice ${VOICE.at.toFixed(2)}–${voiceEnd.toFixed(2)} s · mix measured ${stats.input_i} LUFS`)
