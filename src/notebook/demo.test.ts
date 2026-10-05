import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  addDemoWorkspace,
  DEMO_NOTE_ID,
  DEMO_PACKAGE_IDS,
  DEMO_SOURCE_FILES,
  DEMO_STARTER,
  hasDemoNote,
} from './demo'
import { emptyWorkspace, newNote, openNote } from './model'
import { resolveNoteContext } from './note-context'
import { suggest } from '../services/completion'
import { retrieveContext } from '../services/retrieval'
import { validateWorkspace } from '../services/storage'

describe('optional Bramble House sample', () => {
  it('starts empty and adds a real note with two independent contexts only when requested', () => {
    const original = emptyWorkspace()
    expect(hasDemoNote(original)).toBe(false)
    const installed = addDemoWorkspace(original)
    expect(original.notes).toEqual([])
    expect(installed.activeNoteId).toBe(DEMO_NOTE_ID)
    expect(installed.openNoteIds).toEqual([DEMO_NOTE_ID])
    expect(installed.notes).toHaveLength(1)
    expect(installed.notes[0]?.content.endsWith(DEMO_STARTER)).toBe(true)
    expect(installed.notes[0]?.contextPackageIds).toEqual(DEMO_PACKAGE_IDS)
    expect(installed.notes[0]?.sources).toEqual([])
    expect(
      installed.contextPackages?.map(context => context.sourceIds.length)
    ).toEqual([3, 1])
    expect(installed.contextLibrary).toHaveLength(4)
    expect(installed.settings).toBe(original.settings)
    expect(validateWorkspace(JSON.parse(JSON.stringify(installed)))).toEqual(
      installed
    )
  })

  it('preserves existing writing, contexts, active provider and autosave preferences', () => {
    const personal = newNote(
      'My own writing',
      '',
      'My draft stays exactly as it is.'
    )
    const original = openNote(emptyWorkspace(), personal)
    original.settings.provider = 'openrouter'
    original.settings.externalAutoEnabled = true
    original.settings.autoSave = false
    original.contextPackages = [
      {
        id: 'personal',
        name: 'Personal',
        sourceIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const installed = addDemoWorkspace(original)
    expect(installed.notes.find(note => note.id === personal.id)).toBe(personal)
    expect(installed.contextPackages?.[0]).toBe(original.contextPackages[0])
    expect(installed.openNoteIds).toEqual([personal.id, DEMO_NOTE_ID])
    expect(installed.settings).toBe(original.settings)
    expect(personal.contextPackageIds).toEqual([])
  })

  it('reopens an edited sample without restoring removed sources or detached packages', () => {
    const installed = addDemoWorkspace(emptyWorkspace())
    installed.notes[0] = {
      ...installed.notes[0]!,
      content: 'My own version.',
      contextPackageIds: [],
    }
    installed.contextPackages = []
    installed.contextLibrary = []
    installed.openNoteIds = []
    installed.activeNoteId = null
    const reopened = addDemoWorkspace(installed)
    expect(reopened.notes).toBe(installed.notes)
    expect(reopened.notes[0]?.content).toBe('My own version.')
    expect(reopened.contextLibrary).toEqual([])
    expect(reopened.contextPackages).toEqual([])
    expect(reopened.notes[0]?.contextPackageIds).toEqual([])
    expect(reopened.openNoteIds).toEqual([DEMO_NOTE_ID])
    expect(addDemoWorkspace(reopened)).toEqual(reopened)
  })

  it('recreates a deleted sample note without duplicating or overwriting its edited contexts', () => {
    const installed = addDemoWorkspace(emptyWorkspace())
    installed.contextLibrary![0] = {
      ...installed.contextLibrary![0]!,
      text: 'An edited house reference.',
    }
    installed.contextPackages![0] = {
      ...installed.contextPackages![0]!,
      name: 'My edited context',
      sourceIds: [],
    }
    installed.notes = []
    installed.openNoteIds = []
    installed.activeNoteId = null
    const restored = addDemoWorkspace(installed)
    expect(restored.contextLibrary).toEqual(installed.contextLibrary)
    expect(restored.contextPackages).toEqual(installed.contextPackages)
    expect(restored.notes).toHaveLength(1)
  })

  it('rejects a full library or context collection without partially adding the sample', () => {
    const original = emptyWorkspace()
    original.contextPackages = Array.from({ length: 255 }, (_, index) => ({
      id: String(index),
      name: 'Existing context',
      sourceIds: [],
      createdAt: 1,
      updatedAt: 1,
    }))
    expect(() => addDemoWorkspace(original)).toThrow(
      'no room for the sample contexts'
    )
    expect(original.notes).toEqual([])
    expect(original.contextPackages).toHaveLength(255)
    original.contextPackages = []
    original.contextLibrary = Array.from({ length: 2047 }, (_, index) => ({
      id: String(index),
      name: 'Existing source',
      kind: 'text',
      text: 'My own reference.',
      enabled: true,
      addedAt: 1,
    }))
    expect(() => addDemoWorkspace(original)).toThrow(
      'no room for the sample files'
    )
    expect(original.contextLibrary).toHaveLength(2047)
    expect(original.notes).toEqual([])
  })

  it.each([
    [DEMO_STARTER, ' on Friday at 16:00.', 'house.md'],
    [
      'The Saturday writing session begins',
      ' at 09:30 in the shared writing room.',
      'weekend-plan.txt',
    ],
    [
      'The coastal walk starts',
      ' at the blue orchard gate and ends at the same gate.',
      'coastal-walk.md',
    ],
  ])(
    'retrieves and recalls the real sample fact for %j without a model',
    async (prefix, expected, sourceName) => {
      const workspace = addDemoWorkspace(emptyWorkspace())
      const note = resolveNoteContext(
        { ...workspace.notes[0]!, content: prefix },
        workspace.notes,
        workspace.contextLibrary,
        workspace.contextPackages
      )
      const passages = retrieveContext(note, prefix)
      expect(passages[0]?.sourceName).toBe(sourceName)
      expect(
        passages.some(passage => passage.text.includes(prefix + expected))
      ).toBe(true)
      const result = await suggest(
        note,
        { text: prefix, cursor: prefix.length, selectionEmpty: true },
        workspace.settings
      )
      expect(result.text).toBe(expected)
      expect(result.mode).toBe('recall')
      expect(result.sources).toContain(sourceName)
    }
  )

  it('detaching the facts package removes the arrival fact from the retriever', () => {
    const workspace = addDemoWorkspace(emptyWorkspace())
    const detached = {
      ...workspace.notes[0]!,
      contextPackageIds: [DEMO_PACKAGE_IDS[1]],
    }
    const note = resolveNoteContext(
      detached,
      workspace.notes,
      workspace.contextLibrary,
      workspace.contextPackages
    )
    expect(note.sources).toHaveLength(1)
    expect(
      retrieveContext(note, DEMO_STARTER).some(passage =>
        passage.text.includes('Friday at 16:00')
      )
    ).toBe(false)
  })

  it('ships a download with the exact source files used by the app', () => {
    const files = unzipSync(readFileSync('public/demo/typenext-sample.zip'))
    expect(Object.keys(files)).toHaveLength(6)
    for (const source of DEMO_SOURCE_FILES)
      expect(
        strFromU8(files[`bramble-house/${source.folder}/${source.name}`]!)
      ).toBe(source.text)
    expect(strFromU8(files['bramble-house/welcome-note.md']!).trimEnd()).toBe(
      addDemoWorkspace(emptyWorkspace()).notes[0]!.content
    )
  })
})
