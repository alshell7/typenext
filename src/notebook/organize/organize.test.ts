import { describe, expect, it } from 'vitest'
import { emptyWorkspace, newNote } from '../model'
import { validateWorkspace } from '../../services/storage'
import type { Workspace } from '../../types/notebook'
import {
  canMoveFolder,
  cleanTagName,
  counts,
  createFolder,
  deleteFolder,
  deleteTag,
  ensureTag,
  folderPath,
  moveFolder,
  moveNotes,
  renameTag,
  setNoteTag,
  uniqueFolderName,
} from './organize'

function workspace(): Workspace {
  const base = emptyWorkspace()
  return {
    ...base,
    notes: [newNote('One'), newNote('Two'), newNote('Three')],
  }
}

describe('folders', () => {
  it('creates, nests, moves and counts', () => {
    let value = workspace()
    const projects = createFolder(value, 'Projects')
    value = projects.workspace
    const garden = createFolder(value, 'Garden', projects.folder.id)
    value = garden.workspace
    const [one, two] = value.notes
    value = moveNotes(value, [one!.id, two!.id], garden.folder.id)
    expect(
      folderPath(value.folders!, garden.folder.id).map(f => f.name)
    ).toEqual(['Projects', 'Garden'])
    const total = counts(value)
    expect(total.folders.get(projects.folder.id)).toBe(2)
    expect(total.folders.get(garden.folder.id)).toBe(2)
    // A folder cannot move inside itself.
    expect(
      canMoveFolder(value.folders!, projects.folder.id, garden.folder.id)
    ).toBe(false)
    expect(moveFolder(value, projects.folder.id, garden.folder.id)).toBe(value)
    value = moveFolder(value, garden.folder.id, undefined)
    expect(
      value.folders!.find(f => f.id === garden.folder.id)?.parentId
    ).toBeUndefined()
  })

  it('keeps notes and subfolders when a folder is deleted', () => {
    let value = workspace()
    const top = createFolder(value, 'Top')
    value = top.workspace
    const inner = createFolder(value, 'Inner', top.folder.id)
    value = moveNotes(inner.workspace, [value.notes[0]!.id], top.folder.id)
    value = deleteFolder(value, top.folder.id)
    expect(value.folders!.map(f => f.name)).toEqual(['Inner'])
    expect(value.folders![0]!.parentId).toBeUndefined()
    expect(value.notes.every(note => note.folderId === undefined)).toBe(true)
    expect(value.notes).toHaveLength(3)
  })

  it('suggests a free name', () => {
    let value = workspace()
    value = createFolder(value, '').workspace
    expect(value.folders![0]!.name).toBe('New folder')
    expect(uniqueFolderName(value.folders!, undefined)).toBe('New folder 2')
  })

  it('does not change when notes were edited', () => {
    let value = workspace()
    const before = value.notes.map(note => note.updatedAt)
    value = moveNotes(
      createFolder(value, 'A').workspace,
      [value.notes[0]!.id],
      value.folders?.[0]?.id
    )
    expect(value.notes.map(note => note.updatedAt)).toEqual(before)
  })
})

describe('tags', () => {
  it('creates tags once by name and attaches them', () => {
    let value = workspace()
    const draft = ensureTag(value, '#Draft  ')
    value = draft.workspace
    expect(draft.tag.name).toBe('Draft')
    expect(ensureTag(value, 'draft').tag.id).toBe(draft.tag.id)
    value = setNoteTag(value, value.notes[0]!.id, draft.tag.id, true)
    value = setNoteTag(value, value.notes[1]!.id, draft.tag.id, true)
    expect(counts(value).tags.get(draft.tag.id)).toBe(2)
    value = setNoteTag(value, value.notes[1]!.id, draft.tag.id, false)
    expect(value.notes[1]!.tags).toBeUndefined()
  })

  it('merges on a rename to an existing name and removes a deleted tag', () => {
    let value = workspace()
    const a = ensureTag(value, 'ideas')
    value = a.workspace
    const b = ensureTag(value, 'later')
    value = b.workspace
    value = setNoteTag(value, value.notes[0]!.id, a.tag.id, true)
    value = setNoteTag(value, value.notes[0]!.id, b.tag.id, true)
    value = renameTag(value, a.tag.id, 'Later')
    expect(value.tags!.map(tag => tag.name)).toEqual(['later'])
    expect(value.notes[0]!.tags).toEqual([b.tag.id])
    value = deleteTag(value, b.tag.id)
    expect(value.tags).toEqual([])
    expect(value.notes[0]!.tags).toBeUndefined()
  })

  it('cleans names', () => {
    expect(cleanTagName('  ##  writing   plan ')).toBe('writing plan')
  })
})

describe('saved notebooks', () => {
  it('keep folders and tags, and repair what points nowhere', () => {
    let value = workspace()
    const folder = createFolder(value, 'Work')
    value = folder.workspace
    const tag = ensureTag(value, 'urgent')
    value = setNoteTag(tag.workspace, value.notes[0]!.id, tag.tag.id, true)
    value = moveNotes(value, [value.notes[0]!.id], folder.folder.id)
    const saved = validateWorkspace(JSON.parse(JSON.stringify(value)))
    expect(saved.folders).toEqual(value.folders)
    expect(saved.tags).toEqual(value.tags)
    expect(saved.notes[0]).toMatchObject({
      folderId: folder.folder.id,
      tags: [tag.tag.id],
    })
    const broken = JSON.parse(JSON.stringify(value))
    broken.notes[0].folderId = 'gone'
    broken.notes[0].tags = ['gone', tag.tag.id]
    broken.folders.push({
      id: 'loop',
      name: 'Loop',
      parentId: 'loop',
      createdAt: 1,
    })
    const repaired = validateWorkspace(broken)
    expect(repaired.notes[0]!.folderId).toBeUndefined()
    expect(repaired.notes[0]!.tags).toEqual([tag.tag.id])
    expect(
      repaired.folders!.find(f => f.id === 'loop')?.parentId
    ).toBeUndefined()
  })
})
