import {
  EditorSelection,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { splitRow, tableAt, toggleTaskAt } from './markdown-editing'

/**
 * Live preview keeps Markdown as the source of truth. Bullets, task boxes,
 * rules and tables render as widgets only where the selection is not, so the
 * raw Markdown is always one click or arrow key away.
 */

function touches(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some(
    range => range.from <= to && range.to >= from
  )
}

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super()
  }
  override eq(other: BulletWidget) {
    return other.depth === this.depth
  }
  toDOM() {
    const element = document.createElement('span')
    element.className = 'cm-lp-bullet'
    element.setAttribute('aria-hidden', 'true')
    element.textContent = ['•', '◦', '▪'][this.depth % 3]!
    return element
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly at: number
  ) {
    super()
  }
  override eq(other: TaskWidget) {
    return other.checked === this.checked && other.at === this.at
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-task'
    box.checked = this.checked
    box.tabIndex = -1
    box.setAttribute(
      'aria-label',
      this.checked ? 'Completed task' : 'Open task'
    )
    box.addEventListener('mousedown', event => event.preventDefault())
    box.addEventListener('click', event => {
      event.preventDefault()
      const pos = view.posAtDOM(box)
      const start = view.state.sliceDoc(pos, pos + 3).startsWith('[')
        ? pos
        : this.at
      toggleTaskAt(view, start)
    })
    return box
  }
  override ignoreEvent() {
    return false
  }
}

function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const builder: Range<Decoration>[] = []
  const lines = new Set<number>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name === 'ListMark') {
          const text = state.sliceDoc(node.from, node.to)
          if (!/^[-*+]$/u.test(text)) return
          const next = state.sliceDoc(node.to, node.to + 5)
          // A task item shows only its box, not a bullet before it.
          if (/^\s\[[ xX]\]/u.test(next)) {
            if (!touches(state, node.from, node.to + 5))
              builder.push(Decoration.replace({}).range(node.from, node.to + 1))
            return
          }
          if (touches(state, node.from, node.to)) return
          let depth = 0
          for (let parent = node.node.parent; parent; parent = parent.parent)
            if (parent.name === 'BulletList' || parent.name === 'OrderedList')
              depth++
          builder.push(
            Decoration.replace({
              widget: new BulletWidget(Math.max(0, depth - 1)),
            }).range(node.from, node.to)
          )
        } else if (node.name === 'TaskMarker') {
          const checked = /[xX]/u.test(state.sliceDoc(node.from, node.to))
          const line = state.doc.lineAt(node.from)
          if (checked)
            builder.push(
              Decoration.line({ class: 'cm-lp-task-done' }).range(line.from)
            )
          if (touches(state, node.from, node.to)) return
          builder.push(
            Decoration.replace({
              widget: new TaskWidget(checked, node.from),
            }).range(node.from, node.to)
          )
        } else if (node.name === 'HorizontalRule') {
          const line = state.doc.lineAt(node.from)
          builder.push(
            Decoration.line({ class: 'cm-lp-rule' }).range(line.from)
          )
          if (!touches(state, line.from, line.to))
            builder.push(
              Decoration.mark({ class: 'cm-lp-rule-text' }).range(
                node.from,
                node.to
              )
            )
        } else if (node.name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos)
            if (!lines.has(line.from)) {
              lines.add(line.from)
              builder.push(
                Decoration.line({ class: 'cm-lp-quote' }).range(line.from)
              )
            }
            pos = line.to + 1
          }
        } else if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          for (let number = first; number <= last; number++) {
            const line = state.doc.line(number)
            if (line.from > to + 2000) break
            const edge =
              number === first
                ? ' cm-lp-code-first'
                : number === last
                  ? ' cm-lp-code-last'
                  : ''
            builder.push(
              Decoration.line({ class: `cm-lp-code${edge}` }).range(line.from)
            )
          }
          return false
        }
      },
    })
  }
  return Decoration.set(builder, true)
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = inlineDecorations(update.view)
    }
  },
  { decorations: plugin => plugin.decorations }
)

// ------------------------------------------------------------ Tables

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`)
}

/** Small, safe inline Markdown for table cells: code, bold, italic, links. */
export function renderInline(text: string): string {
  const parts: string[] = []
  let rest = text.replace(/\\\|/gu, '|')
  const pattern =
    /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~|\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)/u
  for (let guard = 0; rest && guard < 200; guard++) {
    const match = pattern.exec(rest)
    if (!match || match.index === undefined) {
      parts.push(escapeHtml(rest))
      break
    }
    parts.push(escapeHtml(rest.slice(0, match.index)))
    const [whole, code, strong, em, em2, strike, wiki, wikiLabel, label, url] =
      match
    if (code) parts.push(`<code>${escapeHtml(code)}</code>`)
    else if (strong) parts.push(`<strong>${escapeHtml(strong)}</strong>`)
    else if (em || em2) parts.push(`<em>${escapeHtml(em ?? em2 ?? '')}</em>`)
    else if (strike) parts.push(`<s>${escapeHtml(strike)}</s>`)
    else if (wiki)
      parts.push(
        `<span class="cm-lp-cell-link">${escapeHtml(wikiLabel ?? wiki)}</span>`
      )
    else if (label && url)
      parts.push(
        `<span class="cm-lp-cell-link" title="${escapeHtml(url)}">${escapeHtml(label)}</span>`
      )
    rest = rest.slice(match.index + whole.length)
  }
  return parts.join('')
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number
  ) {
    super()
  }
  override eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from
  }
  override get estimatedHeight() {
    return this.source.split('\n').length * 34
  }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-lp-table-wrap'
    const table = document.createElement('table')
    table.className = 'cm-lp-table'
    const rows = this.source.split('\n')
    const alignments = splitRow(rows[1] ?? '').map(cell =>
      /^:-+:$/u.test(cell.trim())
        ? 'center'
        : /-+:$/u.test(cell.trim())
          ? 'right'
          : 'left'
    )
    const columns = Math.max(...rows.map(row => splitRow(row).length))
    let offset = 0
    rows.forEach((row, index) => {
      const lineStart = this.from + offset
      offset += row.length + 1
      if (index === 1) return
      const tr = document.createElement('tr')
      const cells = splitRow(row)
      for (let column = 0; column < columns; column++) {
        const cell = document.createElement(index === 0 ? 'th' : 'td')
        cell.style.textAlign = alignments[column] ?? 'left'
        cell.innerHTML = renderInline(cells[column] ?? '') || '&nbsp;'
        cell.dataset.line = String(lineStart)
        cell.dataset.column = String(column)
        tr.append(cell)
      }
      ;(index === 0
        ? table.createTHead()
        : (table.tBodies[0] ?? table.createTBody())
      ).append(tr)
    })
    wrapper.append(table)
    wrapper.addEventListener('mousedown', event => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>('th, td')
      event.preventDefault()
      const start = Number(cell?.dataset.line ?? this.from)
      const column = Number(cell?.dataset.column ?? 0)
      const line = view.state.doc.lineAt(Math.min(start, view.state.doc.length))
      // Place the cursor at the end of the chosen cell's text.
      let pipes = line.text.trimStart().startsWith('|') ? -1 : 0
      let pos = line.to
      for (let index = 0; index < line.text.length; index++) {
        if (line.text[index] === '|' && line.text[index - 1] !== '\\') pipes++
        if (pipes === column + 1) {
          pos = line.from + index
          break
        }
      }
      const text = view.state.sliceDoc(line.from, pos)
      const trimmed = text.replace(/\s+$/u, '')
      view.dispatch({
        selection: EditorSelection.cursor(line.from + trimmed.length),
        scrollIntoView: true,
      })
      view.focus()
    })
    return wrapper
  }
  override ignoreEvent() {
    return false
  }
}

function tableDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const tables: { from: number; to: number }[] = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Table') {
        tables.push({
          from: state.doc.lineAt(node.from).from,
          to: state.doc.lineAt(node.to).to,
        })
        return false
      }
      // Tables only appear in container blocks; skip leaf blocks quickly.
      if (
        !/^(Document|Blockquote|BulletList|OrderedList|ListItem)$/u.test(
          node.name
        )
      )
        return false
    },
  })
  for (const range of tables) {
    if (touches(state, range.from, range.to)) continue
    const table = tableAt(state, range.from)
    if (!table) continue
    builder.add(
      table.from,
      table.to,
      Decoration.replace({
        widget: new TableWidget(
          state.sliceDoc(table.from, table.to),
          table.from
        ),
        block: true,
      })
    )
  }
  return builder.finish()
}

function selectionTouchesTables(transaction: Transaction, set: DecorationSet) {
  let touched = false
  const check = (state: EditorState) =>
    set.between(0, state.doc.length, (from, to) => {
      if (touches(state, from, to)) touched = true
    })
  check(transaction.state)
  return touched
}

/** Whether an edit can create, change or remove a table. */
function editTouchesTables(
  transaction: Transaction,
  decorations: DecorationSet
) {
  let touched = false
  transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (touched) return
    if (inserted.toString().includes('|')) touched = true
    else if (transaction.startState.sliceDoc(fromA, toA).includes('|'))
      touched = true
    else {
      const doc = transaction.state.doc
      const first = doc.lineAt(fromB)
      const last = doc.lineAt(toB)
      // A table can begin or end on a line next to the edit.
      const from =
        first.number > 1 ? doc.line(first.number - 1).from : first.from
      const to =
        last.number < doc.lines ? doc.line(last.number + 1).to : last.to
      if (doc.sliceString(from, to).includes('|')) touched = true
    }
    decorations.between(fromA, toA, () => {
      touched = true
      return false
    })
  })
  return touched
}

const tablePreview = StateField.define<DecorationSet>({
  create: tableDecorations,
  update(decorations, transaction) {
    if (transaction.docChanged) {
      // Typing in prose only maps rendered tables; a full scan of a long
      // note on every key would cost more than the edit itself.
      if (editTouchesTables(transaction, decorations))
        return tableDecorations(transaction.state)
      const mapped = decorations.map(transaction.changes)
      return transaction.selection &&
        selectionTouchesTables(transaction, mapped)
        ? tableDecorations(transaction.state)
        : mapped
    }
    // Background parsing finished more of the document.
    if (syntaxTree(transaction.startState) !== syntaxTree(transaction.state))
      return tableDecorations(transaction.state)
    if (transaction.selection) {
      const mapped = decorations.map(transaction.changes)
      // Rebuild when the cursor enters a rendered table or leaves a raw one.
      if (selectionTouchesTables(transaction, mapped))
        return tableDecorations(transaction.state)
      const previous = transaction.startState.selection.main
      const line = transaction.startState.doc.lineAt(previous.head)
      if (line.text.includes('|')) return tableDecorations(transaction.state)
      return mapped
    }
    return decorations
  },
  provide: field => EditorView.decorations.from(field),
})

export const livePreviewTheme = EditorView.baseTheme({
  '.cm-lp-bullet': {
    display: 'inline-block',
    width: '1ch',
    textAlign: 'center',
    color: 'var(--muted-foreground, #7d8379)',
  },
  '.cm-lp-task': {
    margin: '0 0.35em 0 0',
    verticalAlign: '-0.12em',
    cursor: 'pointer',
    accentColor: 'var(--accent, #42644d)',
  },
  '.cm-lp-task-done': {
    color: 'var(--muted-foreground, #7d8379)',
    textDecoration: 'line-through',
    textDecorationColor: 'color-mix(in srgb, currentColor 45%, transparent)',
  },
  '.cm-lp-rule': { position: 'relative' },
  '.cm-lp-rule::after': {
    content: '""',
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    borderTop: '1px solid var(--line, #dbdbdb)',
  },
  '.cm-lp-rule-text': { color: 'transparent' },
  '.cm-lp-quote': {
    borderLeft: '3px solid var(--line, #dbdbdb)',
    paddingLeft: '0.9em !important',
    color: 'var(--secondary, #545454)',
  },
  '.cm-lp-code': {
    backgroundColor: 'var(--surface, #f6f6f6)',
    fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace",
    fontSize: '0.88em',
    paddingLeft: '0.8em !important',
    paddingRight: '0.8em !important',
  },
  '.cm-lp-code-first': {
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
    paddingTop: '0.2em !important',
  },
  '.cm-lp-code-last': {
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
    paddingBottom: '0.2em !important',
  },
  '.cm-lp-table-wrap': {
    overflowX: 'auto',
    margin: '0.35em 0 0.6em',
    cursor: 'text',
  },
  '.cm-lp-table': {
    borderCollapse: 'collapse',
    fontSize: '0.92em',
    lineHeight: '1.5',
    minWidth: '40%',
  },
  '.cm-lp-table th, .cm-lp-table td': {
    border: '1px solid var(--line, #dbdbdb)',
    padding: '0.35em 0.75em',
    verticalAlign: 'top',
  },
  '.cm-lp-table th': {
    fontWeight: '600',
    backgroundColor: 'var(--surface, #f6f6f6)',
  },
  '.cm-lp-table code': {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: '0.9em',
  },
  '.cm-lp-cell-link': {
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    color: 'var(--accent, #42644d)',
  },
})

export function livePreview(): Extension {
  return [inlinePreview, tablePreview, livePreviewTheme]
}
