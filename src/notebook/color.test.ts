import { describe, expect, it } from 'vitest'
import { hexToHsv, hsvToHex, normalizeHex } from './color'

describe('color', () => {
  it('round-trips hex through HSV', () => {
    for (const hex of [
      '#000000',
      '#ffffff',
      '#42644d',
      '#a6b6c8',
      '#ff0000',
      '#123d77',
    ])
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex)
  })

  it('reads hue, saturation and value', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 })
    expect(hexToHsv('#00ff00')?.h).toBe(120)
    expect(hexToHsv('#808080')).toMatchObject({ h: 0, s: 0 })
    expect(hexToHsv('nope')).toBeNull()
  })

  it('accepts short and unprefixed hex', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('42644D')).toBe('#42644d')
    expect(normalizeHex('#12345')).toBeNull()
  })
})
