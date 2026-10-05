import { describe, expect, it, vi } from 'vitest'
import type { ContextSource, Note } from '../types/notebook'
import { libraryReference } from './context-library'
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
  it('returns a note without sources unchanged and does not visit other notes or the library', () => {
    const draft = note('draft', 'Draft', 'My writing')
    const unrelated = note('unrelated', 'Unrelated', 'Private writing')
    Object.defineProperty(unrelated, 'id', {
      get: () => {
        throw new Error('An unrelated note must not be indexed.')
      },
    })
    const library = [linkNoteSource(draft)]
    Object.defineProperty(library[0], 'id', {
      get: () => {
        throw new Error('An unused library must not be indexed.')
      },
    })
    expect(resolveNoteContext(draft, [unrelated], library)).toBe(draft)
  })

  it('retains ordinary snapshots and their note identity without building unused indexes', () => {
    const ordinary: ContextSource = {
      id: 'file',
      name: 'Imported.md',
      kind: 'markdown',
      text: 'Imported evidence.',
      enabled: true,
      addedAt: 1,
    }
    const draft = { ...note('draft', 'Draft', ''), sources: [ordinary] }
    const unrelated = note('unrelated', 'Unrelated', 'Private writing')
    const library = [linkNoteSource(unrelated)]
    Object.defineProperty(unrelated, 'id', {
      get: () => {
        throw new Error('Ordinary snapshots do not need a note index.')
      },
    })
    Object.defineProperty(library[0], 'id', {
      get: () => {
        throw new Error('Ordinary snapshots do not need a library index.')
      },
    })
    expect(resolveNoteContext(draft, [unrelated], library)).toBe(draft)
    expect(draft.sources[0]).toBe(ordinary)
  })

  it('reuses an immutable library index across writing edits and refreshes replaced snapshots', () => {
    const canonical: ContextSource = {
      id: 'shared',
      name: 'Shared.md',
      kind: 'markdown',
      text: 'First proof.',
      enabled: true,
      addedAt: 1,
    }
    const unused = { ...canonical, id: 'unused' }
    const indexRead = vi.fn(() => 'unused')
    Object.defineProperty(unused, 'id', { get: indexRead })
    const library = [unused, canonical]
    const draft = {
      ...note('draft', 'Draft', 'My writing'),
      sources: [libraryReference(canonical)],
    }
    const unrelated = note('unrelated', 'Unrelated', 'Private writing')
    Object.defineProperty(unrelated, 'id', {
      get: () => {
        throw new Error('File references do not need a note index.')
      },
    })
    expect(
      resolveNoteContext(draft, [unrelated], library).sources[0]?.text
    ).toBe('First proof.')
    expect(indexRead).toHaveBeenCalledTimes(1)
    expect(
      resolveNoteContext(
        { ...draft, content: 'More of my writing.' },
        [unrelated],
        library
      ).sources[0]?.text
    ).toBe('First proof.')
    expect(indexRead).toHaveBeenCalledTimes(1)

    const replaced = { ...canonical, name: 'Updated.md', text: 'Other proof.' }
    const resolved = resolveNoteContext(draft, [unrelated], [unused, replaced])
    expect(resolved.sources[0]).toMatchObject({
      name: 'Updated.md',
      text: 'Other proof.',
    })
    expect(indexRead).toHaveBeenCalledTimes(2)
    expect(canonical.text).toBe('First proof.')
  })

  it('reads current target writing even when its canonical library index is reused', () => {
    const reference = note('reference', 'Research', 'Initial evidence')
    const canonical = linkNoteSource(reference)
    const library = [canonical]
    const draft = {
      ...note('draft', 'Draft', 'My words'),
      sources: [libraryReference(canonical, false)],
    }
    expect(
      resolveNoteContext(draft, [reference], library).sources[0]
    ).toMatchObject({
      name: 'Research',
      text: 'Initial evidence',
      enabled: false,
    })
    const edited = {
      ...reference,
      title: 'Updated research',
      content: 'Current evidence',
    }
    expect(
      resolveNoteContext(draft, [edited], library).sources[0]
    ).toMatchObject({
      name: 'Updated research',
      text: 'Current evidence',
      enabled: false,
    })
    expect(library[0]?.text).toBe('')
    expect(draft.sources[0]?.text).toBe('')
  })

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
