import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzy context matching', () => {
  it('matches subsequences and rejects missing letters', () => {
    expect(fuzzyScore('fr', 'Field research')).not.toBeNull()
    expect(fuzzyScore('vce', 'Voice')).not.toBeNull()
    expect(fuzzyScore('xyz', 'Voice')).toBeNull()
    expect(fuzzyScore('', 'Voice')).toBe(0)
  })

  it('ranks prefixes and word starts ahead of scattered matches, keeping order for ties', () => {
    const names = ['Background', 'Research notes', 'Notes', 'Field research']
    expect(fuzzyFilter(names, 'notes', name => name)).toEqual([
      'Notes',
      'Research notes',
    ])
    expect(fuzzyFilter(names, 'res', name => name)[0]).toBe('Research notes')
    expect(fuzzyFilter(names, '', name => name)).toEqual(names)
  })
})
