import { describe, expect, it } from 'vitest'
import type { Note } from '../types/notebook'
import {
  linkNoteSource,
  resolveNoteContext,
  stripLinkedText,
} from './note-context'

function note(id: string, title: string, content: string): Note {
  return {
    id,
    title,
    content,
    objective: '',
    context: '',
    sources: [],
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('live linked-note context', () => {
  it('stores a reference and follows subsequent writing and title edits', () => {
    const reference = note('reference', 'Research', 'Initial evidence')
    const draft = {
      ...note('draft', 'Draft', 'My words'),
      sources: [linkNoteSource(reference)],
    }
    expect(draft.sources[0]).toMatchObject({
      kind: 'note',
      linkedNoteId: 'reference',
      text: '',
    })
    expect(resolveNoteContext(draft, [reference]).sources[0]?.text).toBe(
      'Initial evidence'
    )
    const edited = {
      ...reference,
      title: 'Updated research',
      content: 'New evidence',
      updatedAt: 3,
    }
    expect(resolveNoteContext(draft, [edited]).sources[0]).toMatchObject({
      name: 'Updated research',
      text: 'New evidence',
    })
    expect(draft.sources[0]?.text).toBe('')
    expect(draft.sources[0]?.name).toBe('Research')
  })

  it('keeps excluded notes excluded while allowing their live text to be previewed', () => {
    const reference = note('reference', 'Research', 'Current writing')
    const source = { ...linkNoteSource(reference), enabled: false }
    const draft = { ...note('draft', 'Draft', ''), sources: [source] }
    expect(resolveNoteContext(draft, [reference]).sources[0]).toMatchObject({
      enabled: false,
      text: 'Current writing',
    })
  })

  it('leaves missing references visibly unavailable and never returns stale copied writing', () => {
    const reference = note('reference', 'Research', 'Old writing')
    const draft = {
      ...note('draft', 'Draft', ''),
      sources: [{ ...linkNoteSource(reference), text: 'Stale copied writing' }],
    }
    const resolved = resolveNoteContext(draft, [])
    expect(resolved.sources[0]).toMatchObject({
      name: 'Research (unavailable)',
      enabled: false,
      text: '',
    })
    expect(resolveNoteContext(resolved, []).sources[0]?.name).toBe(
      'Research (unavailable)'
    )
    expect(draft.sources[0]?.enabled).toBe(true)
  })

  it('resolves mutual links using only each target’s own writing without expanding its sources or background', () => {
    const first = note('first', 'First', 'First writing')
    const second = {
      ...note('second', 'Second', 'Second writing'),
      context: 'Private target background',
    }
    first.sources = [linkNoteSource(second)]
    second.sources = [linkNoteSource(first)]
    expect(resolveNoteContext(first, [first, second]).sources[0]?.text).toBe(
      'Second writing'
    )
    expect(resolveNoteContext(second, [first, second]).sources[0]?.text).toBe(
      'First writing'
    )
    expect(resolveNoteContext(first, [first, second]).sources).toHaveLength(1)
  })

  it('strips only linked text before persistence without mutating resolved previews', () => {
    const reference = note('reference', 'Research', 'Current writing')
    const ordinary = {
      id: 'file',
      name: 'file.md',
      kind: 'markdown' as const,
      text: 'Imported evidence',
      enabled: true,
      addedAt: 1,
    }
    const sources = [
      { ...linkNoteSource(reference), text: reference.content },
      ordinary,
    ]
    expect(stripLinkedText(sources)).toEqual([
      { ...sources[0], text: '' },
      ordinary,
    ])
    expect(sources[0]?.text).toBe('Current writing')
    expect(linkNoteSource(reference)).toEqual(linkNoteSource(reference))
  })
})
