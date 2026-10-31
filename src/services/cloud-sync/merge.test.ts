import { describe, expect, it } from 'vitest'
import { merge3, mergeFields, mergeIds, mergeText, stableJson } from './merge'

const BASE = [
  '# Trip',
  '',
  'We leave on Friday at nine.',
  '',
  'Pack the tent and the stove.',
  '',
  'Call the campsite.',
].join('\n')

describe('mergeText', () => {
  it('keeps edits to different paragraphs from both devices', () => {
    const local = BASE.replace('Friday at nine', 'Friday at ten')
    const remote = BASE.replace(
      'Call the campsite.',
      'Call the campsite and the ranger.'
    )
    const merged = mergeText(BASE, local, remote)
    expect(merged.conflicts).toBe(0)
    expect(merged.text).toContain('Friday at ten')
    expect(merged.text).toContain('the campsite and the ranger')
  })

  it('merges different words of the same sentence', () => {
    const local = BASE.replace('the tent', 'the big tent')
    const remote = BASE.replace('the stove.', 'the camping stove.')
    const merged = mergeText(BASE, local, remote)
    expect(merged.conflicts).toBe(0)
    expect(merged.text).toContain('Pack the big tent and the camping stove.')
  })

  it('reports a conflict and keeps this device where both changed the same words', () => {
    const local = BASE.replace('nine', 'ten')
    const remote = BASE.replace('nine', 'eleven')
    const merged = mergeText(BASE, local, remote)
    expect(merged.conflicts).toBe(1)
    expect(merged.text).toContain('at ten.')
    expect(merged.text).not.toContain('eleven')
  })

  it('takes identical changes once', () => {
    const both = BASE.replace('Friday', 'Saturday')
    expect(mergeText(BASE, both, both)).toEqual({ text: both, conflicts: 0 })
  })

  it('handles additions at both ends and a deletion in the middle', () => {
    const local = `Packing list\n\n${BASE}`
    const remote = `${BASE.replace('Pack the tent and the stove.\n\n', '')}\n\nBring snacks.`
    const merged = mergeText(BASE, local, remote)
    expect(merged.conflicts).toBe(0)
    expect(merged.text.startsWith('Packing list\n\n# Trip')).toBe(true)
    expect(merged.text).not.toContain('Pack the tent')
    expect(merged.text.endsWith('Bring snacks.')).toBe(true)
  })

  it('returns whichever side changed when only one did', () => {
    const changed = `${BASE}\nMore.`
    expect(mergeText(BASE, BASE, changed).text).toBe(changed)
    expect(mergeText(BASE, changed, BASE).text).toBe(changed)
  })

  it('merges two insertions at different places on one line', () => {
    const base = 'one two three four five'
    const merged = mergeText(
      base,
      'zero one two three four five',
      'one two three four five six'
    )
    expect(merged).toEqual({
      text: 'zero one two three four five six',
      conflicts: 0,
    })
  })
})

describe('merge3', () => {
  it('marks only overlapping chunks as conflicts', () => {
    const chunks = merge3([1, 2, 3, 4, 5], [1, 9, 3, 4, 5], [1, 2, 3, 8, 5])
    expect(chunks.some(chunk => chunk.conflict)).toBe(false)
    expect(chunks.flatMap(chunk => chunk.local)).toEqual([1, 9, 3, 8, 5])
  })
})

describe('mergeIds', () => {
  it('keeps additions from both and removals from either', () => {
    expect(mergeIds(['a', 'b'], ['a', 'b', 'c'], ['b', 'd'])).toEqual([
      'b',
      'c',
      'd',
    ])
    expect(mergeIds(undefined, ['x'], ['y'])).toEqual(['x', 'y'])
  })
})

describe('mergeFields', () => {
  it('takes each side’s own changes and the preferred side on a clash', () => {
    const base = { theme: 'light', size: 17, editor: { a: 1, b: 1 } }
    const local = { theme: 'dark', size: 17, editor: { a: 2, b: 1 } }
    const remote = { theme: 'light', size: 19, editor: { a: 1, b: 3 } }
    expect(mergeFields(base, local, remote, 'remote')).toEqual({
      theme: 'dark',
      size: 19,
      editor: { a: 2, b: 3 },
    })
    expect(
      mergeFields(
        base,
        { ...base, theme: 'dark' },
        { ...base, theme: 'sepia' },
        'local'
      ).theme
    ).toBe('dark')
    expect(
      mergeFields(
        base,
        { ...base, theme: 'dark' },
        { ...base, theme: 'sepia' },
        'remote'
      ).theme
    ).toBe('sepia')
  })
})

describe('stableJson', () => {
  it('ignores key order and undefined fields', () => {
    expect(stableJson({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe(
      stableJson({ a: [1, { c: 2 }], b: 1 })
    )
  })
})
