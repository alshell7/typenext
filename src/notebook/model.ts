import type { Note, NotebookSettings, Workspace } from '../types/notebook'
import { migrateContextLibrary } from './context-library'

export const FONTS = [
  { name: 'Merriweather', family: "'Merriweather', Georgia, serif" },
  {
    name: 'Source Sans Pro',
    family: "'Source Sans Pro', 'Segoe UI', sans-serif",
  },
  { name: 'Alegreya', family: "'Alegreya', Georgia, serif" },
  { name: 'EB Garamond', family: "'EB Garamond', Georgia, serif" },
  { name: 'JetBrains Mono', family: "'JetBrains Mono', monospace" },
  { name: 'IBM Plex Mono', family: "'IBM Plex Mono', monospace" },
  { name: 'Miracode', family: "'Miracode', 'JetBrains Mono', monospace" },
  { name: 'Segoe UI', family: "'Segoe UI', -apple-system, sans-serif" },
  { name: 'Tahoma', family: 'Tahoma, Geneva, sans-serif' },
  { name: 'Times New Roman', family: "'Times New Roman', Times, serif" },
] as const

export const PROVIDERS = {
  local: 'Local model',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  custom: 'Custom endpoint',
} as const

export function defaultSettings(): NotebookSettings {
  return {
    theme: 'system',
    palette: {
      light: 'paper',
      dark: 'graphite',
      customLight: { page: '#ffffff', sidebar: '#f3f4f1', accent: '#42644d' },
      customDark: { page: '#212121', sidebar: '#17191c', accent: '#a6b6c8' },
    },
    fontFamily: 'Merriweather',
    fontSize: 17,
    autoSave: true,
    suggestionsEnabled: true,
    autoSuggest: true,
    temperature: 0.35,
    suggestionDelay: 1100,
    maxTokens: 64,
    suggestionLength: 'adaptive',
    provider: 'local',
    externalAutoEnabled: false,
    suggestionInstructions: '',
    localEngine: 'recall',
    externalProvider: 'openrouter',
    websiteImporter: 'direct',
    profiles: {
      local: {
        endpoint: 'http://localhost:1234/v1',
        model: '',
        protocol: 'chat',
      },
      openrouter: {
        endpoint: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
        protocol: 'chat',
      },
      openai: {
        endpoint: 'https://api.openai.com/v1',
        model: '',
        protocol: 'chat',
      },
      anthropic: {
        endpoint: 'https://api.anthropic.com/v1',
        model: '',
        protocol: 'chat',
      },
      custom: { endpoint: '', model: '', protocol: 'chat' },
    },
  }
}

export function emptyWorkspace(): Workspace {
  return {
    version: 1,
    notes: [],
    contextLibrary: [],
    openNoteIds: [],
    activeNoteId: null,
    settings: defaultSettings(),
  }
}

export function normalizeWorkspace(value: Workspace): Workspace {
  const defaults = defaultSettings()
  const settings = {
    ...defaults,
    ...value.settings,
    provider: value.settings?.externalAutoEnabled
      ? value.settings.provider
      : ('local' as const),
    localEngine:
      value.settings?.localEngine ??
      (value.settings?.profiles?.local?.model ? 'server' : 'recall'),
    profiles: { ...defaults.profiles, ...value.settings?.profiles },
  }
  settings.fontSize = Math.min(
    32,
    Math.max(12, Number(settings.fontSize) || 17)
  )
  const notes = value.notes
    .filter(
      note => typeof note.id === 'string' && typeof note.content === 'string'
    )
    .map(note => ({
      ...note,
      sources: note.sources ?? [],
      context: note.context ?? '',
      objective: note.objective ?? '',
    }))
  const migrated = migrateContextLibrary(notes, value.contextLibrary)
  const ids = new Set(notes.map(note => note.id))
  const openNoteIds = [...new Set(value.openNoteIds)].filter(id => ids.has(id))
  return {
    ...value,
    version: 1,
    notes: migrated.notes,
    contextLibrary: migrated.library,
    openNoteIds,
    activeNoteId:
      value.activeNoteId && openNoteIds.includes(value.activeNoteId)
        ? value.activeNoteId
        : (openNoteIds[0] ?? null),
    settings,
  }
}

export function newNote(
  title: string,
  context = '',
  content = '',
  filePath?: string
): Note {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: title.trim() || 'Untitled',
    context: context.trim(),
    objective: '',
    content,
    sources: [],
    createdAt: now,
    updatedAt: now,
    ...(filePath ? { filePath, exportedAt: now } : {}),
  }
}

export function openNote(workspace: Workspace, note: Note): Workspace {
  return {
    ...workspace,
    notes: workspace.notes.some(item => item.id === note.id)
      ? workspace.notes
      : [note, ...workspace.notes],
    openNoteIds: workspace.openNoteIds.includes(note.id)
      ? workspace.openNoteIds
      : [...workspace.openNoteIds, note.id],
    activeNoteId: note.id,
  }
}

export function closeNote(workspace: Workspace, id: string): Workspace {
  const index = workspace.openNoteIds.indexOf(id)
  const openNoteIds = workspace.openNoteIds.filter(item => item !== id)
  return {
    ...workspace,
    openNoteIds,
    activeNoteId:
      workspace.activeNoteId === id
        ? (openNoteIds[Math.max(0, index - 1)] ?? null)
        : workspace.activeNoteId,
  }
}

export function wordCount(text: string): number {
  let count = 0
  let inWord = false
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    // Match ECMAScript \s without allocating a substring for every word.
    const whitespace =
      code <= 0x20
        ? code === 0x20 || (code >= 0x09 && code <= 0x0d)
        : code <= 0x7f
          ? false
          : code === 0x00a0 ||
            code === 0x1680 ||
            (code >= 0x2000 && code <= 0x200a) ||
            code === 0x2028 ||
            code === 0x2029 ||
            code === 0x202f ||
            code === 0x205f ||
            code === 0x3000 ||
            code === 0xfeff
    if (whitespace) inWord = false
    else if (!inWord) {
      count++
      inWord = true
    }
  }
  return count
}

export function relativeDate(date: number): string {
  const days = Math.floor((Date.now() - date) / 86_400_000)
  if (days < 1) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}
