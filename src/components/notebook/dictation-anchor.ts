import {
  Annotation,
  type ChangeDesc,
  EditorSelection,
  MapMode,
  StateEffect,
  StateField,
  Transaction,
  type Range,
} from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { composeDictationEdit, countWords } from '../../services/dictation-text'
import type { DictationPiece } from '../../services/voice-commands'

/** Text this dictation session inserted, mapped through later edits. */
export interface DictationInsert {
  key: number
  from: number
  to: number
  text: string
  /** Briefly highlighted after it arrives. */
  fresh: boolean
}

export interface DictationAnchor {
  id: number
  at: number | null
  phase: 'listening' | 'transcribing'
  inserted?: readonly DictationInsert[]
}
export const setDictationAnchor = StateEffect.define<DictationAnchor | null>()
const settleDictationInsert = StateEffect.define<number>()

function mapInserted(
  inserted: readonly DictationInsert[] | undefined,
  changes: ChangeDesc
): readonly DictationInsert[] | undefined {
  if (!inserted?.length) return inserted
  return inserted.flatMap(item => {
    const from = changes.mapPos(item.from, 1)
    const to = changes.mapPos(item.to, -1)
    return to > from ? [{ ...item, from, to }] : []
  })
}

export const dictationAnchorField = StateField.define<DictationAnchor | null>({
  create: () => null,
  update(value, transaction) {
    if (value && transaction.docChanged)
      value = {
        ...value,
        at:
          value.at === null
            ? null
            : transaction.changes.mapPos(value.at, 1, MapMode.TrackDel),
        inserted: mapInserted(value.inserted, transaction.changes),
      }
    for (const effect of transaction.effects) {
      if (effect.is(setDictationAnchor)) value = effect.value
      else if (effect.is(settleDictationInsert) && value?.inserted)
        value = {
          ...value,
          inserted: value.inserted.map(item =>
            item.key === effect.value ? { ...item, fresh: false } : item
          ),
        }
    }
    return value
  },
})

/**
 * The live dictation chip renders with React into the anchor widget. The
 * widget publishes its host element here; mutations inside a widget are
 * ignored by the editor, so frequent level updates cost no transactions.
 */
let chipHost: { id: number; element: HTMLElement } | null = null
const chipListeners = new Set<() => void>()
function publishHost(next: typeof chipHost) {
  chipHost = next
  chipListeners.forEach(listener => listener())
}
export function getDictationChipHost(): HTMLElement | null {
  return chipHost?.element ?? null
}
export function subscribeDictationChipHost(listener: () => void) {
  chipListeners.add(listener)
  return () => {
    chipListeners.delete(listener)
  }
}

class DictationMarker extends WidgetType {
  constructor(
    readonly id: number,
    readonly phase: DictationAnchor['phase']
  ) {
    super()
  }
  override eq(other: DictationMarker) {
    return this.id === other.id && this.phase === other.phase
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-dictation-anchor'
    span.dataset.phase = this.phase
    // Status reaches assistive technology through the dictation live
    // region; the marker is not part of the note's text.
    span.setAttribute('aria-hidden', 'true')
    const fallback = document.createElement('span')
    fallback.className = 'cm-dictation-fallback'
    fallback.textContent =
      this.phase === 'listening' ? 'Listening…' : 'Transcribing…'
    const host = document.createElement('span')
    host.className = 'cm-dictation-host'
    span.append(fallback, host)
    publishHost({ id: this.id, element: host })
    return span
  }
  override destroy(dom: HTMLElement) {
    if (chipHost && dom.contains(chipHost.element)) publishHost(null)
  }
  override ignoreEvent() {
    return true
  }
}

const freshMark = Decoration.mark({ class: 'cm-dictation-fresh' })

export const dictationAnchorDecoration = EditorView.decorations.compute(
  [dictationAnchorField],
  state => {
    const anchor = state.field(dictationAnchorField)
    if (!anchor) return Decoration.none
    const ranges: Range<Decoration>[] = []
    for (const item of anchor.inserted ?? [])
      if (item.fresh && item.to > item.from)
        ranges.push(freshMark.range(item.from, item.to))
    if (anchor.at != null)
      ranges.push(
        Decoration.widget({
          widget: new DictationMarker(anchor.id, anchor.phase),
          side: 1,
        }).range(anchor.at)
      )
    return Decoration.set(ranges, true)
  }
)

/**
 * Marks the transaction that ends a dictation which inserted words, so the
 * editor can offer a suggestion as it does after typing.
 */
export const dictationFinished = Annotation.define<true>()

export interface DictationCapture {
  /** Insert final text and end the session (the original single-clip API). */
  commit(text: string): void
  /**
   * End the session. Text inserted earlier stays and can be undone.
   * `finished` is true when the dictation ended normally with words.
   */
  cancel(finished?: boolean): void
  transcribing(): void
  /** Back to listening after `transcribing`. */
  listening?(): void
  /**
   * Insert phrases at the position and keep the session open. Returns the
   * number of words inserted. Throws when the position is gone or the note
   * is full, so the caller can keep the words for recovery.
   */
  insert?(pieces: readonly DictationPiece[]): number
  /** Remove the last phrase this session inserted, if it is unchanged. */
  undoLast?(): boolean
}

let nextDictationId = 0
const FRESH_MS = 1_600

/**
 * Start dictation at the cursor of `view`. `alive` tells whether this view
 * is still the note's editor; a replaced or destroyed view refuses inserts.
 */
export function startDictationCapture(
  view: EditorView,
  alive: () => boolean = () => view.dom.isConnected
): DictationCapture {
  if (!view.state.selection.main.empty)
    throw new Error('Place the cursor where you want to dictate.')
  const id = ++nextDictationId
  let keys = 0
  view.focus()
  view.dispatch({
    effects: setDictationAnchor.of({
      id,
      at: view.state.selection.main.head,
      phase: 'listening',
      inserted: [],
    }),
  })
  const anchor = (requirePosition = true) => {
    const value = alive() ? view.state.field(dictationAnchorField) : null
    if (!value || value.id !== id || (requirePosition && value.at === null))
      throw new Error(
        'The dictation position changed. Place the cursor and insert your transcript below.'
      )
    return value
  }
  const phase = (next: DictationAnchor['phase']) => {
    const value = anchor(false)
    if (value.phase !== next)
      view.dispatch({
        effects: setDictationAnchor.of({ ...value, phase: next }),
      })
  }
  return {
    cancel(finished = false) {
      if (alive() && view.state.field(dictationAnchorField)?.id === id)
        view.dispatch({
          effects: setDictationAnchor.of(null),
          ...(finished ? { annotations: dictationFinished.of(true) } : {}),
        })
    },
    // Finish recognition even if typing removed the insertion point. A later
    // commit failure keeps the transcript available for recovery.
    transcribing: () => phase('transcribing'),
    listening: () => phase('listening'),
    commit(text) {
      const at = anchor().at!
      const inserted = spaceDictation(
        text,
        view.state.sliceDoc(Math.max(0, at - 1), at),
        view.state.sliceDoc(at, at + 1)
      )
      if (!inserted)
        throw new Error('No words were heard. Try recording again.')
      const transaction = view.state.update({
        changes: { from: at, insert: inserted },
        selection: EditorSelection.cursor(at + inserted.length),
        effects: setDictationAnchor.of(null),
        annotations: [
          Transaction.userEvent.of('input.dictation'),
          isolateHistory.of('full'),
        ],
        scrollIntoView: true,
      })
      if (!transaction.docChanged)
        throw new Error(
          'This note is full. Keep your transcript below and insert it into a shorter note.'
        )
      view.focus()
      view.dispatch(transaction)
    },
    insert(pieces) {
      const value = anchor()
      const at = value.at!
      const state = view.state
      const edit = composeDictationEdit(
        pieces,
        state.sliceDoc(Math.max(0, at - 600), at),
        state.sliceDoc(at, at + 2)
      )
      if (!edit.text && !edit.remove) return 0
      const from = at - edit.remove
      const end = from + edit.text.length
      const changes = state.changes({ from, to: at, insert: edit.text })
      const selection = state.selection.main
      // The caret follows dictation only when it waits at the position;
      // a writer typing elsewhere keeps their place.
      const follow = selection.empty && selection.head === at
      const key = ++keys
      const transaction = state.update({
        changes,
        ...(follow ? { selection: EditorSelection.cursor(end) } : {}),
        effects: setDictationAnchor.of({
          ...value,
          at: end,
          inserted: [
            ...(mapInserted(value.inserted, changes) ?? []).slice(-49),
            ...(edit.text
              ? [{ key, from, to: end, text: edit.text, fresh: true }]
              : []),
          ],
        }),
        annotations: [
          Transaction.userEvent.of('input.dictation'),
          isolateHistory.of('full'),
        ],
        scrollIntoView: follow,
      })
      if (!transaction.docChanged)
        throw new Error(
          'This note is full. Your words are kept below; insert them into a shorter note.'
        )
      view.dispatch(transaction)
      setTimeout(() => {
        if (alive() && view.state.field(dictationAnchorField)?.id === id)
          view.dispatch({ effects: settleDictationInsert.of(key) })
      }, FRESH_MS)
      return countWords(edit.text)
    },
    undoLast() {
      const value = anchor(false)
      const last = value.inserted?.[value.inserted.length - 1]
      if (!last) return false
      const rest = value.inserted!.slice(0, -1)
      if (view.state.sliceDoc(last.from, last.to) !== last.text) {
        // Edited by the writer since: keep it, and forget it.
        view.dispatch({
          effects: setDictationAnchor.of({ ...value, inserted: rest }),
        })
        return false
      }
      const changes = view.state.changes({ from: last.from, to: last.to })
      view.dispatch({
        changes,
        effects: setDictationAnchor.of({
          ...value,
          at:
            value.at === null
              ? null
              : changes.mapPos(value.at, 1, MapMode.TrackDel),
          inserted: mapInserted(rest, changes),
        }),
        annotations: [
          Transaction.userEvent.of('delete.dictation'),
          isolateHistory.of('full'),
        ],
      })
      return true
    },
  }
}

export function spaceDictation(
  text: string,
  before: string,
  after: string
): string {
  const words = text.trim()
  if (!words) return ''
  const leading =
    before && !/\s$/u.test(before) && !/^[,.;:!?)}\]]/u.test(words) ? ' ' : ''
  const trailing = after && !/^\s|^[,.;:!?)}\]]/u.test(after) ? ' ' : ''
  return leading + words + trailing
}
