import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from '@codemirror/autocomplete'
import { EditorSelection, Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { EditorSettings, Note } from '../../types/notebook'
import { noteKey } from '../../notebook/note-links'
import { tableTemplate } from './markdown-editing'

export type EditorAction = 'suggest' | 'web-facts' | 'dictate' | 'graph'

export interface EditorHost {
  settings(): EditorSettings
  /** Whether web facts are configured, so the menu can offer them. */
  webFacts(): boolean
  notes(): Note[]
  noteId(): string
  runAction(action: EditorAction): void
}

export interface SlashCommand {
  id: string
  name: string
  detail: string
  section: 'Text' | 'Lists' | 'Blocks' | 'Insert' | 'Actions' | 'Yours'
  icon: string
  keywords: string[]
  /** Replace the range `[from, to)` (trigger and query) and apply the command. */
  apply(view: EditorView, from: number, to: number): void
}

const SECTIONS: Record<SlashCommand['section'], CompletionSection> = {
  Text: { name: 'Text', rank: 0 },
  Lists: { name: 'Lists', rank: 1 },
  Blocks: { name: 'Blocks', rank: 2 },
  Insert: { name: 'Insert', rank: 3 },
  Yours: { name: 'Your commands', rank: 4 },
  Actions: { name: 'Actions', rank: 5 },
}

const BLOCK_PREFIX =
  /^(\s*)(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)?/u

/** Expand {date}, {time} and {cursor} in a template. */
export function expandTemplate(template: string, now = new Date()) {
  const date = now.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const time = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const expanded = template
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
  const cursor = expanded.indexOf('{cursor}')
  return cursor < 0
    ? { text: expanded, cursor: expanded.length }
    : {
        text:
          expanded.slice(0, cursor) +
          expanded.slice(cursor + 8).replaceAll('{cursor}', ''),
        cursor,
      }
}

/** Remove the typed trigger, then insert text at that place. */
function insertAt(
  view: EditorView,
  from: number,
  to: number,
  template: string
) {
  const { text, cursor } = expandTemplate(template)
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + cursor),
    scrollIntoView: true,
    userEvent: 'input.complete',
  })
}

/** Set the Markdown prefix of the current line (heading, list, quote). */
function setLinePrefix(
  view: EditorView,
  from: number,
  to: number,
  prefix: string
) {
  const line = view.state.doc.lineAt(from)
  const without =
    view.state.sliceDoc(line.from, from) + view.state.sliceDoc(to, line.to)
  const match = BLOCK_PREFIX.exec(without)
  const indent = match?.[1] ?? ''
  const body = without.slice(match?.[0].length ?? 0)
  const insert = indent + prefix + body
  const cursor =
    line.from + insert.length - view.state.sliceDoc(to, line.to).length
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(
      Math.max(line.from + indent.length + prefix.length, cursor)
    ),
    scrollIntoView: true,
    userEvent: 'input.complete',
  })
}

/** Insert a multi-line block on its own lines. */
function insertBlock(
  view: EditorView,
  from: number,
  to: number,
  template: string
) {
  const line = view.state.doc.lineAt(from)
  const rest =
    view.state.sliceDoc(line.from, from) + view.state.sliceDoc(to, line.to)
  if (!rest.trim()) {
    const { text, cursor } = expandTemplate(template)
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: EditorSelection.cursor(line.from + cursor),
      scrollIntoView: true,
      userEvent: 'input.complete',
    })
    return
  }
  const { text, cursor } = expandTemplate(template)
  const before = view.state.sliceDoc(line.from, from)
  const after = view.state.sliceDoc(to, line.to)
  const insert = `${before}${after}\n${text}`
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(
      line.from + before.length + after.length + 1 + cursor
    ),
    scrollIntoView: true,
    userEvent: 'input.complete',
  })
}

function wrapAt(
  view: EditorView,
  from: number,
  to: number,
  marker: string,
  placeholder: string
) {
  insertAt(view, from, to, `${marker}{cursor}${placeholder}${marker}`)
  const head = view.state.selection.main.head
  view.dispatch({
    selection: EditorSelection.range(head, head + placeholder.length),
  })
}

export function builtinCommands(host: EditorHost): SlashCommand[] {
  const line = (
    id: string,
    name: string,
    prefix: string,
    detail: string,
    section: SlashCommand['section'],
    icon: string,
    keywords: string[]
  ): SlashCommand => ({
    id,
    name,
    detail,
    section,
    icon,
    keywords,
    apply: (view, from, to) => setLinePrefix(view, from, to, prefix),
  })
  const commands: SlashCommand[] = [
    line('heading-1', 'Heading 1', '# ', 'Large section title', 'Text', 'H1', [
      'h1',
      'title',
      'header',
    ]),
    line(
      'heading-2',
      'Heading 2',
      '## ',
      'Medium section title',
      'Text',
      'H2',
      ['h2', 'subheading', 'header']
    ),
    line(
      'heading-3',
      'Heading 3',
      '### ',
      'Small section title',
      'Text',
      'H3',
      ['h3', 'subheading', 'header']
    ),
    line(
      'paragraph',
      'Plain text',
      '',
      'Remove heading, list or quote',
      'Text',
      '¶',
      ['paragraph', 'text', 'normal']
    ),
    line('quote', 'Quote', '> ', 'Quoted passage', 'Blocks', '❝', [
      'blockquote',
      'citation',
    ]),
    line(
      'bullets',
      'Bulleted list',
      '- ',
      'Simple list with bullets',
      'Lists',
      '•',
      ['ul', 'unordered', 'bullet', 'list']
    ),
    line(
      'numbers',
      'Numbered list',
      '1. ',
      'List with numbers',
      'Lists',
      '1.',
      ['ol', 'ordered', 'number', 'list']
    ),
    line('tasks', 'Task list', '- [ ] ', 'Checklist with boxes', 'Lists', '☐', [
      'todo',
      'checkbox',
      'check',
      'task',
    ]),
    {
      id: 'table',
      name: 'Table',
      detail: 'Three columns. Tab moves between cells',
      section: 'Blocks',
      icon: '▦',
      keywords: ['grid', 'columns', 'rows'],
      apply(view, from, to) {
        const template = tableTemplate(3, 2)
        insertBlock(view, from, to, template)
        // Select the first header cell so typing replaces it.
        const head = view.state.selection.main.head
        const start = head - template.length + 2
        view.dispatch({ selection: EditorSelection.range(start, start + 8) })
      },
    },
    {
      id: 'code',
      name: 'Code block',
      detail: 'Fenced code',
      section: 'Blocks',
      icon: '{}',
      keywords: ['fence', 'snippet', 'pre'],
      apply: (view, from, to) =>
        insertBlock(view, from, to, '```\n{cursor}\n```'),
    },
    {
      id: 'divider',
      name: 'Divider',
      detail: 'Horizontal rule',
      section: 'Blocks',
      icon: '—',
      keywords: ['hr', 'rule', 'separator', 'line'],
      apply: (view, from, to) => insertBlock(view, from, to, '---\n{cursor}'),
    },
    {
      id: 'link',
      name: 'Link',
      detail: 'Web address with text',
      section: 'Insert',
      icon: '↗',
      keywords: ['url', 'href', 'web'],
      apply(view, from, to) {
        insertAt(view, from, to, '[{cursor}](https://)')
      },
    },
    {
      id: 'note-link',
      name: 'Link to a note',
      detail: 'Type [[ to choose a note',
      section: 'Insert',
      icon: '[[',
      keywords: ['wiki', 'internal', 'reference', 'backlink'],
      apply(view, from, to) {
        insertAt(view, from, to, '[[{cursor}]]')
        queueMicrotask(() => {
          void import('@codemirror/autocomplete').then(({ startCompletion }) =>
            startCompletion(view)
          )
        })
      },
    },
    {
      id: 'bold',
      name: 'Bold',
      detail: '**strong text**',
      section: 'Text',
      icon: 'B',
      keywords: ['strong'],
      apply: (view, from, to) => wrapAt(view, from, to, '**', 'bold'),
    },
    {
      id: 'italic',
      name: 'Italic',
      detail: '*emphasis*',
      section: 'Text',
      icon: 'I',
      keywords: ['emphasis'],
      apply: (view, from, to) => wrapAt(view, from, to, '*', 'italic'),
    },
    {
      id: 'date',
      name: 'Today’s date',
      detail: new Date().toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }),
      section: 'Insert',
      icon: '◷',
      keywords: ['today', 'day', 'calendar'],
      apply: (view, from, to) => insertAt(view, from, to, '{date}'),
    },
    {
      id: 'time',
      name: 'Current time',
      detail: new Date().toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }),
      section: 'Insert',
      icon: '⏱',
      keywords: ['now', 'clock'],
      apply: (view, from, to) => insertAt(view, from, to, '{time}'),
    },
    {
      id: 'suggest',
      name: 'Suggest a continuation',
      detail: 'Ctrl / ⌘ Space',
      section: 'Actions',
      icon: '✦',
      keywords: ['ai', 'complete', 'continue', 'next'],
      apply(view, from, to) {
        view.dispatch({ changes: { from, to }, userEvent: 'delete' })
        host.runAction('suggest')
      },
    },
    {
      id: 'dictate',
      name: 'Dictate',
      detail: 'Ctrl / ⌘ Shift D',
      section: 'Actions',
      icon: '🎙',
      keywords: ['voice', 'speech', 'microphone', 'whistle'],
      apply(view, from, to) {
        view.dispatch({ changes: { from, to }, userEvent: 'delete' })
        host.runAction('dictate')
      },
    },
    {
      id: 'graph',
      name: 'Open the note graph',
      detail: 'Ctrl / ⌘ Shift G',
      section: 'Actions',
      icon: '◎',
      keywords: ['graph', 'map', 'links', 'network'],
      apply(view, from, to) {
        view.dispatch({ changes: { from, to }, userEvent: 'delete' })
        host.runAction('graph')
      },
    },
  ]
  if (host.webFacts())
    commands.push({
      id: 'web-facts',
      name: 'Search the web for facts',
      detail: 'Ctrl / ⌘ Shift K',
      section: 'Actions',
      icon: '⌕',
      keywords: ['research', 'fact', 'search', 'web', 'source', 'cite'],
      apply(view, from, to) {
        view.dispatch({ changes: { from, to }, userEvent: 'delete' })
        host.runAction('web-facts')
      },
    })
  return commands
}

/** Built-in entries plus the writer's own. A custom name replaces a built-in. */
export function slashCommands(host: EditorHost): SlashCommand[] {
  const custom = host
    .settings()
    .customCommands.map((command): SlashCommand => ({
      id: `custom-${command.id}`,
      name: command.name.trim(),
      detail: command.template.replace(/\s+/gu, ' ').slice(0, 48),
      section: 'Yours',
      icon: '★',
      keywords: [],
      apply(view, from, to) {
        if (command.template.includes('\n'))
          insertBlock(view, from, to, command.template)
        else insertAt(view, from, to, command.template)
      },
    }))
  const names = new Set(custom.map(command => command.name.toLocaleLowerCase()))
  return [
    ...builtinCommands(host).filter(
      command => !names.has(command.name.toLocaleLowerCase())
    ),
    ...custom,
  ]
}

/** Score a command for a query. Higher is better; null is no match. */
export function commandScore(
  command: Pick<SlashCommand, 'name' | 'keywords'>,
  query: string
): number | null {
  const needle = query.toLocaleLowerCase()
  if (!needle) return 0
  const name = command.name.toLocaleLowerCase()
  if (name.startsWith(needle)) return 100 - name.length
  const words = name.split(/\s+/u)
  if (words.some(word => word.startsWith(needle))) return 80 - name.length
  if (command.keywords.some(keyword => keyword.startsWith(needle))) return 60
  if (name.includes(needle)) return 40
  // Subsequence match, for example "bl" for "Bulleted list".
  let position = 0
  for (const character of name) if (character === needle[position]) position++
  return position === needle.length ? 20 : null
}

function inCode(context: CompletionContext) {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null =
      syntaxTree(context.state).resolveInner(context.pos, -1);
    node;
    node = node.parent
  )
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText)$/u.test(node.name))
      return true
  return false
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function slashSource(host: EditorHost) {
  return (context: CompletionContext): CompletionResult | null => {
    const settings = host.settings()
    if (!settings.slashMenu) return null
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(
      Math.max(line.from, context.pos - 40),
      context.pos
    )
    const match = new RegExp(
      `(?:^|[\\s([{>])${escapeRegExp(settings.slashTrigger)}([\\p{L}\\p{N}-]{0,24})$`,
      'u'
    ).exec(before)
    if (!match || inCode(context)) return null
    const query = match[1] ?? ''
    const from = context.pos - query.length
    const ranked = slashCommands(host)
      .map(command => ({ command, score: commandScore(command, query) }))
      .filter(
        (item): item is { command: SlashCommand; score: number } =>
          item.score !== null
      )
      .sort((a, b) => (query ? b.score - a.score : 0))
    if (!ranked.length) return null
    return {
      from,
      to: context.pos,
      filter: false,
      options: ranked.map(({ command }, index): Completion => ({
        label: command.name,
        detail: command.detail,
        type: `slash slash-${command.id}`,
        section: query ? undefined : SECTIONS[command.section],
        boost: query ? 99 - index : undefined,
        apply: (view, _completion, applyFrom, applyTo) =>
          command.apply(
            view,
            applyFrom - settings.slashTrigger.length,
            applyTo
          ),
        info: undefined,
        ...{ icon: command.icon },
      })),
    }
  }
}

function excerpt(note: Note) {
  const text = note.content
    .slice(0, 600)
    .replace(/[#>*_`[\]]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return text.length > 140 ? `${text.slice(0, 140)}…` : text
}

export function wikiLinkSource(host: EditorHost) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(
      Math.max(line.from, context.pos - 120),
      context.pos
    )
    const match = /\[\[([^[\]\n|#]{0,100})$/u.exec(before)
    if (!match || inCode(context)) return null
    const query = match[1] ?? ''
    const from = context.pos - query.length
    const needle = noteKey(query)
    const after = context.state.sliceDoc(
      context.pos,
      Math.min(line.to, context.pos + 2)
    )
    const closing = after === ']]' ? '' : ']]'
    const current = host.noteId()
    const notes = host
      .notes()
      .filter(note => note.id !== current)
      .map(note => {
        const key = noteKey(note.title)
        const score = !needle
          ? 0
          : key === needle
            ? 1000
            : key.startsWith(needle)
              ? 500
              : key.split(' ').some(word => word.startsWith(needle))
                ? 300
                : key.includes(needle)
                  ? 100
                  : -1
        return { note, score }
      })
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt)
      .slice(0, 40)
    const options: Completion[] = notes.map(({ note }, index) => ({
      label: note.title,
      detail: excerpt(note) ? undefined : 'Empty note',
      info: excerpt(note) || undefined,
      type: 'note',
      boost: 50 - index,
      apply: (view, _completion, applyFrom, applyTo) => {
        const insert = `${note.title.replace(/[[\]|#\n]/gu, ' ')}${closing}`
        view.dispatch({
          changes: { from: applyFrom, to: applyTo, insert },
          selection: EditorSelection.cursor(
            applyFrom + insert.length + (closing ? 0 : 2)
          ),
          userEvent: 'input.complete',
        })
      },
    }))
    if (query.trim() && !notes.some(item => item.score === 1000))
      options.push({
        label: query.trim(),
        detail: 'New link · create the note later',
        type: 'note-new',
        boost: -99,
        apply: (view, _completion, applyFrom, applyTo) => {
          const insert = `${query.trim()}${closing}`
          view.dispatch({
            changes: { from: applyFrom, to: applyTo, insert },
            selection: EditorSelection.cursor(
              applyFrom + insert.length + (closing ? 0 : 2)
            ),
            userEvent: 'input.complete',
          })
        },
      })
    return options.length
      ? { from, to: context.pos, filter: false, options }
      : null
  }
}

/** Completion keys only act while the menu is open, so ghost text keeps Tab. */
const completionKeys = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: moveCompletionSelection(true) },
    { key: 'ArrowUp', run: moveCompletionSelection(false) },
    { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
    { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
    { key: 'Enter', run: acceptCompletion },
    { key: 'Tab', run: acceptCompletion },
    { key: 'Escape', run: closeCompletion },
  ])
)

export function editorCompletions(host: EditorHost): Extension {
  return [
    autocompletion({
      override: [slashSource(host), wikiLinkSource(host)],
      defaultKeymap: false,
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      selectOnOpen: true,
      // A quick “/h2 Enter” is deliberate; do not swallow the Enter.
      interactionDelay: 0,
      closeOnBlur: true,
      icons: false,
      maxRenderedOptions: 60,
      tooltipClass: () => 'cm-insert-menu',
      addToOptions: [
        {
          position: 20,
          render(completion) {
            const icon = (completion as Completion & { icon?: string }).icon
            const element = document.createElement('span')
            element.className = `cm-insert-icon cm-insert-icon-${completion.type?.split(' ')[0] ?? 'text'}`
            element.setAttribute('aria-hidden', 'true')
            element.textContent =
              icon ??
              (completion.type === 'note'
                ? '◇'
                : completion.type === 'note-new'
                  ? '+'
                  : '')
            return element
          },
        },
      ],
    }),
    completionKeys,
  ]
}

export function completionOpen(view: EditorView) {
  return completionStatus(view.state) !== null
}
