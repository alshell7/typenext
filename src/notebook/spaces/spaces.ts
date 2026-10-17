import type {
  ContextPackage,
  Note,
  NoteFolder,
  NoteSpace,
  NoteTag,
  OrganizeColor,
  Workspace,
} from '../../types/notebook'
import { cleanName, nextColor } from '../organize/organize'
import { SPACE_ICON_IDS, suggestIcon } from './space-icons'

/**
 * Workspaces split one notebook into separate spaces, like browser profiles.
 * Everything stays in one notebook file: notes, folders and tags carry the
 * id of their workspace, and an item without one belongs to the first
 * workspace. So an older notebook is simply one workspace, "Personal".
 *
 * A shared workspace's notes, folders and tags also appear in every other
 * workspace. A context lists the workspaces that can use it; a context with
 * no list is available everywhere.
 */

export const HOME_SPACE: NoteSpace = {
  id: 'personal',
  name: 'Personal',
  color: 'sage',
  createdAt: 0,
}

export const MAX_SPACES = 64

export function spaceList(workspace: Pick<Workspace, 'spaces'>): NoteSpace[] {
  return workspace.spaces?.length ? workspace.spaces : [HOME_SPACE]
}

export function homeSpace(workspace: Pick<Workspace, 'spaces'>): NoteSpace {
  return spaceList(workspace)[0]!
}

export function activeSpace(
  workspace: Pick<Workspace, 'spaces' | 'activeSpaceId'>
): NoteSpace {
  const spaces = spaceList(workspace)
  return (
    spaces.find(space => space.id === workspace.activeSpaceId) ?? spaces[0]!
  )
}

/** The workspace that holds an item; unknown ids belong to the first one. */
export function spaceOf(
  workspace: Pick<Workspace, 'spaces'>,
  item: { spaceId?: string }
): string {
  const spaces = spaceList(workspace)
  return item.spaceId && spaces.some(space => space.id === item.spaceId)
    ? item.spaceId
    : spaces[0]!.id
}

/** Ids of the workspaces whose items the active workspace shows. */
export function visibleSpaceIds(workspace: Workspace): Set<string> {
  const active = activeSpace(workspace).id
  return new Set(
    spaceList(workspace)
      .filter(space => space.id === active || space.shared)
      .map(space => space.id)
  )
}

export interface SpaceView {
  active: NoteSpace
  /** Notes in the active workspace and in shared ones. */
  notes: Note[]
  folders: NoteFolder[]
  tags: NoteTag[]
  packages: ContextPackage[]
  /** Workspace id of each visible note, folder and tag. */
  owner: Map<string, string>
}

/**
 * What the active workspace sees. Arrays are the stored ones when nothing is
 * filtered, so a single-workspace notebook pays nothing.
 */
export function spaceView(workspace: Workspace): SpaceView {
  const active = activeSpace(workspace)
  const spaces = spaceList(workspace)
  const owner = new Map<string, string>()
  if (spaces.length === 1)
    return {
      active,
      notes: workspace.notes,
      folders: workspace.folders ?? [],
      tags: workspace.tags ?? [],
      packages: workspace.contextPackages ?? [],
      owner,
    }
  const visible = visibleSpaceIds(workspace)
  const keep = <T extends { id: string; spaceId?: string }>(items: T[]) =>
    items.filter(item => {
      const space = spaceOf(workspace, item)
      owner.set(item.id, space)
      return visible.has(space)
    })
  return {
    active,
    notes: keep(workspace.notes),
    folders: keep(workspace.folders ?? []),
    tags: keep(workspace.tags ?? []),
    packages: (workspace.contextPackages ?? []).filter(
      context =>
        !context.spaceIds?.length || context.spaceIds.includes(active.id)
    ),
    owner,
  }
}

/** Notes, folders and tags held by one workspace. */
export function spaceCounts(workspace: Workspace) {
  const result = new Map<string, { notes: number; folders: number }>()
  for (const space of spaceList(workspace))
    result.set(space.id, { notes: 0, folders: 0 })
  for (const note of workspace.notes) {
    const entry = result.get(spaceOf(workspace, note))
    if (entry) entry.notes++
  }
  for (const folder of workspace.folders ?? []) {
    const entry = result.get(spaceOf(workspace, folder))
    if (entry) entry.folders++
  }
  return result
}

// ------------------------------------------------------------------ Changes

/** Make the implicit first workspace a stored one before changing the list. */
function stored(workspace: Workspace): NoteSpace[] {
  return workspace.spaces?.length ? workspace.spaces : [HOME_SPACE]
}

export function createSpace(
  workspace: Workspace,
  name: string,
  options: { shared?: boolean; color?: OrganizeColor; icon?: string } = {}
): { workspace: Workspace; space: NoteSpace } {
  const spaces = stored(workspace)
  if (spaces.length >= MAX_SPACES)
    throw new Error('You can keep up to 64 workspaces.')
  const base = cleanName(name, 60) || (options.shared ? 'Shared' : 'Workspace')
  const taken = new Set(spaces.map(space => space.name.toLocaleLowerCase()))
  let unique = base
  for (let index = 2; taken.has(unique.toLocaleLowerCase()); index++)
    unique = `${base} ${index}`
  const icon =
    options.icon ?? suggestIcon(base) ?? (options.shared ? 'users' : undefined)
  const space: NoteSpace = {
    id: crypto.randomUUID(),
    name: unique,
    color: options.color ?? nextColor(spaces.map(item => item.color)),
    // A name like "Work" or "Novel" suggests an icon; others show the initial.
    ...(icon ? { icon } : {}),
    ...(options.shared ? { shared: true } : {}),
    createdAt: Date.now(),
  }
  return { space, workspace: { ...workspace, spaces: [...spaces, space] } }
}

export function updateSpace(
  workspace: Workspace,
  id: string,
  patch: Partial<
    Pick<NoteSpace, 'name' | 'color' | 'shared' | 'gitFolder'> & {
      /** null shows the first letter again. */
      icon: string | null
    }
  >
): Workspace {
  return {
    ...workspace,
    spaces: stored(workspace).map(space => {
      if (space.id !== id) return space
      const next: NoteSpace = { ...space }
      if (patch.name !== undefined)
        next.name = cleanName(patch.name, 60) || space.name
      if (patch.color) next.color = patch.color
      if (patch.icon !== undefined) {
        if (patch.icon && SPACE_ICON_IDS.includes(patch.icon))
          next.icon = patch.icon
        else delete next.icon
      }
      if (patch.shared !== undefined) {
        if (patch.shared) next.shared = true
        else delete next.shared
      }
      if (patch.gitFolder !== undefined) {
        const folder = patch.gitFolder.trim()
        if (folder) next.gitFolder = folder
        else delete next.gitFolder
      }
      return next
    }),
  }
}

/**
 * Open another workspace. The tabs of the one left behind are remembered,
 * and the new one opens where the writer left it, or at its latest note.
 */
export function switchSpace(workspace: Workspace, id: string): Workspace {
  const spaces = stored(workspace)
  const current = activeSpace(workspace)
  const target = spaces.find(space => space.id === id)
  if (!target || target.id === current.id) return workspace
  const remembered = spaces.map(space =>
    space.id === current.id
      ? {
          ...space,
          openNoteIds: workspace.openNoteIds,
          activeNoteId: workspace.activeNoteId,
        }
      : space
  )
  const next: Workspace = {
    ...workspace,
    spaces: remembered,
    activeSpaceId: id,
  }
  const visible = new Set(spaceView(next).notes.map(note => note.id))
  let openNoteIds = (target.openNoteIds ?? []).filter(note => visible.has(note))
  let activeNoteId =
    target.activeNoteId && openNoteIds.includes(target.activeNoteId)
      ? target.activeNoteId
      : (openNoteIds[0] ?? null)
  if (!openNoteIds.length) {
    // A workspace opened for the first time shows its latest note.
    const latest = workspace.notes
      .filter(note => spaceOf(next, note) === id)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    openNoteIds = latest ? [latest.id] : []
    activeNoteId = latest?.id ?? null
  }
  return { ...next, openNoteIds, activeNoteId }
}

/** Put notes, folders (with what is inside them) or tags in a workspace. */
export function moveToSpace(
  workspace: Workspace,
  items: { notes?: string[]; folders?: string[] },
  spaceId: string
): Workspace {
  if (!stored(workspace).some(space => space.id === spaceId)) return workspace
  const folderIds = new Set(items.folders ?? [])
  // A folder brings its subfolders and notes.
  for (let grew = true; grew;) {
    grew = false
    for (const folder of workspace.folders ?? [])
      if (
        folder.parentId &&
        folderIds.has(folder.parentId) &&
        !folderIds.has(folder.id)
      ) {
        folderIds.add(folder.id)
        grew = true
      }
  }
  const noteIds = new Set(items.notes ?? [])
  const place = <T extends { spaceId?: string }>(item: T): T => ({
    ...item,
    spaceId,
  })
  return {
    ...workspace,
    spaces: stored(workspace),
    folders: (workspace.folders ?? []).map(folder => {
      if (!folderIds.has(folder.id)) return folder
      const moved = place(folder)
      // The top moved folder leaves a parent in another workspace.
      if (
        !items.folders?.includes(folder.id) ||
        !folder.parentId ||
        folderIds.has(folder.parentId)
      )
        return moved
      const { parentId: _old, ...rest } = moved
      void _old
      return rest
    }),
    notes: workspace.notes.map(note => {
      if (noteIds.has(note.id)) {
        const moved = place(note)
        // A single note leaves its folder behind.
        if (!note.folderId || folderIds.has(note.folderId)) return moved
        const { folderId: _old, ...rest } = moved
        void _old
        return rest
      }
      return note.folderId && folderIds.has(note.folderId) ? place(note) : note
    }),
  }
}

/**
 * Remove a workspace. Its notes, folders and tags move to another one, or
 * are deleted with it when `moveTo` is null. The last workspace stays.
 */
export function deleteSpace(
  workspace: Workspace,
  id: string,
  moveTo: string | null
): Workspace {
  const spaces = stored(workspace)
  if (spaces.length <= 1 || !spaces.some(space => space.id === id))
    return workspace
  const rest = spaces.filter(space => space.id !== id)
  const target =
    moveTo && rest.some(space => space.id === moveTo) ? moveTo : null
  const owned = <T extends { spaceId?: string }>(item: T) =>
    spaceOf(workspace, item) === id
  const relocate = <T extends { spaceId?: string }>(items: T[]) =>
    target
      ? items.map(item => (owned(item) ? { ...item, spaceId: target } : item))
      : items.filter(item => !owned(item))
  // Items of the first workspace may hold no id. Make the new first explicit.
  const pin = <T extends { spaceId?: string }>(items: T[]) =>
    items.map(item =>
      item.spaceId ? item : { ...item, spaceId: spaceOf(workspace, item) }
    )
  const notes = relocate(pin(workspace.notes))
  const ids = new Set(notes.map(note => note.id))
  const openNoteIds = workspace.openNoteIds.filter(note => ids.has(note))
  const next: Workspace = {
    ...workspace,
    spaces: rest,
    activeSpaceId:
      workspace.activeSpaceId === id || !workspace.activeSpaceId
        ? (target ?? rest[0]!.id)
        : workspace.activeSpaceId,
    notes,
    folders: relocate(pin(workspace.folders ?? [])),
    tags: relocate(pin(workspace.tags ?? [])),
    contextPackages: workspace.contextPackages?.map(context =>
      context.spaceIds?.includes(id)
        ? {
            ...context,
            spaceIds: [
              ...new Set(
                context.spaceIds
                  .filter(space => space !== id)
                  .concat(target ? [target] : [])
              ),
            ],
          }
        : context
    ),
    openNoteIds,
    activeNoteId:
      workspace.activeNoteId && ids.has(workspace.activeNoteId)
        ? workspace.activeNoteId
        : (openNoteIds[0] ?? null),
  }
  // Leaving a deleted workspace: open the new one at its latest note.
  if (activeSpace(workspace).id === id && !next.openNoteIds.length) {
    const latest = notes
      .filter(note => spaceOf(next, note) === next.activeSpaceId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    return {
      ...next,
      openNoteIds: latest ? [latest.id] : [],
      activeNoteId: latest?.id ?? null,
    }
  }
  return next
}

/** Choose the workspaces a context is available in. Empty: everywhere. */
export function setContextSpaces(
  workspace: Workspace,
  contextId: string,
  spaceIds: string[]
): Workspace {
  const known = new Set(stored(workspace).map(space => space.id))
  const ids = [...new Set(spaceIds.filter(id => known.has(id)))]
  return {
    ...workspace,
    contextPackages: workspace.contextPackages?.map(context => {
      if (context.id !== contextId) return context
      const { spaceIds: _old, ...rest } = context
      void _old
      return ids.length && ids.length < known.size
        ? { ...rest, spaceIds: ids }
        : rest
    }),
  }
}

/** The Git folder that holds a workspace's notes, if any. */
export function spaceGitFolder(workspace: Workspace, space: NoteSpace): string {
  if (space.gitFolder?.trim()) return space.gitFolder.trim()
  return space.id === homeSpace(workspace).id
    ? workspace.settings.git.folder.trim()
    : ''
}
