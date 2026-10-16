import { describe, expect, it } from 'vitest'
import {
  automaticAllowed,
  automaticDelay,
  newRhythm,
  noteAccepted,
  noteKeystroke,
} from './suggestion-timing'

describe('automatic suggestion timing', () => {
  const base = {
    base: 1000,
    adaptive: true,
    lineBefore: 'A thought',
    now: 10_000,
  }

  it('waits longer while the writer types quickly', () => {
    let rhythm = newRhythm()
    for (let at = 9_000; at <= 10_000; at += 100)
      rhythm = noteKeystroke(rhythm, at)
    expect(rhythm.interval).toBeLessThan(160)
    expect(automaticDelay({ ...base, rhythm })).toBe(1800)
  })

  it('is quicker after an accepted suggestion and at a sentence end', () => {
    const rhythm = noteAccepted(newRhythm(), 9_000)
    expect(automaticDelay({ ...base, rhythm, lineBefore: 'Done. ' })).toBe(480)
  })

  it('keeps the exact delay when adaptation is off and clamps extremes', () => {
    expect(
      automaticDelay({ ...base, adaptive: false, rhythm: newRhythm() })
    ).toBe(1000)
    expect(
      automaticDelay({
        ...base,
        adaptive: false,
        base: 50,
        rhythm: newRhythm(),
      })
    ).toBe(200)
    expect(
      automaticDelay({
        ...base,
        adaptive: false,
        base: 99_000,
        rhythm: newRhythm(),
      })
    ).toBe(5000)
  })

  it('does not suggest inside links, code, note links or bare list markers', () => {
    const allowed = (lineBefore: string, minCharacters = 0) =>
      automaticAllowed({ lineBefore, minCharacters, documentEmpty: false })
    expect(allowed('See https://exa')).toBe(false)
    expect(allowed('[docs](https://x')).toBe(false)
    expect(allowed('Read [[Gar')).toBe(false)
    expect(allowed('Run `npm')).toBe(false)
    expect(allowed('-')).toBe(false)
    expect(allowed('Short', 10)).toBe(false)
    expect(allowed('A normal sentence')).toBe(true)
    expect(
      automaticAllowed({
        lineBefore: '',
        minCharacters: 20,
        documentEmpty: true,
      })
    ).toBe(true)
  })
})
