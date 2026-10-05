import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Development-only synthetic speech: never opens a microphone or plays audio.
if (process.platform !== 'win32')
  throw new Error(
    'This fixture uses Windows System.Speech. Provide a 16 kHz mono PCM16 WAV on other platforms.'
  )
const folder = fileURLToPath(new URL('../artifacts/whistle/', import.meta.url))
await mkdir(folder, { recursive: true })
const wavPath = path.join(folder, 'synthetic.wav')
const phrase = 'The patient writer leaves room for another thought.'
const powershell = path.join(
  process.env.SystemRoot || 'C:/Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
)
await promisify(execFile)(
  powershell,
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voice = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $voice.SetOutputToWaveFile($env:TYPENEXT_WHISTLE_FIXTURE, $format)
  $voice.Speak('${phrase}')
} finally { $voice.Dispose() }
`,
  ],
  {
    windowsHide: true,
    env: { ...process.env, TYPENEXT_WHISTLE_FIXTURE: wavPath },
  }
)
const wav = await readFile(wavPath)
if (
  wav.toString('ascii', 0, 4) !== 'RIFF' ||
  wav.toString('ascii', 8, 12) !== 'WAVE'
)
  throw new Error('System.Speech returned an invalid WAV.')
let format, data
for (let offset = 12; offset + 8 <= wav.length;) {
  const name = wav.toString('ascii', offset, offset + 4)
  const size = wav.readUInt32LE(offset + 4)
  const start = offset + 8
  if (start + size > wav.length) throw new Error('Truncated WAV fixture.')
  if (name === 'fmt ' && size >= 16)
    format = {
      encoding: wav.readUInt16LE(start),
      channels: wav.readUInt16LE(start + 2),
      rate: wav.readUInt32LE(start + 4),
      bits: wav.readUInt16LE(start + 14),
    }
  if (name === 'data') data = wav.subarray(start, start + size)
  offset = start + size + (size % 2)
}
if (
  format?.encoding !== 1 ||
  format.channels !== 1 ||
  format.rate !== 16_000 ||
  format.bits !== 16 ||
  !data ||
  data.length === 0 ||
  data.length % 2 ||
  data.length > 960_000
)
  throw new Error(
    'Expected a clip of at most 30 seconds in 16 kHz mono PCM16 format.'
  )
const pcm = new Float32Array(data.length / 2)
for (let index = 0; index < pcm.length; index++)
  pcm[index] = data.readInt16LE(index * 2) / 32768
const pcmPath = path.join(folder, 'synthetic.f32')
await writeFile(pcmPath, new Uint8Array(pcm.buffer))
const report = {
  fixture: 'Offline Windows System.Speech synthetic voice; no human recording',
  phrase,
  wav: wavPath,
  pcm: pcmPath,
  sampleRate: 16_000,
  seconds: pcm.length / 16_000,
}
await writeFile(
  path.join(folder, 'synthetic.json'),
  `${JSON.stringify(report, null, 2)}\n`
)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
