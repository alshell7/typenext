import { requestText } from './native'

export interface LinkPreview {
  url: string
  host: string
  title?: string
  description?: string
  siteName?: string
}

const MAX_HTML = 400_000
const TTL = 30 * 60_000
const MAX_CACHE = 128
const cache = new Map<string, { at: number; value: Promise<LinkPreview> }>()

export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return url
  }
}

function decode(text: string) {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&#(\d{1,6});/gu, (_, code: string) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Read title and description meta tags without running any page code. */
export function parsePreview(url: string, html: string): LinkPreview {
  const head = html.slice(0, MAX_HTML)
  const meta = (name: string) => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']{1,600})["']|<meta[^>]+content=["']([^"']{1,600})["'][^>]*(?:property|name)=["']${name}["']`,
      'iu'
    )
    const match = pattern.exec(head)
    return match ? decode(match[1] ?? match[2] ?? '') : undefined
  }
  const title =
    meta('og:title') ??
    meta('twitter:title') ??
    (/<title[^>]*>([^<]{1,400})<\/title>/iu.exec(head)?.[1]
      ? decode(/<title[^>]*>([^<]{1,400})<\/title>/iu.exec(head)![1]!)
      : undefined)
  const description =
    meta('og:description') ?? meta('description') ?? meta('twitter:description')
  const siteName = meta('og:site_name')
  return {
    url,
    host: linkHost(url),
    ...(title ? { title: title.slice(0, 200) } : {}),
    ...(description ? { description: description.slice(0, 300) } : {}),
    ...(siteName ? { siteName: siteName.slice(0, 80) } : {}),
  }
}

/**
 * Fetch a page title for a hover preview. Only public HTTP(S) addresses are
 * contacted, and no note text is sent.
 */
export function fetchLinkPreview(url: string): Promise<LinkPreview> {
  const cached = cache.get(url)
  if (cached && Date.now() - cached.at < TTL) return cached.value
  const value = (async () => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return { url, host: linkHost(url) }
    try {
      const html = await requestText(url, {
        headers: { Accept: 'text/html' },
        publicOnly: true,
      })
      return parsePreview(url, html)
    } catch {
      return { url, host: linkHost(url) }
    }
  })()
  cache.set(url, { at: Date.now(), value })
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return value
}

export function resetLinkPreviewsForTests() {
  cache.clear()
}
