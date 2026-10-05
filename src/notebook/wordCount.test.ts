import { describe, expect, it } from 'vitest'
import { wordCount } from './model'

const regexCount = (text: string) => text.trim().match(/\S+/gu)?.length ?? 0

describe('word counts without per-word allocations', () => {
  it.each([
    ['', 0],
    [' \t\r\n\v\f\u00a0\ufeff', 0],
    ['word', 1],
    ['  a thought\n\nbecomes\ta sentence  ', 5],
    ['**A** _sentence_ with [Markdown](https://example.test).', 4],
    ['中文\u3000thoughts\u2028remain\u2029visible', 4],
    ['joined\u0085next\u180eword\u200bpart\u2060tail', 1],
    ['\ud800word\udfff \ud83d\ude42joined', 2],
  ])('counts %j as %i', (text, expected) => {
    expect(wordCount(text)).toBe(expected)
    expect(wordCount(text)).toBe(regexCount(text))
  })

  it('agrees with an independent Unicode regex oracle for every UTF-16 code unit', () => {
    const differences: number[] = []
    for (let code = 0; code <= 0xffff; code++) {
      const text = `left${String.fromCharCode(code)}right`
      if (wordCount(text) !== regexCount(text)) differences.push(code)
    }
    expect(differences).toEqual([])
  })

  it('preserves whitespace transitions in mixed text and long runs', () => {
    const sections = [
      'a'.repeat(100_000),
      '\u2001'.repeat(20_000),
      ' \tline\r\nnext\u00a0sentence\ufeff',
      '零\u3000一\u202f二\u205f三\u1680四',
      '\u0085\u180e\u200b\u2060',
      'tail'.repeat(100_000),
    ]
    const text = '\r\n' + sections.join('') + '\t'
    expect(wordCount(text)).toBe(regexCount(text))
    expect(wordCount('a'.repeat(1_048_576))).toBe(1)
  })
})
