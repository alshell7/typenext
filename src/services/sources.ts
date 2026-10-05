import type { ContextSource, NotebookSettings } from '../types/notebook'
import { getSecret, requestJson, requestText } from './native'

export const MAX_CONTEXT_FILE_BYTES = 12 * 1_024 * 1_024
export const MAX_CONTEXT_CHARACTERS = 300_000
const MAX_WEBSITE_RESPONSE_CHARACTERS = 2_000_000
const MAX_WEBSITE_ELEMENTS = 20_000
const MAX_PDF_PAGES = 150
const MAX_DOCX_ENTRIES = 2_048
const MAX_DOCX_EXPANDED_BYTES = 32 * 1_024 * 1_024
const MAX_DOCX_XML_BYTES = 4 * 1_024 * 1_024
let importActive = false

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException('Context import cancelled.', 'AbortError')
}

async function withImport<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  checkAbort(signal)
  if (importActive)
    throw new Error(
      'Another context source is still importing. Please wait for it to finish.'
    )
  importActive = true
  try {
    return await run()
  } finally {
    importActive = false
  }
}

function createSource(
  name: string,
  kind: ContextSource['kind'],
  text: string,
  origin?: string
): ContextSource {
  if (text.length > MAX_CONTEXT_CHARACTERS * 2) {
    throw new Error(
      'This source exceeds 300,000 characters. Attach the relevant sections as smaller files.'
    )
  }
  const cleanText = text.replace(/\r\n?/gu, '\n').replaceAll('\0', '').trim()
  if (!cleanText) throw new Error('This source contains no readable text.')
  if (cleanText.length > MAX_CONTEXT_CHARACTERS) {
    throw new Error(
      'This source exceeds 300,000 characters. Attach the relevant sections as smaller files.'
    )
  }
  return {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 200) || 'Untitled source',
    kind,
    text: cleanText,
    origin,
    enabled: true,
    addedAt: Date.now(),
  }
}

async function readBytes(
  file: File,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  checkAbort(signal)
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => {
      reader.abort()
      cleanup()
      reject(new DOMException('Context import cancelled.', 'AbortError'))
    }
    reader.onerror = () => {
      cleanup()
      reject(new Error('The selected file could not be read.'))
    }
    reader.onload = () => {
      cleanup()
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('The selected file could not be read.'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    reader.readAsArrayBuffer(file)
  })
}

interface DocxEntry {
  compressedSize: number
  expandedSize: number
  offset: number
  method: number
  xml: boolean
}

function corruptDocx(): Error {
  return new Error(
    'This .docx file could not be read. Save a fresh .docx copy or export it as plain text.'
  )
}

function oversizedDocx(): Error {
  return new Error(
    'This Word file expands to too much document data. Export the relevant sections as plain text or a smaller .docx file.'
  )
}

function preflightDocx(bytes: ArrayBuffer): DocxEntry[] {
  const view = new DataView(bytes)
  const entriesToRead: DocxEntry[] = []
  let end = -1
  for (
    let position = bytes.byteLength - 22;
    position >= Math.max(0, bytes.byteLength - 65_557);
    position--
  ) {
    if (
      view.getUint32(position, true) === 0x06054b50 &&
      position + 22 + view.getUint16(position + 20, true) === bytes.byteLength
    ) {
      end = position
      break
    }
  }
  if (end < 0) throw corruptDocx()
  const entries = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const start = view.getUint32(end + 16, true)
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== entries
  )
    throw corruptDocx()
  if (
    entries > MAX_DOCX_ENTRIES ||
    size === 0xffffffff ||
    start === 0xffffffff
  ) {
    throw new Error(
      'This Word archive is too complex to import. Export the relevant sections as plain text or a smaller .docx file.'
    )
  }
  if (start + size > end) throw corruptDocx()
  let position = start
  let expanded = 0
  let xmlBytes = 0
  const decoder = new TextDecoder()
  for (let entry = 0; entry < entries; entry++) {
    if (
      position + 46 > start + size ||
      view.getUint32(position, true) !== 0x02014b50
    )
      throw corruptDocx()
    const compressedSize = view.getUint32(position + 20, true)
    const expandedSize = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const entryLength =
      46 +
      nameLength +
      view.getUint16(position + 30, true) +
      view.getUint16(position + 32, true)
    if (
      position + entryLength > start + size ||
      view.getUint16(position + 34, true)
    )
      throw corruptDocx()
    if (view.getUint16(position + 8, true) & 1) {
      throw new Error(
        'This Word file is encrypted. Attach an unlocked copy or export its text.'
      )
    }
    expanded += expandedSize
    const name = decoder.decode(
      new Uint8Array(bytes, position + 46, nameLength)
    )
    const xml = /\.(?:xml|rels)$/iu.test(name)
    if (xml) xmlBytes += expandedSize
    if (
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      expanded > MAX_DOCX_EXPANDED_BYTES ||
      xmlBytes > MAX_DOCX_XML_BYTES
    ) {
      throw oversizedDocx()
    }
    const local = view.getUint32(position + 42, true)
    const method = view.getUint16(position + 10, true)
    if (
      local + 30 > start ||
      view.getUint32(local, true) !== 0x04034b50 ||
      ![0, 8].includes(method)
    )
      throw corruptDocx()
    const offset =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true)
    if (offset + compressedSize > start) throw corruptDocx()
    entriesToRead.push({ compressedSize, expandedSize, offset, method, xml })
    position += entryLength
  }
  return entriesToRead
}

async function validateDocxExpansion(
  bytes: ArrayBuffer,
  entries: DocxEntry[],
  signal?: AbortSignal
): Promise<void> {
  // Native DecompressionStream is unavailable in older macOS system webviews.
  // Lazy streaming inflation verifies actual output without retaining it, before
  // handing a bounded archive to Mammoth's document reader.
  const { Inflate } = entries.some(entry => entry.method === 8)
    ? await import('fflate')
    : { Inflate: undefined }
  checkAbort(signal)
  let expanded = 0
  let xmlBytes = 0
  let lastYield = performance.now()
  for (const entry of entries) {
    checkAbort(signal)
    let actual = 0
    const count = (size: number) => {
      actual += size
      expanded += size
      if (entry.xml) xmlBytes += size
      if (expanded > MAX_DOCX_EXPANDED_BYTES || xmlBytes > MAX_DOCX_XML_BYTES)
        throw oversizedDocx()
    }
    if (entry.method === 0) {
      count(entry.compressedSize)
    } else {
      if (!Inflate) throw corruptDocx()
      const inflater = new Inflate(chunk => {
        count(chunk.length)
      })
      const data = new Uint8Array(bytes, entry.offset, entry.compressedSize)
      // A small compressed push also bounds temporary output from an entry
      // whose forged size hides an extreme compression ratio.
      for (
        let offset = 0, pushes = 0;
        offset < data.length;
        offset += 64, pushes++
      ) {
        checkAbort(signal)
        try {
          inflater.push(
            data.subarray(offset, offset + 64),
            offset + 64 >= data.length
          )
        } catch {
          if (
            expanded > MAX_DOCX_EXPANDED_BYTES ||
            xmlBytes > MAX_DOCX_XML_BYTES
          )
            throw oversizedDocx()
          throw corruptDocx()
        }
        if ((pushes & 63) === 0 && performance.now() - lastYield >= 8) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          checkAbort(signal)
          lastYield = performance.now()
        }
      }
    }
    if (actual !== entry.expandedSize) throw corruptDocx()
  }
}

async function pdfText(
  bytes: ArrayBuffer,
  signal?: AbortSignal
): Promise<string> {
  // Use the compatibility build and its matching worker for macOS system
  // webviews that lack newer Promise/Iterator helpers. Both stay lazy/local.
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ])
  checkAbort(signal)
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableFontFace: true,
    // This importer extracts text; image-decoding WASM assets are unnecessary.
    useWasm: false,
  })
  let destroyed: Promise<void> | undefined
  const destroy = () => (destroyed ??= task.destroy())
  const abort = () => {
    void destroy().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    checkAbort(signal)
    const document = await task.promise
    checkAbort(signal)
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(
        'This PDF has more than 150 pages. Attach a smaller PDF or the relevant sections.'
      )
    }
    const pages: string[] = []
    let length = 0
    let hasText = false
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      checkAbort(signal)
      const page = await document.getPage(pageNumber)
      let text = ''
      try {
        checkAbort(signal)
        const reader = page.streamTextContent().getReader()
        const fragments: string[] = []
        let pageLength = 0
        let done = false
        try {
          while (!done) {
            checkAbort(signal)
            const chunk = await reader.read()
            checkAbort(signal)
            done = chunk.done
            if (!chunk.value) continue
            for (const item of chunk.value.items) {
              if (!('str' in item)) continue
              const fragment = item.str + (item.hasEOL ? '\n' : ' ')
              pageLength += fragment.length
              if (
                length + pageLength + `[Page ${pageNumber}]\n`.length + 2 >
                MAX_CONTEXT_CHARACTERS
              ) {
                throw new Error(
                  'This PDF exceeds 300,000 extracted characters. Attach the relevant pages in a smaller file.'
                )
              }
              fragments.push(fragment)
            }
          }
          text = fragments.join('').trim()
        } finally {
          if (!done) void reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      } finally {
        page.cleanup()
      }
      if (text) {
        hasText = true
        const section = `[Page ${pageNumber}]\n${text}`
        length += section.length + 2
        if (length > MAX_CONTEXT_CHARACTERS) {
          throw new Error(
            'This PDF exceeds 300,000 extracted characters. Attach the relevant pages in a smaller file.'
          )
        }
        pages.push(section)
      }
    }
    if (!hasText) {
      throw new Error(
        'This PDF has no selectable text. Run OCR first, then attach the resulting text or searchable PDF.'
      )
    }
    return pages.join('\n\n')
  } catch (error) {
    checkAbort(signal)
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new Error(
        'This PDF is password protected. Attach an unlocked copy or export its text.'
      )
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    await destroy()
  }
}

/** Import once, locally. Completion requests reuse ContextSource.text. */
export async function importContextFile(
  file: File,
  signal?: AbortSignal
): Promise<ContextSource> {
  return withImport(signal, async () => {
    if (file.size > MAX_CONTEXT_FILE_BYTES) {
      throw new Error(
        'Context files must be 12 MiB or smaller. Attach the relevant sections in a smaller file.'
      )
    }
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    if (extension === 'doc') {
      throw new Error(
        'Legacy .doc files need conversion. Save this file as .docx or plain text, then attach it.'
      )
    }
    if (
      !extension ||
      !['txt', 'text', 'md', 'markdown', 'mdown', 'pdf', 'docx'].includes(
        extension
      )
    ) {
      throw new Error('Choose a text, Markdown, PDF or .docx file for context.')
    }
    if (
      !['pdf', 'docx'].includes(extension) &&
      file.size > MAX_CONTEXT_CHARACTERS * 4
    ) {
      throw new Error(
        'This text source exceeds 300,000 characters. Attach the relevant sections as smaller files.'
      )
    }
    const bytes = await readBytes(file, signal)
    checkAbort(signal)
    if (bytes.byteLength > MAX_CONTEXT_FILE_BYTES) {
      throw new Error('Context files must be 12 MiB or smaller.')
    }
    if (extension === 'pdf')
      return createSource(file.name, 'pdf', await pdfText(bytes, signal))
    if (extension === 'docx') {
      const entries = preflightDocx(bytes)
      await validateDocxExpansion(bytes, entries, signal)
      checkAbort(signal)
      const mammoth = await import('mammoth')
      checkAbort(signal)
      let text: string
      try {
        const result = await mammoth.extractRawText({ arrayBuffer: bytes })
        checkAbort(signal)
        text = result.value
      } catch {
        checkAbort(signal)
        throw new Error(
          'This .docx file could not be read. Save a fresh .docx copy or export it as plain text.'
        )
      }
      return createSource(file.name, 'docx', text)
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(
        'This text file is not UTF-8. Save it with UTF-8 encoding, then attach it.'
      )
    }
    const markdown = ['md', 'markdown', 'mdown'].includes(extension)
    return createSource(file.name, markdown ? 'markdown' : 'text', text)
  })
}

function publicWebsiteUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error(
      'Enter a full website URL beginning with https:// or http://.'
    )
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Use a public HTTP or HTTPS website URL without embedded credentials.'
    )
  }
  const hostname = url.hostname.toLowerCase()
  const ipv4 = hostname.split('.').map(Number)
  const privateIpv4 =
    ipv4.length === 4 &&
    ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (ipv4[0] === 0 ||
      ipv4[0] === 10 ||
      ipv4[0] === 127 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && (ipv4[1] ?? 0) >= 16 && (ipv4[1] ?? 0) <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) ||
      (ipv4[0] === 100 && (ipv4[1] ?? 0) >= 64 && (ipv4[1] ?? 0) <= 127))
  const privateIpv6 =
    hostname.startsWith('[') &&
    (hostname === '[::]' ||
      hostname === '[::1]' ||
      /^\[(?:fc|fd|fe8|fe9|fea|feb)/u.test(hostname) ||
      hostname.startsWith('[::ffff:'))
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    (!hostname.includes('.') && !hostname.startsWith('[')) ||
    privateIpv4 ||
    privateIpv6
  ) {
    throw new Error(
      'Website context import supports public website URLs. Attach local content as a file.'
    )
  }
  url.hash = ''
  return url
}

function htmlText(document: Document): string {
  document
    .querySelectorAll(
      'script, style, noscript, iframe, object, embed, form, nav, footer, svg, canvas, img, picture, video, audio, source, link'
    )
    .forEach(element => element.remove())
  document
    .querySelectorAll('br')
    .forEach(element => element.replaceWith(document.createTextNode('\n')))
  document
    .querySelectorAll(
      'p, div, article, section, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote'
    )
    .forEach(element => element.append(document.createTextNode('\n')))
  return (document.body.textContent ?? '')
    .replace(/[\t ]+/gu, ' ')
    .replace(/\n[\t ]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** A deliberate import action, never called by the suggestion engine. */
export async function importWebsite(
  input: string,
  settings: NotebookSettings,
  signal?: AbortSignal
): Promise<ContextSource> {
  return withImport(signal, async () => {
    checkAbort(signal)
    const url = publicWebsiteUrl(input)
    if (settings.websiteImporter === 'firecrawl') {
      const key = (await getSecret('firecrawl')).trim()
      checkAbort(signal)
      if (!key)
        throw new Error(
          'Add a Firecrawl key in Settings, or choose Direct website import.'
        )
      const response = await requestJson(
        'https://api.firecrawl.dev/v2/scrape',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: {
            url: url.toString(),
            formats: ['markdown'],
            onlyMainContent: true,
          },
          signal,
        }
      )
      checkAbort(signal)
      const json = response as {
        success?: boolean
        data?: { markdown?: unknown; metadata?: { title?: unknown } }
      }
      if (
        !json ||
        json.success === false ||
        typeof json.data?.markdown !== 'string'
      ) {
        throw new Error(
          'Firecrawl returned no article text. Check the URL or try Direct website import.'
        )
      }
      const title =
        typeof json.data.metadata?.title === 'string'
          ? json.data.metadata.title
          : url.hostname
      return createSource(title, 'website', json.data.markdown, url.toString())
    }

    const response = await requestText(url.toString(), {
      method: 'GET',
      headers: { Accept: 'text/html, text/plain;q=0.8' },
      signal,
      publicOnly: true,
    })
    checkAbort(signal)
    if (response.length > MAX_WEBSITE_RESPONSE_CHARACTERS) {
      throw new Error(
        'This page is too large for Direct import. Attach its relevant text or use Firecrawl.'
      )
    }
    if (!/<(?:!doctype|html|head|body|article|main|p|div)\b/iu.test(response)) {
      return createSource(url.hostname, 'website', response, url.toString())
    }
    let elementStarts = 0
    for (const match of response.matchAll(/<[A-Za-z]/gu)) {
      if (!match[0]) continue
      if (++elementStarts > MAX_WEBSITE_ELEMENTS) {
        throw new Error(
          'This page contains too many elements for Direct import. Attach its relevant text or use Firecrawl.'
        )
      }
    }
    const document = new DOMParser().parseFromString(response, 'text/html')
    const title = document.title || url.hostname
    document
      .querySelectorAll(
        'script, style, noscript, iframe, object, embed, form, nav, footer, svg, canvas, img, picture, video, audio, source, link'
      )
      .forEach(element => element.remove())
    const { Readability } = await import('@mozilla/readability')
    checkAbort(signal)
    const article = new Readability(document.cloneNode(true) as Document, {
      maxElemsToParse: MAX_WEBSITE_ELEMENTS,
    }).parse()
    const content = article?.content
      ? new DOMParser().parseFromString(article.content, 'text/html')
      : document
    const text = htmlText(content)
    if (text.length < 40) {
      throw new Error(
        'Direct import found too little article text. This page may require JavaScript; try Firecrawl or attach its text.'
      )
    }
    return createSource(
      article?.title || title,
      'website',
      text,
      url.toString()
    )
  })
}
