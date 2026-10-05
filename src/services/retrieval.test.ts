import { describe, expect, it, vi } from 'vitest'
import type { ContextSource, Note } from '../types/notebook'
import { retrieveContext } from './retrieval'

function source(id: string, text: string, enabled = true): ContextSource {
  return { id, name: `${id}.md`, kind: 'markdown', text, enabled, addedAt: 0 }
}

function note(sources: ContextSource[]): Note {
  return {
    id: crypto.randomUUID(),
    title: 'Field notes',
    objective: '',
    context: '',
    content: '',
    sources,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('local context retrieval', () => {
  it('ranks a relevant rare subject above unrelated repeated language', () => {
    const draft = note([
      source(
        'routine',
        'The workshop discusses daily writing, morning routines and regular writing practice.'
      ),
      source(
        'plants',
        'Amaranth dries best in a warm sheltered room. Harvest amaranth before the frost.'
      ),
      source(
        'weather',
        'The morning is warm and the garden has a sheltered corner.'
      ),
    ])
    expect(
      retrieveContext(draft, 'drying amaranth before frost')[0]?.sourceId
    ).toBe('plants')
  })

  it('does not retrieve disabled sources or attachments from another note', () => {
    const first = note([
      source('private', 'The orchard contains quince trees.', false),
    ])
    const second = note([
      source('other-note', 'The orchard contains quince trees.'),
    ])
    expect(retrieveContext(second, 'quince')).toHaveLength(1)
    expect(retrieveContext(first, 'quince')).toEqual([])
  })

  it('invalidates cached extraction when text changes without changing its length', () => {
    const draft = note([source('trees', 'Amber tree')])
    expect(retrieveContext(draft, 'Amber')).toHaveLength(1)
    const attachment = draft.sources[0]
    if (!attachment) throw new Error('Missing fixture')
    attachment.text = 'Birch tree'
    expect(retrieveContext(draft, 'Amber')).toEqual([])
    expect(retrieveContext(draft, 'Birch')).toHaveLength(1)
  })

  it('finds CJK phrases without spaces and keeps combining marks in Hindi words', () => {
    const draft = note([
      source('chinese', '夜晚的星空让人平静，月光照亮远处的山谷。'),
      source('hindi', 'यह हिंदी लेखन और कविता के बारे में एक नोट है।'),
    ])
    expect(retrieveContext(draft, '星空')[0]?.sourceId).toBe('chinese')
    expect(retrieveContext(draft, 'हिंदी')[0]?.sourceId).toBe('hindi')
  })

  it('does not invent relevance for an empty or unmatched query', () => {
    const draft = note([
      source('context', 'A harbour lantern marks the entrance.'),
    ])
    expect(retrieveContext(draft, '')).toEqual([])
    expect(retrieveContext(draft, 'asteroid')).toEqual([])
    expect(retrieveContext(draft, 'harbour', 0)).toEqual([])
    expect(retrieveContext(draft, 'harbour', 0.5)).toEqual([])
  })

  it('reuses a source index across writing edits and new arrays with the same source data', () => {
    const draft = note([
      source(
        'large-reference',
        'A harbour lantern marks the entrance. '.repeat(6_000)
      ),
    ])
    retrieveContext(draft, 'harbour lantern')
    const normalize = vi.spyOn(String.prototype, 'normalize')
    try {
      const results = retrieveContext(
        {
          ...draft,
          content: 'A new paragraph in progress.',
          sources: [...draft.sources],
        },
        'harbour lantern'
      )
      expect(results.length).toBeGreaterThan(0)
      // Only the short query is tokenized again; the large reference is not.
      expect(normalize).toHaveBeenCalledOnce()
    } finally {
      normalize.mockRestore()
    }
  })

  it('evicts large inactive indexes rather than retaining twelve megabytes of indexed text', () => {
    const drafts = Array.from({ length: 3 }, (_, index) =>
      note(
        Array.from({ length: 4 }, (_, attachment) =>
          source(
            `context-${index}-${attachment}`,
            `A harbour lantern reference ${index}. `.repeat(7_000)
          )
        )
      )
    )
    for (const draft of drafts) retrieveContext(draft, 'harbour lantern')
    const normalize = vi.spyOn(String.prototype, 'normalize')
    try {
      const draft = drafts[0]
      if (!draft) throw new Error('Missing fixture')
      expect(retrieveContext(draft, 'harbour lantern').length).toBeGreaterThan(
        0
      )
      expect(normalize.mock.calls.length).toBeGreaterThan(1)
    } finally {
      normalize.mockRestore()
    }
  })

  it('indexes a bounded prefix of a large linked note and ignores text beyond the note budget', () => {
    const draft = note([
      {
        ...source(
          'linked-writing',
          'Harbour lantern. '.repeat(25_000) + ' secretbeyondprefix'
        ),
        kind: 'note',
      },
      ...Array.from({ length: 10 }, (_, index) =>
        source(`extra-${index}`, 'Harbour context. '.repeat(20_000))
      ),
      source('beyond-budget', 'Uniqueunindexedmarker'),
    ])
    expect(retrieveContext(draft, 'harbour lantern').length).toBeGreaterThan(0)
    expect(retrieveContext(draft, 'secretbeyondprefix')).toEqual([])
    expect(retrieveContext(draft, 'uniqueunindexedmarker')).toEqual([])
  })

  it('bounds context and removes duplicate passages across attachments', () => {
    const draft = note([
      source('original', 'A harbour lantern marks the entrance.'),
      source('duplicate', 'A harbour lantern marks the entrance.'),
      ...Array.from({ length: 8 }, (_, i) =>
        source(`long-${i}`, `Harbour detail ${i}. `.repeat(400))
      ),
    ])
    const results = retrieveContext(draft, 'harbour lantern detail', 100)
    expect(results.length).toBeLessThanOrEqual(8)
    expect(
      results.reduce((sum, chunk) => sum + chunk.text.length, 0)
    ).toBeLessThanOrEqual(6_000)
    expect(results.every(chunk => chunk.text.length <= 1_400)).toBe(true)
    expect(
      results.filter(
        chunk => chunk.text === 'A harbour lantern marks the entrance.'
      )
    ).toHaveLength(1)
  })
})
