import { createRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
  })
})
import { EditorView } from '@codemirror/view'
import { EditorSelection, Transaction } from '@codemirror/state'
import { undo } from '@codemirror/commands'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'
import { dictationAnchorField, spaceDictation } from './dictation-anchor'
import { defaultSettings, newNote } from '../../notebook/model'
import { suggest } from '../../services/completion'
vi.mock('../../services/completion', () => ({ suggest: vi.fn() }))
let serial = 0
function mount(text = 'Hello tomorrow.') {
  const note = {
    ...newNote('Speech and writing', ''),
    id: 'dictation-editor-' + serial++,
    content: text,
  }
  const ref = createRef<MarkdownEditorHandle>()
  const onChange = vi.fn()
  const result = render(
    <MarkdownEditor
      ref={ref}
      note={note}
      settings={{ ...defaultSettings(), suggestionDelay: 500 }}
      onChange={onChange}
      onStatus={() => {}}
      requestToken={0}
    />
  )
  const content = screen.getByRole('textbox', { name: 'Note content' })
  const view = EditorView.findFromDOM(content)!
  act(() => {
    view.focus()
    view.dispatch({ selection: EditorSelection.cursor(5) })
  })
  return { ...result, view, ref, onChange, note, content }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.mocked(suggest)
    .mockReset()
    .mockResolvedValue({ text: ' More writing.', sources: [] })
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('dictation at the writing position', () => {
  it('maps speech after concurrent typing, preserves the suffix, then schedules suggestions', async () => {
    const { view, ref } = mount()
    let capture!: ReturnType<MarkdownEditorHandle['captureDictation']>
    act(() => {
      capture = ref.current!.captureDictation()
    })
    act(() =>
      view.dispatch({
        changes: { from: 5, insert: ' brave' },
        selection: EditorSelection.cursor(11),
        annotations: Transaction.userEvent.of('input.type'),
      })
    )
    await act(async () => {
      ref.current!.requestSuggestion()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(suggest).not.toHaveBeenCalled()
    act(() => capture.transcribing())
    expect(view.state.field(dictationAnchorField)?.phase).toBe('transcribing')
    act(() => capture.commit('world'))
    expect(view.state.doc.toString()).toBe('Hello brave world tomorrow.')
    expect(view.state.field(dictationAnchorField)).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(suggest).toHaveBeenCalledTimes(1)
    act(() => {
      expect(undo(view)).toBe(true)
    })
    expect(view.state.doc.toString()).toBe('Hello brave tomorrow.')
  })
  it('keeps the captured position when the writer moves the caret', () => {
    const { view, ref } = mount()
    let capture!: ReturnType<MarkdownEditorHandle['captureDictation']>
    act(() => {
      capture = ref.current!.captureDictation()
      view.dispatch({
        selection: EditorSelection.cursor(view.state.doc.length),
      })
    })
    act(() => capture.commit('world'))
    expect(view.state.doc.toString()).toBe('Hello world tomorrow.')
  })
  it('cancels without putting marker text into the note', () => {
    const { view, ref, onChange } = mount()
    let capture!: ReturnType<MarkdownEditorHandle['captureDictation']>
    act(() => {
      capture = ref.current!.captureDictation()
    })
    expect(screen.getByText('Listening…')).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    act(() => capture.cancel())
    expect(view.state.doc.toString()).toBe('Hello tomorrow.')
    expect(view.state.field(dictationAnchorField)).toBeNull()
    expect(() => capture.commit('late speech')).toThrow('position changed')
  })
  it('refuses an insertion into deleted writing or a destroyed editor', () => {
    const { view, ref, unmount } = mount()
    let capture!: ReturnType<MarkdownEditorHandle['captureDictation']>
    act(() => {
      capture = ref.current!.captureDictation()
      view.dispatch({ changes: { from: 1, to: 9, insert: ' new ' } })
    })
    act(() => expect(() => capture.transcribing()).not.toThrow())
    expect(view.state.field(dictationAnchorField)?.at).toBeNull()
    expect(view.state.field(dictationAnchorField)?.phase).toBe('transcribing')
    expect(() => capture.commit('late speech')).toThrow('position changed')
    const text = view.state.doc.toString()
    act(() => unmount())
    expect(() => capture.commit('late speech')).toThrow('position changed')
    expect(text).not.toContain('late speech')
  })
  it('requires an insertion point rather than replacing selected writing', () => {
    const { view, ref } = mount()
    act(() => view.dispatch({ selection: EditorSelection.range(0, 5) }))
    expect(() => ref.current!.captureDictation()).toThrow('Place the cursor')
    expect(view.state.doc.toString()).toBe('Hello tomorrow.')
  })
  it('adds only the whitespace needed at the insertion boundaries', () => {
    expect(spaceDictation('world', 'o', 't')).toBe(' world ')
    expect(spaceDictation('world', ' ', '!')).toBe('world')
    expect(spaceDictation(', yes', 'o', ' ')).toBe(', yes')
    expect(spaceDictation('hello', '', '')).toBe('hello')
  })
})
