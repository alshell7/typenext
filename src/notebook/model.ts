import type {
  EditorSettings,
  Note,
  NotebookSettings,
  SemanticSettings,
  Workspace,
} from '../types/notebook'
import {
  migrateContextLibrary,
  migrateContextPackages,
} from './context-library'

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
  cloudflare: 'Cloudflare',
  custom: 'Custom endpoint',
} as const

export function defaultSemanticSettings(): SemanticSettings {
  return {
    enabled: false,
    // Tests mock the native module, so read the Tauri marker directly.
    runtime:
      typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
        ? 'managed'
        : 'server',
    endpoint: 'http://127.0.0.1:8080',
    quantization: 'UD-Q4_K_XL',
    dimensions: 512,
    media: false,
  }
}

export function defaultEditorSettings(): EditorSettings {
  return {
    slashMenu: true,
    slashTrigger: '/',
    customCommands: [],
    livePreview: true,
    linkPreviews: 'all',
    selectionToolbar: true,
    typewriter: false,
    focus: 'off',
    zenFocus: true,
    smartTypography: true,
    dailyGoal: 0,
  }
}

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
    semantic: defaultSemanticSettings(),
    webFacts: { enabled: false, model: 'gpt-5.4-mini', withSuggestions: false },
    zenLevel: 'chrome',
    editor: defaultEditorSettings(),
    git: {
      enabled: false,
      folder: '',
      autoSync: true,
      delaySeconds: 60,
      pullMinutes: 10,
      push: true,
    },
    dictation: {
      engine: 'whistle',
      silenceStopSeconds: 4,
      livePhrases: true,
      voiceCommands: true,
    },
    timing: {
      adaptiveDelay: true,
      minCharacters: 0,
      indexDelay: 1200,
      hoverDelay: 320,
    },
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
      cloudflare: {
        endpoint: 'https://api.cloudflare.com/client/v4/accounts',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        protocol: 'chat',
        accountId: '',
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
    contextPackages: [],
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
    semantic: { ...defaults.semantic, ...value.settings?.semantic },
    webFacts: { ...defaults.webFacts, ...value.settings?.webFacts },
    editor: { ...defaults.editor, ...value.settings?.editor },
    git: { ...defaults.git, ...value.settings?.git },
    dictation: { ...defaults.dictation, ...value.settings?.dictation },
    timing: { ...defaults.timing, ...value.settings?.timing },
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
    contextPackages: migrateContextPackages(
      migrated.library,
      value.contextPackages
    ),
    openNoteIds,
    activeNoteId:
      value.activeNoteId && openNoteIds.includes(value.activeNoteId)
        ? value.activeNoteId
        : (openNoteIds[0] ?? null),
    settings,
  }
}

export const UNTITLED = 'Untitled'

export function newNote(
  title: string,
  context = '',
  content = '',
  filePath?: string
): Note {
  const now = Date.now()
  const named = title.trim()
  return {
    id: crypto.randomUUID(),
    title: named || UNTITLED,
    ...(named ? {} : { autoTitle: true }),
    context: context.trim(),
    objective: '',
    content,
    sources: [],
    contextPackageIds: [],
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

/** A short title from the first line of writing, without Markdown markers. */
export function titleFromContent(content: string): string {
  for (const raw of content.split('\n', 24)) {
    const line = raw
      .replace(
        /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u,
        ''
      )
      .replace(
        /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu,
        (_, target, alias) => alias ?? target
      )
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/[*_`~]+/gu, '')
      .trim()
    if (!line || /^[|:\-\s]+$/u.test(line)) continue
    if (line.length <= 80) return line
    const cut = line.slice(0, 80)
    const space = cut.lastIndexOf(' ')
    return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`
  }
  return ''
}
