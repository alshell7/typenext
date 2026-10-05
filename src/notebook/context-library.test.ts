import { describe, expect, it } from 'vitest'
import type { ContextPackage, ContextSource, Note } from '../types/notebook'
import {
  contextFolder,
  contextLibraryFolders,
  contextLibraryUsage,
  contextPackageUsage,
  filterContextLibrary,
  libraryReference,
  migrateContextLibrary,
  migrateContextPackages,
  MAX_CONTEXT_PACKAGE_SOURCES,
  newContextPackage,
  pruneContextLibrary,
  resolveLibrarySource,
} from './context-library'
import {
  resolveNoteContext,
  resolvedContextBudget,
  stripLinkedText,
} from './note-context'
import { emptyWorkspace, normalizeWorkspace } from './model'

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

function context(id: string, sourceIds: string[]): ContextPackage {
  return { id, name: id, sourceIds, createdAt: 1, updatedAt: 2 }
}

describe('reusable named context packages', () => {
  it('groups old snapshots without broadening the sources included in an existing note', () => {
    const first = source('first', 'Only this evidence was attached.')
    const other = source('other', 'This must not become context implicitly.')
    const draft = note('draft', [libraryReference(first, false)])
    const restored = normalizeWorkspace({
      ...emptyWorkspace(),
      contextPackages: undefined,
      contextLibrary: [first, other],
      notes: [draft],
    })
    expect(restored.contextPackages).toEqual([
      {
        id: 'context-saved-references',
        name: 'Saved references',
        sourceIds: ['first', 'other'],
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    expect(restored.notes[0]?.contextPackageIds).toBeUndefined()
    const resolved = resolveNoteContext(
      restored.notes[0]!,
      restored.notes,
      restored.contextLibrary,
      restored.contextPackages
    )
    expect(resolved.sources).toHaveLength(1)
    expect(resolved.sources[0]).toMatchObject({
      text: first.text,
      enabled: false,
    })
    expect(
      resolvedContextBudget(
        restored.notes[0]!,
        restored.notes,
        restored.contextLibrary,
        restored.contextPackages
      )
    ).toEqual({ sources: 1, characters: 0 })
  })

  it('chunks migration at the package source bound and keeps explicit package deletion stable', () => {
    const library = Array.from(
      { length: MAX_CONTEXT_PACKAGE_SOURCES + 7 },
      (_, index) => source(`source-${index}`)
    )
    const packages = migrateContextPackages(library)
    expect(packages.map(context => context.sourceIds.length)).toEqual([256, 7])
    expect(packages.flatMap(context => context.sourceIds)).toEqual(
      library.map(source => source.id)
    )
    const removed: ContextPackage[] = []
    expect(migrateContextPackages(library, removed)).toBe(removed)
    expect(migrateContextPackages(library, packages)).toBe(packages)
    expect(newContextPackage('  Research  ')).toMatchObject({
      name: 'Research',
      sourceIds: [],
    })
  })

  it('merges several attached packages and direct references without duplicating shared evidence or changing raw notes', () => {
    const shared = source('shared', 'Shared evidence.')
    const first = source('first', 'First evidence.')
    const second = source('second', 'Second evidence.')
    const direct = source('direct', 'Direct evidence.')
    const packages = [
      context('research', ['shared', 'first']),
      context('voice', ['shared', 'second']),
    ]
    const draft = {
      ...note('draft', [libraryReference(shared, false), direct]),
      contextPackageIds: ['research', 'voice'],
    }
    const resolved = resolveNoteContext(
      draft,
      [draft],
      [shared, first, second],
      packages
    )
    expect(resolved.sources.map(source => source.text)).toEqual([
      'Shared evidence.',
      'Direct evidence.',
      'First evidence.',
      'Second evidence.',
    ])
    expect(resolved.sources.every(source => source.enabled)).toBe(true)
    expect(draft.sources[0]).toMatchObject({ text: '', enabled: false })
    expect(draft.contextPackageIds).toEqual(['research', 'voice'])
    expect(
      resolvedContextBudget(draft, [draft], [shared, first, second], packages)
    ).toEqual({
      sources: 4,
      characters: resolved.sources.reduce(
        (count, source) => count + source.text.length,
        0
      ),
    })
  })

  it('propagates package source edits to every attached note without copying the collection into notes', () => {
    const first = source('first', 'Original evidence.')
    const second = source('second', 'Additional evidence.')
    const packages = [context('research', ['first'])]
    const drafts = [
      { ...note('one'), contextPackageIds: ['research'] },
      { ...note('two'), contextPackageIds: ['research'] },
    ]
    expect(
      resolveNoteContext(drafts[0]!, drafts, [first], packages).sources[0]?.text
    ).toBe('Original evidence.')
    const editedLibrary = [{ ...first, text: 'Modified evidence.' }, second]
    const editedPackages = [
      { ...packages[0]!, sourceIds: ['first', 'second'], updatedAt: 3 },
    ]
    for (const draft of drafts) {
      expect(
        resolveNoteContext(
          draft,
          drafts,
          editedLibrary,
          editedPackages
        ).sources.map(source => source.text)
      ).toEqual(['Modified evidence.', 'Additional evidence.'])
      expect(draft.sources).toEqual([])
    }
  })

  it('reads only a linked note’s current words, deduplicates note links, and skips a note’s own writing', () => {
    const draft = {
      ...note('draft'),
      content: 'My current words',
      contextPackageIds: ['live', 'other'],
    }
    const target = {
      ...note('target'),
      title: 'Current research',
      content: 'Current target words',
      context: 'Do not recursively include this background',
    }
    const self: ContextSource = {
      ...source('self', ''),
      kind: 'note',
      linkedNoteId: draft.id,
    }
    const linked: ContextSource = {
      ...source('linked', ''),
      kind: 'note',
      linkedNoteId: target.id,
    }
    const duplicate: ContextSource = { ...linked, id: 'duplicate' }
    target.sources = [self]
    draft.sources = [libraryReference(self)]
    const library = [self, linked, duplicate]
    const packages = [
      context('live', ['self', 'linked']),
      context('other', ['duplicate']),
    ]
    const resolved = resolveNoteContext(
      draft,
      [draft, target],
      library,
      packages
    )
    expect(resolved.sources).toHaveLength(1)
    expect(resolved.sources[0]).toMatchObject({
      name: 'Current research',
      text: 'Current target words',
    })
    const changed = {
      ...target,
      title: 'Edited research',
      content: 'New target writing',
    }
    expect(
      resolveNoteContext(draft, [draft, changed], library, packages).sources[0]
    ).toMatchObject({ name: 'Edited research', text: 'New target writing' })
    expect(target.sources[0]?.text).toBe('')
  })

  it('ignores missing package members without reviving stale copied evidence', () => {
    const shared = source('shared', 'Current evidence.')
    const draft = {
      ...note('draft', [
        { ...libraryReference(source('gone')), text: 'Stale evidence' },
      ]),
      contextPackageIds: ['research', 'missing-package'],
    }
    const resolved = resolveNoteContext(
      draft,
      [],
      [shared],
      [context('research', ['missing-source', 'shared'])]
    )
    expect(resolved.sources).toHaveLength(2)
    expect(resolved.sources[0]).toMatchObject({ text: '', enabled: false })
    expect(resolved.sources[1]?.text).toBe(shared.text)
    expect(draft.contextPackageIds).toContain('missing-package')
  })

  it('prunes only orphan snapshots after removal and preserves shared or excluded direct references', () => {
    const library = [source('first'), source('shared'), source('direct')]
    const notes = [note('draft', [libraryReference(library[2]!, false)])]
    const packages = [
      context('research', ['first', 'shared']),
      context('voice', ['shared']),
    ]
    expect(pruneContextLibrary(library, notes, packages)).toBe(library)
    expect(pruneContextLibrary(library, notes, [packages[1]!])).toEqual([
      library[1],
      library[2],
    ])
    expect(library).toHaveLength(3)
    const usage = contextPackageUsage([
      {
        ...note('first'),
        contextPackageIds: ['research', 'research', 'voice'],
      },
      { ...note('second'), contextPackageIds: ['research'] },
    ])
    expect(usage.get('research')).toBe(2)
    expect(usage.get('voice')).toBe(1)
  })
})
