import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  history,
  isolateHistory,
  redo,
  undo,
  undoDepth,
} from '@codemirror/commands'
import { STORAGE_LIMITS } from '../../services/storage'
import { defaultSettings } from '../../notebook/model'
import { suggest } from '../../services/completion'
import {
  getBuiltinState,
  subscribeBuiltinState,
} from '../../services/builtin-engine'
import type {
  Note,
  NotebookSettings,
  SuggestionResult,
} from '../../types/notebook'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'
import {
  acceptedRangeField,
  acceptInlineSuggestion,
  firstSuggestionWord,
  documentByteSize,
  inlineSuggestionField,
  setAcceptedRange,
  setInlineSuggestion,
} from './editor-extensions'
import {
  suggestionChoices,
  suggestionMenuField,
  suggestionOrigin,
} from './suggestion-menu'

const restoreUserAgent = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
  // CodeMirror caches browser detection on import. Chromium preserves the
  // caret when a ghost splits a text node; JSDOM's generic UA misses that path.
  // Model the Windows/Edge runtime while retaining real selection/DOM editing.
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
  })
  return () => {
    if (descriptor) Object.defineProperty(navigator, 'userAgent', descriptor)
    else Reflect.deleteProperty(navigator, 'userAgent')
  }
})
afterAll(restoreUserAgent)

vi.mock('../../services/completion', () => ({ suggest: vi.fn() }))
vi.mock('../../services/builtin-engine', () => ({
  getBuiltinState: vi.fn(),
  subscribeBuiltinState: vi.fn(),
}))

let nextNoteId = 0
let builtinListener: (() => void) | undefined

function makeNote(content = 'A thought in progress'): Note {
  return {
    id: `editor-test-${nextNoteId++}`,
    title: 'Thoughts',
    objective: 'Reflect on patient, careful writing.',
    context: '',
    content,
    sources: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeSettings(): NotebookSettings {
  return {
    ...defaultSettings(),
    theme: 'light',
    palette: defaultSettings().palette,
    fontFamily: 'Merriweather',
    fontSize: 18,
    autoSave: true,
    suggestionsEnabled: true,
    autoSuggest: true,
    temperature: 0.3,
    suggestionDelay: 500,
    maxTokens: 80,
    suggestionLength: 'adaptive',
    externalAutoEnabled: false,
    suggestionInstructions: '',
    localEngine: 'recall',
    provider: 'openai',
    externalProvider: 'openai',
    websiteImporter: 'direct',
    profiles: {
      local: {
        endpoint: 'http://localhost:1234/v1',
        model: '',
        protocol: 'chat',
      },
      custom: {
        endpoint: 'https://example.com/v1',
        model: 'custom',
        protocol: 'chat',
      },
      openai: {
        endpoint: 'https://api.openai.com/v1',
        model: 'test',
        protocol: 'chat',
      },
      anthropic: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'test',
        protocol: 'chat',
      },
      openrouter: {
        endpoint: 'https://openrouter.ai/api/v1',
        model: 'test',
        protocol: 'chat',
      },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function mountEditor(note = makeNote(), settings = makeSettings()) {
  const ref = createRef<MarkdownEditorHandle>()
  const onChange = vi.fn()
  const onStatus = vi.fn()
  const onCursorChange = vi.fn()
  const props = {
    note,
    settings,
    onChange,
    onStatus,
    onCursorChange,
    requestToken: 0,
  }
  const result = render(<MarkdownEditor {...props} ref={ref} />)
  const content = screen.getByRole('textbox', { name: 'Note content' })
  const view = EditorView.findFromDOM(content)
  if (!view) throw new Error('CodeMirror view was not mounted')
  return {
    ...result,
    props,
    ref,
    view,
    content,
    onChange,
    onStatus,
    onCursorChange,
  }
}

function syncDOMSelection(view: EditorView) {
  const selection = view.dom.ownerDocument.getSelection()
  if (!selection) throw new Error('A DOM selection is required for this test')
  const anchor = view.domAtPos(view.state.selection.main.anchor)
  const head = view.domAtPos(view.state.selection.main.head)
  // JSDOM queues focus selection events independently of CodeMirror's state.
  // Keep the real selection at the cursor a user would have placed in the DOM.
  selection.setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset)
  expect(view.posAtDOM(selection.focusNode!, selection.focusOffset)).toBe(
    view.state.selection.main.head
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  builtinListener = undefined
  vi.mocked(getBuiltinState).mockReturnValue({
    status: 'ready',
    cached: true,
    progress: 100,
    downloadedBytes: 1,
    totalBytes: 1,
    backend: 'wasm',
    identity: 'builtin-0',
  })
  vi.mocked(subscribeBuiltinState).mockImplementation(listener => {
    builtinListener = listener
    return () => {
      builtinListener = undefined
    }
  })
  vi.mocked(suggest)
    .mockReset()
    .mockResolvedValue({
      text: ' with a useful next thought.',
      sources: ['Attached context'],
    })
  // jsdom has no layout. Preserve real CodeMirror editing and transactions,
  // while supplying the empty geometry its viewport measurement expects.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined)
})

describe('manual suggestion choices', () => {
  const choices: SuggestionResult = {
    text: 'I want to notice the small things.',
    sources: [],
    mode: 'starter',
    alternatives: [
      { text: 'What matters today is patience.', sources: [], mode: 'starter' },
      { text: 'A useful next step is to begin.', sources: [], mode: 'starter' },
    ],
  }

  it('lets a blank note preview and navigate bounded choices without modifying the writing', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { ref, view, content, onChange, onStatus } = mountEditor(makeNote(''))
    await act(async () => ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(suggest).mock.calls[0]?.[1]).toEqual({
      text: '',
      cursor: 0,
      selectionEmpty: true,
    })
    const menu = screen.getByRole('listbox', { name: 'Suggestions' })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(content).toHaveFocus()
    expect(content).toHaveAttribute('data-suggestion-preview', 'true')
    expect(content).toHaveAttribute('aria-controls', menu.id)
    expect(content).toHaveAttribute('aria-activedescendant', options[0]!.id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(view.state.doc.toString()).toBe('')
    expect(onChange).not.toHaveBeenCalled()
    act(() => fireEvent.keyDown(content, { key: 'ArrowDown' }))
    expect(view.state.field(inlineSuggestionField)?.text).toBe(
      choices.alternatives![0]!.text
    )
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(content).toHaveAttribute('aria-activedescendant', options[1]!.id)
    act(() => fireEvent.keyDown(content, { key: 'ArrowUp' }))
    expect(view.state.field(inlineSuggestionField)?.text).toBe(choices.text)
    act(() => fireEvent.keyDown(content, { key: 'ArrowUp' }))
    expect(view.state.field(inlineSuggestionField)?.text).toBe(
      choices.alternatives![1]!.text
    )
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'suggestion',
        mode: 'starter',
        menuOpen: true,
        choices: 3,
      })
    )
    act(() => fireEvent.keyDown(content, { key: 'Enter' }))
    expect(view.state.doc.toString()).toBe(choices.alternatives![1]!.text)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(content).not.toHaveAttribute('aria-activedescendant')
    expect(content).not.toHaveAttribute('data-suggestion-preview')
    expect(view.state.field(inlineSuggestionField)).toBeNull()
    expect(undoDepth(view.state)).toBe(1)
    act(() => expect(undo(view)).toBe(true))
    expect(view.state.doc.toString()).toBe('')
  })

  it('offers a focused blank page a debounced ghost, and opens choices only on manual request', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { view, ref } = mountEditor(makeNote(''))
    await act(async () => vi.advanceTimersByTime(2000))
    expect(suggest).not.toHaveBeenCalled()
    act(() => view.focus())
    await act(async () => vi.advanceTimersByTime(499))
    expect(suggest).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(view.state.field(inlineSuggestionField)?.text).toBe(choices.text)
    expect(screen.queryByRole('listbox')).toBeNull()
    await act(async () => ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('restores the blank-page placeholder after dismissing its ghost preview', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { ref, content, view } = mountEditor(makeNote(''))
    expect(content).not.toHaveAttribute('data-suggestion-preview')
    await act(async () => ref.current?.requestSuggestion())
    expect(content).toHaveAttribute('data-suggestion-preview', 'true')
    await act(async () => fireEvent.keyDown(content, { key: 'Escape' }))
    expect(content).not.toHaveAttribute('data-suggestion-preview')
    expect(content.querySelector('.cm-placeholder')).not.toBeNull()
    expect(view.state.doc.toString()).toBe('')
  })

  it('keeps a manual blank-page menu open through the automatic focus debounce', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { ref, view } = mountEditor(makeNote(''))
    expect(view.hasFocus).toBe(false)
    await act(async () => ref.current?.requestSuggestion())
    expect(screen.getByRole('listbox', { name: 'Suggestions' })).toBeVisible()
    await act(async () => vi.advanceTimersByTime(1500))
    expect(screen.getByRole('listbox', { name: 'Suggestions' })).toBeVisible()
    expect(suggest).toHaveBeenCalledTimes(1)
  })

  it('accepts an alternate by pointer without moving focus or overwriting the suffix', async () => {
    vi.mocked(suggest).mockResolvedValue({
      text: 'careful',
      sources: ['This note'],
      mode: 'recall',
      alternatives: [
        { text: 'patient', sources: ['Research.md'], mode: 'recall' },
      ],
    })
    const { view, ref, content } = mountEditor(makeNote('The  ending.'))
    act(() => {
      view.focus()
      view.dispatch({ selection: EditorSelection.cursor(4) })
      syncDOMSelection(view)
    })
    await act(async () => ref.current?.requestSuggestion())
    expect(view.state.field(suggestionMenuField)).not.toBeNull()
    expect(view.state.selection.main.head).toBe(4)
    expect(screen.getByRole('listbox')).toHaveTextContent('From this note')
    const alternate = screen.getAllByRole('option')[1]!
    expect(alternate).toHaveTextContent('From Research.md')
    act(() => {
      fireEvent.pointerDown(alternate)
      fireEvent.mouseDown(alternate)
      fireEvent.click(alternate)
    })
    expect(content).toHaveFocus()
    expect(view.state.doc.toString()).toBe('The patient ending.')
    expect(view.state.field(suggestionMenuField)).toBeNull()
    act(() => expect(undo(view)).toBe(true))
    expect(view.state.doc.toString()).toBe('The  ending.')
  })

  it('closes the menu on word acceptance while retaining the starter label and remaining ghost', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { ref, view, content, onStatus } = mountEditor(makeNote(''))
    await act(async () => ref.current?.requestSuggestion())
    act(() => fireEvent.keyDown(content, { key: 'ArrowRight', ctrlKey: true }))
    expect(view.state.doc.toString()).toBe('I ')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(view.state.field(inlineSuggestionField)).toEqual({
      at: 2,
      text: 'want to notice the small things.',
      sources: [],
      mode: 'starter',
    })
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'starter', menuOpen: false, choices: 1 })
    )
  })

  it('dismisses both menu and ghost on Escape, edits, cursor movement, blur and composition', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { ref, view, content } = mountEditor()
    async function request() {
      act(() => {
        view.focus()
        syncDOMSelection(view)
      })
      await act(async () => ref.current?.requestSuggestion())
      expect(screen.getByRole('listbox')).toBeVisible()
    }
    function dismissed() {
      expect(screen.queryByRole('listbox')).toBeNull()
      expect(view.state.field(inlineSuggestionField)).toBeNull()
      expect(content).not.toHaveAttribute('aria-controls')
    }
    await request()
    await act(async () => fireEvent.keyDown(content, { key: 'Escape' }))
    dismissed()
    await request()
    act(() => view.dispatch({ changes: { from: 0, insert: 'My ' } }))
    dismissed()
    await request()
    act(() => view.dispatch({ selection: EditorSelection.cursor(4) }))
    dismissed()
    await request()
    await act(async () => content.blur())
    dismissed()
    await request()
    await act(async () => fireEvent.compositionStart(content))
    dismissed()
    await act(async () => ref.current?.requestSuggestion())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('keeps explicit external requests as a single ghost', async () => {
    vi.mocked(suggest).mockResolvedValue({ ...choices, mode: 'model' })
    const { ref, view, onStatus } = mountEditor()
    await act(async () => ref.current?.requestExternalSuggestion('openai'))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(view.state.field(inlineSuggestionField)?.text).toBe(choices.text)
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'model', menuOpen: false, choices: 1 })
    )
    expect(vi.mocked(suggest).mock.calls[0]?.[2].provider).toBe('openai')
    expect(vi.mocked(suggest).mock.calls[0]?.[4]).toBeUndefined()
  })

  it('refreshes hosted choices on repeated Ctrl+Space at the same cursor and accepts only the selected insertion', async () => {
    vi.mocked(suggest)
      .mockResolvedValueOnce({
        text: 'careful',
        sources: [],
        mode: 'model',
        alternatives: [
          { text: 'patient', sources: [], mode: 'model' },
          { text: 'steady', sources: [], mode: 'model' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'thoughtful',
        sources: [],
        mode: 'model',
        alternatives: [
          { text: 'quiet', sources: [], mode: 'model' },
          { text: 'unhurried', sources: [], mode: 'model' },
        ],
      })
    const editor = mountEditor(makeNote('The  ending.'), {
      ...makeSettings(),
      provider: 'openrouter',
      externalAutoEnabled: true,
      autoSuggest: false,
    })
    act(() => {
      editor.view.focus()
      editor.view.dispatch({ selection: EditorSelection.cursor(4) })
      syncDOMSelection(editor.view)
    })
    await act(async () =>
      fireEvent.keyDown(editor.content, {
        key: ' ',
        code: 'Space',
        ctrlKey: true,
      })
    )
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('careful')
    await act(async () =>
      fireEvent.keyDown(editor.content, {
        key: ' ',
        code: 'Space',
        ctrlKey: true,
      })
    )
    expect(suggest).toHaveBeenCalledTimes(2)
    expect(
      vi
        .mocked(suggest)
        .mock.calls.every(call => call[4]?.purpose === 'alternatives')
    ).toBe(true)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('thoughtful')
    expect(editor.view.state.doc.toString()).toBe('The  ending.')
    expect(editor.onChange).not.toHaveBeenCalled()
    act(() => fireEvent.keyDown(editor.content, { key: 'ArrowDown' }))
    act(() => fireEvent.keyDown(editor.content, { key: 'Enter' }))
    expect(editor.view.state.doc.toString()).toBe('The quiet ending.')
    expect(editor.content).toHaveFocus()
    act(() => expect(undo(editor.view)).toBe(true))
    expect(editor.view.state.doc.toString()).toBe('The  ending.')
  })

  it('keeps a single valid hosted choice usable with an honest refresh hint', async () => {
    vi.mocked(suggest).mockResolvedValue({
      text: 'careful',
      sources: [],
      mode: 'model',
    })
    const editor = mountEditor(makeNote('The  ending.'), {
      ...makeSettings(),
      externalAutoEnabled: true,
      autoSuggest: false,
    })
    act(() => {
      editor.view.focus()
      editor.view.dispatch({ selection: EditorSelection.cursor(4) })
      syncDOMSelection(editor.view)
    })
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(editor.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'suggestion',
        choices: 1,
        mode: 'model',
        message: expect.stringContaining('one distinct choice'),
      })
    )
    act(() => fireEvent.keyDown(editor.content, { key: 'Tab' }))
    expect(editor.view.state.doc.toString()).toBe('The careful ending.')
  })

  it('never accepts a detached stale option after cursor movement dismisses its menu', async () => {
    vi.mocked(suggest).mockResolvedValue(choices)
    const { ref, view } = mountEditor()
    await act(async () => ref.current?.requestSuggestion())
    const oldOption = screen.getAllByRole('option')[1]!
    act(() => view.dispatch({ selection: EditorSelection.cursor(2) }))
    expect(screen.queryByRole('listbox')).toBeNull()
    act(() => fireEvent.click(oldOption))
    expect(view.state.doc.toString()).toBe('A thought in progress')
    expect(view.state.field(inlineSuggestionField)).toBeNull()
  })

  it('includes alternative text in the existing completion-cache memory limit', async () => {
    vi.mocked(suggest).mockResolvedValue({
      text: 'A short preview.',
      sources: [],
      alternatives: [{ text: 'x'.repeat(260_000), sources: [] }],
    })
    const { ref } = mountEditor()
    await act(async () => ref.current?.requestSuggestion())
    await act(async () => ref.current?.requestSuggestion())
    // A result larger than half the shared character budget is displayed,
    // but cannot displace the bounded cache with its additional choices.
    expect(suggest).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('gives clear paused and empty-result feedback without displaying a menu', async () => {
    const settings = makeSettings()
    const editor = mountEditor(makeNote(''), {
      ...settings,
      suggestionsEnabled: false,
    })
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).not.toHaveBeenCalled()
    expect(editor.onStatus).toHaveBeenLastCalledWith({
      state: 'idle',
      message: 'Suggestions are paused. Turn on suggestions to continue.',
    })
    editor.rerender(
      <MarkdownEditor {...editor.props} settings={settings} ref={editor.ref} />
    )
    vi.mocked(suggest).mockResolvedValue({ text: '', sources: [] })
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(editor.onStatus).toHaveBeenLastCalledWith({
      state: 'idle',
      message:
        'Try a new line for a writing starter, or connect a local model in Preferences.',
    })
  })

  it('passes existing Markdown syntax context for inline and fenced code', async () => {
    const editor = mountEditor(
      makeNote('`some code`\n\n```js\nconst value = 1\n```')
    )
    for (const cursor of [5, 25]) {
      act(() =>
        editor.view.dispatch({ selection: EditorSelection.cursor(cursor) })
      )
      await act(async () => editor.ref.current?.requestSuggestion())
      expect(vi.mocked(suggest).mock.lastCall?.[1]).toEqual(
        expect.objectContaining({ inCode: true, cursor })
      )
    }
  })

  it('caps and deduplicates choices and labels their actual origins', () => {
    expect(
      suggestionChoices({
        ...choices,
        alternatives: [
          { text: ` ${choices.text} `, sources: [] },
          { text: '', sources: [] },
          { text: 'A fourth choice is ignored.', sources: [] },
        ],
      })
    ).toEqual([{ text: choices.text, sources: [], mode: 'starter' }])
    expect(suggestionOrigin({ text: 'x', sources: [], mode: 'model' })).toBe(
      'Local model'
    )
    expect(
      suggestionOrigin({ text: 'x', sources: ['Current note'], mode: 'recall' })
    ).toBe('From this note')
  })
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('inline suggestion transactions', () => {
  function stateView(doc = 'The  ending.', cursor = 4) {
    let state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [history(), inlineSuggestionField, acceptedRangeField],
    })
    const view = {
      get state() {
        return state
      },
      composing: false,
      dispatch(
        transaction: Parameters<EditorState['update']>[0] | Transaction
      ) {
        state =
          transaction instanceof Transaction
            ? transaction.state
            : state.update(transaction).state
      },
    } as unknown as EditorView
    return view
  }

  it('keeps a middle-of-document ghost outside the Markdown source', () => {
    const view = stateView()
    view.dispatch({
      effects: setInlineSuggestion.of({ at: 4, text: 'careful', sources: [] }),
    })
    expect(view.state.doc.toString()).toBe('The  ending.')
    expect(view.state.field(inlineSuggestionField)?.at).toBe(4)
    view.dispatch({ selection: EditorSelection.cursor(5) })
    expect(view.state.field(inlineSuggestionField)).toBeNull()
  })

  it('accepts exactly at the cursor and undo removes only the suggestion', () => {
    const view = stateView()
    view.dispatch({
      changes: { from: 4, insert: 'very ' },
      selection: EditorSelection.cursor(9),
    })
    view.dispatch({
      effects: setInlineSuggestion.of({ at: 9, text: 'careful', sources: [] }),
    })
    expect(acceptInlineSuggestion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('The very careful ending.')
    expect(view.state.selection.main.head).toBe(16)
    expect(view.state.field(inlineSuggestionField)).toBeNull()
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('The very  ending.')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('The  ending.')
  })

  it('accepts one word and moves the remaining ghost without losing suffix text', () => {
    const view = stateView()
    view.dispatch({
      effects: setInlineSuggestion.of({
        at: 4,
        text: 'careful, patient',
        sources: ['Research'],
      }),
    })
    expect(acceptInlineSuggestion(view, 'word')).toBe(true)
    expect(view.state.doc.toString()).toBe('The careful,  ending.')
    expect(view.state.field(inlineSuggestionField)).toEqual({
      at: 13,
      text: 'patient',
      sources: ['Research'],
    })
    expect(acceptInlineSuggestion(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('The careful, patient ending.')
  })

  it('preserves apostrophes and stops before a new paragraph', () => {
    expect(firstSuggestionWord(" don't stop")).toBe(" don't ")
    expect(firstSuggestionWord('Hello,\n\nnext paragraph')).toBe('Hello,')
  })
})

describe('private suggestion lifecycle', () => {
  it('announces a fresh continuation and its shortcuts, while cancelled text is never announced', async () => {
    const cancelled = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => cancelled.promise)
    const { ref, view } = mountEditor()
    await act(async () => ref.current?.requestSuggestion())
    act(() => view.dispatch({ changes: { from: 0, insert: 'Updated ' } }))
    await act(async () =>
      cancelled.resolve({ text: 'CANCELLED_CONTINUATION', sources: [] })
    )
    const announcements = view.dom.querySelector('.cm-announced')
    expect(announcements).toHaveAttribute('aria-live', 'polite')
    expect(announcements).not.toHaveTextContent('CANCELLED_CONTINUATION')
    await act(async () => ref.current?.requestSuggestion())
    expect(announcements).toHaveTextContent(
      'Suggested continuation: with a useful next thought.'
    )
    expect(announcements).toHaveTextContent('Press Tab to accept.')
    expect(announcements).toHaveTextContent('Right Arrow for one word.')
    expect(announcements).toHaveTextContent('Press Escape to dismiss.')
  })

  it('does not request on mount or focus, and debounces only document edits', async () => {
    const { view } = mountEditor()
    act(() => view.focus())
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(suggest).not.toHaveBeenCalled()
    act(() => view.dispatch({ changes: { from: 0, insert: 'My ' } }))
    await act(async () => {
      vi.advanceTimersByTime(499)
    })
    expect(suggest).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(vi.mocked(suggest).mock.calls[0]?.[2].provider).toBe('local')
    expect(vi.mocked(suggest).mock.calls[0]?.[2].profiles.local.model).toBe('')
  })

  it('keeps remembered external profiles local until automatic inference is deliberately activated', async () => {
    const { ref, view } = mountEditor()
    await act(async () => ref.current?.requestSuggestion())
    expect(vi.mocked(suggest).mock.calls[0]?.[2].provider).toBe('local')
    await act(async () => ref.current?.requestExternalSuggestion('openai'))
    expect(vi.mocked(suggest).mock.calls[1]?.[2].provider).toBe('openai')
    expect(view.state.doc.toString()).toBe('A thought in progress')
  })

  it.each(['openai', 'openrouter', 'anthropic', 'custom'] as const)(
    'uses deliberately activated %s for both automatic and normal manual requests',
    async provider => {
      vi.mocked(suggest).mockResolvedValue({
        text: ' with a useful thought.',
        sources: [],
        mode: 'model',
      })
      const settings = {
        ...makeSettings(),
        provider,
        externalAutoEnabled: true,
      }
      const editor = mountEditor(makeNote(), settings)
      act(() => {
        editor.view.focus()
        editor.view.dispatch({
          changes: { from: editor.view.state.doc.length, insert: ' today' },
          selection: EditorSelection.cursor(editor.view.state.doc.length + 6),
        })
      })
      await act(async () => vi.advanceTimersByTime(500))
      expect(vi.mocked(suggest).mock.calls[0]?.[2].provider).toBe(provider)
      expect(screen.queryByRole('listbox')).toBeNull()
      await act(async () => editor.ref.current?.requestSuggestion())
      expect(suggest).toHaveBeenCalledTimes(2)
      expect(vi.mocked(suggest).mock.calls[1]?.[4]).toEqual({
        purpose: 'alternatives',
      })
      expect(screen.getByRole('listbox')).toBeVisible()
      const label = {
        openai: 'OpenAI',
        openrouter: 'OpenRouter',
        anthropic: 'Anthropic',
        custom: 'Custom endpoint',
      }[provider]
      expect(screen.getAllByRole('option')[0]).toHaveTextContent(label)
      expect(editor.view.state.doc.toString()).toBe(
        'A thought in progress today'
      )
    }
  )

  it('allows an activated external model to start from a blank page with a writing objective', async () => {
    const editor = mountEditor(makeNote(''), {
      ...makeSettings(),
      externalAutoEnabled: true,
    })
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(vi.mocked(suggest).mock.calls[0]?.[1].text).toBe('')
    expect(vi.mocked(suggest).mock.calls[0]?.[2].provider).toBe('openai')
    expect(editor.view.state.doc.toString()).toBe('')
    expect(screen.getByRole('listbox')).toBeVisible()
  })

  it.each<{ label: string; patch: Partial<NotebookSettings> }>([
    {
      label: 'instructions',
      patch: { suggestionInstructions: 'Use short sentences.' },
    },
    { label: 'provider', patch: { provider: 'openrouter' } },
    { label: 'external activation', patch: { externalAutoEnabled: false } },
    { label: 'local engine', patch: { localEngine: 'embedded' } },
  ])('cancels a pending insertion when $label changes', async ({ patch }) => {
    const pending = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => pending.promise)
    const settings = { ...makeSettings(), externalAutoEnabled: true }
    const editor = mountEditor(makeNote(), settings)
    await act(async () => editor.ref.current?.requestSuggestion())
    const signal = vi.mocked(suggest).mock.calls[0]?.[3]
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        settings={{ ...settings, ...patch }}
        ref={editor.ref}
      />
    )
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve({ text: ' stale.', sources: [], mode: 'model' })
    )
    expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('returns routine inference to local immediately when external activation is switched off', async () => {
    const settings = { ...makeSettings(), externalAutoEnabled: true }
    const editor = mountEditor(makeNote(), settings)
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(vi.mocked(suggest).mock.calls[0]?.[2].provider).toBe('openai')
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        settings={{ ...settings, externalAutoEnabled: false }}
        ref={editor.ref}
      />
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(vi.mocked(suggest).mock.calls[1]?.[2].provider).toBe('local')
    expect(editor.props.settings.profiles.openai.model).toBe('test')
  })

  it('invalidates completed cached insertions after a writer instruction change', async () => {
    const editor = mountEditor()
    await act(async () => editor.ref.current?.requestSuggestion())
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(1)
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        settings={{
          ...editor.props.settings,
          suggestionInstructions: 'Avoid metaphors.',
        }}
        ref={editor.ref}
      />
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(2)
    expect(vi.mocked(suggest).mock.calls[1]?.[2].suggestionInstructions).toBe(
      'Avoid metaphors.'
    )
  })

  it.each(['local', 'openai'] as const)(
    'offers one next automatic continuation after full acceptance in %s mode',
    async provider => {
      const settings = {
        ...makeSettings(),
        provider,
        externalAutoEnabled: provider !== 'local',
      }
      const editor = mountEditor(makeNote(), settings)
      act(() =>
        editor.view.dispatch({
          selection: EditorSelection.cursor(editor.view.state.doc.length),
        })
      )
      await act(async () => editor.ref.current?.requestSuggestion())
      act(() => fireEvent.keyDown(editor.content, { key: 'Tab' }))
      expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
      await act(async () => vi.advanceTimersByTime(499))
      expect(suggest).toHaveBeenCalledTimes(1)
      await act(async () => vi.advanceTimersByTime(1))
      expect(suggest).toHaveBeenCalledTimes(2)
      expect(vi.mocked(suggest).mock.calls[1]?.[2].provider).toBe(provider)
      expect(vi.mocked(suggest).mock.calls[1]?.[1].text).toBe(
        'A thought in progress with a useful next thought.'
      )
      await act(async () => vi.advanceTimersByTime(2_000))
      expect(suggest).toHaveBeenCalledTimes(2)
      expect(editor.view.state.doc.toString()).toBe(
        'A thought in progress with a useful next thought.'
      )
    }
  )

  it('preserves a remaining word preview without starting another automatic request', async () => {
    const editor = mountEditor()
    await act(async () => editor.ref.current?.requestSuggestion())
    act(() =>
      fireEvent.keyDown(editor.content, { key: 'ArrowRight', ctrlKey: true })
    )
    const remaining = editor.view.state.field(inlineSuggestionField)
    expect(remaining?.text).toBe('a useful next thought.')
    await act(async () => vi.advanceTimersByTime(2_000))
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(editor.view.state.field(inlineSuggestionField)).toBe(remaining)
  })

  it('keeps manual-only mode quiet after full acceptance', async () => {
    const editor = mountEditor(makeNote(), {
      ...makeSettings(),
      autoSuggest: false,
      externalAutoEnabled: true,
    })
    await act(async () => editor.ref.current?.requestSuggestion())
    act(() => fireEvent.keyDown(editor.content, { key: 'Tab' }))
    await act(async () => vi.advanceTimersByTime(2_000))
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
  })

  it('cancels requests when the page is hidden and never schedules inference in a hidden page', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('visible')
    const pending = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => pending.promise)
    const editor = mountEditor(makeNote(), {
      ...makeSettings(),
      externalAutoEnabled: true,
    })
    await act(async () => editor.ref.current?.requestSuggestion())
    const signal = vi.mocked(suggest).mock.calls[0]?.[3]
    await act(async () => {
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve({ text: 'stale.', sources: [] }))
    act(() =>
      editor.view.dispatch({ changes: { from: 0, insert: 'Changed ' } })
    )
    await act(async () => vi.advanceTimersByTime(2_000))
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
    visibility.mockRestore()
  })

  it('invalidates embedded results and cached insertions when the local worker is unloaded or replaced', async () => {
    const settings = {
      ...makeSettings(),
      provider: 'local' as const,
      localEngine: 'embedded' as const,
    }
    const editor = mountEditor(makeNote(), settings)
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(editor.view.state.field(inlineSuggestionField)).not.toBeNull()
    await act(async () => {
      vi.mocked(getBuiltinState).mockReturnValue({
        ...getBuiltinState(),
        identity: 'builtin-1',
        status: 'idle',
      })
      builtinListener?.()
    })
    expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(2)
    const pending = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => pending.promise)
    act(() =>
      editor.view.dispatch({ changes: { from: 0, insert: 'Changed ' } })
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    const signal = vi.mocked(suggest).mock.calls[2]?.[3]
    await act(async () => {
      vi.mocked(getBuiltinState).mockReturnValue({
        ...getBuiltinState(),
        identity: 'builtin-2',
      })
      builtinListener?.()
    })
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      pending.resolve({
        text: ' stale embedded insertion.',
        sources: [],
        mode: 'model',
      })
    )
    expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
  })

  it('handles the manual shortcut once and accepts a word through the keyboard', async () => {
    const { view, content } = mountEditor()
    act(() => {
      view.focus()
      view.dispatch({
        selection: EditorSelection.cursor(view.state.doc.length),
      })
    })
    await act(async () => {
      fireEvent.keyDown(content, { key: ' ', code: 'Space', ctrlKey: true })
    })
    expect(suggest).toHaveBeenCalledTimes(1)
    act(() => {
      fireEvent.keyDown(content, {
        key: 'ArrowRight',
        code: 'ArrowRight',
        ctrlKey: true,
      })
    })
    expect(view.state.doc.toString()).toBe('A thought in progress with ')
    expect(view.state.field(inlineSuggestionField)?.text).toBe(
      'a useful next thought.'
    )
    expect(view.state.field(acceptedRangeField)).not.toBeNull()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept suggestion' }))
    })
    expect(view.state.doc.toString()).toBe(
      'A thought in progress with a useful next thought.'
    )
    act(() => vi.advanceTimersByTime(240))
    expect(view.state.field(acceptedRangeField)).toBeNull()
  })

  it('accepts with Tab and dismisses with Escape without inserting text', async () => {
    const { ref, view, content, onChange } = mountEditor()
    act(() =>
      view.dispatch({
        selection: EditorSelection.cursor(view.state.doc.length),
      })
    )
    await act(async () => ref.current?.requestSuggestion())
    expect(
      screen.getByRole('button', { name: 'Accept suggestion' })
    ).toBeVisible()
    await act(async () => {
      fireEvent.keyDown(content, { key: 'Escape', code: 'Escape' })
    })
    expect(view.state.field(inlineSuggestionField)).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => ref.current?.requestSuggestion())
    act(() => {
      fireEvent.keyDown(content, { key: 'Tab', code: 'Tab' })
    })
    expect(onChange).toHaveBeenLastCalledWith(
      'A thought in progress with a useful next thought.'
    )
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('A thought in progress')
  })

  it('aborts edits and serializes the next request even when abort settles late', async () => {
    const first = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => first.promise)
    const { ref, view } = mountEditor()
    await act(async () => ref.current?.requestSuggestion())
    const firstSignal = vi.mocked(suggest).mock.calls[0]?.[3]
    act(() => view.dispatch({ changes: { from: 0, insert: 'Changed ' } }))
    expect(firstSignal?.aborted).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(suggest).toHaveBeenCalledTimes(1)
    await act(async () =>
      first.resolve({ text: 'stale suggestion', sources: [] })
    )
    expect(suggest).toHaveBeenCalledTimes(2)
    expect(view.state.field(inlineSuggestionField)?.text).toBe(
      ' with a useful next thought.'
    )
  })

  it('drops a late error after switching notes and never updates the new note status', async () => {
    const first = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => first.promise)
    const editor = mountEditor()
    await act(async () => editor.ref.current?.requestSuggestion())
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={makeNote('A fresh note')}
        ref={editor.ref}
      />
    )
    const newStatusCount = editor.onStatus.mock.calls.length
    await act(async () => first.reject(new Error('Late failure')))
    expect(editor.onStatus).toHaveBeenCalledTimes(newStatusCount)
    expect(
      screen.queryByRole('button', { name: 'Accept suggestion' })
    ).toBeNull()
    expect(
      screen.getByRole('textbox', { name: 'Note content' })
    ).toHaveTextContent('A fresh note')
  })

  it('does not request with a selection, or when automatic suggestions are disabled', async () => {
    const editor = mountEditor()
    act(() => {
      editor.view.focus()
      editor.view.dispatch({ selection: EditorSelection.range(0, 3) })
    })
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).not.toHaveBeenCalled()
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        settings={{ ...editor.props.settings, autoSuggest: false }}
        ref={editor.ref}
      />
    )
    act(() =>
      editor.view.dispatch({
        changes: { from: 0, insert: 'New ' },
        selection: EditorSelection.cursor(4),
      })
    )
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(suggest).not.toHaveBeenCalled()
  })

  it('pauses while composing and debounces after an IME edit finishes', async () => {
    const { view, content } = mountEditor()
    act(() => view.focus())
    act(() => {
      fireEvent.compositionStart(content)
      view.dispatch({ changes: { from: 0, insert: '写作 ' } })
    })
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(suggest).not.toHaveBeenCalled()
    act(() => {
      fireEvent.compositionEnd(content)
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(suggest).toHaveBeenCalledTimes(1)
  })

  it('invalidates an in-flight response when suggestions are disabled', async () => {
    const first = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => first.promise)
    const editor = mountEditor()
    await act(async () => editor.ref.current?.requestSuggestion())
    const signal = vi.mocked(suggest).mock.calls[0]?.[3]
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        settings={{ ...editor.props.settings, suggestionsEnabled: false }}
        ref={editor.ref}
      />
    )
    expect(signal?.aborted).toBe(true)
    await act(async () =>
      first.resolve({ text: 'Should never appear', sources: [] })
    )
    expect(editor.view.state.field(inlineSuggestionField)).toBeNull()
    expect(editor.onStatus.mock.lastCall?.[0].state).toBe('idle')
  })

  it('reuses exact requests but invalidates the cache after objective changes', async () => {
    const editor = mountEditor()
    await act(async () => editor.ref.current?.requestSuggestion())
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(1)
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={{
          ...editor.props.note,
          objective: 'Explain a different subject.',
        }}
        ref={editor.ref}
      />
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(2)
  })

  it('updates external content without onChange feedback and preserves tab undo history', () => {
    const editor = mountEditor(makeNote('First'))
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={{ ...editor.props.note, content: 'Updated' }}
        ref={editor.ref}
      />
    )
    expect(editor.view.state.doc.toString()).toBe('Updated')
    expect(editor.onChange).not.toHaveBeenCalled()
    act(() =>
      editor.view.dispatch({
        changes: { from: 7, insert: ' thought' },
        selection: EditorSelection.cursor(15),
      })
    )
    const written = {
      ...editor.props.note,
      content: editor.view.state.doc.toString(),
    }
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={makeNote('Second')}
        ref={editor.ref}
      />
    )
    editor.rerender(
      <MarkdownEditor {...editor.props} note={written} ref={editor.ref} />
    )
    const restored = EditorView.findFromDOM(
      screen.getByRole('textbox', { name: 'Note content' })
    )
    expect(restored?.state.selection.main.head).toBe(15)
    expect(restored && undo(restored)).toBe(true)
    expect(restored?.state.doc.toString()).toBe('Updated')
  })

  it('reuses the materialized document for cursor-only movement', () => {
    const editor = mountEditor(makeNote('A large paragraph.\n'.repeat(10_000)))
    const stringify = vi.spyOn(editor.view.state.doc, 'toString')
    act(() => {
      for (let index = 1; index <= 30; index++)
        editor.view.dispatch({ selection: EditorSelection.cursor(index) })
    })
    expect(stringify).not.toHaveBeenCalled()
    expect(editor.onCursorChange).toHaveBeenLastCalledWith({
      text: editor.props.note.content,
      cursor: 30,
      selectionEmpty: true,
    })
    expect(editor.onChange).not.toHaveBeenCalled()
  })

  it('keeps cached Windows line endings aligned with the actual document and cursor', async () => {
    const editor = mountEditor(makeNote('# Heading\r\n\r\nBody'))
    const text = '# Heading\n\nBody'
    expect(editor.onCursorChange).toHaveBeenLastCalledWith({
      text,
      cursor: 0,
      selectionEmpty: true,
    })
    act(() => editor.view.dispatch({ selection: EditorSelection.cursor(13) }))
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: text }),
      { text, cursor: 13, selectionEmpty: true },
      expect.anything(),
      expect.any(AbortSignal)
    )
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={{ ...editor.props.note, content: 'First\rSecond\r\nThird' }}
        ref={editor.ref}
      />
    )
    expect(editor.view.state.doc.toString()).toBe('First\nSecond\nThird')
    expect(editor.onCursorChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'First\nSecond\nThird' })
    )
    expect(editor.onChange).not.toHaveBeenCalled()
    act(() => editor.view.dispatch({ changes: { from: 0, insert: 'My ' } }))
    expect(editor.onChange).toHaveBeenLastCalledWith('My First\nSecond\nThird')
  })

  it('keeps an in-flight request through equal source copies, but invalidates same-length text changes', async () => {
    const pending = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => pending.promise)
    const note = makeNote()
    note.sources = [
      {
        id: 'large-source',
        name: 'Research',
        kind: 'text',
        text: 'a'.repeat(250_000),
        enabled: true,
        addedAt: 1,
      },
    ]
    const editor = mountEditor(note)
    await act(async () => editor.ref.current?.requestSuggestion())
    const signal = vi.mocked(suggest).mock.calls[0]?.[3]
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={{ ...note, sources: note.sources.map(source => ({ ...source })) }}
        ref={editor.ref}
      />
    )
    expect(signal?.aborted).toBe(false)
    await act(async () =>
      pending.resolve({ text: ' retained context.', sources: ['Research'] })
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(1)
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={{
          ...note,
          sources: note.sources.map(source => ({
            ...source,
            text: 'b'.repeat(250_000),
          })),
        }}
        ref={editor.ref}
      />
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    expect(suggest).toHaveBeenCalledTimes(2)
  })

  it('destroys views and cancels queued work and timers when a note closes', async () => {
    const pending = deferred<SuggestionResult>()
    vi.mocked(suggest).mockImplementationOnce(() => pending.promise)
    const editor = mountEditor()
    const destroy = vi.spyOn(editor.view, 'destroy')
    await act(async () => editor.ref.current?.requestSuggestion())
    const signal = vi.mocked(suggest).mock.calls[0]?.[3]
    editor.rerender(
      <MarkdownEditor
        {...editor.props}
        note={makeNote('A queued note')}
        ref={editor.ref}
      />
    )
    await act(async () => editor.ref.current?.requestSuggestion())
    editor.unmount()
    await act(async () => {
      pending.resolve({ text: ' disposed text.', sources: [] })
      vi.advanceTimersByTime(2000)
    })
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds repeated large replacements while preserving the latest undo and redo', async () => {
    const editor = mountEditor(makeNote('Start'))
    const versions = Array.from(
      { length: 30 },
      (_, index) => `${index} ${'x'.repeat(100_000)}`
    )
    for (const text of versions) {
      await act(async () =>
        editor.view.dispatch({
          changes: { from: 0, to: editor.view.state.doc.length, insert: text },
          selection: EditorSelection.cursor(text.length),
          annotations: [
            Transaction.userEvent.of('input.paste'),
            isolateHistory.of('full'),
          ],
        })
      )
    }
    expect(undoDepth(editor.view.state)).toBeGreaterThan(0)
    expect(undoDepth(editor.view.state)).toBeLessThan(15)
    await act(async () => {
      expect(undo(editor.view)).toBe(true)
    })
    expect(editor.view.state.doc.toString()).toBe(versions.at(-2))
    await act(async () => {
      expect(redo(editor.view)).toBe(true)
    })
    expect(editor.view.state.doc.toString()).toBe(versions.at(-1))
  })

  it('does not repeatedly rebuild history after retaining one unavoidable large undo action', async () => {
    const editor = mountEditor(makeNote('x'.repeat(2_000_000)))
    const serialize = vi.spyOn(EditorState.prototype, 'toJSON')
    await act(async () =>
      editor.view.dispatch({
        changes: { from: 0, to: editor.view.state.doc.length, insert: 'Small' },
        annotations: [
          Transaction.userEvent.of('input.paste'),
          isolateHistory.of('full'),
        ],
      })
    )
    expect(serialize).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 10; index++)
      await act(async () =>
        editor.view.dispatch({
          changes: { from: editor.view.state.doc.length, insert: 'x' },
          annotations: Transaction.userEvent.of('input.type'),
        })
      )
    expect(serialize).toHaveBeenCalledTimes(1)
    await act(async () => {
      expect(undo(editor.view)).toBe(true)
    })
    expect(editor.view.state.doc.toString()).toBe('Small')
    await act(async () => {
      expect(undo(editor.view)).toBe(true)
    })
    expect(editor.view.state.doc.length).toBe(2_000_000)
  })

  it('preserves the active ghost and expires its accepted highlight across a history rebuild', async () => {
    const editor = mountEditor(makeNote('x'.repeat(2_000_000)))
    await act(async () =>
      editor.view.dispatch({
        changes: {
          from: 0,
          to: editor.view.state.doc.length,
          insert: 'My words',
        },
        selection: EditorSelection.cursor(8),
        effects: [
          setInlineSuggestion.of({
            at: 8,
            text: ' stay mine.',
            sources: ['Local context'],
          }),
          setAcceptedRange.of({ from: 0, to: 2 }),
        ],
        annotations: [
          Transaction.userEvent.of('input.complete'),
          isolateHistory.of('full'),
        ],
      })
    )
    expect(editor.view.state.field(inlineSuggestionField)?.text).toBe(
      ' stay mine.'
    )
    expect(editor.view.state.selection.main.head).toBe(8)
    expect(editor.view.state.field(acceptedRangeField)).toEqual({
      from: 0,
      to: 2,
    })
    await act(async () => {
      vi.advanceTimersByTime(240)
    })
    expect(editor.view.state.field(acceptedRangeField)).toBeNull()
    await act(async () => {
      expect(acceptInlineSuggestion(editor.view)).toBe(true)
    })
    expect(editor.view.state.doc.toString()).toBe('My words stay mine.')
    await act(async () => {
      expect(undo(editor.view)).toBe(true)
    })
    expect(editor.view.state.doc.toString()).toBe('My words')
  })

  it('evicts heavy inactive undo states while retaining their writing and cursor', async () => {
    const notes: Note[] = []
    const editor = mountEditor(makeNote('First'))
    function view() {
      return EditorView.findFromDOM(
        screen.getByRole('textbox', { name: 'Note content' })
      )!
    }
    for (let index = 0; index < 7; index++) {
      const note = makeNote(`${index}: ${'x'.repeat(400_000)}`)
      editor.rerender(
        <MarkdownEditor {...editor.props} note={note} ref={editor.ref} />
      )
      for (let revision = 0; revision < 2; revision++) {
        const text = `${index}/${revision}: ${'y'.repeat(400_000)}`
        await act(async () =>
          view().dispatch({
            changes: { from: 0, to: view().state.doc.length, insert: text },
            selection: EditorSelection.cursor(200_000),
            annotations: [
              Transaction.userEvent.of('input.paste'),
              isolateHistory.of('full'),
            ],
          })
        )
      }
      notes.push({ ...note, content: view().state.doc.toString() })
    }
    editor.rerender(
      <MarkdownEditor {...editor.props} note={notes[0]!} ref={editor.ref} />
    )
    expect(view().state.doc.toString()).toBe(notes[0]?.content)
    expect(view().state.selection.main.head).toBe(200_000)
    expect(undoDepth(view().state)).toBe(0)
    editor.rerender(
      <MarkdownEditor {...editor.props} note={notes.at(-1)!} ref={editor.ref} />
    )
    expect(undoDepth(view().state)).toBeGreaterThan(0)
  })

  it('tracks exact UTF-8 bytes across surrogate boundaries and multiple changed spans', () => {
    let state = EditorState.create({
      doc: 'a😀b\ud800c\udc00d',
      extensions: [documentByteSize],
    })
    const edits = [
      [{ from: 2, to: 3, insert: '' }],
      [
        { from: 1, to: 2, insert: 'é' },
        { from: 4, to: 5, insert: '界' },
      ],
      [
        { from: 0, insert: '\ud800' },
        { from: 2, insert: '\udc00' },
      ],
      [{ from: 0, to: 3, insert: '🪴' }],
    ]
    for (const changes of edits) {
      state = state.update({ changes }).state
      expect(state.field(documentByteSize)).toBe(
        new TextEncoder().encode(state.doc.toString()).byteLength
      )
    }
  })

  it('defers a large history rebuild until an IME composition finishes', async () => {
    const original = 'x'.repeat(2_000_000)
    const { view, content } = mountEditor(makeNote(original))
    const rebuild = vi.spyOn(view, 'setState')
    await act(async () => {
      fireEvent.compositionStart(content)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '写作' },
        annotations: Transaction.userEvent.of('input.type.compose'),
      })
    })
    expect(rebuild).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('写作')
    await act(async () => fireEvent.compositionEnd(content))
    expect(rebuild).toHaveBeenCalledTimes(1)
    await act(async () => {
      expect(undo(view)).toBe(true)
    })
    expect(view.state.doc.toString()).toBe(original)
  })

  it('keeps the incremental byte budget exact over mixed Unicode edits', () => {
    let state = EditorState.create({
      doc: 'A😀é界\n\ud800\udc00B',
      extensions: [documentByteSize],
    })
    let seed = 314159
    function random(limit: number) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const inserts = ['A', 'é', '界', '😀', '\ud800', '\udc00', '\n', '']
    for (let index = 0; index < 400; index++) {
      const first = random(state.doc.length + 1)
      const second = first + random(state.doc.length - first + 1)
      const changes = [
        { from: first, to: second, insert: inserts[random(inserts.length)]! },
      ]
      if (second < state.doc.length)
        changes.push({
          from: second + 1,
          to: second + 1,
          insert: inserts[random(inserts.length)]!,
        })
      state = state.update({ changes }).state
      expect(state.field(documentByteSize)).toBe(
        new TextEncoder().encode(state.doc.toString()).byteLength
      )
    }
  })

  it('rejects direct and imperative oversized insertions without truncation, then allows a precise UTF-8 boundary edit', async () => {
    const original = 'a'.repeat(STORAGE_LIMITS.noteBytes - 4)
    const editor = mountEditor(makeNote(original))
    await act(async () =>
      editor.view.dispatch({
        changes: { from: original.length, insert: '😀😀' },
      })
    )
    act(() =>
      editor.view.dispatch({
        selection: EditorSelection.cursor(original.length),
      })
    )
    await act(async () =>
      expect(() => editor.ref.current!.insert('😀😀')).toThrow('8 MiB')
    )
    expect(editor.view.state.doc.length).toBe(original.length)
    expect(editor.onChange).not.toHaveBeenCalled()
    expect(editor.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'error',
        kind: 'document',
        message: expect.stringContaining('8 MiB'),
      })
    )
    await act(async () => editor.ref.current!.insert('😀'))
    expect(editor.view.state.field(documentByteSize)).toBe(
      STORAGE_LIMITS.noteBytes
    )
    expect(editor.view.state.doc.toString()).toBe(`${original}😀`)
    await act(async () =>
      editor.view.dispatch({
        changes: { from: original.length, to: original.length + 1, insert: '' },
      })
    )
    expect(editor.view.state.field(documentByteSize)).toBe(
      STORAGE_LIMITS.noteBytes - 1
    )
  }, 30_000)
  it('allows an identical selection replacement instead of misclassifying it as a blocked insertion', () => {
    const editor = mountEditor(makeNote('The same ending.'))
    act(() => editor.view.dispatch({ selection: EditorSelection.range(4, 8) }))
    act(() => expect(() => editor.ref.current!.insert('same')).not.toThrow())
    expect(editor.view.state.doc.toString()).toBe('The same ending.')
    expect(editor.onChange).toHaveBeenCalledExactlyOnceWith('The same ending.')
  })
})
