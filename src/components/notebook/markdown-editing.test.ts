import { afterEach, describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { CompletionContext } from '@codemirror/autocomplete'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  formatTable,
  insertLink,
  insertTableRow,
  moveTableCell,
  parseListItem,
  shiftListItems,
  smartEnter,
  smartShiftTab,
  smartTab,
  splitRow,
  tableAt,
  tableTemplate,
  toggleTask,
  wrapSelection,
} from './markdown-editing'
import {
  commandScore,
  expandTemplate,
  slashCommands,
  slashSource,
  wikiLinkSource,
  type EditorHost,
} from './editor-completions'
import { livePreview, renderInline } from './live-preview'
import { linkAt } from './link-tools'
import { defaultEditorSettings } from '../../notebook/model'
import type { EditorSettings, Note } from '../../types/notebook'

const views: EditorView[] = []
afterEach(() => {
  views.splice(0).forEach(view => view.destroy())
})

/** `|` in the document marks the cursor; `[` and `]` mark a selection. */
function editor(text: string, extensions: Extension[] = []) {
  let doc = text
  let selection = EditorSelection.cursor(0)
  const start = doc.indexOf('[[sel')
  if (start >= 0) {
    const end = doc.indexOf('sel]]')
    doc = doc.slice(0, start) + doc.slice(start + 5, end) + doc.slice(end + 5)
    selection = EditorSelection.range(start, end - 5)
  } else if (doc.includes('‸')) {
    const at = doc.indexOf('‸')
    doc = doc.replace('‸', '')
    selection = EditorSelection.cursor(at)
  }
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        markdown({ base: markdownLanguage, addKeymap: false }),
        ...extensions,
      ],
    }),
    parent: document.body,
  })
  ensureSyntaxTree(view.state, view.state.doc.length, 5_000)
  views.push(view)
  return view
}

function text(view: EditorView) {
  const doc = view.state.doc.toString()
  const { from, to } = view.state.selection.main
  return from === to ? `${doc.slice(0, from)}‸${doc.slice(from)}` : doc
}

describe('list editing', () => {
  it('parses bullets, numbers and tasks', () => {
    expect(parseListItem('  - [ ] milk')).toMatchObject({
      indent: '  ',
      marker: '-',
      task: '[ ] ',
      contentOffset: 4,
    })
    expect(parseListItem('12) twelve')).toMatchObject({
      marker: '12)',
      contentOffset: 4,
    })
    expect(parseListItem('plain text')).toBeNull()
  })

  it('nests an item under its previous sibling and outdents it again', () => {
    const view = editor('- one\n- tw‸o\n- three')
    expect(shiftListItems(view, 1)).toBe(true)
    expect(text(view)).toBe('- one\n  - tw‸o\n- three')
    expect(shiftListItems(view, -1)).toBe(true)
    expect(text(view)).toBe('- one\n- tw‸o\n- three')
  })

  it('does not nest the first item, which has no parent', () => {
    const view = editor('- fir‸st\n- second')
    expect(shiftListItems(view, 1)).toBe(true)
    expect(text(view)).toBe('- fir‸st\n- second')
  })

  it('renumbers ordered lists after indenting and outdenting', () => {
    const view = editor('1. one\n2. tw‸o\n3. three')
    shiftListItems(view, 1)
    expect(view.state.doc.toString()).toBe('1. one\n   1. two\n2. three')
    shiftListItems(view, -1)
    expect(view.state.doc.toString()).toBe('1. one\n2. two\n3. three')
  })

  it('indents several selected items at once', () => {
    const view = editor('- a\n[[sel- b\n- csel]]')
    shiftListItems(view, 1)
    expect(view.state.doc.toString()).toBe('- a\n  - b\n  - c')
  })

  it('Tab outside lists and tables inserts an indent unit', () => {
    const view = editor('Hello‸')
    expect(smartTab(view)).toBe(true)
    expect(text(view)).toBe('Hello  ‸')
    smartShiftTab(view)
    expect(view.state.doc.toString()).toBe('Hello  ')
  })

  it('Enter continues lists and tasks', () => {
    const view = editor('- [x] done‸')
    smartEnter(view)
    expect(text(view)).toBe('- [x] done\n- [ ] ‸')
  })

  it('Enter on an empty item leaves the list, or moves a nested item out', () => {
    const view = editor('- [ ] Water\n- [ ] ‸')
    smartEnter(view)
    expect(text(view)).toBe('- [ ] Water\n‸')
    const nested = editor('- a\n  - b\n  - ‸')
    smartEnter(nested)
    expect(text(nested)).toBe('- a\n  - b\n- ‸')
    smartEnter(nested)
    expect(text(nested)).toBe('- a\n  - b\n‸')
  })

  it('Tab into an empty table cell puts the cursor at the cell start', () => {
    const view = editor('| Name | Role |\n| --- | --- |\n| Ada | x‸ |\n|  |  |')
    moveTableCell(view, 1)
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    expect(view.state.selection.main.head - line.from).toBe(2)
  })

  it('toggles tasks and converts lines into tasks', () => {
    const view = editor('- [ ] wa‸ter')
    toggleTask(view)
    expect(view.state.doc.toString()).toBe('- [x] water')
    toggleTask(view)
    expect(view.state.doc.toString()).toBe('- [ ] water')
    const plain = editor('Buy br‸ead')
    toggleTask(plain)
    expect(plain.state.doc.toString()).toBe('- [ ] Buy bread')
  })
})

describe('table editing', () => {
  const table = '| Name | Age |\n| --- | --: |\n| Ada | 36 |'

  it('splits rows, keeping escaped pipes and code spans', () => {
    expect(splitRow('| a \\| b | `x|y` | c |')).toEqual([
      'a \\| b',
      '`x|y`',
      'c',
    ])
  })

  it('finds a table and its alignments', () => {
    const view = editor(`${table}\n\nAfter`)
    const found = tableAt(view.state, 3)!
    expect(found.firstLine).toBe(1)
    expect(found.lastLine).toBe(3)
    expect(found.alignments).toEqual([null, 'right'])
    expect(tableAt(view.state, view.state.doc.length)).toBeNull()
  })

  it('formats aligned columns, counting wide characters', () => {
    const { lines } = formatTable({
      rows: [
        ['A', '名前'],
        ['---', '---'],
        ['long text', 'x'],
      ],
      alignments: [null, 'center'],
      indent: '',
    })
    expect(lines).toEqual([
      '| A         | 名前 |',
      '| --------- | :--: |',
      '| long text |  x   |',
    ])
  })

  it('Tab moves to the next cell, selects it and aligns the table', () => {
    const view = editor('| Name | Age |\n| --- | --- |\n| Ada‸ | 36 |')
    expect(moveTableCell(view, 1)).toBe(true)
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('36')
    expect(view.state.doc.toString()).toBe(
      '| Name | Age |\n| ---- | --- |\n| Ada  | 36  |'
    )
  })

  it('Tab after the last cell adds a row; Shift-Tab goes back', () => {
    const view = editor('| A | B |\n| --- | --- |\n| 1 | 2‸ |')
    moveTableCell(view, 1)
    expect(view.state.doc.lines).toBe(4)
    expect(view.state.doc.line(4).text).toBe('|     |     |')
    moveTableCell(view, -1)
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to
      )
    ).toBe('2')
  })

  it('Shift-Tab in the first body cell skips the delimiter row', () => {
    const view = editor('| A | B |\n| --- | --- |\n| 1‸ | 2 |')
    moveTableCell(view, -1)
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('B')
  })

  it('Enter inserts a row below; Enter on an empty last row leaves the table', () => {
    const view = editor('| A | B |\n| --- | --- |\n| 1‸ | 2 |')
    expect(insertTableRow(view)).toBe(true)
    expect(view.state.doc.lines).toBe(4)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4)
    expect(insertTableRow(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(
      '| A   | B   |\n| --- | --- |\n| 1   | 2   |\n'
    )
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
  })

  it('does not treat code blocks as tables', () => {
    const view = editor('```\n| a | b |\n| - | - |\n| c‸ | d |\n```')
    expect(moveTableCell(view, 1)).toBe(false)
  })

  it('creates a template that parses as a table', () => {
    const view = editor(tableTemplate(3, 2))
    expect(tableAt(view.state, 0)?.rows).toHaveLength(4)
  })
})

describe('formatting commands', () => {
  it('wraps and unwraps a selection', () => {
    const view = editor('a [[selwordsel]] b')
    wrapSelection(view, '**')
    expect(view.state.doc.toString()).toBe('a **word** b')
    view.dispatch({ selection: EditorSelection.range(2, 10) })
    wrapSelection(view, '**')
    expect(view.state.doc.toString()).toBe('a word b')
  })

  it('turns a selection into a link and selects the address', () => {
    const view = editor('See [[selthe docssel]].')
    insertLink(view)
    expect(view.state.doc.toString()).toBe('See [the docs](https://).')
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('https://')
  })
})

function host(
  settings: Partial<EditorSettings> = {},
  notes: Note[] = []
): EditorHost & { actions: string[] } {
  const actions: string[] = []
  return {
    actions,
    settings: () => ({ ...defaultEditorSettings(), ...settings }),
    webFacts: () => true,
    notes: () => notes,
    noteId: () => 'current',
    runAction: action => actions.push(action),
  }
}

function complete(
  view: EditorView,
  source: ReturnType<typeof slashSource>,
  explicit = false
) {
  return source(
    new CompletionContext(view.state, view.state.selection.main.head, explicit)
  )
}

describe('insert menu', () => {
  it('ranks commands by name, word, keyword and subsequence', () => {
    expect(
      commandScore({ name: 'Heading 1', keywords: ['h1'] }, 'hea')
    ).toBeGreaterThan(
      commandScore({ name: 'Bulleted list', keywords: ['bullet'] }, 'li')!
    )
    expect(commandScore({ name: 'Heading 1', keywords: ['h1'] }, 'h1')).toBe(60)
    expect(commandScore({ name: 'Bulleted list', keywords: [] }, 'bl')).toBe(20)
    expect(commandScore({ name: 'Table', keywords: [] }, 'zz')).toBeNull()
  })

  it('opens at the start of a word only, and stays closed for // and URLs', () => {
    const source = slashSource(host())
    expect(complete(editor('/‸'), source)?.options.length).toBeGreaterThan(10)
    expect(complete(editor('Text /tab‸'), source)?.options[0]?.label).toBe(
      'Table'
    )
    expect(complete(editor('a//‸'), source)).toBeNull()
    expect(complete(editor('https:/‸'), source)).toBeNull()
    expect(complete(editor('/zzzz‸'), source)).toBeNull()
    expect(complete(editor('`code /h‸`'), source)).toBeNull()
  })

  it('respects the trigger character and the off switch', () => {
    expect(
      complete(editor('/h‸'), slashSource(host({ slashMenu: false })))
    ).toBeNull()
    expect(
      complete(editor('/h‸'), slashSource(host({ slashTrigger: ';' })))
    ).toBeNull()
    expect(
      complete(editor(';h‸'), slashSource(host({ slashTrigger: ';' })))
        ?.options[0]?.label
    ).toBe('Heading 1')
  })

  it('applies a heading to the current line and removes the query', () => {
    const view = editor('My section /h2‸')
    const result = complete(view, slashSource(host()))!
    const option = result.options.find(item => item.label === 'Heading 2')!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(text(view)).toBe('## My section ‸')
  })

  it('replaces an existing list marker when converting a line', () => {
    const view = editor('- item /task‸')
    const result = complete(view, slashSource(host()))!
    const option = result.options.find(item => item.label === 'Task list')!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(view.state.doc.toString()).toBe('- [ ] item ')
  })

  it('inserts a table on its own line and selects the first header', () => {
    const view = editor('Intro /table‸')
    const result = complete(view, slashSource(host()))!
    const option = result.options[0]!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(view.state.doc.line(1).text).toBe('Intro ')
    expect(view.state.doc.line(2).text).toMatch(
      /^\| Column 1 \| Column 2 \| Column 3 \|$/u
    )
    const { from, to } = view.state.selection.main
    expect(view.state.sliceDoc(from, to)).toBe('Column 1')
  })

  it('lets a custom command replace a built-in and expands its template', () => {
    const commands = slashCommands(
      host({
        customCommands: [{ id: 'x', name: 'Table', template: 'Hi {cursor}!' }],
      })
    )
    expect(commands.filter(command => command.name === 'Table')).toHaveLength(1)
    expect(commands.find(command => command.name === 'Table')?.section).toBe(
      'Yours'
    )
    const view = editor('/Tab‸')
    const result = complete(
      view,
      slashSource(
        host({
          customCommands: [
            { id: 'x', name: 'Table', template: 'Hi {cursor}!' },
          ],
        })
      )
    )!
    const option = result.options[0]!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(text(view)).toBe('Hi ‸!')
    expect(expandTemplate('{date} at {time}').text).not.toContain('{')
  })

  it('runs actions after removing the query', () => {
    const actions = host()
    const view = editor('Text /sugg‸')
    const result = complete(view, slashSource(actions))!
    const option = result.options[0]!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(view.state.doc.toString()).toBe('Text ')
    expect(actions.actions).toEqual(['suggest'])
  })
})

describe('note link completion', () => {
  const note = (id: string, title: string, updatedAt = 1): Note => ({
    id,
    title,
    objective: '',
    context: '',
    content: `About ${title}`,
    sources: [],
    createdAt: 0,
    updatedAt,
  })

  it('offers notes by title and closes the link', () => {
    const notes = [
      note('a', 'Garden plan'),
      note('b', 'Gardening tools', 5),
      note('current', 'Self'),
    ]
    const view = editor('See [[gar‸')
    const result = complete(view, wikiLinkSource(host({}, notes)))!
    expect(result.options.map(option => option.label)).toEqual([
      'Gardening tools',
      'Garden plan',
      'gar',
    ])
    const option = result.options[1]!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(text(view)).toBe('See [[Garden plan]]‸')
  })

  it('reuses closing brackets that already exist', () => {
    const view = editor('[[Gar‸]]')
    const result = complete(
      view,
      wikiLinkSource(host({}, [note('a', 'Garden plan')]))
    )!
    const option = result.options[0]!
    ;(
      option.apply as (
        view: EditorView,
        completion: typeof option,
        from: number,
        to: number
      ) => void
    )(view, option, result.from, result.to!)
    expect(text(view)).toBe('[[Garden plan]]‸')
  })
})

describe('live preview', () => {
  it('escapes HTML in table cells and renders a safe subset', () => {
    expect(
      renderInline('<img src=x onerror=alert(1)> **b** `c` [l](javascript:x)')
    ).toBe(
      '&#60;img src=x onerror=alert(1)&#62; <strong>b</strong> <code>c</code> <span class="cm-lp-cell-link" title="javascript:x">l</span>'
    )
  })

  it('renders a table when the cursor is elsewhere and shows Markdown inside it', () => {
    const view = editor('‸Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n', [
      livePreview(),
    ])
    expect(view.dom.querySelector('.cm-lp-table')).not.toBeNull()
    expect(view.dom.querySelectorAll('.cm-lp-table td')).toHaveLength(2)
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.line(5).from + 2),
    })
    expect(view.dom.querySelector('.cm-lp-table')).toBeNull()
  })

  it('draws bullets and task boxes outside the cursor line', () => {
    const view = editor('- one\n- [x] done\n\n‸', [livePreview()])
    expect(view.dom.querySelector('.cm-lp-bullet')?.textContent).toBe('•')
    const box = view.dom.querySelector<HTMLInputElement>('.cm-lp-task')!
    expect(box.checked).toBe(true)
    box.click()
    expect(view.state.doc.toString()).toBe('- one\n- [ ] done\n\n')
  })
})

describe('link detection', () => {
  it('finds wiki links, Markdown links and bare URLs', () => {
    const view = editor(
      '[[Plan|the plan]] and [docs](https://example.com) or https://typenext.app'
    )
    expect(linkAt(view.state, 3)).toMatchObject({
      kind: 'note',
      target: 'Plan',
      label: 'the plan',
    })
    expect(linkAt(view.state, 25)).toMatchObject({
      kind: 'url',
      url: 'https://example.com',
      label: 'docs',
    })
    expect(linkAt(view.state, view.state.doc.length - 3)).toMatchObject({
      kind: 'url',
      url: 'https://typenext.app',
    })
    expect(linkAt(view.state, 19)).toBeNull()
  })

  it('never follows script or file URLs', () => {
    const view = editor('[x](javascript:alert(1)) [y](file:///etc/passwd)')
    expect(linkAt(view.state, 1)).toBeNull()
    expect(linkAt(view.state, 27)).toBeNull()
  })
})
