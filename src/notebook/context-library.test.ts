import { describe, expect, it } from 'vitest'
import type { ContextSource, Note } from '../types/notebook'
import {
  contextFolder,
  contextLibraryFolders,
  contextLibraryUsage,
  filterContextLibrary,
  libraryReference,
  migrateContextLibrary,
  resolveLibrarySource,
} from './context-library'
import { resolveNoteContext, stripLinkedText } from './note-context'

function source(id: string, text = 'Imported writing.'): ContextSource {
  return {
    id,
    name: 'Research.md',
    kind: 'markdown',
    text,
    enabled: true,
    addedAt: 1,
  }
}

function note(id: string, sources: ContextSource[] = []): Note {
  return {
    id,
    title: id,
    content: '',
    context: '',
    objective: '',
    sources,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('reusable context library', () => {
  it('migrates duplicate legacy snapshots once while retaining each note’s inclusion choice', () => {
    const first = source('original', 'Exact evidence\nwith line breaks.')
    const second = { ...first, id: 'other', enabled: false }
    const original = [note('first', [first]), note('second', [second])]
    const migrated = migrateContextLibrary(original)
    expect(migrated.library).toHaveLength(1)
    expect(migrated.library[0]).toEqual(first)
    expect(migrated.notes[0]?.sources[0]).toMatchObject({
      libraryId: 'original',
      text: '',
      enabled: true,
    })
    expect(migrated.notes[1]?.sources[0]).toMatchObject({
      libraryId: 'original',
      text: '',
      enabled: false,
    })
    expect(
      resolveNoteContext(migrated.notes[1]!, migrated.notes, migrated.library)
        .sources[0]
    ).toMatchObject({ text: first.text, enabled: false })
    expect(original[0]?.sources[0]?.text).toBe(first.text)
    expect(original[1]?.sources[0]?.id).toBe('other')
  })

  it('preserves differing source bodies even when old source IDs collide', () => {
    const original = [
      note('first', [source('shared', 'First evidence')]),
      note('second', [source('shared', 'Other evidence')]),
    ]
    const migrated = migrateContextLibrary(original)
    expect(migrated.library.map(item => item.id)).toEqual([
      'shared',
      'shared-2',
    ])
    expect(migrated.library.map(item => item.text)).toEqual([
      'First evidence',
      'Other evidence',
    ])
    expect(migrated.notes[1]?.sources[0]?.libraryId).toBe('shared-2')
    expect(
      resolveNoteContext(migrated.notes[1]!, migrated.notes, migrated.library)
        .sources[0]?.text
    ).toBe('Other evidence')
  })

  it('retains stable arrays when references are migrated, and keeps unmatched legacy text at the cap', () => {
    const library = [source('canonical')]
    const migratedNotes = [note('done', [libraryReference(library[0]!)])]
    const again = migrateContextLibrary(migratedNotes, library)
    expect(again.notes).toBe(migratedNotes)
    expect(again.library).toBe(library)
    const unmatched = source('unmatched', 'Keep every character.😀')
    const originals = [note('legacy', [unmatched])]
    const bounded = migrateContextLibrary(originals, library, 1)
    expect(bounded.notes).toBe(originals)
    expect(bounded.library).toBe(library)
    expect(bounded.notes[0]?.sources[0]).toBe(unmatched)
  })

  it('reuses an exact snapshot at the cap even when the old reference has a different ID', () => {
    const canonical = source('canonical', 'An exact bounded snapshot.😀')
    const library = [canonical]
    const original = [note('draft', [{ ...canonical, id: 'legacy' }])]
    const migrated = migrateContextLibrary(original, library, 1)
    expect(migrated.library).toBe(library)
    expect(migrated.notes[0]?.sources[0]).toMatchObject({
      libraryId: 'canonical',
      text: '',
    })
    expect(
      resolveNoteContext(migrated.notes[0]!, migrated.notes, library).sources[0]
        ?.text
    ).toBe(canonical.text)
  })

  it('preserves exact Unicode snapshot text and metadata across many mixed legacy references', () => {
    const originals = Array.from({ length: 240 }, (_, index) => ({
      ...source(
        `source-${index}`,
        `Shared opening\n${index % 80} · 😀é界\nshared ending`
      ),
      name: `Reference ${index % 3}.md`,
      origin: index % 2 ? undefined : 'https://example.org/research',
      folder: index % 4 ? 'Research' : 'Research/Interviews',
      enabled: index % 5 !== 0,
    }))
    const expected = new Set(
      originals.map(item =>
        JSON.stringify([
          item.kind,
          item.name,
          item.origin,
          item.folder,
          item.text,
        ])
      )
    )
    const migrated = migrateContextLibrary([note('draft', originals)])
    expect(migrated.library).toHaveLength(expected.size)
    const resolved = resolveNoteContext(
      migrated.notes[0]!,
      migrated.notes,
      migrated.library
    )
    for (const original of originals) {
      const matching = resolved.sources.find(
        item =>
          item.name === original.name &&
          item.folder === original.folder &&
          item.origin === original.origin &&
          item.text === original.text
      )
      expect(
        matching,
        'No snapshot may disappear or resolve to a different body'
      ).toBeDefined()
    }
  })

  it('deduplicates equivalent links within one note without losing an enabled reference', () => {
    const first = source('first')
    const original = [
      note('draft', [
        { ...first, enabled: false },
        { ...first, id: 'second' },
      ]),
    ]
    const migrated = migrateContextLibrary(original)
    expect(migrated.library).toHaveLength(1)
    expect(migrated.notes[0]?.sources).toHaveLength(1)
    expect(migrated.notes[0]?.sources[0]?.enabled).toBe(true)
  })

  it('uses current linked writing through the library without expanding reciprocal sources', () => {
    const linked = {
      ...note('research'),
      title: 'Current research',
      content: 'Updated evidence',
    }
    const live: ContextSource = {
      ...source('live', ''),
      name: 'Earlier title',
      kind: 'note',
      linkedNoteId: linked.id,
    }
    const draft = note('draft', [libraryReference(live)])
    linked.sources = [
      libraryReference({ ...live, id: 'draft-link', linkedNoteId: draft.id }),
    ]
    const resolved = resolveNoteContext(draft, [draft, linked], [live])
    expect(resolved.sources[0]).toMatchObject({
      name: 'Current research',
      text: 'Updated evidence',
      libraryId: 'live',
    })
    expect(resolved.sources).toHaveLength(1)
    expect(resolveLibrarySource(live, [linked]).text).toBe(linked.content)
    expect(stripLinkedText(resolved.sources)[0]?.text).toBe('')
  })

  it('withholds stale copied text if either the canonical entry or its linked note is missing', () => {
    const missing = note('draft', [
      { ...libraryReference(source('gone')), text: 'Stale derived body.' },
    ])
    expect(resolveNoteContext(missing, [], []).sources[0]).toMatchObject({
      text: '',
      enabled: false,
    })
    const live: ContextSource = {
      ...source('live'),
      kind: 'note',
      linkedNoteId: 'missing-note',
    }
    expect(
      resolveNoteContext(note('draft', [libraryReference(live)]), [], [live])
        .sources[0]
    ).toMatchObject({ text: '', enabled: false })
    expect(
      stripLinkedText([missing.sources[0]!, source('ordinary')])[1]?.text
    ).toBe('Imported writing.')
  })

  it('counts notes once, including excluded attachments, to explain library removal accurately', () => {
    const reference = libraryReference(source('research'))
    const counts = contextLibraryUsage([
      note('one', [reference, { ...reference, id: 'duplicate' }]),
      note('two', [{ ...reference, enabled: false }]),
      note('unrelated', [source('research')]),
    ])
    expect(counts.get('research')).toBe(2)
  })

  it('preserves nested directory snapshots and filters by folder, live note title, and website address', () => {
    expect(
      contextFolder({ webkitRelativePath: 'Research/Interviews/field.txt' })
    ).toBe('Research/Interviews')
    expect(contextFolder({ webkitRelativePath: 'Research\\field.txt' })).toBe(
      'Research'
    )
    expect(
      contextFolder({ webkitRelativePath: 'Research/../field.txt' })
    ).toBeUndefined()
    expect(contextFolder({ webkitRelativePath: '' })).toBeUndefined()
    const nested = { ...source('nested'), folder: 'Research/Interviews' }
    const root = { ...source('root'), folder: 'Research' }
    const website: ContextSource = {
      ...source('site'),
      kind: 'website',
      name: 'Essay',
      origin: 'https://example.org/gardens',
    }
    const live: ContextSource = {
      ...source('live', ''),
      kind: 'note',
      name: 'Old title',
      linkedNoteId: 'linked',
    }
    const library = [nested, root, website, live]
    expect(contextLibraryFolders(library)).toEqual([
      { path: 'Research', count: 2, name: 'Research', depth: 0 },
      { path: 'Research/Interviews', count: 1, name: 'Interviews', depth: 1 },
    ])
    expect(filterContextLibrary(library, [], '', 'Research')).toEqual([
      nested,
      root,
    ])
    expect(filterContextLibrary(library, [], 'example.org', null)).toEqual([
      website,
    ])
    expect(
      filterContextLibrary(
        library,
        [{ ...note('linked'), title: 'Changed title' }],
        'changed',
        null
      )
    ).toEqual([live])
  })
})
