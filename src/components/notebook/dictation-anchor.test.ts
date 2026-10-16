import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import {
  dictationAnchorDecoration,
  dictationAnchorField,
  getDictationChipHost,
  startDictationCapture,
  subscribeDictationChipHost,
} from './dictation-anchor'
import {
  parseVoiceCommands,
  type DictationPiece,
} from '../../services/voice-commands'

const say = (text: string): DictationPiece[] => [parseVoiceCommands(text)]
let view: EditorView
function mount(doc: string, cursor = doc.length) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [history(), dictationAnchorField, dictationAnchorDecoration],
    }),
    parent: document.body,
  })
  return view
}
const text = () => view.state.doc.toString()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
})
afterEach(() => {
  view?.destroy()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('live dictation capture', () => {
  it('inserts phrases at the position while the session stays open', () => {
    mount('Plan:')
    const capture = startDictationCapture(view)
    expect(capture.insert!(say('guests arrive Friday.'))).toBe(3)
    expect(capture.insert!(say('they leave on Sunday new paragraph'))).toBe(4)
    expect(capture.insert!(say('menu next.'))).toBe(2)
    expect(text()).toBe(
      'Plan: guests arrive Friday. They leave on Sunday\n\nMenu next.'
    )
    expect(view.state.field(dictationAnchorField)?.at).toBe(text().length)
    expect(view.state.selection.main.head).toBe(text().length)
    capture.cancel()
    expect(view.state.field(dictationAnchorField)).toBeNull()
    expect(text()).toContain('Menu next.')
  })

  it('keeps the writer’s caret when they type elsewhere, and maps the position', () => {
    mount('Hello. Later.', 6)
    const capture = startDictationCapture(view)
    view.dispatch({
      changes: { from: 13, insert: ' Typed.' },
      selection: EditorSelection.cursor(20),
      annotations: Transaction.userEvent.of('input.type'),
    })
    view.dispatch({ changes: { from: 0, insert: '# ' } })
    capture.insert!(say('spoken words.'))
    expect(text()).toBe('# Hello. Spoken words. Later. Typed.')
    expect(view.state.selection.main.head).toBe(text().length)
  })

  it('replaces the mark before the position for spoken punctuation', () => {
    mount('')
    const capture = startDictationCapture(view)
    capture.insert!(say('We arrived.'))
    capture.insert!(say('Question mark.'))
    expect(text()).toBe('We arrived?')
  })

  it('undoes the last phrase with scratch-that and keeps edited text', () => {
    mount('Start.')
    const capture = startDictationCapture(view)
    capture.insert!(say('first idea.'))
    capture.insert!(say('second idea.'))
    expect(capture.undoLast!()).toBe(true)
    expect(text()).toBe('Start. First idea.')
    capture.insert!(say('third.'))
    expect(text()).toBe('Start. First idea. Third.')
    // The writer edits the newest phrase: it is no longer dictation's to remove.
    view.dispatch({ changes: { from: text().length - 1, insert: '!' } })
    expect(capture.undoLast!()).toBe(false)
    expect(text()).toBe('Start. First idea. Third!.')
    expect(capture.undoLast!()).toBe(true)
    expect(text()).toBe('Start. Third!.')
  })

  it('gives each phrase its own undo step', () => {
    mount('')
    const capture = startDictationCapture(view)
    capture.insert!(say('one.'))
    capture.insert!(say('two.'))
    capture.cancel()
    undo(view)
    expect(text()).toBe('One.')
  })

  it('refuses to insert after the position was deleted', () => {
    mount('Hello world', 5)
    const capture = startDictationCapture(view)
    view.dispatch({ changes: { from: 3, to: 8 } })
    expect(() => capture.insert!(say('late words'))).toThrow('position changed')
    expect(text()).toBe('Helrld')
  })

  it('refuses a destroyed editor', () => {
    mount('Hello')
    const capture = startDictationCapture(view)
    view.destroy()
    expect(() => capture.insert!(say('late'))).toThrow('position changed')
  })

  it('highlights fresh words briefly', () => {
    mount('')
    const capture = startDictationCapture(view)
    capture.insert!(say('fresh words'))
    expect(view.dom.querySelector('.cm-dictation-fresh')?.textContent).toBe(
      'Fresh words'
    )
    vi.advanceTimersByTime(1_600)
    expect(view.dom.querySelector('.cm-dictation-fresh')).toBeNull()
    capture.cancel()
  })

  it('publishes the chip host and shows a plain marker until it is used', () => {
    const listener = vi.fn()
    const stop = subscribeDictationChipHost(listener)
    mount('Hello')
    const capture = startDictationCapture(view)
    const host = getDictationChipHost()
    expect(host).toBeInstanceOf(HTMLElement)
    expect(view.dom.contains(host)).toBe(true)
    expect(listener).toHaveBeenCalled()
    expect(view.dom.querySelector('.cm-dictation-fallback')?.textContent).toBe(
      'Listening…'
    )
    expect(text()).toBe('Hello')
    capture.cancel()
    expect(getDictationChipHost()).toBeNull()
    stop()
  })

  it('keeps the original single-commit API', () => {
    mount('Hello tomorrow.', 5)
    const capture = startDictationCapture(view)
    capture.transcribing()
    expect(view.state.field(dictationAnchorField)?.phase).toBe('transcribing')
    capture.listening!()
    expect(view.state.field(dictationAnchorField)?.phase).toBe('listening')
    capture.commit('world')
    expect(text()).toBe('Hello world tomorrow.')
    expect(view.state.field(dictationAnchorField)).toBeNull()
  })

  it('requires an insertion point rather than a selection', () => {
    mount('Hello')
    view.dispatch({ selection: EditorSelection.range(0, 5) })
    expect(() => startDictationCapture(view)).toThrow('Place the cursor')
  })
})
