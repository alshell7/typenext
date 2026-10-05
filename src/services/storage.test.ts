import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspace, newNote, openNote } from '../notebook/model'
import { linkNoteSource } from '../notebook/note-context'
import { newContextPackage } from '../notebook/context-library'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

beforeEach(() => {
  vi.resetModules()
  native.invoke.mockReset()
  localStorage.clear()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})
afterEach(() => vi.restoreAllMocks())

describe('notebook persistence', () => {
  it('persists several named context packages with one stored source body and restores their memberships on recovery', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const source = {
      id: 'shared',
      name: 'Shared.md',
      kind: 'markdown' as const,
      text: 'One uniquely stored package body.',
      enabled: true,
      addedAt: 1,
    }
    const research = {
      ...newContextPackage('Research'),
      sourceIds: [source.id],
    }
    const voice = { ...newContextPackage('Voice'), sourceIds: [source.id] }
    const draft = {
      ...newNote('Draft', '', 'My independent words'),
      contextPackageIds: [research.id, voice.id],
    }
    const workspace = {
      ...openNote(emptyWorkspace(), draft),
      contextLibrary: [source],
      contextPackages: [research, voice],
    }
    await persistWorkspace(workspace)
    const raw = localStorage.getItem('typenext.workspace.v1')!
    expect(raw.match(/One uniquely stored package body\./gu)).toHaveLength(1)
    const loaded = (await loadWorkspace())!
    expect(loaded.contextPackages).toEqual([research, voice])
    expect(loaded.notes[0]?.contextPackageIds).toEqual([research.id, voice.id])
    expect(loaded.notes[0]?.sources).toEqual([])
    await persistWorkspace({
      ...workspace,
      contextPackages: [{ ...research, name: 'Updated research' }, voice],
    })
    localStorage.setItem('typenext.workspace.v1', '{broken package save')
    const recovered = (await loadWorkspace())!
    expect(recovered.contextPackages?.[0]?.name).toBe('Research')
    expect(recovered.notes[0]?.content).toBe('My independent words')
    expect(recovered.notes[0]?.contextPackageIds).toEqual([
      research.id,
      voice.id,
    ])
  })

  it('preserves missing package fields for legacy migration and projects only package schema fields', async () => {
    const { validateWorkspace } = await import('./storage')
    const legacy = validateWorkspace({
      ...emptyWorkspace(),
      contextPackages: undefined,
    })
    expect(legacy).not.toHaveProperty('contextPackages')
    const context = {
      ...newContextPackage('Research'),
      apiKey: 'must-not-persist',
      sourceIds: ['missing-source'],
    }
    const workspace = validateWorkspace({
      ...emptyWorkspace(),
      contextPackages: [context],
      notes: [{ ...newNote('Draft'), contextPackageIds: ['missing-package'] }],
    })
    expect(workspace.contextPackages?.[0]).not.toHaveProperty('apiKey')
    expect(workspace.contextPackages?.[0]?.sourceIds).toEqual([
      'missing-source',
    ])
    expect(workspace.notes[0]?.contextPackageIds).toEqual(['missing-package'])
    expect(
      validateWorkspace({ ...emptyWorkspace(), contextPackages: [] })
        .contextPackages
    ).toEqual([])
  })

  it('rejects duplicate and oversized package memberships or names before replacing a valid notebook', async () => {
    const { validateWorkspace, persistWorkspace } = await import('./storage')
    const context = newContextPackage('Research')
    const valid = { ...emptyWorkspace(), contextPackages: [context] }
    await persistWorkspace(valid)
    const original = localStorage.getItem('typenext.workspace.v1')
    const malformed = [
      { ...valid, contextPackages: [context, context] },
      {
        ...valid,
        contextPackages: [{ ...context, sourceIds: ['same', 'same'] }],
      },
      { ...valid, contextPackages: [{ ...context, name: '  ' }] },
      { ...valid, contextPackages: [{ ...context, name: '😀'.repeat(257) }] },
      {
        ...valid,
        contextPackages: [
          {
            ...context,
            sourceIds: Array.from(
              { length: 257 },
              (_, index) => `source-${index}`
            ),
          },
        ],
      },
      {
        ...valid,
        contextPackages: Array.from({ length: 257 }, (_, index) => ({
          ...context,
          id: `context-${index}`,
        })),
      },
      {
        ...valid,
        notes: [{ ...newNote('Draft'), contextPackageIds: ['same', 'same'] }],
      },
      {
        ...valid,
        notes: [
          {
            ...newNote('Draft'),
            contextPackageIds: Array.from(
              { length: 65 },
              (_, index) => `context-${index}`
            ),
          },
        ],
      },
    ]
    for (const workspace of malformed) {
      expect(() => validateWorkspace(workspace)).toThrow('invalid')
      await expect(persistWorkspace(workspace)).rejects.toThrow('invalid')
      expect(localStorage.getItem('typenext.workspace.v1')).toBe(original)
    }
  })

  it('includes bounded package metadata in the aggregate workspace budget', async () => {
    const { assertWorkspaceFits } = await import('./storage')
    const text = 'x'.repeat(7_800_000)
    const workspace = {
      ...emptyWorkspace(),
      contextLibrary: Array.from({ length: 8 }, (_, index) => ({
        id: `source-${index}`,
        name: 'Reference.txt',
        kind: 'text' as const,
        text,
        enabled: true,
        addedAt: 1,
      })),
    }
    expect(() => assertWorkspaceFits(workspace)).not.toThrow()
    const sourceIds = Array.from({ length: 256 }, (_, index) =>
      `id-${index}`.padEnd(256, 'x')
    )
    const packages = Array.from({ length: 256 }, (_, index) => ({
      id: `context-${index}`,
      name: 'Research',
      sourceIds,
      createdAt: 1,
      updatedAt: 1,
    }))
    expect(() =>
      assertWorkspaceFits({ ...workspace, contextPackages: packages })
    ).toThrow('64 MB')
  })

  it('autosaves a captured snapshot without writing API keys or switching ordinary suggestions to cloud', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('My note', '', 'My own words')
    )
    const extended = {
      ...workspace,
      apiKey: 'must-not-save',
      settings: {
        ...workspace.settings,
        provider: 'openai' as const,
        apiKey: 'also-must-not-save',
      },
    }
    await persistWorkspace(extended)
    expect(localStorage.getItem('typenext.workspace.v1')).not.toContain(
      'must-not-save'
    )
    expect((await loadWorkspace())?.notes[0]?.content).toBe('My own words')
    expect((await loadWorkspace())?.settings.provider).toBe('local')
  })

  it('recovers the previous valid save when the primary snapshot is corrupt', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('My note', '', 'First draft')
    )
    await persistWorkspace(workspace)
    await persistWorkspace({
      ...workspace,
      notes: workspace.notes.map(note => ({
        ...note,
        content: 'Second draft',
      })),
    })
    localStorage.setItem('typenext.workspace.v1', '{broken')
    expect((await loadWorkspace())?.notes[0]?.content).toBe('First draft')
    expect(localStorage.getItem('typenext.workspace.v1')).toBe('{broken')
  })

  it('preserves a valid backup when saving after primary corruption', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('My note', '', 'First draft')
    )
    await persistWorkspace(workspace)
    await persistWorkspace(workspace)
    localStorage.setItem('typenext.workspace.v1', 'broken')
    await persistWorkspace({
      ...workspace,
      notes: workspace.notes.map(note => ({
        ...note,
        content: 'Recovered work',
      })),
    })
    localStorage.setItem('typenext.workspace.v1', 'broken again')
    expect((await loadWorkspace())?.notes[0]?.content).toBe('First draft')
  })

  it('reports invalid storage without silently replacing the writer’s data', async () => {
    const { loadWorkspace } = await import('./storage')
    localStorage.setItem('typenext.workspace.v1', 'broken')
    await expect(loadWorkspace()).rejects.toThrow('recovery copy')
    expect(localStorage.getItem('typenext.workspace.v1')).toBe('broken')
  })

  it('serializes native saves so an older request cannot finish after a newer one', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    let finishFirst: (() => void) | undefined
    native.invoke
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishFirst = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    const { persistWorkspace } = await import('./storage')
    const first = openNote(
      emptyWorkspace(),
      newNote('My note', '', 'First draft')
    )
    const firstSave = persistWorkspace(first)
    first.notes[0]!.content = 'Later draft'
    const secondSave = persistWorkspace(first)
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1))
    expect(native.invoke.mock.calls[0]?.[1]?.workspace.notes[0].content).toBe(
      'First draft'
    )
    finishFirst?.()
    await Promise.all([firstSave, secondSave])
    expect(native.invoke.mock.calls[1]?.[1]?.workspace.notes[0].content).toBe(
      'Later draft'
    )
  })

  it('notifies native recovery after decoding the load response and strips transient metadata from saves', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    const workspace = openNote(
      emptyWorkspace(),
      newNote('Draft', '', 'Recovered copy')
    )
    native.invoke
      .mockResolvedValueOnce({ ...workspace, recovered: true })
      .mockResolvedValueOnce(undefined)
    const listener = vi.fn()
    window.addEventListener('typenext:workspace-recovered', listener)
    try {
      const { loadWorkspace, persistWorkspace } = await import('./storage')
      const loaded = await loadWorkspace()
      expect(listener).toHaveBeenCalledOnce()
      expect(loaded?.notes[0]?.content).toBe('Recovered copy')
      expect(loaded).not.toHaveProperty('recovered')
      await persistWorkspace(loaded!)
      expect(native.invoke.mock.calls[1]![1].workspace).not.toHaveProperty(
        'recovered'
      )
    } finally {
      window.removeEventListener('typenext:workspace-recovered', listener)
    }
  })

  it('projects old preferences safely and rejects invalid tabs', async () => {
    const { validateWorkspace } = await import('./storage')
    const workspace = emptyWorkspace()
    expect(
      validateWorkspace({
        ...workspace,
        settings: {
          ...workspace.settings,
          suggestionLength: undefined,
          externalProvider: undefined,
        },
      }).settings.suggestionLength
    ).toBe('adaptive')
    expect(() =>
      validateWorkspace({ ...workspace, activeNoteId: 'missing-note' })
    ).toThrow('invalid')
  })

  it('uses portable Markdown filenames without path or Windows device names', async () => {
    const { markdownFilename } = await import('./storage')
    expect(markdownFilename('CON')).toBe('CON-note.md')
    expect(markdownFilename('A / thought: today')).toBe('A - thought- today.md')
    expect(markdownFilename('Draft.md')).toBe('Draft.md')
  })

  it('persists live-note identities without copying their derived text', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const reference = newNote('Research', '', 'Current reference writing')
    const draft = {
      ...newNote('Draft', '', 'My words'),
      sources: [{ ...linkNoteSource(reference), text: reference.content }],
    }
    await persistWorkspace(
      openNote(openNote(emptyWorkspace(), reference), draft)
    )
    const raw = JSON.parse(
      localStorage.getItem('typenext.workspace.v1') ?? '{}'
    )
    const savedDraft = raw.notes.find(
      (candidate: { id: string }) => candidate.id === draft.id
    )
    expect(savedDraft.sources[0]).toMatchObject({
      kind: 'note',
      linkedNoteId: reference.id,
      text: '',
    })
    expect(
      (await loadWorkspace())?.notes.find(
        candidate => candidate.id === draft.id
      )?.sources[0]?.linkedNoteId
    ).toBe(reference.id)
    expect(draft.sources[0]?.text).toBe('Current reference writing')
  })

  it('requires note-link IDs and prevents duplicate links or note IDs on file sources', async () => {
    const { validateWorkspace } = await import('./storage')
    const reference = newNote('Research')
    const link = linkNoteSource(reference)
    const draft = newNote('Draft')
    const workspace = (sources: typeof draft.sources) =>
      openNote(emptyWorkspace(), { ...draft, sources })
    expect(() =>
      validateWorkspace(workspace([{ ...link, linkedNoteId: undefined }]))
    ).toThrow('invalid')
    expect(() =>
      validateWorkspace(workspace([{ ...link, kind: 'markdown' }]))
    ).toThrow('invalid')
    expect(() =>
      validateWorkspace(workspace([link, { ...link, id: 'second-link' }]))
    ).toThrow('invalid')
    // A removed target remains recoverable as a link, rather than corrupting
    // the notebook; the context resolver will mark it unavailable.
    expect(
      validateWorkspace(workspace([link])).notes[0]?.sources[0]?.linkedNoteId
    ).toBe(reference.id)
  })

  it('preserves each damaged browser snapshot before a new save and keeps the valid backup', async () => {
    const { persistWorkspace } = await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('Draft', '', 'Good copy')
    )
    await persistWorkspace(workspace)
    await persistWorkspace(workspace)
    for (const damaged of ['{first torn snapshot', '{second torn snapshot']) {
      localStorage.setItem('typenext.workspace.v1', damaged)
      await persistWorkspace(workspace)
    }
    const archives = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index)
    )
      .filter(key => key?.startsWith('typenext.workspace.v1.corrupt.'))
      .map(key => localStorage.getItem(key!))
      .sort()
    expect(archives).toEqual(['{first torn snapshot', '{second torn snapshot'])
    expect(
      JSON.parse(localStorage.getItem('typenext.workspace.v1.backup')!).notes[0]
        .content
    ).toBe('Good copy')
  })

  it('refuses to replace corruption when storage cannot preserve its original bytes', async () => {
    const { persistWorkspace } = await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('Draft', '', 'Good copy')
    )
    await persistWorkspace(workspace)
    await persistWorkspace(workspace)
    const backup = localStorage.getItem('typenext.workspace.v1.backup')
    localStorage.setItem('typenext.workspace.v1', '{damaged original')
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value
    ) {
      if (key.startsWith('typenext.workspace.v1.corrupt.'))
        throw new DOMException('Full', 'QuotaExceededError')
      original.call(this, key, value)
    })
    await expect(persistWorkspace(workspace)).rejects.toThrow(
      'Existing data is preserved'
    )
    expect(localStorage.getItem('typenext.workspace.v1')).toBe(
      '{damaged original'
    )
    expect(localStorage.getItem('typenext.workspace.v1.backup')).toBe(backup)
  })

  it('flushes browser lifecycle saves synchronously and supersedes queued stale snapshots', async () => {
    const { persistWorkspace, flushBrowserWorkspace } =
      await import('./storage')
    const first = openNote(emptyWorkspace(), newNote('Draft', '', 'First'))
    const older = persistWorkspace(first)
    const latest = {
      ...first,
      notes: first.notes.map(note => ({
        ...note,
        content: 'Latest edit before unload',
      })),
    }
    expect(flushBrowserWorkspace(latest)).toBe(true)
    expect(
      JSON.parse(localStorage.getItem('typenext.workspace.v1')!).notes[0]
        .content
    ).toBe('Latest edit before unload')
    await older
    expect(
      JSON.parse(localStorage.getItem('typenext.workspace.v1')!).notes[0]
        .content
    ).toBe('Latest edit before unload')
  })

  it('keeps lifecycle flushing browser-only and avoids a redundant native JSON stringify', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    native.invoke.mockResolvedValue(undefined)
    const { persistWorkspace, flushBrowserWorkspace } =
      await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('Draft', '', 'Writing')
    )
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(flushBrowserWorkspace(workspace)).toBe(false)
    await persistWorkspace(workspace)
    expect(stringify).not.toHaveBeenCalled()
    expect(native.invoke).toHaveBeenCalledOnce()
  })

  it('bounds the whole serialized notebook before committing and accounts for JSON escapes', async () => {
    const { assertWorkspaceFits, persistWorkspace, STORAGE_LIMITS } =
      await import('./storage')
    const workspace = openNote(
      emptyWorkspace(),
      newNote('Saved', '', 'Keep this')
    )
    await persistWorkspace(workspace)
    const saved = localStorage.getItem('typenext.workspace.v1')
    const escaped = '\u0000'.repeat(3 * 1024 * 1024)
    const notes = Array.from({ length: 4 }, () => newNote('Large', '', escaped))
    const oversized = {
      ...workspace,
      notes,
      openNoteIds: [notes[0]!.id],
      activeNoteId: notes[0]!.id,
    }
    expect(STORAGE_LIMITS.workspaceBytes).toBe(64 * 1024 * 1024)
    expect(() => assertWorkspaceFits(oversized)).toThrow('64 MB')
    await expect(persistWorkspace(oversized)).rejects.toThrow('64 MB')
    expect(localStorage.getItem('typenext.workspace.v1')).toBe(saved)
    // Unpaired UTF-16 surrogates are escaped by well-formed JSON.stringify.
    notes.forEach(note => {
      note.content = '\ud800'.repeat(2 * 1024 * 1024)
    })
    expect(() => assertWorkspaceFits(oversized)).not.toThrow()
    oversized.notes = [
      ...notes,
      newNote('More', '', notes[0]!.content),
      newNote('More', '', notes[0]!.content),
    ]
    expect(() => assertWorkspaceFits(oversized)).toThrow('64 MB')
  })

  it('rejects per-field UTF-8 overflow and invalid source counts before any write', async () => {
    const { assertWorkspaceFits, STORAGE_LIMITS } = await import('./storage')
    const note = newNote(
      'Draft',
      '',
      '界'.repeat(Math.floor(STORAGE_LIMITS.noteBytes / 3) + 1)
    )
    expect(() => assertWorkspaceFits(openNote(emptyWorkspace(), note))).toThrow(
      'invalid'
    )
    const source = {
      id: 'source',
      name: 'Reference',
      kind: 'text' as const,
      text: '',
      enabled: true,
      addedAt: 1,
    }
    expect(() =>
      assertWorkspaceFits(
        openNote(emptyWorkspace(), {
          ...newNote('Draft'),
          sources: Array.from(
            { length: STORAGE_LIMITS.sourcesPerNote + 1 },
            (_, index) => ({ ...source, id: `source-${index}` })
          ),
        })
      )
    ).toThrow('invalid')
    expect(localStorage.length).toBe(0)
  })

  it('migrates an absent palette with shared defaults while preserving the existing theme', async () => {
    const { validateWorkspace } = await import('./storage')
    const workspace = emptyWorkspace()
    const migrated = validateWorkspace({
      ...workspace,
      settings: { ...workspace.settings, theme: 'light', palette: undefined },
    })
    expect(migrated.settings.theme).toBe('light')
    expect(migrated.settings.palette).toEqual({
      light: 'paper',
      dark: 'graphite',
      customLight: { page: '#ffffff', sidebar: '#f3f4f1', accent: '#42644d' },
      customDark: { page: '#212121', sidebar: '#17191c', accent: '#a6b6c8' },
    })
  })

  it('persists custom palettes and projects only validated color fields', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const workspace = emptyWorkspace()
    const extended = {
      ...workspace,
      settings: {
        ...workspace.settings,
        palette: {
          ...workspace.settings.palette,
          light: 'custom' as const,
          dark: 'forest' as const,
          customLight: {
            page: '#FAFAF8',
            sidebar: '#F1F2EF',
            accent: '#42644d',
            apiKey: 'private-do-not-store',
          },
        },
      },
    }
    await persistWorkspace(extended)
    expect((await loadWorkspace())?.settings.palette).toMatchObject({
      light: 'custom',
      dark: 'forest',
      customLight: { page: '#FAFAF8', sidebar: '#F1F2EF', accent: '#42644d' },
    })
    expect(localStorage.getItem('typenext.workspace.v1')).not.toContain(
      'private-do-not-store'
    )
  })

  it.each([
    null,
    { light: 'unexpected' },
    { dark: 'url(https://invalid.example)' },
    { customDark: { page: '#123' } },
    { customLight: { accent: '#12345678' } },
    { customDark: { sidebar: '#gg0000' } },
    { customDark: { page: '#123456\n' } },
    { customLight: { page: '#fff; background:url(https://invalid.example)' } },
    { customDark: { accent: 'var(--injected)' } },
  ])(
    'rejects a malformed or injected palette before replacing valid saved data: %j',
    async patch => {
      const { persistWorkspace } = await import('./storage')
      const workspace = emptyWorkspace()
      await persistWorkspace(workspace)
      const saved = localStorage.getItem('typenext.workspace.v1')
      const palette =
        patch === null
          ? null
          : {
              ...workspace.settings.palette,
              ...patch,
              customLight: {
                ...workspace.settings.palette.customLight,
                ...patch.customLight,
              },
              customDark: {
                ...workspace.settings.palette.customDark,
                ...patch.customDark,
              },
            }
      await expect(
        persistWorkspace({
          ...workspace,
          settings: { ...workspace.settings, palette },
        } as never)
      ).rejects.toThrow('invalid')
      expect(localStorage.getItem('typenext.workspace.v1')).toBe(saved)
    }
  )
})

describe('context library and explicit engine preferences', () => {
  it('stores one canonical source, empty note references, all provider profiles and intentional continuous mode', async () => {
    const { persistWorkspace, loadWorkspace } = await import('./storage')
    const workspace = openNote(emptyWorkspace(), newNote('Draft'))
    const source = {
      id: 'reference',
      name: 'Research.txt',
      kind: 'text' as const,
      text: 'Shared reference only stored once',
      enabled: true,
      addedAt: 1,
      folder: 'Research/Ideas',
    }
    workspace.contextLibrary = [source]
    workspace.notes[0]!.sources = [{ ...source, libraryId: source.id }]
    workspace.settings = {
      ...workspace.settings,
      provider: 'openai',
      externalAutoEnabled: true,
      suggestionInstructions: 'Preserve my voice.',
      localEngine: 'embedded',
    }
    workspace.settings.profiles.openai = {
      ...workspace.settings.profiles.openai,
      model: 'writer-a',
      savedModels: ['writer-a', 'writer-b'],
    }
    workspace.settings.palette.dark = 'black'
    await persistWorkspace(workspace)
    const restored = await loadWorkspace()
    expect(restored?.contextLibrary).toEqual([source])
    expect(restored?.notes[0]?.sources[0]?.text).toBe('')
    expect(restored?.notes[0]?.sources[0]?.libraryId).toBe('reference')
    expect(restored?.settings).toMatchObject({
      provider: 'openai',
      externalAutoEnabled: true,
      suggestionInstructions: 'Preserve my voice.',
      localEngine: 'embedded',
      palette: { dark: 'black' },
    })
    expect(restored?.settings.profiles.openai.savedModels).toEqual([
      'writer-a',
      'writer-b',
    ])
    const raw = localStorage.getItem('typenext.workspace.v1')!
    expect(raw.split(source.text)).toHaveLength(2)
  })
  it('rejects nested or duplicate library entries and oversized instructions before saving', async () => {
    const { validateWorkspace } = await import('./storage')
    const workspace = emptyWorkspace()
    const source = {
      id: 'one',
      name: 'Source',
      kind: 'text' as const,
      text: 'Words',
      enabled: true,
      addedAt: 1,
    }
    expect(() =>
      validateWorkspace({ ...workspace, contextLibrary: [source, source] })
    ).toThrow()
    expect(() =>
      validateWorkspace({
        ...workspace,
        contextLibrary: [{ ...source, libraryId: 'other' }],
      })
    ).toThrow()
    expect(() =>
      validateWorkspace({
        ...workspace,
        settings: {
          ...workspace.settings,
          suggestionInstructions: 'x'.repeat(8001),
        },
      })
    ).toThrow()
    expect(() =>
      validateWorkspace({
        ...workspace,
        settings: { ...workspace.settings, externalAutoEnabled: 'yes' },
      })
    ).toThrow()
  })
})
