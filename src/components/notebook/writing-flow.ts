import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  showTooltip,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { insertLink, wrapSelection } from './markdown-editing'

/**
 * Small writing aids that stay out of the way: a format bar for a selection,
 * typewriter scrolling, focus dimming, smart typography and smart link paste.
 */
export interface FlowHost {
  selectionToolbar(): boolean
  typewriter(): boolean
  focus(): 'off' | 'paragraph' | 'sentence'
  smartTypography(): boolean
  webFacts(): boolean
  runWebFacts(): void
  /** A page title for a pasted address, or null. */
  linkTitle?(url: string): Promise<string | null>
}

function inCode(state: EditorState, pos: number) {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null =
      syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  )
    if (/^(FencedCode|CodeBlock|InlineCode|CodeText)$/u.test(node.name)) return true
  return false
}

// ---------------------------------------------------------------- Format bar

const setPointerDown = StateEffect.define<boolean>()
/** Dispatch when a writing-flow setting changes outside the editor. */
export const refreshFlow = StateEffect.define<null>()

const pointerDown = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setPointerDown)) value = effect.value
    return value
  },
})

interface BarAction {
  label: string
  title: string
  run(view: EditorView): void
}

function barActions(host: FlowHost): BarAction[] {
  const actions: BarAction[] = [
    { label: 'B', title: 'Bold', run: view => wrapSelection(view, '**') },
    { label: 'I', title: 'Italic', run: view => wrapSelection(view, '*') },
    { label: 'S', title: 'Strikethrough', run: view => wrapSelection(view, '~~') },
    { label: '</>', title: 'Code', run: view => wrapSelection(view, '`') },
    { label: '↗', title: 'Link', run: view => insertLink(view) },
    {
      label: '[[ ]]',
      title: 'Link to a note',
      run: view => wrapSelection(view, '[[', ']]'),
    },
    {
      label: '“ ”',
      title: 'Quote',
      run: view => {
        const { state } = view
        const range = state.selection.main
        const first = state.doc.lineAt(range.from).number
        const last = state.doc.lineAt(range.to).number
        const changes = []
        for (let number = first; number <= last; number++) {
          const line = state.doc.line(number)
          if (!line.text.startsWith('> ')) changes.push({ from: line.from, insert: '> ' })
        }
        view.dispatch({ changes, userEvent: 'input.format' })
      },
    },
  ]
  if (host.webFacts())
    actions.push({ label: '⌕ Facts', title: 'Search the web for facts', run: () => host.runWebFacts() })
  return actions
}

function formatBarTooltip(state: EditorState, host: FlowHost): Tooltip | null {
  const range = state.selection.main
  if (
    !host.selectionToolbar() ||
    state.selection.ranges.length !== 1 ||
    range.empty ||
    state.field(pointerDown) ||
    inCode(state, range.from)
  )
    return null
  return {
    pos: range.from,
    end: range.to,
    above: true,
    strictSide: false,
    arrow: false,
    create: view => {
      const dom = document.createElement('div')
      dom.className = 'cm-format-bar'
      dom.setAttribute('role', 'toolbar')
      dom.setAttribute('aria-label', 'Format selection')
      for (const action of barActions(host)) {
        const button = dom.appendChild(document.createElement('button'))
        button.type = 'button'
        button.textContent = action.label
        button.title = action.title
        button.setAttribute('aria-label', action.title)
        button.tabIndex = -1
        button.addEventListener('mousedown', event => event.preventDefault())
        button.addEventListener('click', event => {
          event.preventDefault()
          action.run(view)
          view.focus()
        })
      }
      return { dom, offset: { x: 0, y: 6 } }
    },
  }
}

function formatBar(host: FlowHost): Extension {
  const field = StateField.define<Tooltip | null>({
    create: state => formatBarTooltip(state, host),
    update(tooltip, transaction) {
      if (!transaction.docChanged && !transaction.selection && !transaction.effects.some(effect => effect.is(setPointerDown)))
        return tooltip
      const next = formatBarTooltip(transaction.state, host)
      // Keep one tooltip object while the selection only moves, so the bar
      // does not flicker or replay its entrance.
      if (tooltip && next) return { ...tooltip, pos: next.pos, end: next.end }
      return next
    },
    provide: field => showTooltip.from(field),
  })
  return [
    pointerDown,
    field,
    EditorView.domEventHandlers({
      mousedown(_event, view) {
        view.dispatch({ effects: setPointerDown.of(true) })
        const up = () => {
          window.removeEventListener('mouseup', up)
          // The bar appears after the selection settles.
          setTimeout(() => {
            if (view.dom.isConnected) view.dispatch({ effects: setPointerDown.of(false) })
          }, 0)
        }
        window.addEventListener('mouseup', up)
        return false
      },
    }),
  ]
}

// ---------------------------------------------------------------- Focus

function focusDecorations(view: EditorView, mode: 'paragraph' | 'sentence'): DecorationSet {
  const { state } = view
  if (!view.hasFocus) return Decoration.none
  const head = state.selection.main.head
  const doc = state.doc
  const cursorLine = doc.lineAt(head)
  // The current paragraph is the run of non-blank lines around the cursor.
  let first = cursorLine.number
  let last = cursorLine.number
  while (first > 1 && doc.line(first - 1).text.trim()) first--
  while (last < doc.lines && doc.line(last + 1).text.trim()) last++
  const decorations: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos)
      if (line.number < first || line.number > last)
        decorations.push(Decoration.line({ class: 'cm-flow-dim' }).range(line.from))
      pos = line.to + 1
    }
  }
  if (mode === 'sentence') {
    const start = doc.line(first).from
    const end = doc.line(last).to
    const text = doc.sliceString(start, end)
    const offset = head - start
    const before = text.slice(0, offset)
    const boundary = Math.max(
      ...['. ', '! ', '? ', '\n'].map(mark => {
        const index = before.lastIndexOf(mark)
        return index < 0 ? -1 : index + mark.length
      })
    )
    const sentenceStart = Math.max(0, boundary)
    const rest = text.slice(offset)
    const ends = [rest.search(/[.!?](?:\s|$)/u), rest.indexOf('\n')].filter(index => index >= 0)
    const sentenceEnd = ends.length ? offset + Math.min(...ends) + 1 : text.length
    if (sentenceStart > 0)
      decorations.push(Decoration.mark({ class: 'cm-flow-dim-text' }).range(start, start + sentenceStart))
    if (sentenceEnd < text.length)
      decorations.push(Decoration.mark({ class: 'cm-flow-dim-text' }).range(start + sentenceEnd, end))
  }
  return Decoration.set(decorations, true)
}

function focusDimming(host: FlowHost): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(readonly view: EditorView) {
        const mode = host.focus()
        this.decorations = mode === 'off' ? Decoration.none : focusDecorations(view, mode)
      }
      update(update: ViewUpdate) {
        const mode = host.focus()
        if (mode === 'off') {
          this.decorations = Decoration.none
          return
        }
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.focusChanged ||
          update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshFlow)))
        )
          this.decorations = focusDecorations(update.view, mode)
      }
    },
    { decorations: plugin => plugin.decorations }
  )
}

// ---------------------------------------------------------------- Typewriter

/** Keep the line being written near the middle of the window. */
function typewriter(host: FlowHost): Extension {
  return EditorView.updateListener.of(update => {
    if (!host.typewriter() || !update.view.hasFocus) return
    if (!update.transactions.some(transaction => transaction.isUserEvent('input') || transaction.isUserEvent('delete')))
      return
    const head = update.state.selection.main.head
    const line = update.state.doc.lineAt(head).number
    const previous = update.startState.doc.lineAt(update.startState.selection.main.head).number
    // Re-centre when the writer moves to another line, not on every key.
    if (line === previous && update.startState.doc.lines === update.state.doc.lines) return
    requestAnimationFrame(() => {
      if (!update.view.dom.isConnected) return
      update.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) })
    })
  })
}

// ---------------------------------------------------------------- Typography

const REPLACEMENTS: [string, string][] = [
  ['--', '—'],
  ['...', '…'],
  ['->', '→'],
  ['<-', '←'],
]

/** Replace typed ASCII shortcuts with typographic characters outside code. */
export function smartReplacement(before: string, typed: string): { remove: number; insert: string } | null {
  for (const [ascii, glyph] of REPLACEMENTS) {
    if (typed !== ascii.at(-1)) continue
    const prefix = ascii.slice(0, -1)
    if (!before.endsWith(prefix)) continue
    // Keep Markdown rules ("---"), list markers and table delimiters intact.
    if (ascii === '--' && /^\s*$|\|\s*$/u.test(before.slice(0, -1))) return null
    if (ascii === '--' && before.endsWith('—')) return null
    return { remove: prefix.length, insert: glyph }
  }
  return null
}

function typography(host: FlowHost): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (!host.smartTypography() || text.length !== 1 || from !== to) return false
    const line = view.state.doc.lineAt(from)
    const before = view.state.sliceDoc(line.from, from)
    const replacement = smartReplacement(before, text)
    // An unclosed backtick is code the parser cannot see yet.
    const openCode = (before.match(/`/gu)?.length ?? 0) % 2 === 1
    if (!replacement || openCode || inCode(view.state, from)) return false
    view.dispatch({
      changes: { from: from - replacement.remove, to, insert: replacement.insert },
      selection: EditorSelection.cursor(from - replacement.remove + replacement.insert.length),
      userEvent: 'input.type',
    })
    return true
  })
}

// ---------------------------------------------------------------- Paste

const URL_ONLY = /^https?:\/\/[^\s<>()]{3,2000}$/iu

/** Paste an address as a Markdown link, then use the page title as its text. */
function smartPaste(host: FlowHost): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
      const range = view.state.selection.main
      // With a selection, the Markdown package already links the selection.
      if (!URL_ONLY.test(text) || !range.empty || inCode(view.state, range.from)) return false
      const before = view.state.sliceDoc(Math.max(0, range.from - 2), range.from)
      if (before.endsWith('](') || before.endsWith('<')) return false
      event.preventDefault()
      const label = text.replace(/^https?:\/\/(?:www\.)?/iu, '').replace(/\/$/u, '')
      const insert = `[${label}](${text})`
      view.dispatch({
        changes: { from: range.from, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        userEvent: 'input.paste',
      })
      const start = range.from
      void host.linkTitle?.(text).then(title => {
        const clean = title?.replace(/[[\]\n]/gu, ' ').trim()
        if (!clean || !view.dom.isConnected) return
        // Replace the label only if the writer has not changed the link.
        const current = view.state.sliceDoc(start, start + insert.length)
        if (current !== insert) return
        view.dispatch({
          changes: { from: start + 1, to: start + 1 + label.length, insert: clean },
          userEvent: 'input.paste',
        })
      })
      return true
    },
  })
}

export const writingFlowTheme = EditorView.baseTheme({
  '.cm-flow-dim': { opacity: '0.32', transition: 'opacity 160ms ease-out' },
  '.cm-flow-dim-text': { opacity: '0.4' },
  '.cm-tooltip.cm-tooltip-format, .cm-tooltip:has(> .cm-format-bar)': {
    background: 'transparent',
    border: '0',
  },
})

export function writingFlow(host: FlowHost): Extension {
  return [
    formatBar(host),
    focusDimming(host),
    typewriter(host),
    typography(host),
    smartPaste(host),
    writingFlowTheme,
  ]
}
