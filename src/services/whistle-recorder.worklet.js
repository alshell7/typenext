/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Keep audio on the rendering thread until Stop; only the final bounded PCM
// buffer and a few duration messages cross to the page.
class WhistleRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.samples = new Float32Array(480000)
    this.count = 0
    this.ratio = sampleRate / 16000
    this.remaining = this.ratio
    this.area = 0
    this.lastProgress = 0
    this.emitLevel = !!options?.processorOptions?.emitLevel
    this.levelEnergy = 0
    this.levelSamples = 0
    this.finished = false
    this.port.onmessage = event => {
      if (event.data?.type === 'stop') this.complete()
    }
  }

  complete() {
    if (this.finished) return
    this.finished = true
    const samples = this.samples.slice(0, this.count)
    this.samples.fill(0)
    this.samples = null
    this.port.postMessage({ type: 'complete', samples }, [samples.buffer])
  }

  process(inputs) {
    if (this.finished) return false
    const channels = inputs[0]
    if (!channels?.length || !channels[0]?.length) return true
    for (let index = 0; index < channels[0].length; index++) {
      let mono = 0
      for (const channel of channels) mono += channel[index] || 0
      mono = Math.max(-1, Math.min(1, mono / channels.length))
      let available = 1
      // Integrate each source sample across output windows. This preserves
      // duration/phase across arbitrary worklet blocks at 44.1/48 kHz.
      while (available > 0.00000001) {
        const weight = Math.min(available, this.remaining)
        this.area += mono * weight
        this.remaining -= weight
        available -= weight
        if (this.remaining <= 0.00000001) {
          const sample = this.area / this.ratio
          this.samples[this.count++] = sample
          if (this.emitLevel) {
            this.levelEnergy += sample * sample
            this.levelSamples++
          }
          this.area = 0
          this.remaining = this.ratio
          if (this.count >= 480000) {
            this.complete()
            return false
          }
        }
      }
    }
    if (this.count - this.lastProgress >= 3200) {
      this.lastProgress = this.count
      const progress = { type: 'progress', seconds: this.count / 16000 }
      if (this.emitLevel) {
        progress.level = Math.min(
          1,
          Math.sqrt(this.levelEnergy / this.levelSamples)
        )
        this.levelEnergy = 0
        this.levelSamples = 0
      }
      this.port.postMessage(progress)
    }
    return true
  }
}

registerProcessor('typenext-whistle-recorder', WhistleRecorder)
