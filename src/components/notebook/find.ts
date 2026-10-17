import {
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'

/**
 * Find and replace inside a note. The query lives in editor state, matches
 * are found once per edit while the find bar is open, and only matches in
 * the visible lines are decorated. Replacing is one undoable change.
 */

export interface FindQuery {
  search: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface FindMatch {
  from: number
  to: number
}

/** Counting stops here; a longer note still finds the next match. */
export const MAX_MATCHES = 10_000

export const setFindQuery = StateEffect.define<FindQuery | null>()

interface FindState {
  query: FindQuery | null
  matches: FindMatch[]
  /** The search could not be read as a pattern. */
  error?: string
  truncated?: boolean
}

const WORD = '[\\p{L}\\p{M}\\p{N}_]'

export function findPattern(query: FindQuery): RegExp | string {
  if (!query.search) return ''
  try {
    const source = query.regex
      ? query.search
      : query.search.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const wrapped = query.wholeWord
      ? `(?<!${WORD})(?:${source})(?!${WORD})`
      : source
    return new RegExp(wrapped, `gu${query.caseSensitive ? '' : 'i'}`)
  } catch (error) {
    return error instanceof Error ? error.message : 'This pattern is not valid.'
  }
}

export function findMatches(
  text: string,
  query: FindQuery | null
): Omit<FindState, 'query'> {
  if (!query?.search) return { matches: [] }
  const pattern = findPattern(query)
  if (typeof pattern === 'string')
    return { matches: [], ...(pattern ? { error: pattern } : {}) }
  const matches: FindMatch[] = []
  for (const match of text.matchAll(pattern)) {
    // A pattern that can match nothing would match everywhere.
    if (!match[0].length || match.index === undefined) continue
    matches.push({ from: match.index, to: match.index + match[0].length })
    if (matches.length >= MAX_MATCHES) return { matches, truncated: true }
  }
  return { matches }
}

export const findField = StateField.define<FindState>({
  create: () => ({ query: null, matches: [] }),
  update(value, transaction) {
    let query = value.query
    let changed = false
    for (const effect of transaction.effects)
      if (effect.is(setFindQuery)) {
        query = effect.value
        changed = true
      }
    if (!changed && !(query && transaction.docChanged)) return value
    return { query, ...findMatches(transaction.state.doc.toString(), query) }
  },
})

/** The match the selection is on, or -1. */
export function currentMatch(state: EditorState): number {
  const { matches } = state.field(findField)
  const { from, to } = state.selection.main
  let low = 0
  let high = matches.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const match = matches[middle]!
    if (match.from === from && match.to === to) return middle
    if (match.from < from || (match.from === from && match.to < to))
      low = middle + 1
    else high = middle - 1
  }
  return -1
}

/** Index of the first match ending after a position (matches.length if none). */
function lowerBound(matches: FindMatch[], pos: number) {
  let low = 0
  let high = matches.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (matches[middle]!.to <= pos) low = middle + 1
    else high = middle
  }
  return low
}

/** Index of the first match at or after a position, wrapping to the start. */
function matchFrom(matches: FindMatch[], pos: number) {
  let low = 0
  let high = matches.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (matches[middle]!.from < pos) low = middle + 1
    else high = middle
  }
  return low < matches.length ? low : 0
}

function select(
  view: EditorView,
  match: FindMatch,
  userEvent = 'select.search'
) {
  view.dispatch({
    selection: EditorSelection.range(match.from, match.to),
    effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    userEvent,
  })
}

/**
 * Select the match nearest the cursor, as a browser's find does while you
 * type. Returns its index, or -1 without a match.
 */
export function revealFirst(
  view: EditorView,
  from = view.state.selection.main.from
) {
  const { matches } = view.state.field(findField)
  if (!matches.length) return -1
  const index = matchFrom(matches, from)
  select(view, matches[index]!)
  return index
}

export function findNext(view: EditorView, direction: 1 | -1 = 1): number {
  const { matches } = view.state.field(findField)
  if (!matches.length) return -1
  const { from, to } = view.state.selection.main
  const current = currentMatch(view.state)
  let index: number
  if (direction === 1)
    index =
      current >= 0 ? (current + 1) % matches.length : matchFrom(matches, to)
  else {
    const start = current >= 0 ? current : matchFrom(matches, from)
    index = (start - 1 + matches.length) % matches.length
  }
  select(view, matches[index]!)
  return index
}

/** The replacement for one match; a pattern may use $1, $& and the like. */
function replacementFor(
  view: EditorView,
  match: FindMatch,
  query: FindQuery,
  replacement: string
) {
  if (!query.regex) return replacement
  const pattern = findPattern(query)
  if (typeof pattern === 'string') return replacement
  const text = view.state.sliceDoc(match.from, match.to)
  const single = new RegExp(pattern.source, pattern.flags.replace('g', ''))
  return text.replace(single, replacement)
}

/** Replace the selected match, then move to the next one. */
export function replaceNext(view: EditorView, replacement: string): boolean {
  const { query, matches } = view.state.field(findField)
  if (!query || !matches.length) return false
  const index = currentMatch(view.state)
  if (index < 0) {
    findNext(view)
    return false
  }
  const match = matches[index]!
  const insert = replacementFor(view, match, query, replacement)
  view.dispatch({
    changes: { from: match.from, to: match.to, insert },
    selection: EditorSelection.cursor(match.from + insert.length),
    userEvent: 'input.replace',
  })
  const next = view.state.field(findField).matches
  if (next.length)
    select(view, next[matchFrom(next, match.from + insert.length)]!)
  return true
}

/** Replace every match in one undoable step. Returns how many changed. */
export function replaceAll(view: EditorView, replacement: string): number {
  const { query, matches } = view.state.field(findField)
  if (!query || !matches.length) return 0
  view.dispatch({
    changes: matches.map(match => ({
      from: match.from,
      to: match.to,
      insert: replacementFor(view, match, query, replacement),
    })),
    annotations: [
      Transaction.userEvent.of('input.replace.all'),
      isolateHistory.of('full'),
    ],
    scrollIntoView: true,
  })
  return matches.length
}

const matchMark = Decoration.mark({ class: 'cm-find-match' })
const currentMark = Decoration.mark({ class: 'cm-find-match cm-find-current' })

const findDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.startState.field(findField) !== update.state.field(findField)
      )
        this.decorations = this.build(update.view)
    }
    build(view: EditorView): DecorationSet {
      const { matches, query } = view.state.field(findField)
      if (!query || !matches.length) return Decoration.none
      const current = currentMatch(view.state)
      const ranges: Range<Decoration>[] = []
      for (const { from, to } of view.visibleRanges) {
        for (
          let index = lowerBound(matches, from);
          index < matches.length;
          index++
        ) {
          const match = matches[index]!
          if (match.from > to) break
          ranges.push(
            (index === current ? currentMark : matchMark).range(
              match.from,
              match.to
            )
          )
        }
      }
      return Decoration.set(ranges, true)
    }
  },
  { decorations: plugin => plugin.decorations }
)

export function findTools(): Extension {
  return [findField, findDecorations]
}
