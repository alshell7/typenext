import { describe, expect, it } from 'vitest'
import {
  closeNote,
  defaultSettings,
  emptyWorkspace,
  newNote,
  normalizeWorkspace,
  openNote,
} from './model'

describe('notebook lifecycle', () => {
  it('closes a tab without deleting the saved note and selects its neighbor', () => {
    const first = newNote('First')
    const second = newNote('Second')
    const workspace = openNote(openNote(emptyWorkspace(), first), second)
    const closed = closeNote(workspace, second.id)
    expect(closed.notes).toHaveLength(2)
    expect(closed.activeNoteId).toBe(first.id)
    expect(openNote(closed, second).notes).toHaveLength(2)
  })
  it('restores valid tabs and forces ordinary inference local', () => {
    const note = newNote('Personal note')
    const workspace = openNote(emptyWorkspace(), note)
    workspace.openNoteIds.push('missing', note.id)
    workspace.activeNoteId = 'missing'
    workspace.settings.provider = 'openrouter'
    const restored = normalizeWorkspace(workspace)
    expect(restored.openNoteIds).toEqual([note.id])
    expect(restored.activeNoteId).toBe(note.id)
    expect(restored.settings.provider).toBe('local')
    expect(defaultSettings().profiles.local.model).toBe('')
  })
})
