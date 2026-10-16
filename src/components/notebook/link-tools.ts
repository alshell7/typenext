import {
  StateEffect,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  hoverTooltip,
  keymap,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Note } from '../../types/notebook'
import {
  backlinks,
  parseWikiLinks,
  resolveNoteLink,
} from '../../notebook/note-links'
import { relativeDate } from '../../notebook/model'
import { fetchLinkPreview, linkHost } from '../../services/link-preview'

export interface LinkHost {
  notes(): Note[]
  noteId(): string
  previews(): 'off' | 'notes' | 'all'
  /** Milliseconds before a hover card opens. Read when the editor opens. */
  hoverDelay?(): number
  openNote(id: string): void
  createNote(title: string): void
  openUrl(url: string): void
}

export type FoundLink =
  | { kind: 'note'; from: number; to: number; target: string; label?: string }
  | { kind: 'url'; from: number; to: number; url: string; label?: string }

/** Dispatch after note titles change so link styles follow. */
export const refreshLinks = StateEffect.define<null>()

const SAFE_URL = /^(?:https?:\/\/|mailto:)/iu

function normalizeUrl(raw: string): string | null {
  const url = raw.trim().replace(/^<|>$/gu, '')
  if (/^www\./iu.test(url)) return `https://${url}`
  return SAFE_URL.test(url) ? url : null
}

/** The wiki link, Markdown link or bare URL at `pos`, if any. */
export function linkAt(state: EditorState, pos: number): FoundLink | null {
  const line = state.doc.lineAt(pos)
  for (const link of parseWikiLinks(line.text)) {
    const from = line.from + link.from
    const to = line.from + link.to
    if (pos >= from && pos <= to)
      return {
        kind: 'note',
        from,
        to,
        target: link.target,
        ...(link.label ? { label: link.label } : {}),
      }
  }
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null =
      syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name === 'Link' || node.name === 'Image') {
      const urlNode = node.getChild('URL')
      const url = urlNode
        ? normalizeUrl(state.sliceDoc(urlNode.from, urlNode.to))
        : null
      if (!url) return null
      const text = state.sliceDoc(node.from, node.to)
      const label = /^!?\[([^\]]*)\]/u.exec(text)?.[1]
      return {
        kind: 'url',
        from: node.from,
        to: node.to,
        url,
        ...(label ? { label } : {}),
      }
    }
    if (node.name === 'URL' || node.name === 'Autolink') {
      const url = normalizeUrl(state.sliceDoc(node.from, node.to))
      return url ? { kind: 'url', from: node.from, to: node.to, url } : null
    }
  }
  return null
}

function linkDecorations(view: EditorView, host: LinkHost): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const notes = host.notes()
  for (const { from, to } of view.visibleRanges) {
    const first = view.state.doc.lineAt(from).number
    const last = view.state.doc.lineAt(to).number
    for (let number = first; number <= last; number++) {
      const line = view.state.doc.line(number)
      if (!line.text.includes('[[')) continue
      for (const link of parseWikiLinks(line.text)) {
        const start = line.from + link.from
        const end = line.from + link.to
        const resolved = resolveNoteLink(link.target, notes)
        decorations.push(
          Decoration.mark({ class: 'cm-wikilink-bracket' }).range(
            start,
            start + 2
          ),
          Decoration.mark({
            class: resolved ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-missing',
            attributes: { 'data-link-target': link.target },
          }).range(start + 2, end - 2),
          Decoration.mark({ class: 'cm-wikilink-bracket' }).range(end - 2, end)
        )
      }
    }
  }
  return Decoration.set(decorations, true)
}

function linkStyles(host: LinkHost) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = linkDecorations(view, host)
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.transactions.some(transaction =>
            transaction.effects.some(effect => effect.is(refreshLinks))
          )
        )
          this.decorations = linkDecorations(update.view, host)
      }
    },
    { decorations: plugin => plugin.decorations }
  )
}

function button(label: string, onClick: () => void, primary = false) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `cm-link-card-button${primary ? ' primary' : ''}`
  element.textContent = label
  element.addEventListener('mousedown', event => event.preventDefault())
  element.addEventListener('click', event => {
    event.preventDefault()
    onClick()
  })
  return element
}

function excerpt(text: string) {
  const plain = text
    .slice(0, 1200)
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu,
      (_, target: string, label?: string) => label ?? target
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`>~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return plain.length > 260 ? `${plain.slice(0, 260)}…` : plain
}

export function openShortcut() {
  return typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/u.test(navigator.platform)
    ? '⌘-click'
    : 'Ctrl-click'
}

function noteCard(
  link: Extract<FoundLink, { kind: 'note' }>,
  host: LinkHost
): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-link-card'
  const notes = host.notes()
  const target = resolveNoteLink(link.target, notes)
  const kind = dom.appendChild(document.createElement('div'))
  kind.className = 'cm-link-card-kind'
  kind.textContent = target ? 'Note' : 'Not written yet'
  const title = dom.appendChild(document.createElement('strong'))
  title.className = 'cm-link-card-title'
  title.textContent = target?.title ?? link.target
  if (target) {
    const meta = dom.appendChild(document.createElement('div'))
    meta.className = 'cm-link-card-meta'
    const count = backlinks(target, notes).length
    meta.textContent = `Edited ${relativeDate(target.updatedAt).toLocaleLowerCase()} · ${count} ${count === 1 ? 'note links' : 'notes link'} here`
    const body = dom.appendChild(document.createElement('p'))
    body.className = 'cm-link-card-body'
    body.textContent = excerpt(target.content) || 'This note is empty.'
  } else {
    const body = dom.appendChild(document.createElement('p'))
    body.className = 'cm-link-card-body'
    body.textContent = 'Create the note to give this link a destination.'
  }
  const actions = dom.appendChild(document.createElement('div'))
  actions.className = 'cm-link-card-actions'
  if (target && target.id !== host.noteId())
    actions.append(button('Open note', () => host.openNote(target.id), true))
  if (!target)
    actions.append(
      button(
        `Create “${link.target}”`,
        () => host.createNote(link.target),
        true
      )
    )
  const hint = actions.appendChild(document.createElement('span'))
  hint.className = 'cm-link-card-hint'
  hint.textContent = target ? `${openShortcut()} to open` : ''
  return dom
}

function urlCard(
  link: Extract<FoundLink, { kind: 'url' }>,
  host: LinkHost
): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-link-card'
  const kind = dom.appendChild(document.createElement('div'))
  kind.className = 'cm-link-card-kind'
  kind.textContent = link.url.startsWith('mailto:')
    ? 'Email'
    : linkHost(link.url)
  const title = dom.appendChild(document.createElement('strong'))
  title.className = 'cm-link-card-title'
  title.textContent = link.label || link.url
  const body = dom.appendChild(document.createElement('p'))
  body.className = 'cm-link-card-body cm-link-card-url'
  body.textContent = link.url
  if (host.previews() === 'all' && /^https?:/iu.test(link.url)) {
    dom.classList.add('loading')
    void fetchLinkPreview(link.url).then(preview => {
      dom.classList.remove('loading')
      if (preview.title) {
        title.textContent = preview.title
        if (preview.siteName)
          kind.textContent = `${preview.siteName} · ${preview.host}`
      }
      if (preview.description) {
        const description = document.createElement('p')
        description.className = 'cm-link-card-body'
        description.textContent = preview.description
        body.before(description)
      }
    })
  }
  const actions = dom.appendChild(document.createElement('div'))
  actions.className = 'cm-link-card-actions'
  actions.append(button('Open link', () => host.openUrl(link.url), true))
  const hint = actions.appendChild(document.createElement('span'))
  hint.className = 'cm-link-card-hint'
  hint.textContent = `${openShortcut()} to open`
  return dom
}

function linkHover(host: LinkHost) {
  return hoverTooltip(
    (view, pos): Tooltip | null => {
      const mode = host.previews()
      if (mode === 'off') return null
      const link = linkAt(view.state, pos)
      if (!link) return null
      if (link.kind === 'url' && mode === 'notes') return null
      return {
        pos: link.from,
        end: link.to,
        above: true,
        create: () => ({
          dom:
            link.kind === 'note' ? noteCard(link, host) : urlCard(link, host),
        }),
      }
    },
    { hoverTime: Math.max(0, host.hoverDelay?.() ?? 320), hideOnChange: true }
  )
}

export function followLink(host: LinkHost, link: FoundLink) {
  if (link.kind === 'url') {
    host.openUrl(link.url)
    return
  }
  const target = resolveNoteLink(link.target, host.notes())
  if (target) host.openNote(target.id)
  else host.createNote(link.target)
}

export function linkTools(host: LinkHost): Extension {
  return [
    linkStyles(host),
    linkHover(host),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0)
          return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        const link = linkAt(view.state, pos)
        if (!link) return false
        event.preventDefault()
        followLink(host, link)
        return true
      },
    }),
    keymap.of([
      {
        key: 'Alt-Enter',
        run: view => {
          const link = linkAt(view.state, view.state.selection.main.head)
          if (!link) return false
          followLink(host, link)
          return true
        },
      },
    ]),
    EditorView.baseTheme({
      '.cm-wikilink': {
        color: 'var(--accent, #42644d)',
        textDecoration: 'underline',
        textDecorationColor:
          'color-mix(in srgb, currentColor 40%, transparent)',
        textUnderlineOffset: '3px',
        cursor: 'pointer',
      },
      '.cm-wikilink-missing': {
        opacity: '0.72',
        textDecorationStyle: 'dashed',
      },
      '.cm-wikilink-bracket': {
        color: 'var(--muted-foreground, #92958d)',
        opacity: '0.6',
      },
    }),
  ]
}
