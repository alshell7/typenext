export type ProviderId =
  'openrouter' | 'openai' | 'anthropic' | 'cloudflare' | 'local' | 'custom'
export type CompletionProtocol = 'chat' | 'fim'

export interface ProviderProfile {
  endpoint: string
  model: string
  savedModels?: string[]
  protocol: CompletionProtocol
  /** Cloudflare only: the account that owns Workers AI. */
  accountId?: string
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

export type EmbeddingDimensions = 128 | 256 | 512 | 768
export type EmbeddingQuantization = 'UD-Q4_K_XL' | 'Q8_0'

/** Semantic retrieval with EmbeddingGemma 2, beside the lexical BM25 index. */
export interface SemanticSettings {
  enabled: boolean
  /** managed: TypeNext installs and runs llama.cpp. server: the writer runs it. */
  runtime: 'managed' | 'server'
  /** Base URL of a llama.cpp server started with --embeddings (server mode). */
  endpoint: string
  quantization: EmbeddingQuantization
  /** Matryoshka truncation. Vectors are re-normalized after truncation. */
  dimensions: EmbeddingDimensions
  /** Load the vision and audio encoder for image, audio and video sources. */
  media: boolean
}

/** Optional OpenAI web search that returns cited facts as insertions. */
export interface WebFactSettings {
  enabled: boolean
  model: string
  /** Also ground Ctrl/Command + Space choices with web facts. */
  withSuggestions: boolean
}

/** sidebars: hide side panels. chrome: also toolbars and tabs. full: only the page. */
export type ZenLevel = 'sidebars' | 'chrome' | 'full'

export interface SlashCommandSetting {
  id: string
  name: string
  /** Markdown to insert. {cursor} marks the caret, {date} and {time} expand. */
  template: string
}

export interface EditorSettings {
  slashMenu: boolean
  /** One character that opens the insert menu at the start of a word. */
  slashTrigger: string
  /** Writer-defined entries. A matching name replaces a built-in entry. */
  customCommands: SlashCommandSetting[]
  /** Render bullets, tasks, rules and tables when the cursor is elsewhere. */
  livePreview: boolean
  /** notes: previews of linked notes only. all: also fetch website titles. */
  linkPreviews: 'off' | 'notes' | 'all'
  /** A small format bar above selected text. */
  selectionToolbar: boolean
  /** Keep the line being written near the middle of the window. */
  typewriter: boolean
  /** Dim everything except the current paragraph or sentence. */
  focus: 'off' | 'paragraph' | 'sentence'
  /** Full zen turns on typewriter scrolling and paragraph focus. */
  zenFocus: boolean
  /** -- → —, ... → …, -> → →. */
  smartTypography: boolean
  /** Words to write each day. 0 hides the goal. */
  dailyGoal: number
  /** Show only a link's text until the cursor enters it. */
  foldLinks: boolean
}

/** Synchronize notes as Markdown files in a Git repository (desktop). */
export interface GitSyncSettings {
  enabled: boolean
  /** Absolute path of the repository folder. */
  folder: string
  autoSync: boolean
  /** Commit and push this many seconds after writing stops (10 to 3600). */
  delaySeconds: number
  /** Look for remote changes this often in minutes. 0 checks only on start. */
  pullMinutes: number
  push: boolean
}

export type CloudBackend = 'neon' | 'd1'

/**
 * One database that holds the encrypted notebook. Credentials live in the
 * credential vault, never here. Field names must not end in "key" or
 * "token": the desktop save drops such fields as possible credentials.
 */
export interface CloudTarget {
  id: string
  kind: CloudBackend
  /** Shown in Preferences: the database name or host. */
  label: string
  enabled: boolean
  /** Neon: Live updates through Neon Realtime. */
  realtimeUrl?: string
  /** Cloudflare D1: the account and database. */
  accountId?: string
  databaseId?: string
  /** The encrypted notebook this database holds. */
  vaultId?: string
  addedAt: number
}

export interface CloudSyncInclude {
  notes: boolean
  /** Folders, tags and workspaces. */
  organize: boolean
  /** The context library and its contexts. */
  contexts: boolean
  /** Appearance, editor, suggestion and shortcut preferences. */
  settings: boolean
}

/** End-to-end encrypted sync between devices. This device only. */
export interface CloudSyncSettings {
  enabled: boolean
  /** live: moments after writing, and at once from other devices. */
  cadence: 'live' | 'interval' | 'manual'
  /** For interval: sync this often (1 to 1440). */
  intervalMinutes: number
  include: CloudSyncInclude
  /** Workspaces to sync. Empty: every workspace. */
  spaceIds: string[]
  /** How this device appears to the others. Empty: a name from the platform. */
  deviceName: string
  /** Show which devices are open on the same note. */
  presence: boolean
  targets: CloudTarget[]
}

export interface DictationSettings {
  /** whistle: small in-app model. fluid: Fluid Speech Mini (desktop). */
  engine: 'whistle' | 'fluid'
  /** Stop listening after this many seconds of silence. 0 never stops. */
  silenceStopSeconds: number
  /** Insert finished phrases while speaking, at natural pauses. */
  livePhrases: boolean
  /** Spoken “new line”, “new paragraph” and punctuation words. */
  voiceCommands: boolean
}

export interface UpdateSettings {
  /** Look for a new version on GitHub after launch and every few hours. */
  autoCheck: boolean
  /** Download a found version in the background, ready to install. */
  autoDownload: boolean
}

/** The small animation shown while a model works. */
export type AiIndicatorStyle =
  | 'orb'
  | 'spark'
  | 'bloom'
  | 'firefly'
  | 'ink'
  | 'dots'
  | 'orbit'
  | 'scribble'
  | 'off'

export type AiActionId =
  'polish' | 'grammar' | 'rewrite' | 'paraphrase' | 'shorter' | 'longer'

export interface AiSettings {
  /** Polish, fix grammar, rewrite and more for selected text. */
  selectionActions: boolean
  indicator: AiIndicatorStyle
}

/**
 * Writer-chosen keys in CodeMirror notation (for example "Mod-Space").
 * Field names must not end in "key": the desktop save drops such fields as
 * possible credentials.
 */
export interface ShortcutSettings {
  /** Ask for suggestion choices at the cursor. */
  suggest: string
  /** Accept one word of the inline suggestion. */
  acceptWord: string
  /** Open the AI actions for the selected text. */
  aiActions: string
}

/** Local revisions of each note, kept beside the notebook. */
export interface RevisionSettings {
  enabled: boolean
  /** automatic: after writing pauses. manual: only when asked. */
  mode: 'automatic' | 'manual'
  /** Characters added or removed before a pause becomes a revision. */
  minChanges: number
  /** At least this many minutes between automatic revisions. */
  minMinutes: number
  /** Revisions kept per note. Named and pinned revisions are always kept. */
  keep: number
  /** Keep the text before an AI edit, a restore or a large deletion. */
  safetyNet: boolean
}

export interface TimingSettings {
  /** Wait longer while typing quickly, and less after a pause or accept. */
  adaptiveDelay: boolean
  /** Characters written in the current line before automatic suggestions. */
  minCharacters: number
  /** Milliseconds after edits before the meaning index updates. */
  indexDelay: number
  /** Milliseconds a pointer rests on a link before its preview opens. */
  hoverDelay: number
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
  /** Most words in one suggestion. 0 lets the length setting decide. */
  suggestionWords: number
  externalAutoEnabled: boolean
  suggestionInstructions: string
  localEngine: 'recall' | 'embedded' | 'server'
  provider: ProviderId
  externalProvider: Exclude<ProviderId, 'local'>
  profiles: Record<ProviderId, ProviderProfile>
  websiteImporter: 'direct' | 'firecrawl'
  semantic: SemanticSettings
  webFacts: WebFactSettings
  zenLevel: ZenLevel
  editor: EditorSettings
  git: GitSyncSettings
  cloud: CloudSyncSettings
  dictation: DictationSettings
  timing: TimingSettings
  updates: UpdateSettings
  ai: AiSettings
  shortcuts: ShortcutSettings
  revisions: RevisionSettings
}

export type MediaKind = 'image' | 'audio' | 'video'

/** Media is embedded once at import. The original file is not stored. */
export interface MediaInfo {
  mime: string
  bytes: number
  durationSeconds?: number
  width?: number
  height?: number
  /** Small JPEG data URL for images and video posters (at most 64 KB). */
  thumbnail?: string
  /** Base64 little-endian Float32 vector at full model width (768). */
  vector?: string
  /** Model identity that produced the vector. */
  vectorModel?: string
}

export interface ContextSource {
  id: string
  name: string
  kind: 'text' | 'markdown' | 'pdf' | 'docx' | 'website' | 'note' | MediaKind
  /** For media sources: the caption and file name used for search and prompts. */
  text: string
  origin?: string
  linkedNoteId?: string
  libraryId?: string
  folder?: string
  enabled: boolean
  addedAt: number
  media?: MediaInfo
}

export interface ContextPackage {
  id: string
  name: string
  /** Workspaces that can use this context. Absent: every workspace. */
  spaceIds?: string[]
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
  /** The title follows the first line until the writer names the note. */
  autoTitle?: boolean
  /** The folder that holds the note. Absent: the notebook root. */
  folderId?: string
  /** Tag ids from the workspace tag list. */
  tags?: string[]
  /** Folders whose notes are live context for this note. */
  contextFolderIds?: string[]
  /** The workspace that holds the note. Absent: the first workspace. */
  spaceId?: string
}

/** Named colours that adapt to light and dark appearances. */
export type OrganizeColor =
  'sage' | 'sky' | 'iris' | 'plum' | 'rose' | 'amber' | 'sand' | 'slate'

export interface NoteFolder {
  id: string
  name: string
  /** Absent: a top-level folder. */
  parentId?: string
  color?: OrganizeColor
  createdAt: number
  /** Collapsed in the sidebar. */
  collapsed?: boolean
  spaceId?: string
}

export interface NoteTag {
  id: string
  name: string
  color: OrganizeColor
  createdAt: number
  spaceId?: string
}

/**
 * A workspace: its own notes, folders, tags and contexts, like a browser
 * profile. A shared workspace's items also appear in every other workspace.
 */
export interface NoteSpace {
  id: string
  name: string
  color: OrganizeColor
  /** An icon id from space-icons.ts; absent shows the first letter. */
  icon?: string
  /** Also show this workspace's notes, folders and tags everywhere. */
  shared?: boolean
  /** This workspace's Git repository folder (desktop). The first workspace
   * uses the folder in Preferences → Sync. */
  gitFolder?: string
  createdAt: number
  /** Tabs and the open note when the writer last left the workspace. */
  openNoteIds?: string[]
  activeNoteId?: string | null
}

export interface Workspace {
  version: 1
  contextLibrary?: ContextSource[]
  contextPackages?: ContextPackage[]
  folders?: NoteFolder[]
  tags?: NoteTag[]
  spaces?: NoteSpace[]
  activeSpaceId?: string
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
  /** How the passage was found. Hybrid hits matched both indexes. */
  match?: 'lexical' | 'semantic' | 'hybrid'
  mediaKind?: MediaKind
}

export interface SuggestionCandidate {
  text: string
  sources: string[]
  mode?: 'model' | 'recall' | 'starter' | 'web'
  /** Web citations for mode 'web'. */
  citations?: { title: string; url: string }[]
}

export interface SuggestionResult extends SuggestionCandidate {
  /** At most two additional distinct insertions at the same cursor. */
  alternatives?: SuggestionCandidate[]
}

export interface SuggestionRequestOptions {
  /** Manual hosted choices use one fresh request; ordinary inline text stays plain. */
  purpose?: 'inline' | 'alternatives'
}
