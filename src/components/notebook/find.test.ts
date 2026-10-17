import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import {
  currentMatch,
  findField,
  findMatches,
  findNext,
  findTools,
  replaceAll,
  replaceNext,
  revealFirst,
  setFindQuery,
  type FindQuery,
} from './find'

function query(search: string, options: Partial<FindQuery> = {}): FindQuery {
  return {
    search,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...options,
  }
}

function editor(doc: string) {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [history(), findTools()] }),
    parent: document.body,
  })
}

describe('findMatches', () => {
  it('finds text, with case, whole words and patterns', () => {
    const text = 'Rose, rose and rosemary. ROSE!'
    expect(findMatches(text, query('rose')).matches).toHaveLength(4)
    expect(
      findMatches(text, query('rose', { caseSensitive: true })).matches
    ).toEqual([
      { from: 6, to: 10 },
      { from: 15, to: 19 },
    ])
    expect(
      findMatches(text, query('rose', { wholeWord: true })).matches
    ).toHaveLength(3)
    expect(
      findMatches(text, query('ros\\w+', { regex: true, caseSensitive: true }))
        .matches
    ).toEqual([
      { from: 6, to: 10 },
      { from: 15, to: 23 },
    ])
  })

  it('treats special characters literally unless asked, and reports bad patterns', () => {
    expect(findMatches('a.b axb', query('a.b')).matches).toEqual([
      { from: 0, to: 3 },
    ])
    expect(findMatches('abc', query('(', { regex: true })).error).toBeTruthy()
    // A pattern that matches nothing finds nothing, rather than everything.
    expect(findMatches('abc', query('x*', { regex: true })).matches).toEqual([])
  })

  it('stops counting at the limit', () => {
    const many = findMatches('a'.repeat(20_000), query('a'))
    expect(many.matches).toHaveLength(10_000)
    expect(many.truncated).toBe(true)
  })
})

describe('find in the editor', () => {
  it('moves between matches, wrapping at both ends', () => {
    const view = editor('one two one two one')
    view.dispatch({ effects: setFindQuery.of(query('one')) })
    expect(view.state.field(findField).matches).toHaveLength(3)
    expect(revealFirst(view, 0)).toBe(0)
    expect(currentMatch(view.state)).toBe(0)
    expect(findNext(view)).toBe(1)
    expect(findNext(view)).toBe(2)
    expect(findNext(view)).toBe(0)
    expect(findNext(view, -1)).toBe(2)
    view.destroy()
  })

  it('replaces one at a time and all at once, undoable in one step', () => {
    const view = editor('cat hat cat mat cat')
    view.dispatch({ effects: setFindQuery.of(query('cat')) })
    revealFirst(view, 0)
    expect(replaceNext(view, 'dog')).toBe(true)
    expect(view.state.doc.toString()).toBe('dog hat cat mat cat')
    // The next match is selected for the next replace.
    expect(currentMatch(view.state)).toBe(0)
    expect(replaceAll(view, 'fox')).toBe(2)
    expect(view.state.doc.toString()).toBe('dog hat fox mat fox')
    undo(view)
    expect(view.state.doc.toString()).toBe('dog hat cat mat cat')
    view.destroy()
  })

  it('uses capture groups in a pattern replacement', () => {
    const view = editor('2026-10-18 and 2025-01-02')
    view.dispatch({
      effects: setFindQuery.of(
        query('(\\d{4})-(\\d{2})-(\\d{2})', { regex: true })
      ),
    })
    replaceAll(view, '$3/$2/$1')
    expect(view.state.doc.toString()).toBe('18/10/2026 and 02/01/2025')
    view.destroy()
  })

  it('follows edits while open and clears when closed', () => {
    const view = editor('alpha')
    view.dispatch({ effects: setFindQuery.of(query('beta')) })
    expect(view.state.field(findField).matches).toEqual([])
    view.dispatch({ changes: { from: 5, insert: ' beta' } })
    expect(view.state.field(findField).matches).toEqual([{ from: 6, to: 10 }])
    view.dispatch({ effects: setFindQuery.of(null) })
    expect(view.state.field(findField).matches).toEqual([])
    view.destroy()
  })
})
