import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { smartReplacement, writingFlow, type FlowHost } from './writing-flow'
import { activeHeading, addWordsToday, outlineOf, readingMinutes, wordsToday } from '../../notebook/WritingAids'

const views: EditorView[] = []
afterEach(() => {
  views.splice(0).forEach(view => view.destroy())
  localStorage.clear()
})

function host(patch: Partial<FlowHost> = {}): FlowHost {
  return {
    selectionToolbar: () => true,
    typewriter: () => false,
    focus: () => 'off',
    smartTypography: () => true,
    webFacts: () => false,
    runWebFacts: vi.fn(),
    ...patch,
  }
}

function editor(doc: string, flow = host(), cursor = doc.length) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), writingFlow(flow)],
    }),
    parent: document.body,
  })
  ensureSyntaxTree(view.state, view.state.doc.length, 5_000)
  views.push(view)
  return view
}

function type(view: EditorView, text: string) {
  for (const character of text) {
    const at = view.state.selection.main.head
    const handled = view.state.facet(EditorView.inputHandler).some(handler => handler(view, at, at, character, () => view.state.update({ changes: { from: at, insert: character } })))
    if (!handled) view.dispatch({ changes: { from: at, insert: character }, selection: EditorSelection.cursor(at + 1), userEvent: 'input.type' })
  }
}

describe('smart typography', () => {
  it('turns ASCII shortcuts into dashes, ellipses and arrows', () => {
    expect(smartReplacement('word-', '-')).toEqual({ remove: 1, insert: '—' })
    expect(smartReplacement('a -', '-')).toEqual({ remove: 1, insert: '—' })
    expect(smartReplacement('wait..', '.')).toEqual({ remove: 2, insert: '…' })
    expect(smartReplacement('go -', '>')).toEqual({ remove: 1, insert: '→' })
    expect(smartReplacement('x <', '-')).toEqual({ remove: 1, insert: '←' })
  })

  it('keeps list markers, rules and table delimiters', () => {
    expect(smartReplacement('-', '-')).toBeNull()
    expect(smartReplacement('  -', '-')).toBeNull()
    expect(smartReplacement('| -', '-')).toBeNull()
    expect(smartReplacement('a—', '-')).toBeNull()
  })

  it('applies while typing, but not in code or when turned off', () => {
    const view = editor('')
    type(view, 'Yes--no...')
    expect(view.state.doc.toString()).toBe('Yes—no…')
    const code = editor('`a')
    type(code, '--')
    expect(code.state.doc.toString()).toBe('`a--')
    const off = editor('', host({ smartTypography: () => false }))
    type(off, 'a--b')
    expect(off.state.doc.toString()).toBe('a--b')
  })
})

describe('format bar', () => {
  it('appears for a selection and formats it', () => {
    const view = editor('Make this bold')
    view.dispatch({ selection: EditorSelection.range(10, 14) })
    const bar = view.dom.querySelector('.cm-format-bar')
    expect(bar).not.toBeNull()
    ;(bar!.querySelector('button[aria-label="Bold"]') as HTMLButtonElement).click()
    expect(view.state.doc.toString()).toBe('Make this **bold**')
  })

  it('offers web facts only when available, and stays hidden in code or when off', () => {
    const run = vi.fn()
    const view = editor('Webb launched', host({ webFacts: () => true, runWebFacts: run }))
    view.dispatch({ selection: EditorSelection.range(0, 4) })
    ;(view.dom.querySelector('button[aria-label="Search the web for facts"]') as HTMLButtonElement).click()
    expect(run).toHaveBeenCalled()
    const code = editor('```\ncode here\n```')
    code.dispatch({ selection: EditorSelection.range(4, 8) })
    expect(code.dom.querySelector('.cm-format-bar')).toBeNull()
    const off = editor('Text', host({ selectionToolbar: () => false }))
    off.dispatch({ selection: EditorSelection.range(0, 4) })
    expect(off.dom.querySelector('.cm-format-bar')).toBeNull()
  })
})

describe('smart paste', () => {
  it('pastes a web address as a link and uses the page title', async () => {
    const view = editor('See ', host({ linkTitle: async () => 'The Real Title' }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'https://www.example.com/page/' : '') },
    })
    view.contentDOM.dispatchEvent(event)
    expect(view.state.doc.toString()).toBe('See [example.com/page](https://www.example.com/page/)')
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe('See [The Real Title](https://www.example.com/page/)'))
  })
})

describe('focus dimming', () => {
  it('dims lines outside the current paragraph', () => {
    const view = editor('First paragraph.\n\nSecond line one\nline two\n\nThird.', host({ focus: () => 'paragraph' }), 20)
    view.focus()
    view.dispatch({ selection: EditorSelection.cursor(22) })
    const lines = [...view.dom.querySelectorAll('.cm-line')].map(line => line.classList.contains('cm-flow-dim'))
    expect(lines).toEqual([true, true, false, false, true, true])
  })
})

describe('writing aids', () => {
  it('builds an outline outside code fences', () => {
    const text = '# One\ntext\n```\n# not a heading\n```\n## Two **bold**\n### Three ###'
    expect(outlineOf(text)).toEqual([
      { level: 1, text: 'One', from: 0 },
      { level: 2, text: 'Two bold', from: text.indexOf('## Two') },
      { level: 3, text: 'Three', from: text.indexOf('### Three') },
    ])
    const headings = outlineOf(text)
    expect(activeHeading(headings, 0)).toBe(0)
    expect(activeHeading(headings, text.length)).toBe(2)
    expect(activeHeading([], 4)).toBe(-1)
  })

  it('counts today’s words and caps a large paste', () => {
    expect(wordsToday()).toBe(0)
    expect(addWordsToday(120)).toBe(120)
    expect(addWordsToday(-50)).toBe(120)
    expect(addWordsToday(10_000)).toBe(2_120)
    expect(readingMinutes(10)).toBe(1)
    expect(readingMinutes(2300)).toBe(10)
  })
})
