import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown'
import { indentUnit, syntaxTree } from '@codemirror/language'

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/u
const TABLE_ROW = /^\s*\|.*\|\s*$|^\s*[^|\n]*\|[^\n]*$/u
const DELIMITER_CELL = /^\s*:?-{1,}:?\s*$/u

export interface ListItem {
  indent: string
  marker: string
  spacing: string
  task?: string
  /** Column where the item's text starts. */
  contentOffset: number
}

export function parseListItem(text: string): ListItem | null {
  const match = LIST_ITEM.exec(text)
  if (!match) return null
  const [, indent = '', marker = '', spacing = '', task] = match
  return {
    indent,
    marker,
    spacing,
    ...(task ? { task } : {}),
    contentOffset: indent.length + marker.length + spacing.length,
  }
}

function inCodeBlock(state: EditorState, pos: number) {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null =
      syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  )
    if (/^(FencedCode|CodeBlock)$/u.test(node.name)) return true
  return false
}

function selectedLines(state: EditorState, range: SelectionRange): Line[] {
  const lines: Line[] = []
  const first = state.doc.lineAt(range.from)
  const last = state.doc.lineAt(range.to)
  // A selection ending at the start of a line does not include that line.
  const end =
    range.to > range.from &&
    last.from === range.to &&
    last.number > first.number
      ? last.number - 1
      : last.number
  for (let number = first.number; number <= end; number++)
    lines.push(state.doc.line(number))
  return lines
}

function previousItem(state: EditorState, line: Line, maxIndent: number) {
  for (let number = line.number - 1; number >= 1; number--) {
    const text = state.doc.line(number).text
    if (!text.trim()) continue
    const item = parseListItem(text)
    if (!item) {
      // Continuation text of an item is indented; anything else ends the list.
      if (/^\s+\S/u.test(text)) continue
      return null
    }
    if (item.indent.length <= maxIndent) return item
  }
  return null
}

/** Renumber ordered items in the contiguous list around `lineNumber`. */
function renumberChanges(
  state: EditorState,
  lineNumber: number,
  edits: Map<number, string>
) {
  const text = (number: number) =>
    edits.get(number) ?? state.doc.line(number).text
  let start = lineNumber
  while (
    start > 1 &&
    (parseListItem(text(start - 1)) || /^\s+\S/u.test(text(start - 1)))
  )
    start--
  let end = lineNumber
  while (
    end < state.doc.lines &&
    (parseListItem(text(end + 1)) || /^\s+\S/u.test(text(end + 1)))
  )
    end++
  const counters = new Map<number, number>()
  for (let number = start; number <= end; number++) {
    const line = text(number)
    const item = parseListItem(line)
    if (!item) continue
    const depth = item.indent.length
    for (const key of [...counters.keys()])
      if (key > depth) counters.delete(key)
    const ordered = /^\d/u.exec(item.marker)
    if (!ordered) {
      counters.delete(depth)
      continue
    }
    const next = (counters.get(depth) ?? 0) + 1
    counters.set(depth, next)
    const suffix = item.marker.slice(-1)
    const marker = `${next}${suffix}`
    if (marker !== item.marker)
      edits.set(
        number,
        item.indent +
          marker +
          item.spacing +
          line.slice(
            item.indent.length + item.marker.length + item.spacing.length
          )
      )
  }
}

/** Change only the part of a line that differs, so cursors keep their place. */
function lineDiff(line: Line, text: string): ChangeSpec {
  const old = line.text
  let start = 0
  while (
    start < old.length &&
    start < text.length &&
    old[start] === text[start]
  )
    start++
  let end = 0
  while (
    end < old.length - start &&
    end < text.length - start &&
    old[old.length - 1 - end] === text[text.length - 1 - end]
  )
    end++
  return {
    from: line.from + start,
    to: line.from + old.length - end,
    insert: text.slice(start, text.length - end),
  }
}

/** Indent or outdent list items under the selection. */
export function shiftListItems(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  const edits = new Map<number, string>()
  let touched = false
  for (const range of state.selection.ranges) {
    for (const line of selectedLines(state, range)) {
      const item = parseListItem(line.text)
      if (!item || inCodeBlock(state, line.from)) {
        if (selectedLines(state, range).length === 1) return false
        continue
      }
      touched = true
      let indent: number
      if (direction === 1) {
        const parent = previousItem(state, line, item.indent.length)
        // An item can only nest under a previous item.
        if (!parent) continue
        indent = Math.max(
          item.indent.length + 1,
          parent.indent.length + parent.marker.length + parent.spacing.length
        )
        if (parent.indent.length < item.indent.length) continue
      } else {
        if (!item.indent.length) continue
        const parent = previousItem(state, line, item.indent.length - 1)
        indent = parent ? parent.indent.length : 0
      }
      const marker =
        /^\d/u.test(item.marker) && direction === 1
          ? `1${item.marker.slice(-1)}`
          : item.marker
      edits.set(
        line.number,
        ' '.repeat(indent) +
          marker +
          line.text.slice(item.indent.length + item.marker.length)
      )
    }
  }
  if (!touched) return false
  if (!edits.size) return true
  for (const number of [...edits.keys()]) renumberChanges(state, number, edits)
  const changes: ChangeSpec[] = []
  for (const [number, text] of edits) {
    const line = state.doc.line(number)
    if (text !== line.text) changes.push(lineDiff(line, text))
  }
  view.dispatch(
    state.update({
      changes,
      scrollIntoView: true,
      userEvent: direction === 1 ? 'input.indent' : 'delete.dedent',
    })
  )
  return true
}

// ---------------------------------------------------------------- Tables

export interface TableBlock {
  from: number
  to: number
  firstLine: number
  lastLine: number
  rows: string[][]
  /** Index of the delimiter row (normally 1). */
  delimiter: number
  alignments: ('left' | 'center' | 'right' | null)[]
  indent: string
}

export function splitRow(text: string): string[] {
  let body = text.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let code = false
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!
    if (character === '\\' && body[index + 1] === '|') {
      current += '\\|'
      index++
    } else if (character === '`') {
      code = !code
      current += character
    } else if (character === '|' && !code) {
      cells.push(current.trim())
      current = ''
    } else current += character
  }
  cells.push(current.trim())
  return cells
}

function isRow(text: string) {
  return text.includes('|') && TABLE_ROW.test(text)
}

function isDelimiterRow(text: string) {
  if (!isRow(text)) return false
  const cells = splitRow(text)
  return cells.length > 0 && cells.every(cell => DELIMITER_CELL.test(cell))
}

/** The GFM table containing `pos`, if any. */
export function tableAt(state: EditorState, pos: number): TableBlock | null {
  const line = state.doc.lineAt(pos)
  if (!isRow(line.text) || inCodeBlock(state, pos)) return null
  let first = line.number
  while (first > 1 && isRow(state.doc.line(first - 1).text)) first--
  let last = line.number
  while (last < state.doc.lines && isRow(state.doc.line(last + 1).text)) last++
  const texts: string[] = []
  for (let number = first; number <= last; number++)
    texts.push(state.doc.line(number).text)
  const delimiter = texts.findIndex(isDelimiterRow)
  if (delimiter !== 1) return null
  const rows = texts.map(splitRow)
  const alignments = rows[1]!.map(cell => {
    const value = cell.trim()
    if (value.startsWith(':') && value.endsWith(':')) return 'center'
    if (value.endsWith(':')) return 'right'
    if (value.startsWith(':')) return 'left'
    return null
  })
  return {
    from: state.doc.line(first).from,
    to: state.doc.line(last).to,
    firstLine: first,
    lastLine: last,
    rows,
    delimiter,
    alignments,
    indent: /^\s*/u.exec(texts[0]!)?.[0] ?? '',
  }
}

function displayWidth(text: string) {
  let width = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    // Wide East Asian characters and most emoji take two columns.
    width +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1faff)
        ? 2
        : 1
  }
  return width
}

/** Format a table with aligned columns. Returns the text and cell offsets. */
export function formatTable(
  table: Pick<TableBlock, 'rows' | 'alignments' | 'indent'>
): {
  lines: string[]
  /** For each row and column: start offset of the cell text within its line. */
  cells: { start: number; end: number }[][]
} {
  const columns = Math.max(...table.rows.map(row => row.length))
  const rows = table.rows.map((row, index) =>
    index === 1
      ? Array.from({ length: columns }, (_, column) => row[column] ?? '---')
      : Array.from({ length: columns }, (_, column) => row[column] ?? '')
  )
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      3,
      ...rows
        .filter((_, index) => index !== 1)
        .map(row => displayWidth(row[column]!))
    )
  )
  const lines: string[] = []
  const cells: { start: number; end: number }[][] = []
  rows.forEach((row, index) => {
    let line = `${table.indent}|`
    const positions: { start: number; end: number }[] = []
    row.forEach((cell, column) => {
      const width = widths[column]!
      let content: string
      if (index === 1) {
        const alignment = table.alignments[column] ?? null
        const dashes = '-'.repeat(
          Math.max(1, width - (alignment === 'center' ? 2 : alignment ? 1 : 0))
        )
        content =
          alignment === 'center'
            ? `:${dashes}:`
            : alignment === 'right'
              ? `${dashes}:`
              : alignment === 'left'
                ? `:${dashes}`
                : dashes
      } else {
        const padding = width - displayWidth(cell)
        const alignment = table.alignments[column]
        content =
          alignment === 'right'
            ? ' '.repeat(padding) + cell
            : alignment === 'center'
              ? ' '.repeat(Math.floor(padding / 2)) +
                cell +
                ' '.repeat(Math.ceil(padding / 2))
              : cell + ' '.repeat(padding)
      }
      line += ' '
      // An empty cell puts the cursor right after the pipe and its space.
      const leading = cell ? content.length - content.trimStart().length : 0
      positions.push({
        start: line.length + leading,
        end: line.length + leading + cell.length,
      })
      line += `${content} |`
    })
    lines.push(line)
    cells.push(positions)
  })
  return { lines, cells }
}

function cellIndexAt(lineText: string, column: number) {
  let index = -1
  let code = false
  for (let offset = 0; offset < Math.min(column, lineText.length); offset++) {
    const character = lineText[offset]
    if (character === '\\') offset++
    else if (character === '`') code = !code
    else if (character === '|' && !code) index++
  }
  return Math.max(0, lineText.trimStart().startsWith('|') ? index : index + 1)
}

function rewriteTable(
  view: EditorView,
  table: TableBlock,
  rows: string[][],
  target: { row: number; column: number },
  selectCell = true
) {
  const formatted = formatTable({ ...table, rows })
  const insert = formatted.lines.join('\n')
  const row = Math.min(target.row, formatted.lines.length - 1)
  const lineStart =
    table.from +
    formatted.lines
      .slice(0, row)
      .reduce((total, line) => total + line.length + 1, 0)
  const cell =
    formatted.cells[row]![
      Math.min(target.column, formatted.cells[row]!.length - 1)
    ]!
  const anchor = lineStart + cell.start
  const head = lineStart + cell.end
  view.dispatch({
    changes: { from: table.from, to: table.to, insert },
    selection: selectCell
      ? EditorSelection.range(anchor, head)
      : EditorSelection.cursor(head),
    scrollIntoView: true,
    userEvent: 'input.table',
  })
}

/** Tab / Shift-Tab between cells. Tab after the last cell adds a row. */
export function moveTableCell(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  if (state.selection.ranges.length !== 1) return false
  const head = state.selection.main.head
  const table = tableAt(state, head)
  if (!table) return false
  const line = state.doc.lineAt(head)
  let row = line.number - table.firstLine
  let column = cellIndexAt(line.text, head - line.from)
  const columns = Math.max(...table.rows.map(cells => cells.length))
  const rows = table.rows.map(cells => [...cells])
  column += direction
  if (column >= columns) {
    column = 0
    row++
    if (row === table.delimiter) row++
    if (row >= rows.length) rows.push(Array.from({ length: columns }, () => ''))
  } else if (column < 0) {
    column = columns - 1
    row--
    if (row === table.delimiter) row--
    if (row < 0) {
      row = 0
      column = 0
    }
  }
  rewriteTable(view, table, rows, { row, column })
  return true
}

/** Enter in a table row inserts a row below and moves to its first cell. */
export function insertTableRow(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty)
    return false
  const head = state.selection.main.head
  const table = tableAt(state, head)
  if (!table) return false
  const line = state.doc.lineAt(head)
  const row = line.number - table.firstLine
  const columns = Math.max(...table.rows.map(cells => cells.length))
  const rows = table.rows.map(cells => [...cells])
  // Enter on an empty last row leaves the table, like an empty list item.
  if (
    row === rows.length - 1 &&
    row > table.delimiter &&
    rows[row]!.every(cell => !cell.trim())
  ) {
    rows.pop()
    const formatted = formatTable({ ...table, rows }).lines.join('\n')
    view.dispatch({
      changes: { from: table.from, to: table.to, insert: `${formatted}\n` },
      selection: EditorSelection.cursor(table.from + formatted.length + 1),
      scrollIntoView: true,
      userEvent: 'input.table',
    })
    return true
  }
  const insertAt = Math.max(row, table.delimiter) + 1
  rows.splice(
    insertAt,
    0,
    Array.from({ length: columns }, () => '')
  )
  rewriteTable(view, table, rows, { row: insertAt, column: 0 }, false)
  return true
}

export function tableTemplate(columns = 3, bodyRows = 2): string {
  const header = Array.from(
    { length: columns },
    (_, index) => `Column ${index + 1}`
  )
  const rows = [
    header,
    header.map(() => '---'),
    ...Array.from({ length: bodyRows }, () => header.map(() => '')),
  ]
  return formatTable({ rows, alignments: [], indent: '' }).lines.join('\n')
}

// ---------------------------------------------------------------- Tasks

/** Toggle `[ ]` and `[x]` on the selected task items, or make lines tasks. */
export function toggleTask(view: EditorView): boolean {
  const { state } = view
  const changes: ChangeSpec[] = []
  for (const range of state.selection.ranges)
    for (const line of selectedLines(state, range)) {
      const item = parseListItem(line.text)
      if (item?.task) {
        const at = line.from + item.contentOffset + 1
        const checked = /[xX]/u.test(item.task)
        changes.push({ from: at, to: at + 1, insert: checked ? ' ' : 'x' })
      } else if (item) {
        changes.push({ from: line.from + item.contentOffset, insert: '[ ] ' })
      } else if (line.text.trim()) {
        const indent = /^\s*/u.exec(line.text)?.[0].length ?? 0
        changes.push({ from: line.from + indent, insert: '- [ ] ' })
      }
    }
  if (!changes.length) return false
  view.dispatch({ changes, userEvent: 'input.toggle-task' })
  return true
}

/** Toggle the task box whose `[` starts at `pos`. */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const text = view.state.sliceDoc(pos, pos + 3)
  if (!/^\[[ xX]\]$/u.test(text)) return false
  view.dispatch({
    changes: {
      from: pos + 1,
      to: pos + 2,
      insert: /[xX]/u.test(text) ? ' ' : 'x',
    },
    userEvent: 'input.toggle-task',
  })
  return true
}

// ---------------------------------------------------------------- Keys

/** Tab: table cell, list indent, else indent unit at the cursor. */
export function smartTab(view: EditorView): boolean {
  if (moveTableCell(view, 1)) return true
  if (shiftListItems(view, 1)) return true
  const unit = view.state.facet(indentUnit)
  view.dispatch(view.state.replaceSelection(unit), {
    scrollIntoView: true,
    userEvent: 'input.indent',
  })
  return true
}

export function smartShiftTab(view: EditorView): boolean {
  if (moveTableCell(view, -1)) return true
  if (shiftListItems(view, -1)) return true
  // Remove one indent unit before the cursor when there is one.
  const { state } = view
  const unit = state.facet(indentUnit)
  const changes: ChangeSpec[] = []
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head)
    const leading = /^\s*/u.exec(line.text)?.[0] ?? ''
    if (!leading) continue
    changes.push({
      from: line.from,
      to: line.from + Math.min(unit.length, leading.length),
    })
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'delete.dedent' })
  return true
}

/**
 * Enter on an empty list item leaves the list: a nested item moves out one
 * level, a top-level item becomes an empty line.
 */
export function exitEmptyListItem(view: EditorView): boolean {
  const { state } = view
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty)
    return false
  const line = state.doc.lineAt(state.selection.main.head)
  const item = parseListItem(line.text)
  if (
    !item ||
    // An item with only a task box still counts as empty.
    !/^(?:\[[ xX]\])?\s*$/u.test(line.text.slice(item.contentOffset)) ||
    state.selection.main.head < line.from + item.contentOffset ||
    inCodeBlock(state, line.from)
  )
    return false
  if (item.indent.length && shiftListItems(view, -1)) return true
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: '' },
    selection: EditorSelection.cursor(line.from),
    userEvent: 'delete.list',
  })
  return true
}

export function smartEnter(view: EditorView): boolean {
  return (
    insertTableRow(view) ||
    exitEmptyListItem(view) ||
    insertNewlineContinueMarkup(view)
  )
}

export { deleteMarkupBackward }

/** Wrap the selection with Markdown markers, or insert them around the cursor. */
export function wrapSelection(
  view: EditorView,
  before: string,
  after = before
): boolean {
  const { state } = view
  view.dispatch(
    state.changeByRange(range => {
      const text = state.sliceDoc(range.from, range.to)
      if (
        text.startsWith(before) &&
        text.endsWith(after) &&
        text.length >= before.length + after.length
      ) {
        const inner = text.slice(before.length, text.length - after.length)
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        }
      }
      return {
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: EditorSelection.range(
          range.from + before.length,
          range.to + before.length
        ),
      }
    }),
    { userEvent: 'input.format' }
  )
  return true
}

/** Mod-K: make the selection a link, or insert an empty link. */
export function insertLink(view: EditorView): boolean {
  const { state } = view
  view.dispatch(
    state.changeByRange(range => {
      const text = state.sliceDoc(range.from, range.to)
      if (/^https?:\/\/\S+$/u.test(text)) {
        const insert = `[](${text})`
        return {
          changes: { from: range.from, to: range.to, insert },
          range: EditorSelection.cursor(range.from + 1),
        }
      }
      const insert = `[${text}](https://)`
      const urlStart = range.from + text.length + 3
      return {
        changes: { from: range.from, to: range.to, insert },
        range: text
          ? EditorSelection.range(urlStart, urlStart + 8)
          : EditorSelection.cursor(range.from + 1),
      }
    }),
    { userEvent: 'input.format' }
  )
  return true
}
