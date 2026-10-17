import { describe, expect, it } from 'vitest'
import { emptyWorkspace, newNote } from '../model'
import { createFolder, ensureTag, moveNotes } from '../organize/organize'
import { validateWorkspace } from '../../services/storage'
import type { Workspace } from '../../types/notebook'
import {
  activeSpace,
  createSpace,
  deleteSpace,
  HOME_SPACE,
  moveToSpace,
  setContextSpaces,
  spaceCounts,
  spaceGitFolder,
  spaceList,
  spaceView,
  switchSpace,
  updateSpace,
} from './spaces'

function notebook(): Workspace {
  const notes = [newNote('Diary'), newNote('Plans')]
  return {
    ...emptyWorkspace(),
    notes,
    openNoteIds: [notes[0]!.id],
    activeNoteId: notes[0]!.id,
  }
}

describe('workspaces', () => {
  it('treats an older notebook as one Personal workspace', () => {
    const value = notebook()
    expect(spaceList(value)).toEqual([HOME_SPACE])
    const view = spaceView(value)
    expect(view.active.name).toBe('Personal')
    // Nothing is filtered or copied for a single workspace.
    expect(view.notes).toBe(value.notes)
  })

  it('switches, remembers tabs and opens a new workspace at its latest note', () => {
    let value = notebook()
    const work = createSpace(value, 'Work')
    value = work.workspace
    // An empty workspace opens on the welcome page.
    value = switchSpace(value, work.space.id)
    expect(activeSpace(value).id).toBe(work.space.id)
    expect(value.openNoteIds).toEqual([])
    expect(spaceView(value).notes).toEqual([])
    const report = { ...newNote('Report'), spaceId: work.space.id }
    value = {
      ...value,
      notes: [...value.notes, report],
      openNoteIds: [report.id],
      activeNoteId: report.id,
    }
    // Back to Personal: its tab returns.
    value = switchSpace(value, 'personal')
    expect(value.activeNoteId).toBe(value.notes[0]!.id)
    expect(spaceView(value).notes.map(note => note.title)).toEqual([
      'Diary',
      'Plans',
    ])
    value = switchSpace(value, work.space.id)
    expect(value.openNoteIds).toEqual([report.id])
  })

  it('shows a shared workspace everywhere', () => {
    let value = notebook()
    const team = createSpace(value, 'Team', { shared: true })
    value = team.workspace
    const handbook = { ...newNote('Handbook'), spaceId: team.space.id }
    value = { ...value, notes: [...value.notes, handbook] }
    const work = createSpace(value, 'Work')
    value = switchSpace(work.workspace, work.space.id)
    expect(spaceView(value).notes.map(note => note.title)).toEqual(['Handbook'])
    value = updateSpace(value, team.space.id, { shared: false })
    expect(spaceView(value).notes).toEqual([])
  })

  it('moves notes and whole folders between workspaces', () => {
    let value = notebook()
    const work = createSpace(value, 'Work')
    value = work.workspace
    const folder = createFolder(value, 'Clients')
    value = folder.workspace
    const inner = createFolder(value, 'Acme', folder.folder.id)
    value = moveNotes(inner.workspace, [value.notes[1]!.id], inner.folder.id)
    value = moveToSpace(value, { folders: [folder.folder.id] }, work.space.id)
    const counts = spaceCounts(value)
    expect(counts.get(work.space.id)).toEqual({ notes: 1, folders: 2 })
    expect(counts.get('personal')).toEqual({ notes: 1, folders: 0 })
    // A single note leaves its folder behind when it changes workspace.
    value = moveToSpace(value, { notes: [value.notes[1]!.id] }, 'personal')
    expect(value.notes[1]!.folderId).toBeUndefined()
  })

  it('deletes a workspace, moving or deleting what it holds', () => {
    let value = notebook()
    const work = createSpace(value, 'Work')
    value = work.workspace
    value = moveToSpace(value, { notes: [value.notes[1]!.id] }, work.space.id)
    const moved = deleteSpace(value, work.space.id, 'personal')
    expect(moved.notes).toHaveLength(2)
    expect(spaceList(moved).map(space => space.name)).toEqual(['Personal'])
    const removed = deleteSpace(value, work.space.id, null)
    expect(removed.notes.map(note => note.title)).toEqual(['Diary'])
    // The first workspace can go too; its notes follow the choice.
    const first = deleteSpace(value, 'personal', work.space.id)
    expect(activeSpace(first).id).toBe(work.space.id)
    expect(first.notes.every(note => note.spaceId === work.space.id)).toBe(true)
    expect(first.openNoteIds.length).toBeGreaterThan(0)
    // The last workspace stays.
    expect(deleteSpace(moved, 'personal', null)).toBe(moved)
  })

  it('limits a context to chosen workspaces', () => {
    let value = notebook()
    const work = createSpace(value, 'Work')
    value = {
      ...work.workspace,
      contextPackages: [
        { id: 'ctx', name: 'Style', sourceIds: [], createdAt: 0, updatedAt: 0 },
      ],
    }
    value = setContextSpaces(value, 'ctx', [work.space.id])
    expect(spaceView(value).packages).toEqual([])
    expect(spaceView(switchSpace(value, work.space.id)).packages).toHaveLength(
      1
    )
    // Every workspace chosen means no list at all.
    value = setContextSpaces(value, 'ctx', ['personal', work.space.id])
    expect(value.contextPackages![0]!.spaceIds).toBeUndefined()
  })

  it('gives each workspace its own Git folder', () => {
    let value = notebook()
    value.settings.git.folder = '/notes/personal'
    const work = createSpace(value, 'Work')
    value = updateSpace(work.workspace, work.space.id, {
      gitFolder: ' /notes/work ',
    })
    const [home, other] = spaceList(value)
    expect(spaceGitFolder(value, home!)).toBe('/notes/personal')
    expect(spaceGitFolder(value, other!)).toBe('/notes/work')
  })

  it('keeps workspaces through a save and repairs unknown ids', () => {
    let value = notebook()
    const work = createSpace(value, 'Work', { color: 'sky' })
    value = switchSpace(work.workspace, work.space.id)
    value = ensureTag(value, 'client').workspace
    value = {
      ...value,
      tags: value.tags!.map(tag => ({ ...tag, spaceId: work.space.id })),
    }
    const saved = validateWorkspace(JSON.parse(JSON.stringify(value)))
    expect(saved.spaces).toEqual(value.spaces)
    expect(saved.activeSpaceId).toBe(work.space.id)
    expect(saved.tags![0]!.spaceId).toBe(work.space.id)
    const broken = JSON.parse(JSON.stringify(value))
    broken.notes[0].spaceId = 'gone'
    broken.activeSpaceId = 'gone'
    const repaired = validateWorkspace(broken)
    expect(repaired.notes[0]!.spaceId).toBeUndefined()
    expect(repaired.activeSpaceId).toBeUndefined()
  })
})

describe('workspace icons', () => {
  it('suggests an icon from the name and keeps a chosen one', async () => {
    const { suggestIcon } = await import('./space-icons')
    expect(suggestIcon('Work')).toBe('briefcase')
    expect(suggestIcon('My novel')).toBe('book')
    expect(suggestIcon('Zebra')).toBeUndefined()
    let value = notebook()
    const work = createSpace(value, 'Client work')
    expect(work.space.icon).toBe('briefcase')
    const plain = createSpace(work.workspace, 'Zebra')
    expect(plain.space.icon).toBeUndefined()
    value = updateSpace(plain.workspace, plain.space.id, { icon: 'cat' })
    expect(spaceList(value).at(-1)?.icon).toBe('cat')
    value = updateSpace(value, plain.space.id, { icon: 'not-an-icon' })
    expect(spaceList(value).at(-1)?.icon).toBeUndefined()
    const saved = validateWorkspace(
      JSON.parse(
        JSON.stringify(updateSpace(value, plain.space.id, { icon: 'cat' }))
      )
    )
    expect(saved.spaces?.at(-1)?.icon).toBe('cat')
  })
})
