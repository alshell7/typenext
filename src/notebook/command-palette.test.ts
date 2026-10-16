import { describe, expect, it } from 'vitest'
import type { Note } from '../types/notebook'
import {
  buildPalette,
  CONTENT_SCAN_LIMIT,
  flattenGroups,
  makeSnippet,
  matchText,
  nextGroupStart,
  parseQuery,
  rankActions,
  rankHeadings,
  rankNotes,
  recentNotes,
  type RankableAction,
} from './command-palette'

const NOW = Date.UTC(2026, 9, 16, 12)
const DAY = 86_400_000

function note(
  id: string,
  title: string,
  content = '',
  updatedAt = NOW - DAY
): Note {
  return {
    id,
    title,
    objective: '',
    context: '',
    content,
    sources: [],
    createdAt: updatedAt,
    updatedAt,
  }
}

const actions: RankableAction[] = [
  { id: 'new', title: 'New note', section: 'Actions', keywords: ['create'] },
  {
    id: 'zen',
    title: 'Zen mode: Hide toolbars',
    section: 'Actions',
    keywords: ['focus', 'distraction'],
  },
  { id: 'graph', title: 'Open note graph', section: 'Go to' },
  { id: 'theme', title: 'Theme: Dark', section: 'Preferences' },
  { id: 'table', title: 'Table', section: 'Insert', keywords: ['grid'] },
  {
    id: 'export',
    title: 'Export Markdown',
    section: 'Actions',
    disabled: true,
  },
]

describe('parseQuery', () => {
  it('detects prefix modes and normalizes the text', () => {
    expect(parseQuery('  Hello   World ')).toEqual({
      mode: 'all',
      text: 'hello world',
    })
    expect(parseQuery('> zen')).toEqual({ mode: 'actions', text: 'zen' })
    expect(parseQuery('>')).toEqual({ mode: 'actions', text: '' })
    expect(parseQuery('#Intro')).toEqual({ mode: 'headings', text: 'intro' })
  })
})

describe('matchText tiers', () => {
  const score = (text: string, query: string) =>
    matchText(text, query)?.score ?? -1

  it('ranks exact prefix > word prefix > substring > subsequence', () => {
    const prefix = score('Garden plans', 'gar')
    const word = score('My garden', 'gar')
    const substring = score('Cigars', 'gar')
    const subsequence = score('Great artichokes', 'gar')
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(subsequence)
    expect(subsequence).toBeGreaterThan(0)
  })

  it('prefers an exact title over a longer prefix match', () => {
    expect(score('Ideas', 'ideas')).toBeGreaterThan(
      score('Ideas for May', 'ideas')
    )
  })

  it('returns null when characters are missing', () => {
    expect(matchText('Garden', 'gx')).toBeNull()
  })

  it('matches every word in any order', () => {
    const match = matchText('Zen mode: Hide toolbars', 'hide zen')
    expect(match).not.toBeNull()
    expect(match!.ranges).toEqual([
      [0, 3],
      [10, 14],
    ])
  })

  it('reports ranges at word starts, not the first inner occurrence', () => {
    // "an" first appears inside "Plans", but "Annual" starts a word.
    expect(matchText('Plans Annual', 'an')!.ranges).toEqual([[6, 8]])
  })

  it('merges adjacent subsequence characters into one range', () => {
    expect(matchText('Note graph', 'notgr')!.ranges).toEqual([
      [0, 3],
      [5, 7],
    ])
  })
})

describe('rankNotes', () => {
  it('puts title matches above content matches and adds a snippet', () => {
    const notes = [
      note('a', 'Groceries', 'Remember the garden hose'),
      note('b', 'Garden plans', 'Tomatoes and basil'),
    ]
    const ranked = rankNotes(notes, 'garden', NOW)
    expect(ranked.map(item => item.note.id)).toEqual(['b', 'a'])
    expect(ranked[0]!.snippet).toBeUndefined()
    const snippet = ranked[1]!.snippet!
    expect(snippet.text).toContain('garden')
    const [from, to] = snippet.ranges[0]!
    expect(snippet.text.slice(from, to)).toBe('garden')
  })

  it('breaks ties with recency', () => {
    const notes = [
      note('old', 'Journal', '', NOW - 40 * DAY),
      note('new', 'Journal', '', NOW - DAY),
    ]
    expect(rankNotes(notes, 'journal', NOW)[0]!.note.id).toBe('new')
  })

  it('does not let recency overturn a better tier', () => {
    const notes = [
      note('recent', 'My journal', '', NOW),
      note('old', 'Journal', '', NOW - 300 * DAY),
    ]
    expect(rankNotes(notes, 'journal', NOW)[0]!.note.id).toBe('old')
  })

  it('names untitled notes and only scans the first 20k characters', () => {
    const late = `${'x '.repeat(CONTENT_SCAN_LIMIT)}needle`
    const ranked = rankNotes(
      [note('u', '', 'early words'), note('late', 'Long', late)],
      'needle',
      NOW
    )
    expect(ranked).toEqual([])
    expect(rankNotes([note('u', '  ', 'words')], 'untit', NOW)[0]!.title).toBe(
      'Untitled'
    )
  })
})

describe('makeSnippet', () => {
  it('trims to word edges, adds ellipses and keeps offsets on one line', () => {
    const content = `${'lead '.repeat(20)}the\nmatch here${' tail'.repeat(30)}`
    const index = content.indexOf('match')
    const snippet = makeSnippet(content, index, 5)
    expect(snippet.text.startsWith('…')).toBe(true)
    expect(snippet.text.endsWith('…')).toBe(true)
    expect(snippet.text).not.toContain('\n')
    const [from, to] = snippet.ranges[0]!
    expect(snippet.text.slice(from, to)).toBe('match')
  })
})

describe('recentNotes', () => {
  it('returns the six most recent notes, excluding the active one', () => {
    const notes = Array.from({ length: 10 }, (_, index) =>
      note(`n${index}`, `Note ${index}`, '', NOW - index * DAY)
    )
    expect(recentNotes(notes, 'n0').map(item => item.id)).toEqual([
      'n1',
      'n2',
      'n3',
      'n4',
      'n5',
      'n6',
    ])
  })
})

describe('rankActions', () => {
  it('finds actions by keywords, below a title hit', () => {
    expect(rankActions(actions, 'focus').map(item => item.action.id)).toEqual([
      'zen',
    ])
    const createHits = rankActions(
      [...actions, { id: 'c', title: 'Create table', section: 'Insert' }],
      'create'
    ).map(item => item.action.id)
    expect(createHits).toEqual(['c', 'new'])
  })

  it('keeps disabled actions findable but below enabled ones', () => {
    const ranked = rankActions(
      [
        { id: 'off', title: 'Export', section: 'Actions', disabled: true },
        { id: 'on', title: 'Export as PDF', section: 'Actions' },
      ],
      'export'
    )
    expect(ranked.map(item => item.action.id)).toEqual(['on', 'off'])
  })
})

describe('rankHeadings', () => {
  const headings = [
    { level: 1, text: 'Introduction', from: 0 },
    { level: 2, text: 'Method', from: 40 },
    { level: 2, text: 'Results', from: 90 },
  ]
  it('keeps document order for an empty query', () => {
    expect(rankHeadings(headings, '').map(item => item.heading.from)).toEqual([
      0, 40, 90,
    ])
  })
  it('ranks by match', () => {
    expect(rankHeadings(headings, 'res')[0]!.heading.text).toBe('Results')
  })
})

describe('buildPalette', () => {
  const notes = [
    note('active', 'Today', '', NOW),
    note('a', 'Garden plans', 'basil', NOW - DAY),
    note('b', 'Reading list', 'a new garden book', NOW - 2 * DAY),
  ]
  const headings = [{ level: 2, text: 'New ideas', from: 10 }]
  const base = { notes, activeNoteId: 'active', headings, actions, now: NOW }

  it('shows recent notes then suggested actions for an empty query', () => {
    const groups = buildPalette({ ...base, query: '' })
    expect(groups.map(group => group.label)).toEqual([
      'Recent notes',
      'Actions',
    ])
    expect(groups[0]!.items.map(item => item.key)).toEqual(['note:a', 'note:b'])
    // Disabled actions are not suggested.
    expect(groups[1]!.items.some(item => item.key === 'action:export')).toBe(
      false
    )
  })

  it('leads with the strongest group and ends with Create note', () => {
    const groups = buildPalette({ ...base, query: 'new' })
    expect(groups[0]!.label).toBe('Actions')
    expect(groups[0]!.items[0]!.key).toBe('action:new')
    expect(groups.map(group => group.id)).toContain('headings')
    const last = groups[groups.length - 1]!
    expect(last.items).toEqual([
      expect.objectContaining({ kind: 'create', title: 'new' }),
    ])
  })

  it('omits Create note when a note already has that exact title', () => {
    const groups = buildPalette({ ...base, query: 'garden plans' })
    expect(groups.some(group => group.id === 'create')).toBe(false)
    expect(groups[0]!.items[0]!.key).toBe('note:a')
  })

  it('limits > to actions grouped by section in a fixed order', () => {
    const groups = buildPalette({ ...base, query: '>' })
    expect(groups.map(group => group.label)).toEqual([
      'Actions',
      'Go to',
      'Insert',
      'Preferences',
    ])
    expect(
      buildPalette({ ...base, query: '> grid' }).flatMap(group =>
        group.items.map(item => item.key)
      )
    ).toEqual(['action:table'])
  })

  it('limits # to headings of this note', () => {
    const groups = buildPalette({ ...base, query: '# idea' })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items[0]).toMatchObject({ kind: 'heading' })
  })
})

describe('group navigation', () => {
  it('steps to the start of the next and previous group, wrapping', () => {
    const { starts, total } = flattenGroups([
      { items: [1, 2, 3] },
      { items: [4] },
      { items: [5, 6] },
    ])
    expect(starts).toEqual([0, 3, 4])
    expect(total).toBe(6)
    expect(nextGroupStart(starts, 1, 1)).toBe(3)
    expect(nextGroupStart(starts, 5, 1)).toBe(0)
    expect(nextGroupStart(starts, 1, -1)).toBe(4)
  })
})

describe('performance', () => {
  it('ranks 2,000 notes of 1 KB in a few milliseconds per keystroke', () => {
    const words =
      'garden river paper quiet notebook morning letter window'.split(' ')
    const notes = Array.from({ length: 2000 }, (_, index) => {
      let content = ''
      while (content.length < 1024)
        content += `${words[(index * 7 + content.length) % words.length]} `
      return note(`n${index}`, `Note ${index} ${words[index % 8]}`, content)
    })
    const queries = [
      'g',
      'ga',
      'gar',
      'gard',
      'garde',
      'garden',
      'zzq',
      'nt 12',
    ]
    // Warm the per-note cache, as the first open of the palette does.
    buildPalette({
      query: 'warm',
      notes,
      activeNoteId: null,
      headings: [],
      actions,
      now: NOW,
    })
    const times: number[] = []
    for (let round = 0; round < 3; round++)
      for (const query of queries) {
        const start = performance.now()
        buildPalette({
          query,
          notes,
          activeNoteId: null,
          headings: [],
          actions,
          now: NOW,
        })
        times.push(performance.now() - start)
      }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]!
    // Target is ~2 ms on a laptop; the bound is lenient for slow CI runners.
    expect(median).toBeLessThan(25)
  })
})
