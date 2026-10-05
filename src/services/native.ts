import { invoke } from '@tauri-apps/api/core'

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  /** Website imports must never fetch private or local network addresses. */
  publicOnly?: boolean
}

interface NativeResponse {
  status: number
  body: string
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const sessionSecrets = new Map<string, string>()
const secretWrites = new Map<string, Promise<void>>()

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function abortError(): DOMException {
  return new DOMException('The request was cancelled.', 'AbortError')
}

function validateUrl(value: string): string {
  if (value.length > 4096) throw new Error('The endpoint URL is too long.')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Use a valid HTTP or HTTPS endpoint URL.')
  }
  if (url.username || url.password) {
    throw new Error(
      'Keep credentials in the API key field rather than in the URL.'
    )
  }
  const host = url.hostname.toLowerCase()
  const loopback =
    host === 'localhost' ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'Use HTTPS for remote endpoints or HTTP for a localhost model server.'
    )
  }
  return url.toString()
}

function validateSecretId(id: string): void {
  if (!/^[a-zA-Z0-9:_.-]{1,128}$/.test(id)) {
    throw new Error('The credential identifier is invalid.')
  }
}

export async function getSecret(id: string): Promise<string> {
  validateSecretId(id)
  await secretWrites.get(id)?.catch(() => {})
  if (sessionSecrets.has(id)) return sessionSecrets.get(id) ?? ''
  if (!isDesktop()) return ''
  try {
    const value = await invoke<string>('get_secret', { id })
    if (value) sessionSecrets.set(id, value)
    return value
  } catch (error) {
    // Local servers normally need no key. Optional vault availability must
    // not prevent an unkeyed offline model from working.
    if (id === 'provider:local') return ''
    throw asError(error)
  }
}

/** Keys stay in this session unless the writer opts into their OS vault. */
export async function setSecret(
  id: string,
  value: string,
  remember = false
): Promise<void> {
  validateSecretId(id)
  if (
    new TextEncoder().encode(value).byteLength > 4096 ||
    value.includes('\0')
  ) {
    throw new Error(
      'API keys must be no larger than 4096 bytes and contain no null characters.'
    )
  }
  const previous = secretWrites.get(id) ?? Promise.resolve()
  const pending = previous
    .catch(() => {})
    .then(async () => {
      sessionSecrets.set(id, value)
      if (isDesktop()) {
        try {
          // Clearing a key or turning off remembering removes its old vault copy.
          await invoke('set_secret', {
            id,
            value: remember && value ? value : null,
          })
        } catch (error) {
          const detail = asError(error).message
          if (remember && value) {
            throw new Error(
              `This key is ready for this session, but could not be saved in the credential vault. ${detail}`
            )
          }
          throw new Error(
            `${value ? 'This key is ready' : 'The key is cleared'} for this session. Removal of any previous vault copy could not be confirmed. ${detail}`
          )
        }
      }
    })
  secretWrites.set(id, pending)
  try {
    await pending
  } finally {
    if (secretWrites.get(id) === pending) secretWrites.delete(id)
  }
}

function responseError(status: number, body: string): Error {
  let detail = ''
  try {
    const value = JSON.parse(body) as {
      error?: string | { message?: string }
      message?: string
      detail?: string
    }
    detail =
      typeof value.error === 'string'
        ? value.error
        : (value.error?.message ?? value.message ?? value.detail ?? '')
  } catch {
    // HTML errors are neither useful provider messages nor safe UI copy.
  }
  return new Error(
    `The server returned HTTP ${status}.${detail ? ` ${detail.slice(0, 400)}` : ''}`
  )
}

async function desktopRequest(
  url: string,
  options: RequestOptions
): Promise<NativeResponse> {
  const requestId = crypto.randomUUID()
  if (options.signal?.aborted) throw abortError()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void invoke('cancel_http_request', { requestId }).catch(() => {})
      reject(abortError())
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const pending = invoke<NativeResponse>('http_request', {
      request: {
        requestId,
        url,
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: options.headers ?? {},
        body: options.body ?? null,
        publicOnly: options.publicOnly ?? false,
      },
    })
    return await Promise.race([pending, aborted])
  } catch (error) {
    if (options.signal?.aborted) throw abortError()
    throw asError(error)
  } finally {
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (
    Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel()
    throw new Error('The server response exceeds the supported size (8 MB).')
  }
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error('The server response exceeds the supported size (8 MB).')
    }
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(
          'The server response exceeds the supported size (8 MB).'
        )
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function browserRequest(
  url: string,
  options: RequestOptions
): Promise<NativeResponse> {
  if (options.signal?.aborted) throw abortError()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = window.setTimeout(() => controller.abort(), 60_000)
  try {
    const headers = new Headers(options.headers)
    if (options.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      signal: controller.signal,
      // Provider credentials must never be replayed through a redirect.
      redirect:
        options.body === undefined &&
        (!options.method ||
          ['GET', 'HEAD'].includes(options.method.toUpperCase())) &&
        Object.keys(options.headers ?? {}).every(name =>
          ['accept', 'content-type'].includes(name.toLowerCase())
        )
          ? 'follow'
          : 'error',
    })
    return {
      status: response.status,
      body: await readBoundedResponse(response),
    }
  } catch (error) {
    if (options.signal?.aborted) throw abortError()
    if (controller.signal.aborted) {
      throw new Error(
        'The server took too long to respond. Try again or check the model server.'
      )
    }
    if (error instanceof TypeError) {
      throw new Error(
        'The browser could not reach this endpoint. Check its CORS settings, or use TypeNext desktop.'
      )
    }
    throw asError(error)
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

export async function requestText(
  url: string,
  options: RequestOptions = {}
): Promise<string> {
  const endpoint = validateUrl(url)
  if (options.body !== undefined) {
    const serialized = JSON.stringify(options.body)
    if (
      serialized === undefined ||
      new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES
    ) {
      throw new Error('The request body exceeds the supported size (2 MB).')
    }
  }
  const response = await (isDesktop()
    ? desktopRequest(endpoint, options)
    : browserRequest(endpoint, options))
  if (response.status < 200 || response.status >= 300)
    throw responseError(response.status, response.body)
  return response.body
}

export async function requestJson(
  url: string,
  options: RequestOptions = {}
): Promise<unknown> {
  const text = await requestText(url, options)
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('The server response was not valid JSON.')
  }
}
