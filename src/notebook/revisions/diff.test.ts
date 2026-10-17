import { describe, expect, it } from 'vitest'
import {
  changeSize,
  diffSequence,
  lineDiff,
  revertHunks,
  wordChanges,
  wordDiff,
} from './diff'

function apply<T>(parts: ReturnType<typeof diffSequence<T>>) {
  const before: T[] = []
  const after: T[] = []
  for (const part of parts) {
    if (part.op !== 'insert') before.push(...part.items)
    if (part.op !== 'delete') after.push(...part.items)
  }
  return { before, after }
}

describe('diffSequence', () => {
  it('reproduces both sides for random edits', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () =>
        'abcde'.charAt(Math.floor(random() * 5))
      )
      const b = a.flatMap(item =>
        random() < 0.2 ? [] : random() < 0.2 ? [item, 'x'] : [item]
      )
      const parts = diffSequence(a, b)
      expect(apply(parts)).toEqual({ before: a, after: b })
    }
  })

  it('finds a minimal difference', () => {
    const parts = diffSequence([...'ABCABBA'], [...'CBABAC'])
    const edits = parts
      .filter(part => part.op !== 'equal')
      .reduce((total, part) => total + part.items.length, 0)
    expect(edits).toBe(5)
  })

  it('handles empty sides', () => {
    expect(diffSequence([], ['a'])).toEqual([{ op: 'insert', items: ['a'] }])
    expect(diffSequence(['a'], [])).toEqual([{ op: 'delete', items: ['a'] }])
    expect(diffSequence([], [])).toEqual([])
  })
})

describe('wordDiff', () => {
  it('marks only the changed words and keeps spaces readable', () => {
    expect(wordDiff('The quick fox jumps.', 'The swift fox leaps.')).toEqual([
      { op: 'equal', text: 'The ' },
      { op: 'delete', text: 'quick' },
      { op: 'insert', text: 'swift' },
      { op: 'equal', text: ' fox ' },
      { op: 'delete', text: 'jumps' },
      { op: 'insert', text: 'leaps' },
      { op: 'equal', text: '.' },
    ])
  })

  it('joins nearby changes into one readable replacement', () => {
    const segments = wordDiff('a big red ball', 'a small blue ball')
    expect(segments).toEqual([
      { op: 'equal', text: 'a ' },
      { op: 'delete', text: 'big red' },
      { op: 'insert', text: 'small blue' },
      { op: 'equal', text: ' ball' },
    ])
  })
})

describe('lineDiff and revertHunks', () => {
  const older = ['# Plan', '', 'First idea.', 'Second idea.', '', 'End.'].join(
    '\n'
  )
  const newer = [
    '# Plan',
    '',
    'First idea, sharper.',
    'Second idea.',
    '',
    'A new closing line.',
    'End.',
  ].join('\n')

  it('groups changed lines into hunks with their positions', () => {
    const diff = lineDiff(older, newer)
    expect(diff.hunks).toEqual([
      {
        id: 0,
        oldStart: 2,
        oldLines: ['First idea.'],
        newStart: 2,
        newLines: ['First idea, sharper.'],
      },
      {
        id: 1,
        oldStart: 5,
        oldLines: [],
        newStart: 5,
        newLines: ['A new closing line.'],
      },
    ])
    expect(diff.added).toBeGreaterThan(0)
  })

  it('merges chosen parts of the older text back in', () => {
    const { hunks } = lineDiff(older, newer)
    expect(revertHunks(newer, hunks, new Set([1]))).toBe(
      ['# Plan', '', 'First idea, sharper.', 'Second idea.', '', 'End.'].join(
        '\n'
      )
    )
    expect(revertHunks(newer, hunks, new Set([0, 1]))).toBe(older)
    expect(revertHunks(newer, hunks, new Set())).toBe(newer)
  })
})

describe('change measures', () => {
  it('counts changed characters and words', () => {
    expect(changeSize('hello world', 'hello world')).toBe(0)
    expect(changeSize('hello world', 'hello brave world')).toBe(6)
    expect(changeSize('abc', '')).toBe(3)
    expect(wordChanges('one two three', 'one three four five')).toEqual({
      added: 2,
      removed: 1,
    })
  })
})
