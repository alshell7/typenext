// Product facts for the website. Keep them in step with README.md and
// docs/userguide/userguide.md; do not add numbers that the docs do not state.

export const links = {
  releases: 'https://github.com/alshell7/typenext/releases/latest',
  repo: 'https://github.com/alshell7/typenext',
  guide: 'https://github.com/alshell7/typenext/blob/main/docs/userguide/userguide.md',
  development: 'https://github.com/alshell7/typenext#development',
  license: 'https://github.com/alshell7/typenext/blob/main/LICENSE.md',
  notices: 'https://github.com/alshell7/typenext/blob/main/public/notices/THIRD-PARTY-NOTICES.md',
  issues: 'https://github.com/alshell7/typenext/issues',
  reactBits: 'https://reactbits.dev',
  reactBitsRepo: 'https://github.com/DavidHDev/react-bits',
} as const

export const repoApi = 'https://api.github.com/repos/alshell7/typenext'

export type Shot = {
  id: string
  label: string
  caption: string
  alt: string
  light: string
  /** Optional dark capture; the appearance switch shows only when present. */
  dark?: string
}

export const shots: Shot[] = [
  {
    id: 'writing',
    label: 'Writing',
    caption: 'Your notes in a narrow rail, and a broad page for the one you are writing.',
    alt: 'TypeNext with a Markdown note, a short inline continuation and an open Context panel.',
    light: 'writing-light.png',
    dark: 'writing-dark.png',
  },
  {
    id: 'insert',
    label: 'Insert menu',
    caption: 'Type / for headings, lists, tables, the date, actions and your own commands.',
    alt: 'The insert menu open in a note, listing headings, lists and tables.',
    light: 'insert-menu.png',
  },
  {
    id: 'links',
    label: 'Note links',
    caption: 'Point at a [[note link]] to read the opening lines of that note.',
    alt: 'A hover card that previews a linked note.',
    light: 'link-preview.png',
  },
  {
    id: 'context',
    label: 'Contexts',
    caption: 'The Context panel holds the intent of the note and the contexts attached to it.',
    alt: 'The Context panel with the intent of the note and attached contexts.',
    light: 'context-board.png',
  },
  {
    id: 'graph',
    label: 'Note graph',
    caption: 'Links, notes used as context, and notes not written yet.',
    alt: 'The note graph with linked notes as points and lines.',
    light: 'note-graph.png',
  },
  {
    id: 'zen',
    label: 'Zen levels',
    caption: 'Hide the side panels, the toolbars, or everything but the page.',
    alt: 'The zen mode level menu.',
    light: 'zen-levels.png',
  },
  {
    id: 'models',
    label: 'Models',
    caption: 'Keys, saved models and the recommended models of each provider.',
    alt: 'Preferences, Models pane with a model chooser.',
    light: 'preferences-models.png',
  },
  {
    id: 'knowledge',
    label: 'Semantic search',
    caption: 'Turn on semantic search with EmbeddingGemma 2, on your own device.',
    alt: 'Preferences, Knowledge pane with semantic search settings.',
    light: 'preferences-knowledge.png',
  },
]

export type Engine = { name: string; detail?: string; where: 'device' | 'external' }

export const engines: Engine[] = [
  { name: 'Writing starters & recall', detail: 'default, no setup', where: 'device' },
  { name: 'SmolLM2', detail: 'built-in · 139 MB', where: 'device' },
  { name: 'LM Studio', detail: 'local server', where: 'device' },
  { name: 'Jan', detail: 'local server', where: 'device' },
  { name: 'Lemonade', detail: 'local server', where: 'device' },
  { name: 'llama.cpp', detail: 'local server', where: 'device' },
  { name: 'EmbeddingGemma 2', detail: 'semantic search', where: 'device' },
  { name: 'Whistle', detail: 'dictation · 17 MB', where: 'device' },
  { name: 'Fluid Speech Mini', detail: 'dictation · 347 MB', where: 'device' },
  { name: 'OpenRouter', where: 'external' },
  { name: 'OpenAI', where: 'external' },
  { name: 'Anthropic', where: 'external' },
  { name: 'Cloudflare Workers AI', where: 'external' },
  { name: 'Custom endpoint', detail: 'OpenAI-compatible', where: 'external' },
]

export type ShortcutGroup = {
  title: string
  rows: { action: string; mac: string[]; other: string[] }[]
}

// From docs/userguide/userguide.md, "Keyboard shortcuts".
export const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'Suggestions',
    rows: [
      { action: 'Accept', mac: ['Tab'], other: ['Tab'] },
      { action: 'Accept one word', mac: ['⌘', '→'], other: ['Ctrl', '→'] },
      { action: 'Ask for suggestions', mac: ['⌘', 'Space'], other: ['Ctrl', 'Space'] },
      { action: 'Choose another choice', mac: ['↑', '↓'], other: ['↑', '↓'] },
      { action: 'Accept the menu choice', mac: ['Enter'], other: ['Enter'] },
      { action: 'Dismiss', mac: ['Esc'], other: ['Esc'] },
    ],
  },
  {
    title: 'Editor',
    rows: [
      { action: 'Insert menu', mac: ['/'], other: ['/'] },
      { action: 'Note link', mac: ['[['], other: ['[['] },
      { action: 'Italic', mac: ['⌘', 'I'], other: ['Ctrl', 'I'] },
      { action: 'Link', mac: ['⌘', 'K'], other: ['Ctrl', 'K'] },
      { action: 'Toggle a task', mac: ['⌘', 'Enter'], other: ['Ctrl', 'Enter'] },
      { action: 'Open the link at the cursor', mac: ['⌥', 'Enter'], other: ['Alt', 'Enter'] },
      { action: 'Search the web for facts', mac: ['⌘', '⇧', 'K'], other: ['Ctrl', 'Shift', 'K'] },
    ],
  },
  {
    title: 'Notes and window',
    rows: [
      { action: 'New note', mac: ['⌘', 'N'], other: ['Ctrl', 'N'] },
      { action: 'Command palette', mac: ['⌘', 'P'], other: ['Ctrl', 'P'] },
      { action: 'Show or hide notes', mac: ['⌘', 'B'], other: ['Ctrl', 'B'] },
      { action: 'Zen mode', mac: ['⌘', '⇧', 'F'], other: ['Ctrl', 'Shift', 'F'] },
      { action: 'Note graph', mac: ['⌘', '⇧', 'G'], other: ['Ctrl', 'Shift', 'G'] },
      { action: 'Dictation', mac: ['⌘', '⇧', 'D'], other: ['Ctrl', 'Shift', 'D'] },
      { action: 'Preferences', mac: ['⌘', ','], other: ['Ctrl', ','] },
    ],
  },
]

export type Faq = { q: string; a: string[] }

export const faqs: Faq[] = [
  {
    q: 'Is TypeNext free?',
    a: [
      'Yes. TypeNext is open source under the MIT licence. There is no TypeNext account, no subscription and no paid tier. Optional external providers bill you directly for their own models.',
    ],
  },
  {
    q: 'Does my writing leave my computer?',
    a: [
      'Not unless you turn something on. Notes, extracted references and vectors stay on your device, and files are parsed locally.',
      'An external provider, web facts, a Git remote and website link previews each send something only after you choose them. The privacy section above lists exactly what each one sends.',
    ],
  },
  {
    q: 'Do I need to download a model?',
    a: [
      'No. The default, writing starters and recall, works on your device with no setup: it recalls phrases from your writing and your references.',
      'For richer continuations, download the built-in SmolLM2 model (about 139 MB) inside TypeNext, or connect a local server such as LM Studio, Jan, Lemonade or llama.cpp.',
    ],
  },
  {
    q: 'Which systems does it run on?',
    a: [
      'Windows has a setup EXE, an MSI and a portable ZIP. Each Mac type (Apple Silicon and Intel) has a DMG and a ZIP. Linux builds from source.',
      'The release binaries are not signed by a certificate authority, so macOS and Windows can show a security prompt at the first start.',
    ],
  },
  {
    q: 'Are my notes ordinary files?',
    a: [
      'Yes. Each note is plain Markdown. Autosave keeps a recoverable previous version, and you can open and save Markdown files from anywhere on your disk.',
      'With Git sync, every note is a Markdown file in a Git repository that you choose.',
    ],
  },
  {
    q: 'Can I use my own OpenAI, Anthropic or OpenRouter key?',
    a: [
      'Yes. Add the key in Preferences → Models and choose Use continuously. On the desktop, keys stay in memory unless you choose the operating system credential vault. A local error never starts an external request.',
    ],
  },
  {
    q: 'What does semantic search download?',
    a: [
      'Inside the desktop app, TypeNext downloads a pinned llama.cpp build (about 12–20 MB) and Google EmbeddingGemma 2 (Q4 175.7 MB or Q8 309.9 MB), and checks the SHA-256 of each file. You can also use your own llama-server.',
      'If the embedding server is slow or stopped, TypeNext answers with the local BM25 index alone.',
    ],
  },
]
