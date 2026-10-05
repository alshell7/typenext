import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'

export interface InlineSuggestion {
  at: number
  text: string
  sources: string[]
}

/** External file updates must not echo back through React's onChange. */
export const externalDocumentUpdate = Annotation.define<boolean>()
export const setInlineSuggestion = StateEffect.define<InlineSuggestion | null>()
export const setAcceptedRange = StateEffect.define<{
  from: number
  to: number
} | null>()

export const HISTORY_CHARACTER_BUDGET = 1_000_000
export const HISTORY_TRIM_THRESHOLD = 1_500_000
export const HISTORY_TRIM_MIN_WORK = 128_000

/** A conservative ledger avoids serializing undo data during ordinary typing. */
export const retainedHistoryWeight = StateField.define<{
  characters: number
  changes: number
}>({
  create: () => ({ characters: 0, changes: 0 }),
  update(weight, transaction) {
    if (
      !transaction.docChanged ||
      transaction.annotation(Transaction.addToHistory) === false
    )
      return weight
    let added = 128
    transaction.changes.iterChangedRanges((from, to, newFrom, newTo) => {
      added += to - from + newTo - newFrom
    })
    return {
      characters: weight.characters + added,
      changes: weight.changes + added,
    }
  },
})

function utf8StringSize(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

function utf8TextSize(text: Text) {
  let bytes = 0
  let highSurrogate = false
  for (const iterator = text.iter(); !iterator.next().done;) {
    for (let index = 0; index < iterator.value.length; index++) {
      const code = iterator.value.charCodeAt(index)
      if (highSurrogate && code >= 0xdc00 && code <= 0xdfff) {
        bytes++ // The preceding unpaired high surrogate was counted as three.
        highSurrogate = false
        continue
      }
      highSurrogate = code >= 0xd800 && code <= 0xdbff
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
    }
  }
  return bytes
}

/** Expand and merge boundary spans so splitting or joining emoji stays exact. */
const transactionByteSizes = new WeakMap<Transaction, number>()

function changedByteSize(transaction: Transaction, previous: number) {
  const cached = transactionByteSizes.get(transaction)
  if (cached !== undefined) return cached
  const spans: { from: number; to: number; newFrom: number; newTo: number }[] =
    []
  const before = transaction.startState.doc
  const after = transaction.newDoc
  transaction.changes.iterChangedRanges((from, to, newFrom, newTo) => {
    const span = {
      from: Math.max(0, from - 1),
      to: Math.min(before.length, to + 1),
      newFrom: Math.max(0, newFrom - 1),
      newTo: Math.min(after.length, newTo + 1),
    }
    const last = spans.at(-1)
    if (last && span.from <= last.to) {
      last.to = Math.max(last.to, span.to)
      last.newTo = Math.max(last.newTo, span.newTo)
    } else spans.push(span)
  })
  const bytes = spans.reduce(
    (bytes, span) =>
      bytes -
      utf8StringSize(before.sliceString(span.from, span.to)) +
      utf8StringSize(after.sliceString(span.newFrom, span.newTo)),
    previous
  )
  transactionByteSizes.set(transaction, bytes)
  return bytes
}

export const documentByteSize = StateField.define<number>({
  create: state => utf8TextSize(state.doc),
  update: (bytes, transaction) =>
    transaction.docChanged ? changedByteSize(transaction, bytes) : bytes,
})

export function proposedDocumentByteSize(transaction: Transaction) {
  return changedByteSize(
    transaction,
    transaction.startState.field(documentByteSize)
  )
}

function serializedHistoryWeight(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value))
    return value.reduce<number>(
      (total, item) => total + serializedHistoryWeight(item),
      8
    )
  if (value && typeof value === 'object')
    return Object.values(value).reduce<number>(
      (total, item) => total + serializedHistoryWeight(item),
      32
    )
  return 8
}

/** Keep recent undo/redo within a shared text budget, preserving each next action. */
export function boundSerializedHistory(value: unknown) {
  const history = value as { done: unknown[]; undone: unknown[] }
  let weight = 0
  function recent(branch: unknown[]) {
    const kept: unknown[] = []
    for (let index = branch.length - 1; index >= 0; index--) {
      const eventWeight = serializedHistoryWeight(branch[index]) + 128
      if (kept.length && weight + eventWeight > HISTORY_CHARACTER_BUDGET) break
      kept.unshift(branch[index])
      weight += eventWeight
    }
    return kept
  }
  return {
    history: { done: recent(history.done), undone: recent(history.undone) },
    weight,
  }
}

class SuggestionWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  override eq(other: SuggestionWidget) {
    return other.text === this.text
  }

  override get lineBreaks() {
    return this.text.split('\n').length - 1
  }

  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement('span')
    element.className = 'cm-ghost-suggestion'
    element.setAttribute('contenteditable', 'false')
    const text = view.dom.ownerDocument.createElement('span')
    text.className = 'cm-ghost-text'
    text.textContent = this.text
    text.setAttribute('aria-hidden', 'true')
    const accept = view.dom.ownerDocument.createElement('button')
    accept.type = 'button'
    accept.className = 'cm-ghost-accept'
    accept.textContent = 'Tab'
    accept.tabIndex = -1
    accept.setAttribute('aria-label', 'Accept suggestion')
    accept.setAttribute('aria-description', this.text)
    accept.title = 'Accept suggestion'
    accept.addEventListener('mousedown', event => event.preventDefault())
    accept.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      const current = view.state.field(inlineSuggestionField)
      if (view.hasFocus && current?.text === this.text)
        acceptInlineSuggestion(view)
    })
    element.append(text, accept)
    return element
  }
}

/** Ghost text is a decoration, never part of the document until accepted. */
export const inlineSuggestionField = StateField.define<InlineSuggestion | null>(
  {
    create: () => null,
    update(suggestion, transaction) {
      if (transaction.docChanged || transaction.selection) suggestion = null
      for (const effect of transaction.effects) {
        if (effect.is(setInlineSuggestion)) suggestion = effect.value
      }
      const { selection, doc } = transaction.state
      if (
        suggestion &&
        (!suggestion.text ||
          suggestion.at < 0 ||
          suggestion.at > doc.length ||
          selection.ranges.length !== 1 ||
          !selection.main.empty ||
          selection.main.head !== suggestion.at)
      ) {
        return null
      }
      return suggestion
    },
    provide: field =>
      EditorView.decorations.from(field, suggestion =>
        suggestion
          ? Decoration.set([
              Decoration.widget({
                widget: new SuggestionWidget(suggestion.text),
                side: 1,
              }).range(suggestion.at),
            ])
          : Decoration.none
      ),
  }
)

export const acceptedRangeField = StateField.define<{
  from: number
  to: number
} | null>({
  create: () => null,
  update(range, transaction) {
    if (range && transaction.docChanged) {
      range = {
        from: transaction.changes.mapPos(range.from, 1),
        to: transaction.changes.mapPos(range.to, -1),
      }
    }
    for (const effect of transaction.effects) {
      if (effect.is(setAcceptedRange)) range = effect.value
    }
    return range && range.from < range.to ? range : null
  },
  provide: field =>
    EditorView.decorations.from(field, range =>
      range
        ? Decoration.set([
            Decoration.mark({ class: 'cm-suggestion-accepted' }).range(
              range.from,
              range.to
            ),
          ])
        : Decoration.none
    ),
})

const acceptedRangeTimeout = ViewPlugin.fromClass(
  class {
    timeout: ReturnType<typeof setTimeout> | undefined

    constructor(readonly view: EditorView) {
      this.schedule()
    }

    schedule() {
      clearTimeout(this.timeout)
      if (this.view.state.field(acceptedRangeField)) {
        this.timeout = setTimeout(() => {
          this.view.dispatch({ effects: setAcceptedRange.of(null) })
        }, 240)
      }
    }

    update(update: ViewUpdate) {
      if (
        update.transactions.some(transaction =>
          transaction.effects.some(effect => effect.is(setAcceptedRange))
        )
      ) {
        this.schedule()
      }
    }

    destroy() {
      clearTimeout(this.timeout)
    }
  }
)

export const acceptedSuggestionHighlight: Extension = [
  acceptedRangeField,
  acceptedRangeTimeout,
]

/** Include punctuation and following spaces, with proper word boundaries. */
export function firstSuggestionWord(text: string) {
  if (typeof Intl.Segmenter === 'undefined') {
    return text.match(/^\s*\S+[ \t]*/u)?.[0] ?? text
  }
  let foundWord = false
  let end = 0
  for (const segment of new Intl.Segmenter(undefined, {
    granularity: 'word',
  }).segment(text)) {
    if (foundWord && (segment.isWordLike || segment.segment.includes('\n'))) {
      break
    }
    end = segment.index + segment.segment.length
    if (segment.isWordLike) foundWord = true
  }
  return text.slice(0, end)
}

export function acceptInlineSuggestion(
  view: EditorView,
  mode: 'all' | 'word' = 'all'
) {
  const suggestion = view.state.field(inlineSuggestionField)
  const selection = view.state.selection
  if (
    !suggestion ||
    view.composing ||
    selection.ranges.length !== 1 ||
    !selection.main.empty ||
    selection.main.head !== suggestion.at
  ) {
    return false
  }

  let text =
    mode === 'word' ? firstSuggestionWord(suggestion.text) : suggestion.text
  let remaining = suggestion.text.slice(text.length)
  if (!remaining.trim()) {
    text = suggestion.text
    remaining = ''
  }
  const nextCursor = suggestion.at + text.length

  view.dispatch({
    changes: { from: suggestion.at, insert: text },
    selection: EditorSelection.cursor(nextCursor),
    effects: [
      setInlineSuggestion.of(
        remaining
          ? { at: nextCursor, text: remaining, sources: suggestion.sources }
          : null
      ),
      setAcceptedRange.of({ from: suggestion.at, to: nextCursor }),
    ],
    annotations: [
      Transaction.userEvent.of('input.complete'),
      isolateHistory.of('full'),
    ],
    scrollIntoView: true,
  })
  return true
}

const markdownMarks: Record<string, string> = {
  ATXHeading1: 'cm-md-heading cm-md-heading-1',
  ATXHeading2: 'cm-md-heading cm-md-heading-2',
  ATXHeading3: 'cm-md-heading cm-md-heading-3',
  ATXHeading4: 'cm-md-heading',
  ATXHeading5: 'cm-md-heading',
  ATXHeading6: 'cm-md-heading',
  SetextHeading1: 'cm-md-heading cm-md-heading-1',
  SetextHeading2: 'cm-md-heading cm-md-heading-2',
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-emphasis',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  CodeText: 'cm-md-code',
  URL: 'cm-md-link',
  Link: 'cm-md-link',
  HeaderMark: 'cm-md-marker',
  QuoteMark: 'cm-md-marker',
  ListMark: 'cm-md-marker',
  EmphasisMark: 'cm-md-marker',
  CodeMark: 'cm-md-marker',
  LinkMark: 'cm-md-marker',
}

function markMarkdown(view: EditorView): DecorationSet {
  const decorations: ReturnType<Decoration['range']>[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const className = markdownMarks[node.name]
        if (className && node.from !== node.to) {
          decorations.push(
            Decoration.mark({ class: className }).range(node.from, node.to)
          )
        }
      },
    })
  }
  return Decoration.set(decorations, true)
}

/** Keep the Markdown source visible while giving it a quiet visual hierarchy. */
export const markdownPresentation: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = markMarkdown(view)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = markMarkdown(update.view)
      }
    }
  },
  { decorations: plugin => plugin.decorations }
)

export const writingSurface = EditorView.theme({
  '&': {
    height: '100%',
    color: 'inherit',
    backgroundColor: 'transparent',
    fontSize: 'inherit',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'inherit',
    lineHeight: '1.85',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '0 0 30vh',
    caretColor: 'var(--editor-caret, currentColor)',
    fontFamily: 'inherit',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--editor-caret, currentColor)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: 'var(--editor-selection, rgba(126, 136, 113, 0.22))',
    },
  '.cm-ghost-suggestion': {
    whiteSpace: 'pre-wrap',
    userSelect: 'none',
    fontStyle: 'normal',
    fontWeight: 'normal',
  },
  '.cm-ghost-text': { pointerEvents: 'none' },
  '.cm-ghost-accept': {
    verticalAlign: 'middle',
    cursor: 'pointer',
  },
  '.cm-md-heading': { fontWeight: '600', letterSpacing: '-0.02em' },
  '.cm-md-heading-1': { fontSize: '1.3em' },
  '.cm-md-heading-2': { fontSize: '1.15em' },
  '.cm-md-strong': { fontWeight: '600' },
  '.cm-md-emphasis': { fontStyle: 'italic' },
  '.cm-md-strike': { textDecoration: 'line-through' },
  '.cm-md-code': { color: 'var(--editor-code, inherit)' },
  '.cm-md-link': { textDecoration: 'underline', textUnderlineOffset: '3px' },
  '.cm-md-marker': { color: 'var(--muted-foreground, #92958d)' },
  '.cm-placeholder': { color: 'var(--muted-foreground, #92958d)' },
})
