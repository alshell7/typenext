export type ProviderId =
  'openrouter' | 'openai' | 'anthropic' | 'local' | 'custom'
export type CompletionProtocol = 'chat' | 'fim'

export interface ProviderProfile {
  endpoint: string
  model: string
  savedModels?: string[]
  protocol: CompletionProtocol
}

export interface PaletteColors {
  page: string
  sidebar: string
  accent: string
}

export interface PalettePreferences {
  light: 'paper' | 'linen' | 'mist' | 'contrast' | 'custom'
  dark: 'graphite' | 'midnight' | 'forest' | 'black' | 'contrast' | 'custom'
  customLight: PaletteColors
  customDark: PaletteColors
}

export interface NotebookSettings {
  theme: 'light' | 'dark' | 'system'
  palette: PalettePreferences
  fontFamily: string
  fontSize: number
  autoSave: boolean
  suggestionsEnabled: boolean
  autoSuggest: boolean
  temperature: number
  suggestionDelay: number
  maxTokens: number
  suggestionLength: 'adaptive' | 'short' | 'sentence'
  externalAutoEnabled: boolean
  suggestionInstructions: string
  localEngine: 'recall' | 'embedded' | 'server'
  provider: ProviderId
  externalProvider: Exclude<ProviderId, 'local'>
  profiles: Record<ProviderId, ProviderProfile>
  websiteImporter: 'direct' | 'firecrawl'
}

export interface ContextSource {
  id: string
  name: string
  kind: 'text' | 'markdown' | 'pdf' | 'docx' | 'website' | 'note'
  text: string
  origin?: string
  linkedNoteId?: string
  libraryId?: string
  folder?: string
  enabled: boolean
  addedAt: number
}

export interface ContextPackage {
  id: string
  name: string
  sourceIds: string[]
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  title: string
  objective: string
  context: string
  content: string
  sources: ContextSource[]
  contextPackageIds?: string[]
  createdAt: number
  updatedAt: number
  filePath?: string
  exportedAt?: number
}

export interface Workspace {
  version: 1
  contextLibrary?: ContextSource[]
  contextPackages?: ContextPackage[]
  notes: Note[]
  openNoteIds: string[]
  activeNoteId: string | null
  settings: NotebookSettings
}

export interface CursorContext {
  text: string
  cursor: number
  selectionEmpty: boolean
  /** Editor syntax can rule out starters inside a fenced or inline code span. */
  inCode?: boolean
}

export interface RetrievedChunk {
  sourceId: string
  sourceName: string
  text: string
  score: number
}

export interface SuggestionCandidate {
  text: string
  sources: string[]
  mode?: 'model' | 'recall' | 'starter'
}

export interface SuggestionResult extends SuggestionCandidate {
  /** At most two additional distinct insertions at the same cursor. */
  alternatives?: SuggestionCandidate[]
}

export interface SuggestionRequestOptions {
  /** Manual hosted choices use one fresh request; ordinary inline text stays plain. */
  purpose?: 'inline' | 'alternatives'
}
