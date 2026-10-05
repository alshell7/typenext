import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const code = readFileSync(
  resolve(process.cwd(), 'src/services/whistle-recorder.worklet.js'),
  'utf8'
)
interface Output {
  type: 'progress' | 'complete'
  seconds?: number
  level?: number
  samples?: Float32Array
}
interface Recorder {
  process(inputs: Float32Array[][]): boolean
  samples: Float32Array | null
  port: { onmessage(event: { data: { type: string } }): void }
}
function create(sampleRate: number, meter = false) {
  const messages: Output[] = []
  let Constructor!: new (options?: {
    processorOptions: { emitLevel: boolean }
  }) => Recorder
  class Processor {
    port = {
      onmessage: null,
      postMessage: (value: Output) => messages.push(value),
    }
  }
  runInNewContext(code, {
    Float32Array,
    AudioWorkletProcessor: Processor,
    sampleRate,
    registerProcessor: (name: string, value: typeof Constructor) => {
      expect(name).toBe('typenext-whistle-recorder')
      Constructor = value
    },
  })
  return {
    recorder: new Constructor({ processorOptions: { emitLevel: meter } }),
    messages,
  }
}

describe('fixed-size on-device audio worklet', () => {
  it('adds RMS levels only when requested and bounds them to the existing five-hertz progress stream', () => {
    const enabled = create(16_000, true)
    const disabled = create(16_000)
    const input = new Float32Array(128).fill(0.25)
    for (let index = 0; index < 125; index++) {
      enabled.recorder.process([[input]])
      disabled.recorder.process([[input]])
    }
    expect(enabled.messages).toHaveLength(5)
    expect(disabled.messages).toHaveLength(5)
    expect(enabled.messages.every(message => message.level === 0.25)).toBe(true)
    expect(
      disabled.messages.every(message => message.level === undefined)
    ).toBe(true)
    const silent = create(16_000, true)
    silent.recorder.process([[new Float32Array(3_200)]])
    expect(silent.messages[0]?.level).toBe(0)
  })
  it('averages channels, bounds amplitude, leaves inputs unchanged and wipes its capture buffer on stop', () => {
    const { recorder, messages } = create(16_000)
    const retained = recorder.samples!
    const left = new Float32Array([0.8, -0.8, 2, -2])
    const right = new Float32Array([0.2, 0.4, 2, -2])
    expect(recorder.process([[left, right]])).toBe(true)
    expect(messages).toHaveLength(0)
    recorder.port.onmessage({ data: { type: 'stop' } })
    expect(Array.from(messages[0]!.samples!)).toEqual([
      0.5,
      expect.closeTo(-0.2),
      1,
      -1,
    ])
    expect(left[0]).toBeCloseTo(0.8)
    expect(retained.every(value => value === 0)).toBe(true)
    expect(recorder.samples).toBeNull()
    expect(recorder.process([[left]])).toBe(false)
    recorder.port.onmessage({ data: { type: 'stop' } })
    expect(messages).toHaveLength(1)
  })

  it.each([44_100, 48_000])(
    'resamples %s Hz with identical phase across arbitrary block boundaries',
    rate => {
      const block = create(rate)
      const whole = create(rate)
      const input = Float32Array.from(
        { length: rate },
        (_, index) => Math.sin(index / 19) / 2
      )
      for (let offset = 0; offset < input.length; offset += 128)
        block.recorder.process([[input.subarray(offset, offset + 128)]])
      whole.recorder.process([[input]])
      block.recorder.port.onmessage({ data: { type: 'stop' } })
      whole.recorder.port.onmessage({ data: { type: 'stop' } })
      const fragmented = block.messages.find(
        message => message.type === 'complete'
      )!.samples!
      const contiguous = whole.messages.find(
        message => message.type === 'complete'
      )!.samples!
      expect(fragmented.length).toBe(16_000)
      expect(fragmented).toEqual(contiguous)
      expect(
        block.messages.filter(message => message.type === 'progress').length
      ).toBeLessThanOrEqual(5)
    }
  )

  it('self-stops at thirty seconds even if the main-page timer stalls', () => {
    const { recorder, messages } = create(16_000)
    const input = new Float32Array(480_001).fill(0.25)
    expect(recorder.process([[input]])).toBe(false)
    const complete = messages.find(message => message.type === 'complete')!
    expect(complete.samples?.length).toBe(480_000)
    expect(complete.samples?.byteLength).toBe(1_920_000)
    expect(complete.samples?.at(-1)).toBe(0.25)
    expect(recorder.samples).toBeNull()
    expect(recorder.process([[input]])).toBe(false)
    recorder.port.onmessage({ data: { type: 'stop' } })
    expect(
      messages.filter(message => message.type === 'complete')
    ).toHaveLength(1)
  })
})
