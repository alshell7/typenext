import { invoke } from '@tauri-apps/api/core'
import type {
  ContextSource,
  Note,
  NotebookSettings,
  ProviderId,
  ProviderProfile,
  Workspace,
} from '@/types/notebook'
import { asError, isDesktop } from './native'
import { stripLinkedText } from '../notebook/note-context'
import { defaultSettings } from '../notebook/model'

const WORKSPACE_KEY = 'typenext.workspace.v1'
const BACKUP_KEY = 'typenext.workspace.v1.backup'
const CORRUPT_KEY_PREFIX = 'typenext.workspace.v1.corrupt.'
export const STORAGE_LIMITS = {
  workspaceBytes: 64 * 1024 * 1024,
  noteBytes: 8 * 1024 * 1024,
  sourceBytes: 8 * 1024 * 1024,
  contextBytes: 1024 * 1024,
  objectiveBytes: 65_536,
  notes: 10_000,
  sourcesPerNote: 256,
} as const
const MAX_WORKSPACE_BYTES = STORAGE_LIMITS.workspaceBytes
const MAX_FILE_BYTES = STORAGE_LIMITS.noteBytes
const PROVIDERS: ProviderId[] = [
  'openrouter',
  'openai',
  'anthropic',
  'local',
  'custom',
]
let saveQueue: Promise<void> = Promise.resolve()
let saveSequence = 0
let browserCommittedSequence = 0
let knownPrimary: { raw: string; sanitized: string } | undefined
const noteSizes = new WeakMap<object, { signature: unknown[]; size: number }>()

interface BrowserWritable {
  write(value: string): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

interface BrowserFileHandle {
  name: string
  createWritable(): Promise<BrowserWritable>
}

interface PickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<BrowserFileHandle>
}

const fileHandles = new Map<string, BrowserFileHandle>()

function invalid(): never {
  throw new Error('The saved notebook contains invalid or unsupported data.')
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid()
  return value as Record<string, unknown>
}

function string(value: unknown, limit = MAX_FILE_BYTES): string {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    (value.length > limit / 3 && utf8Size(value, limit) > limit)
  )
    return invalid()
  return value
}

function utf8Size(value: string, limit: number): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 128) bytes++
    else if (code < 2048) bytes += 2
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index++
    } else bytes += 3
    if (bytes > limit) return bytes
  }
  return bytes
}

function id(value: unknown): string {
  const valueString = string(value, 256)
  if (
    !valueString ||
    Array.from(valueString).some(character => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || (code >= 127 && code <= 159)
    })
  )
    return invalid()
  return valueString
}

function numeric(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  )
    return invalid()
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    return invalid()
  return value as T
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid()
  return value as unknown[]
}

function optionalString(value: unknown, limit: number): string | undefined {
  return value === undefined || value === null
    ? undefined
    : string(value, limit)
}

function parseSource(value: unknown): ContextSource {
  const source = record(value)
  const kind = choice(source.kind, [
    'text',
    'markdown',
    'pdf',
    'docx',
    'website',
    'note',
  ])
  const linkedNoteId = kind === 'note' ? id(source.linkedNoteId) : undefined
  if (
    kind !== 'note' &&
    source.linkedNoteId !== undefined &&
    source.linkedNoteId !== null
  )
    return invalid()
  return {
    id: id(source.id),
    name: string(source.name, 4096),
    kind,
    text: string(source.text),
    origin: optionalString(source.origin, 32_768),
    ...(linkedNoteId ? { linkedNoteId } : {}),
    enabled: boolean(source.enabled),
    addedAt: numeric(source.addedAt),
  }
}

function parseNote(value: unknown): Note {
  const note = record(value)
  const sources = stripLinkedText(
    array(note.sources, STORAGE_LIMITS.sourcesPerNote).map(parseSource)
  )
  if (new Set(sources.map(source => source.id)).size !== sources.length)
    return invalid()
  const linkedIds = sources
    .filter(source => source.kind === 'note')
    .map(source => source.linkedNoteId)
  if (new Set(linkedIds).size !== linkedIds.length) return invalid()
  return {
    id: id(note.id),
    title: string(note.title, 4096),
    objective: string(note.objective, STORAGE_LIMITS.objectiveBytes),
    context: string(note.context, STORAGE_LIMITS.contextBytes),
    content: string(note.content),
    sources,
    createdAt: numeric(note.createdAt),
    updatedAt: numeric(note.updatedAt),
    filePath: optionalString(note.filePath, 32_768),
    exportedAt:
      note.exportedAt === undefined || note.exportedAt === null
        ? undefined
        : numeric(note.exportedAt),
  }
}

function parsePalette(value: unknown): NotebookSettings['palette'] {
  if (value === undefined) return defaultSettings().palette
  const palette = record(value)
  const colors = (value: unknown) => {
    const colorValues = record(value)
    const color = (value: unknown) => {
      if (
        typeof value !== 'string' ||
        value.length !== 7 ||
        !/^#[0-9a-f]{6}$/i.test(value)
      )
        return invalid()
      return value
    }
    return {
      page: color(colorValues.page),
      sidebar: color(colorValues.sidebar),
      accent: color(colorValues.accent),
    }
  }
  return {
    light: choice(palette.light, ['paper', 'linen', 'mist', 'custom']),
    dark: choice(palette.dark, ['graphite', 'midnight', 'forest', 'custom']),
    customLight: colors(palette.customLight),
    customDark: colors(palette.customDark),
  }
}

function parseSettings(value: unknown): NotebookSettings {
  const settings = record(value)
  const rawProfiles = record(settings.profiles)
  const profiles = Object.fromEntries(
    PROVIDERS.map(provider => {
      const profile = record(rawProfiles[provider])
      return [
        provider,
        {
          endpoint: string(profile.endpoint, 4096),
          model: string(profile.model, 256),
          protocol: choice(profile.protocol, ['chat', 'fim']),
        },
      ]
    })
  ) as Record<ProviderId, ProviderProfile>
  return {
    theme: choice(settings.theme, ['light', 'dark', 'system']),
    palette: parsePalette(settings.palette),
    fontFamily: string(settings.fontFamily, 256),
    fontSize: numeric(settings.fontSize, 8, 72),
    autoSave: boolean(settings.autoSave),
    suggestionsEnabled: boolean(settings.suggestionsEnabled),
    autoSuggest: boolean(settings.autoSuggest),
    temperature: numeric(settings.temperature, 0, 2),
    suggestionDelay: numeric(settings.suggestionDelay, 100, 10_000),
    maxTokens: numeric(settings.maxTokens, 8, 2048),
    suggestionLength: choice(settings.suggestionLength ?? 'adaptive', [
      'adaptive',
      'short',
      'sentence',
    ]),
    provider: 'local',
    externalProvider: choice(
      settings.externalProvider ??
        (settings.provider === 'local' ? 'openrouter' : settings.provider),
      ['openrouter', 'openai', 'anthropic', 'custom']
    ),
    profiles,
    websiteImporter: choice(settings.websiteImporter, ['direct', 'firecrawl']),
  }
}

/** Project only notebook fields so API keys cannot accidentally enter autosaves. */
export function validateWorkspace(value: unknown): Workspace {
  const workspace = record(value)
  if (workspace.version !== 1) return invalid()
  const notes = array(workspace.notes, STORAGE_LIMITS.notes).map(parseNote)
  const ids = new Set(notes.map(note => note.id))
  if (ids.size !== notes.length) return invalid()
  const openNoteIds = array(workspace.openNoteIds, STORAGE_LIMITS.notes).map(id)
  if (
    new Set(openNoteIds).size !== openNoteIds.length ||
    openNoteIds.some(noteId => !ids.has(noteId))
  )
    return invalid()
  const activeNoteId =
    workspace.activeNoteId === null ? null : id(workspace.activeNoteId)
  if (activeNoteId !== null && !openNoteIds.includes(activeNoteId))
    return invalid()
  return {
    version: 1,
    notes,
    openNoteIds,
    activeNoteId,
    settings: parseSettings(workspace.settings),
  }
}

function tooLarge(): never {
  throw new Error(
    'The notebook exceeds the supported size (64 MB). Export or remove context before adding more.'
  )
}

/** Count JSON bytes directly, including escapes and unpaired surrogates. */
function jsonStringSize(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 34 || code === 92) bytes += 2
    else if (code < 32)
      bytes +=
        code === 8 || code === 9 || code === 10 || code === 12 || code === 13
          ? 2
          : 6
    else if (code < 128) bytes++
    else if (code < 2048) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
    else bytes += 3
    if (bytes > MAX_WORKSPACE_BYTES) return tooLarge()
  }
  return bytes
}

function jsonSize(value: unknown): number {
  if (typeof value === 'string') return jsonStringSize(value)
  if (value === null) return 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (typeof value === 'number') return String(value).length
  let bytes = 2
  const values = Array.isArray(value)
    ? value.map(item => [undefined, item] as const)
    : Object.entries(record(value)).filter(([, item]) => item !== undefined)
  values.forEach(([key, item], index) => {
    bytes +=
      (index ? 1 : 0) +
      (key === undefined ? 0 : jsonStringSize(key) + 1) +
      jsonSize(item)
    if (bytes > MAX_WORKSPACE_BYTES) tooLarge()
  })
  return bytes
}

function measuredNote(note: Note, original: Note): number {
  const signature: unknown[] = [
    note.id,
    note.title,
    note.objective,
    note.context,
    note.content,
    note.createdAt,
    note.updatedAt,
    note.filePath,
    note.exportedAt,
    ...note.sources.flatMap(source => [
      source.id,
      source.name,
      source.kind,
      source.text,
      source.origin,
      source.linkedNoteId,
      source.enabled,
      source.addedAt,
    ]),
  ]
  const cached = noteSizes.get(original)
  if (
    cached &&
    cached.signature.length === signature.length &&
    signature.every((part, index) => part === cached.signature[index])
  )
    return cached.size
  const size = jsonSize(note)
  noteSizes.set(original, { signature, size })
  return size
}

function captureWorkspace(workspace: Workspace): Workspace {
  const snapshot = validateWorkspace(workspace)
  let bytes = jsonSize({ ...snapshot, notes: [] })
  snapshot.notes.forEach((note, index) => {
    bytes += (index ? 1 : 0) + measuredNote(note, workspace.notes[index]!)
    if (bytes > MAX_WORKSPACE_BYTES) tooLarge()
  })
  return snapshot
}

/** Check prospective imports once; never run this for every editing keystroke. */
export function assertWorkspaceFits(workspace: Workspace): void {
  captureWorkspace(workspace)
}

function parseSaved(value: string): Workspace {
  if (utf8Size(value, MAX_WORKSPACE_BYTES) > MAX_WORKSPACE_BYTES)
    return tooLarge()
  return validateWorkspace(JSON.parse(value) as unknown)
}

export async function loadWorkspace(): Promise<Workspace | null> {
  await saveQueue.catch(() => {})
  if (isDesktop()) {
    try {
      const workspace = await invoke<unknown>('load_workspace')
      if (workspace === null) return null
      const snapshot = validateWorkspace(workspace)
      if (record(workspace).recovered === true)
        window.dispatchEvent(new Event('typenext:workspace-recovered'))
      return snapshot
    } catch (error) {
      throw asError(error)
    }
  }
  const primary = localStorage.getItem(WORKSPACE_KEY)
  const backup = localStorage.getItem(BACKUP_KEY)
  if (primary === null && backup === null) return null
  if (primary !== null) {
    try {
      const workspace = parseSaved(primary)
      knownPrimary = { raw: primary, sanitized: JSON.stringify(workspace) }
      return workspace
    } catch {
      /* Try the last valid snapshot. */
    }
  }
  if (backup !== null) {
    try {
      const recovered = parseSaved(backup)
      // Loading the backup must not silently overwrite forensic evidence.
      // A subsequent save preserves the corrupt primary before replacing it.
      window.dispatchEvent(new Event('typenext:workspace-recovered'))
      return recovered
    } catch {
      /* Preserve both copies for manual recovery. */
    }
  }
  throw new Error(
    'The notebook and its recovery copy could not be read. Your browser data is preserved; restore a valid copy before starting a new notebook.'
  )
}

function writeBrowserSnapshot(serialized: string, sequence: number): void {
  if (sequence <= browserCommittedSequence) return
  try {
    const previous = localStorage.getItem(WORKSPACE_KEY)
    if (previous !== null) {
      let sanitized: string | undefined
      if (knownPrimary?.raw === previous) sanitized = knownPrimary.sanitized
      else {
        try {
          sanitized = JSON.stringify(parseSaved(previous))
        } catch {
          const recoveryKey = `${CORRUPT_KEY_PREFIX}${crypto.randomUUID()}`
          localStorage.setItem(recoveryKey, previous)
        }
      }
      if (sanitized !== undefined) localStorage.setItem(BACKUP_KEY, sanitized)
    }
    localStorage.setItem(WORKSPACE_KEY, serialized)
    knownPrimary = { raw: serialized, sanitized: serialized }
    browserCommittedSequence = sequence
  } catch {
    throw new Error(
      'Your browser could not save this notebook. Existing data is preserved. Export your note, free browser storage, or use TypeNext desktop.'
    )
  }
}

/** Browser lifecycle events cannot wait for a queued promise to run. */
export function flushBrowserWorkspace(workspace: Workspace): boolean {
  if (isDesktop()) return false
  const snapshot = captureWorkspace(workspace)
  writeBrowserSnapshot(JSON.stringify(snapshot), ++saveSequence)
  return true
}

export async function persistWorkspace(workspace: Workspace): Promise<void> {
  const snapshot = captureWorkspace(workspace)
  const desktop = isDesktop()
  const serialized = desktop ? undefined : JSON.stringify(snapshot)
  const sequence = ++saveSequence
  const pending = saveQueue
    .catch(() => {})
    .then(async () => {
      if (desktop) {
        try {
          await invoke('persist_workspace', { workspace: snapshot })
        } catch (error) {
          throw asError(error)
        }
        return
      }
      writeBrowserSnapshot(serialized!, sequence)
    })
  saveQueue = pending
  await pending
}

export function markdownFilename(title: string): string {
  let name = Array.from(title, character =>
    (character.codePointAt(0) ?? 0) < 32 ? '-' : character
  )
    .join('')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[.\s]+$/, '')
    .trim()
    .slice(0, 100)
  name = name.replace(/\.(md|markdown|txt)$/i, '') || 'Untitled'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name += '-note'
  return `${name}.md`
}

async function openBrowserFile(): Promise<{
  name: string
  content: string
} | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    input.hidden = true
    document.body.append(input)
    let settled = false
    const cleanup = () => {
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
    }
    const cancelled = () => {
      if (settled) return
      cleanup()
      resolve(null)
    }
    const onFocus = () => {
      // Older browsers omit the input cancel event; allow change to arrive first.
      window.setTimeout(() => {
        if (!settled && !input.files?.length) cancelled()
      }, 350)
    }
    input.addEventListener('cancel', cancelled, { once: true })
    window.addEventListener('focus', onFocus)
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0]
        cleanup()
        if (!file) {
          resolve(null)
          return
        }
        if (file.size > MAX_FILE_BYTES) {
          reject(new Error('This note exceeds the supported size (8 MB).'))
          return
        }
        void file.text().then(
          content =>
            resolve({
              name: file.name,
              content: content.replace(/^\uFEFF/, ''),
            }),
          reject
        )
      },
      { once: true }
    )
    input.click()
  })
}

export async function openMarkdownFile(): Promise<{
  name: string
  content: string
  path?: string
} | null> {
  if (!isDesktop()) return openBrowserFile()
  try {
    const [{ open }, { readTextFile, stat }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ])
    const selected = await open({
      title: 'Open a note',
      multiple: false,
      directory: false,
      filters: [
        { name: 'Markdown & text', extensions: ['md', 'markdown', 'txt'] },
      ],
    })
    if (!selected || Array.isArray(selected)) return null
    const metadata = await stat(selected)
    if (metadata.size > MAX_FILE_BYTES)
      throw new Error('This note exceeds the supported size (8 MB).')
    const content = await readTextFile(selected)
    return {
      name: selected.split(/[\\/]/).at(-1) ?? 'Untitled.md',
      content: content.replace(/^\uFEFF/, ''),
      path: selected,
    }
  } catch (error) {
    throw asError(error)
  }
}

async function saveBrowserFile(
  note: Note,
  saveAs: boolean
): Promise<{ path?: string } | null> {
  const picker = (window as PickerWindow).showSaveFilePicker
  if (picker) {
    let writable: BrowserWritable | undefined
    try {
      let handle = saveAs ? undefined : fileHandles.get(note.id)
      handle ??= await picker.call(window, {
        suggestedName: markdownFilename(note.title),
        types: [
          { description: 'Markdown', accept: { 'text/markdown': ['.md'] } },
        ],
      })
      writable = await handle.createWritable()
      await writable.write(note.content)
      await writable.close()
      fileHandles.set(note.id, handle)
      return {}
    } catch (error) {
      await writable?.abort().catch(() => {})
      if (error instanceof DOMException && error.name === 'AbortError')
        return null
      throw asError(error)
    }
  }
  const url = URL.createObjectURL(
    new Blob([note.content], { type: 'text/markdown;charset=utf-8' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = markdownFilename(note.title)
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return {}
}

export async function saveMarkdownFile(
  note: Note,
  saveAs = false
): Promise<{ path?: string } | null> {
  if (new TextEncoder().encode(note.content).byteLength > MAX_FILE_BYTES) {
    throw new Error('This note exceeds the supported export size (8 MB).')
  }
  if (!isDesktop()) return saveBrowserFile(note, saveAs)
  try {
    let path = saveAs ? undefined : note.filePath
    if (!path) {
      const { save } = await import('@tauri-apps/plugin-dialog')
      path =
        (await save({
          title: 'Save Markdown',
          defaultPath: note.filePath ?? markdownFilename(note.title),
          filters: [
            { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
          ],
        })) ?? undefined
      if (!path) return null
    }
    const savedPath = await invoke<string>('write_markdown_file', {
      path,
      content: note.content,
    })
    return { path: savedPath }
  } catch (error) {
    throw asError(error)
  }
}
