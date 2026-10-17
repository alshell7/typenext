import type {
  Note,
  NoteFolder,
  NoteTag,
  OrganizeColor,
  Workspace,
} from '../../types/notebook'

/**
 * Folders and tags. Folders form a tree; a note sits in one folder or at the
 * top level. Tags are named and coloured once, and a note holds tag ids, so a
 * rename reaches every note at once. Organising never changes when a note
 * was last edited.
 */

export const ORGANIZE_COLORS: readonly { id: OrganizeColor; name: string }[] = [
  { id: 'sage', name: 'Sage' },
  { id: 'sky', name: 'Sky' },
  { id: 'iris', name: 'Iris' },
  { id: 'plum', name: 'Plum' },
  { id: 'rose', name: 'Rose' },
  { id: 'amber', name: 'Amber' },
  { id: 'sand', name: 'Sand' },
  { id: 'slate', name: 'Slate' },
]

export const MAX_FOLDERS = 4096
export const MAX_TAGS = 4096
export const MAX_TAGS_PER_NOTE = 64

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function byName<T extends { name: string }>(left: T, right: T) {
  return collator.compare(left.name, right.name)
}

export function cleanName(name: string, limit = 120): string {
  return name.replace(/\s+/gu, ' ').trim().slice(0, limit)
}

/** “#Draft  notes ” → “Draft notes”. */
export function cleanTagName(name: string): string {
  return cleanName(name.trim().replace(/^#+\s*/u, ''), 48)
}

export function tagKey(name: string) {
  return cleanTagName(name).toLocaleLowerCase()
}

/** The next colour nobody uses yet, or the least used one. */
export function nextColor(used: readonly (OrganizeColor | undefined)[]) {
  const counts = new Map(ORGANIZE_COLORS.map(color => [color.id, 0]))
  for (const color of used)
    if (color) counts.set(color, (counts.get(color) ?? 0) + 1)
  let best = ORGANIZE_COLORS[0]!.id
  for (const color of ORGANIZE_COLORS)
    if ((counts.get(color.id) ?? 0) < (counts.get(best) ?? 0)) best = color.id
  return best
}

// ------------------------------------------------------------------ Folders

export function folderList(workspace: Workspace): NoteFolder[] {
  return workspace.folders ?? []
}

export function childFolders(
  folders: readonly NoteFolder[],
  parentId: string | undefined
): NoteFolder[] {
  return folders.filter(folder => folder.parentId === parentId).sort(byName)
}

/** The folder and every folder inside it. */
export function folderAndDescendants(
  folders: readonly NoteFolder[],
  id: string
): Set<string> {
  const found = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const folder of folders)
      if (
        folder.parentId &&
        found.has(folder.parentId) &&
        !found.has(folder.id)
      ) {
        found.add(folder.id)
        grew = true
      }
  }
  return found
}

/** From the top level down to the folder itself. */
export function folderPath(
  folders: readonly NoteFolder[],
  id: string | undefined
): NoteFolder[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const path: NoteFolder[] = []
  const seen = new Set<string>()
  for (let current = id ? byId.get(id) : undefined; current;) {
    if (seen.has(current.id)) break
    seen.add(current.id)
    path.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

export function folderDepth(folders: readonly NoteFolder[], id: string) {
  return folderPath(folders, id).length - 1
}

/** A name not yet used beside it: “New folder”, “New folder 2” … */
export function uniqueFolderName(
  folders: readonly NoteFolder[],
  parentId: string | undefined,
  base = 'New folder'
) {
  const names = new Set(
    childFolders(folders, parentId).map(folder =>
      folder.name.toLocaleLowerCase()
    )
  )
  if (!names.has(base.toLocaleLowerCase())) return base
  for (let index = 2; ; index++) {
    const name = `${base} ${index}`
    if (!names.has(name.toLocaleLowerCase())) return name
  }
}

export function createFolder(
  workspace: Workspace,
  name: string,
  parentId?: string,
  /** The workspace of a new top-level folder. A subfolder follows its parent. */
  spaceId?: string
): { workspace: Workspace; folder: NoteFolder } {
  const folders = folderList(workspace)
  if (folders.length >= MAX_FOLDERS)
    throw new Error('You can keep up to 4,096 folders.')
  const parentFolder = parentId
    ? folders.find(folder => folder.id === parentId)
    : undefined
  const parent = Boolean(parentFolder)
  const space = parentFolder ? parentFolder.spaceId : spaceId
  const folder: NoteFolder = {
    id: crypto.randomUUID(),
    name: cleanName(name) || uniqueFolderName(folders, parentId),
    ...(parent ? { parentId } : {}),
    ...(space ? { spaceId: space } : {}),
    color: nextColor(folders.map(item => item.color)),
    createdAt: Date.now(),
  }
  return {
    folder,
    workspace: {
      ...workspace,
      folders: [
        // A new folder opens its parent so it can be seen.
        ...folders.map(item =>
          item.id === parentId && item.collapsed
            ? { ...item, collapsed: undefined }
            : item
        ),
        folder,
      ],
    },
  }
}

function changeFolder(
  workspace: Workspace,
  id: string,
  change: (folder: NoteFolder) => NoteFolder
): Workspace {
  return {
    ...workspace,
    folders: folderList(workspace).map(folder =>
      folder.id === id ? change(folder) : folder
    ),
  }
}

export function renameFolder(workspace: Workspace, id: string, name: string) {
  const clean = cleanName(name)
  if (!clean) return workspace
  return changeFolder(workspace, id, folder => ({ ...folder, name: clean }))
}

export function setFolderColor(
  workspace: Workspace,
  id: string,
  color: OrganizeColor
) {
  return changeFolder(workspace, id, folder => ({ ...folder, color }))
}

export function setFolderCollapsed(
  workspace: Workspace,
  id: string,
  collapsed: boolean
) {
  return changeFolder(workspace, id, folder => {
    const { collapsed: _old, ...rest } = folder
    void _old
    return collapsed ? { ...rest, collapsed: true } : rest
  })
}

export function canMoveFolder(
  folders: readonly NoteFolder[],
  id: string,
  parentId: string | undefined
) {
  if (!parentId) return true
  return !folderAndDescendants(folders, id).has(parentId)
}

export function moveFolder(
  workspace: Workspace,
  id: string,
  parentId: string | undefined
): Workspace {
  if (!canMoveFolder(folderList(workspace), id, parentId)) return workspace
  return changeFolder(workspace, id, folder => {
    const { parentId: _old, ...rest } = folder
    void _old
    return parentId ? { ...rest, parentId } : rest
  })
}

/**
 * Remove a folder. Its notes and folders move up to its parent; nothing is
 * deleted with it.
 */
export function deleteFolder(workspace: Workspace, id: string): Workspace {
  const folders = folderList(workspace)
  const target = folders.find(folder => folder.id === id)
  if (!target) return workspace
  const parentId = target.parentId
  const place = <T extends { parentId?: string; folderId?: string }>(
    item: T,
    key: 'parentId' | 'folderId'
  ): T => {
    if (item[key] !== id) return item
    const next = { ...item }
    if (parentId) next[key] = parentId
    else delete next[key]
    return next
  }
  return {
    ...workspace,
    folders: folders
      .filter(folder => folder.id !== id)
      .map(folder => place(folder, 'parentId')),
    notes: workspace.notes.map(note => {
      const placed = place(note, 'folderId')
      if (!placed.contextFolderIds?.includes(id)) return placed
      const kept = placed.contextFolderIds.filter(folder => folder !== id)
      const { contextFolderIds: _old, ...rest } = placed
      void _old
      return kept.length ? { ...rest, contextFolderIds: kept } : rest
    }),
  }
}

export function moveNotes(
  workspace: Workspace,
  ids: readonly string[],
  folderId: string | undefined
): Workspace {
  const wanted = new Set(ids)
  const valid =
    !folderId || folderList(workspace).some(folder => folder.id === folderId)
  if (!valid) return workspace
  return {
    ...workspace,
    notes: workspace.notes.map(note => {
      if (!wanted.has(note.id) || note.folderId === folderId) return note
      const { folderId: _old, ...rest } = note
      void _old
      return folderId ? { ...rest, folderId } : rest
    }),
  }
}

// ------------------------------------------------------------------ Tags

export function tagList(workspace: Workspace): NoteTag[] {
  return workspace.tags ?? []
}

export function findTag(tags: readonly NoteTag[], name: string) {
  const key = tagKey(name)
  return tags.find(tag => tag.name.toLocaleLowerCase() === key)
}

/** The tag with this name, created when it does not exist yet. */
export function ensureTag(
  workspace: Workspace,
  name: string,
  color?: OrganizeColor,
  /** With workspaces: only tags the writer can see are reused. */
  scope?: { spaceId?: string; visible?(tag: NoteTag): boolean }
): { workspace: Workspace; tag: NoteTag } {
  const tags = tagList(workspace)
  const clean = cleanTagName(name)
  if (!clean) throw new Error('Give the tag a name.')
  const existing = findTag(
    scope?.visible ? tags.filter(scope.visible) : tags,
    clean
  )
  if (existing) return { workspace, tag: existing }
  if (tags.length >= MAX_TAGS) throw new Error('You can keep up to 4,096 tags.')
  const tag: NoteTag = {
    id: crypto.randomUUID(),
    name: clean,
    color: color ?? nextColor(tags.map(item => item.color)),
    createdAt: Date.now(),
    ...(scope?.spaceId ? { spaceId: scope.spaceId } : {}),
  }
  return { tag, workspace: { ...workspace, tags: [...tags, tag] } }
}

export function renameTag(
  workspace: Workspace,
  id: string,
  name: string
): Workspace {
  const clean = cleanTagName(name)
  if (!clean) return workspace
  const clash = findTag(tagList(workspace), clean)
  // Renaming onto another tag merges the two.
  if (clash && clash.id !== id) return mergeTags(workspace, id, clash.id)
  return {
    ...workspace,
    tags: tagList(workspace).map(tag =>
      tag.id === id ? { ...tag, name: clean } : tag
    ),
  }
}

export function setTagColor(
  workspace: Workspace,
  id: string,
  color: OrganizeColor
): Workspace {
  return {
    ...workspace,
    tags: tagList(workspace).map(tag =>
      tag.id === id ? { ...tag, color } : tag
    ),
  }
}

function withTags(note: Note, tags: string[]): Note {
  const { tags: _old, ...rest } = note
  void _old
  return tags.length ? { ...rest, tags } : rest
}

/** Move every use of one tag to another, then remove the first. */
export function mergeTags(
  workspace: Workspace,
  fromId: string,
  intoId: string
): Workspace {
  if (fromId === intoId) return workspace
  return {
    ...workspace,
    tags: tagList(workspace).filter(tag => tag.id !== fromId),
    notes: workspace.notes.map(note =>
      note.tags?.includes(fromId)
        ? withTags(note, [
            ...new Set(note.tags.map(tag => (tag === fromId ? intoId : tag))),
          ])
        : note
    ),
  }
}

export function deleteTag(workspace: Workspace, id: string): Workspace {
  return {
    ...workspace,
    tags: tagList(workspace).filter(tag => tag.id !== id),
    notes: workspace.notes.map(note =>
      note.tags?.includes(id)
        ? withTags(
            note,
            note.tags.filter(tag => tag !== id)
          )
        : note
    ),
  }
}

export function setNoteTag(
  workspace: Workspace,
  noteId: string,
  tagId: string,
  on: boolean
): Workspace {
  return {
    ...workspace,
    notes: workspace.notes.map(note => {
      if (note.id !== noteId) return note
      const tags = note.tags ?? []
      if (on === tags.includes(tagId)) return note
      if (on && tags.length >= MAX_TAGS_PER_NOTE)
        throw new Error('A note can have up to 64 tags.')
      return withTags(
        note,
        on ? [...tags, tagId] : tags.filter(tag => tag !== tagId)
      )
    }),
  }
}

// ------------------------------------------------------------------ Counts

export interface Counts {
  /** Notes in each folder, including its subfolders. */
  folders: Map<string, number>
  tags: Map<string, number>
}

export function counts(workspace: Workspace): Counts {
  const folders = folderList(workspace)
  const parent = new Map(folders.map(folder => [folder.id, folder.parentId]))
  const folderCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  for (const note of workspace.notes) {
    const seen = new Set<string>()
    for (let id = note.folderId; id && !seen.has(id); id = parent.get(id)) {
      seen.add(id)
      folderCounts.set(id, (folderCounts.get(id) ?? 0) + 1)
    }
    for (const tag of note.tags ?? [])
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  return { folders: folderCounts, tags: tagCounts }
}
