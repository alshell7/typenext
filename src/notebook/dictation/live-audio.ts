import { readFileSync } from 'node:fs'
import { vi } from 'vitest'

/**
 * Helpers for the opt-in tests against a real Fluid Speech Mini server
 * (`TYPENEXT_SPEECH_URL`). Test-only: never imported by the app.
 */

/** Decode a PCM16 WAV file to float samples. */
export function readWav(file: string): Float32Array {
  const bytes = readFileSync(file)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 12
  while (
    at < bytes.length - 8 &&
    String.fromCharCode(...bytes.subarray(at, at + 4)) !== 'data'
  )
    at += 8 + view.getUint32(at + 4, true)
  const size = view.getUint32(at + 4, true)
  const pcm = new Float32Array(size / 2)
  for (let index = 0; index < pcm.length; index++)
    pcm[index] = view.getInt16(at + 8 + index * 2, true) / 0x8000
  return pcm
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  const buffer = await new Promise<ArrayBuffer>(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
  return new Uint8Array(buffer)
}

/**
 * jsdom's FormData does not serialize through Node's fetch, so encode the
 * client's form by hand. Everything else is the real client.
 */
export function useNodeMultipart() {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const form = init.body as FormData
    const boundary = `----typenext${Date.now().toString(16)}`
    const parts: Uint8Array[] = []
    const text = (value: string) => new Uint8Array(Buffer.from(value))
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        parts.push(
          text(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
          )
        )
        continue
      }
      parts.push(
        text(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`
        ),
        await bytesOf(value),
        text('\r\n')
      )
    }
    parts.push(text(`--${boundary}--\r\n`))
    return realFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts),
      signal: init.signal,
    })
  })
}
