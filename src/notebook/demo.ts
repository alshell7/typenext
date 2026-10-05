import type {
  ContextPackage,
  ContextSource,
  Workspace,
} from '../types/notebook'
import { openNote } from './model'
import {
  MAX_CONTEXT_LIBRARY_ITEMS,
  MAX_CONTEXT_PACKAGES,
} from './context-library'
import { assertWorkspaceFits, STORAGE_LIMITS } from '../services/storage'
import house from '../../examples/bramble-house/details/house.md?raw'
import weekend from '../../examples/bramble-house/details/weekend-plan.txt?raw'
import coast from '../../examples/bramble-house/details/coastal-walk.md?raw'
import voice from '../../examples/bramble-house/voice/welcome-voice.md?raw'
import writing from '../../examples/bramble-house/welcome-note.md?raw'

export const DEMO_NOTE_ID = 'typenext-demo-bramble-house-v1'
export const DEMO_DOWNLOAD_PATH = 'demo/typenext-sample.zip'
export const DEMO_STARTER = 'Guests arrive at Bramble House'
export const DEMO_PACKAGE_IDS = [
  'typenext-demo-bramble-details-v1',
  'typenext-demo-bramble-voice-v1',
] as const

export const DEMO_SOURCE_FILES = [
  {
    id: 'house',
    name: 'house.md',
    folder: 'details',
    kind: 'markdown',
    text: house,
  },
  {
    id: 'weekend',
    name: 'weekend-plan.txt',
    folder: 'details',
    kind: 'text',
    text: weekend,
  },
  {
    id: 'coast',
    name: 'coastal-walk.md',
    folder: 'details',
    kind: 'markdown',
    text: coast,
  },
  {
    id: 'voice',
    name: 'welcome-voice.md',
    folder: 'voice',
    kind: 'markdown',
    text: voice,
  },
] as const

export function hasDemoNote(workspace: Workspace): boolean {
  return workspace.notes.some(note => note.id === DEMO_NOTE_ID)
}

/** Explicit, atomic sample installation. Opening it again never resets edits. */
export function addDemoWorkspace(workspace: Workspace): Workspace {
  const existing = workspace.notes.find(note => note.id === DEMO_NOTE_ID)
  if (existing) return openNote(workspace, existing)
  const now = Date.now()
  const library = workspace.contextLibrary ?? []
  const packages = workspace.contextPackages ?? []
  const sources: ContextSource[] = DEMO_SOURCE_FILES.map(file => ({
    id: `typenext-demo-bramble-${file.id}-v1`,
    name: file.name,
    kind: file.kind,
    text: file.text,
    folder: file.folder,
    enabled: true,
    addedAt: now,
  }))
  const additions: ContextPackage[] = [
    {
      id: DEMO_PACKAGE_IDS[0],
      name: 'Bramble House · details',
      sourceIds: sources.slice(0, 3).map(source => source.id),
      createdAt: now,
      updatedAt: now,
    },
    {
      id: DEMO_PACKAGE_IDS[1],
      name: 'Bramble House · voice',
      sourceIds: [sources[3]!.id],
      createdAt: now,
      updatedAt: now,
    },
  ].filter(context => !packages.some(item => item.id === context.id))
  // Existing demo packages may have been edited deliberately. Restore only new
  // packages and their missing source files; never repopulate an edited package.
  const needed = new Set(additions.flatMap(context => context.sourceIds))
  const missing = sources.filter(
    source =>
      needed.has(source.id) && !library.some(item => item.id === source.id)
  )
  if (workspace.notes.length >= STORAGE_LIMITS.notes)
    throw new Error(
      'The notebook is full. Remove a note before trying the sample.'
    )
  if (packages.length + additions.length > MAX_CONTEXT_PACKAGES)
    throw new Error(
      'There is no room for the sample contexts. Remove an unused context first.'
    )
  if (library.length + missing.length > MAX_CONTEXT_LIBRARY_ITEMS)
    throw new Error(
      'There is no room for the sample files. Remove an unused source first.'
    )
  const next = openNote(
    {
      ...workspace,
      contextLibrary: [...library, ...missing],
      contextPackages: [...packages, ...additions],
    },
    {
      id: DEMO_NOTE_ID,
      title: 'A morning at Bramble House',
      objective:
        'Write a warm, factual welcome note for the fictional Bramble House writing retreat.',
      context:
        'Address the guests directly in an unhurried voice. Use the attached house details and weekend plan for facts, and the welcome voice for tone.',
      content: writing.trimEnd(),
      sources: [],
      contextPackageIds: [...DEMO_PACKAGE_IDS],
      createdAt: now,
      updatedAt: now,
    }
  )
  assertWorkspaceFits(next)
  return next
}
