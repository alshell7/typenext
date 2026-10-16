import { getSecret } from './native'

/**
 * Model files come from huggingface.co. Public files need no account, but
 * Hugging Face can ask for a token: for gated repositories (401/403) and when
 * anonymous downloads are rate-limited (429). A token is optional, stored like
 * other keys, and sent only to huggingface.co.
 */
export const HUGGING_FACE_SECRET = 'huggingface'
export const HUGGING_FACE_TOKEN_URL =
  'https://huggingface.co/settings/tokens/new?tokenType=read'

export type HuggingFaceIssue = 'auth' | 'rate-limit'

export interface HuggingFacePrompt {
  issue: HuggingFaceIssue
  /** What the writer was downloading, for example "Fluid Speech Mini". */
  model: string
  /** Repository that refused, for the guide's "accept the terms" step. */
  repository?: string
  /** Which download to try again after a token is saved. */
  source?: 'embedding' | 'speech' | 'builtin' | 'whistle'
}

const listeners = new Set<() => void>()
let prompt: HuggingFacePrompt | null = null

export async function huggingFaceToken(): Promise<string> {
  try {
    return (await getSecret(HUGGING_FACE_SECRET)).trim()
  } catch {
    return ''
  }
}

export function isHuggingFaceUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === 'huggingface.co' || host.endsWith('.huggingface.co')
  } catch {
    return false
  }
}

/** Headers for a model download. The token never goes to another host. */
export async function huggingFaceHeaders(
  url: string
): Promise<Record<string, string>> {
  if (!isHuggingFaceUrl(url)) return {}
  const token = await huggingFaceToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Recognize a Hugging Face refusal from an HTTP status or an error text. */
export function huggingFaceIssue(
  value: number | string | undefined | null
): HuggingFaceIssue | null {
  if (typeof value === 'number') {
    if (value === 401 || value === 403) return 'auth'
    if (value === 429) return 'rate-limit'
    return null
  }
  const text = String(value ?? '')
  if (
    /huggingface-rate-limit|\b429\b|rate.?limit|too many requests/iu.test(text)
  )
    return 'rate-limit'
  if (
    /huggingface-auth|\b40[13]\b|gated|unauthori[sz]ed|access to model .* is restricted|invalid (?:user )?token/iu.test(
      text
    )
  )
    return 'auth'
  return null
}

export function getHuggingFacePrompt(): HuggingFacePrompt | null {
  return prompt
}

export function subscribeHuggingFacePrompt(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Ask the interface to show the token guide. */
export function requestHuggingFaceToken(next: HuggingFacePrompt) {
  prompt = next
  listeners.forEach(listener => listener())
}

export function dismissHuggingFacePrompt() {
  prompt = null
  listeners.forEach(listener => listener())
}

/**
 * Show the guide when a download error is a Hugging Face refusal. Returns
 * true when it did, so the caller can show a shorter message.
 */
export function promptForHuggingFaceError(
  error: unknown,
  model: string,
  repository?: string
): boolean {
  const issue = huggingFaceIssue(
    error instanceof Error ? error.message : String(error)
  )
  if (!issue) return false
  requestHuggingFaceToken({
    issue,
    model,
    ...(repository ? { repository } : {}),
  })
  return true
}

/** Check a token without downloading anything. */
export async function verifyHuggingFaceToken(
  token: string,
  signal?: AbortSignal
): Promise<{ name: string }> {
  const response = await fetch('https://huggingface.co/api/whoami-v2', {
    headers: { Authorization: `Bearer ${token.trim()}` },
    credentials: 'omit',
    signal,
  }).catch(() => {
    throw new Error(
      'TypeNext could not reach Hugging Face. Check the connection.'
    )
  })
  if (response.status === 401)
    throw new Error('Hugging Face did not accept this token. Copy it again.')
  if (!response.ok)
    throw new Error(`Hugging Face returned HTTP ${response.status}.`)
  const value = (await response.json()) as { name?: unknown }
  return { name: typeof value.name === 'string' ? value.name : 'your account' }
}

export function resetHuggingFaceForTests() {
  prompt = null
  listeners.clear()
}
