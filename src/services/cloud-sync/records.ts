import type {
  CloudSyncInclude,
  ContextPackage,
  ContextSource,
  Note,
  NoteFolder,
  NoteSpace,
  NoteTag,
  NotebookSettings,
  Workspace,
} from '../../types/notebook'
import { closeNote, defaultSettings } from '../../notebook/model'
import { activeSpace, spaceList, spaceOf } from '../../notebook/spaces/spaces'
import { syncParsers } from '../storage'
import { textHash } from '../vector-store'
import {
  mergeFields,
  mergeIds,
  mergeText,
  sameValue,
  stableJson,
} from './merge'

/**
 * The notebook as sync records: one per note, folder, tag, workspace,
 * context source, context and synced preference. What is true only on one
 * device stays out of the records: file paths, Git folders, open tabs,
 * collapsed folders, local model servers and this sync setup itself. Each
 * device publishes its own file paths in a separate record, so another
 * device can offer to map them to its own folders.
 */

export type RecordKind =
  | 'space'
  | 'layout'
  | 'folder'
  | 'tag'
  | 'source'
  | 'package'
  | 'setting'
  | 'note'
  | 'links'

/** Containers travel before what they contain. */
export const KIND_ORDER: RecordKind[] = [
  'space',
  'layout',
  'folder',
  'tag',
  'source',
  'package',
  'setting',
  'note',
  'links',
]

/** Preferences that follow the writer. The rest belong to one device. */
export const SYNCED_SETTINGS = [
  'theme',
  'palette',
  'fontFamily',
  'fontSize',
  'autoSave',
  'suggestionsEnabled',
  'autoSuggest',
  'temperature',
  'suggestionDelay',
  'maxTokens',
  'suggestionLength',
  'suggestionWords',
  'externalAutoEnabled',
  'suggestionInstructions',
  'provider',
  'externalProvider',
  'profiles',
  'websiteImporter',
  'webFacts',
  'zenLevel',
  'editor',
  'timing',
  'ai',
  'shortcuts',
  'revisions',
  'dictation',
] as const satisfies readonly (keyof NotebookSettings)[]

type SyncedSetting = (typeof SYNCED_SETTINGS)[number]

export interface SyncScope {
  include: CloudSyncInclude
  /** Empty: every workspace. */
  spaceIds: string[]
}

export interface LocalItem {
  kind: RecordKind
  itemId: string
  value: unknown
  /** In the writer's chosen selection. Items outside it are neither sent nor deleted. */
  inScope: boolean
}

/** Paths that exist only on the device that published them. */
export interface DeviceLinks {
  name: string
  notes: Record<string, string>
  spaces: Record<string, string>
  git?: string
}

export function itemKey(kind: RecordKind, itemId: string) {
  return `${kind}:${itemId}`
}

// ------------------------------------------------------------------ Values

function noteValue(workspace: Workspace, note: Note) {
  const { filePath: _path, exportedAt: _exported, ...rest } = note
  void _path
  void _exported
  return { ...rest, spaceId: explicitSpace(workspace, note) }
}

/**
 * Items without a workspace belong to the first one here; say so
 * explicitly, since another device may order its workspaces differently.
 * An id this device does not know (a workspace outside its selection)
 * stays as it is.
 */
function explicitSpace(workspace: Workspace, item: { spaceId?: string }) {
  return item.spaceId || spaceOf(workspace, item)
}

function folderValue(workspace: Workspace, folder: NoteFolder) {
  const { collapsed: _collapsed, ...rest } = folder
  void _collapsed
  return { ...rest, spaceId: explicitSpace(workspace, folder) }
}

function tagValue(workspace: Workspace, tag: NoteTag) {
  return { ...tag, spaceId: explicitSpace(workspace, tag) }
}

function spaceValue(space: NoteSpace) {
  const {
    gitFolder: _git,
    openNoteIds: _open,
    activeNoteId: _active,
    ...rest
  } = space
  void _git
  void _open
  void _active
  return rest
}

function settingValue(settings: NotebookSettings, key: SyncedSetting) {
  if (key === 'profiles') {
    const { local: _local, ...rest } = settings.profiles
    void _local
    return rest
  }
  return settings[key]
}

const built = new WeakMap<object, { value: unknown; spaces: unknown }>()
const hashes = new WeakMap<object, string>()

/** The hash of a value's canonical JSON. */
export function valueHash(value: unknown): string {
  return textHash(stableJson(value))
}

/**
 * Unchanged notebook objects keep their identity between edits, so their
 * record values and hashes come from these caches.
 */
function cached(source: object, build: () => unknown, spaces?: unknown) {
  const hit = built.get(source)
  // A note's workspace can depend on the workspace list.
  if (hit && hit.spaces === spaces) return hit.value
  const value = build()
  built.set(source, { value, spaces })
  return value
}

function remember(value: unknown) {
  if (value && typeof value === 'object' && !hashes.has(value))
    hashes.set(value, valueHash(value))
  return value
}

/** Hash of a value made by snapshot(), cached when possible. */
export function itemHash(value: unknown): string {
  const known =
    value && typeof value === 'object' ? hashes.get(value) : undefined
  return known ?? valueHash(value)
}

// ---------------------------------------------------------------- Snapshot

/** Every syncable item of the notebook, keyed by kind and id. */
export function snapshot(
  workspace: Workspace,
  scope: SyncScope,
  device: { id: string; name: string }
): Map<string, LocalItem> {
  const items = new Map<string, LocalItem>()
  const selected = (space: string) =>
    !scope.spaceIds.length || scope.spaceIds.includes(space)
  const add = (
    kind: RecordKind,
    itemId: string,
    value: unknown,
    inScope: boolean
  ) =>
    items.set(itemKey(kind, itemId), {
      kind,
      itemId,
      value: remember(value),
      inScope,
    })
  const spaces = spaceList(workspace)
  for (const space of spaces)
    add(
      'space',
      space.id,
      cached(space, () => spaceValue(space)),
      scope.include.organize && selected(space.id)
    )
  add(
    'layout',
    'spaces',
    spaces.map(space => space.id),
    scope.include.organize && !scope.spaceIds.length
  )
  for (const folder of workspace.folders ?? [])
    add(
      'folder',
      folder.id,
      cached(folder, () => folderValue(workspace, folder), workspace.spaces),
      scope.include.organize && selected(spaceOf(workspace, folder))
    )
  for (const tag of workspace.tags ?? [])
    add(
      'tag',
      tag.id,
      cached(tag, () => tagValue(workspace, tag), workspace.spaces),
      scope.include.organize && selected(spaceOf(workspace, tag))
    )
  for (const source of workspace.contextLibrary ?? [])
    add('source', source.id, source, scope.include.contexts)
  for (const context of workspace.contextPackages ?? [])
    add('package', context.id, context, scope.include.contexts)
  for (const key of SYNCED_SETTINGS) {
    const value = workspace.settings[key]
    add(
      'setting',
      key,
      value && typeof value === 'object'
        ? cached(
            value,
            () => settingValue(workspace.settings, key),
            workspace.settings.profiles.local
          )
        : value,
      scope.include.settings
    )
  }
  const links: DeviceLinks = { name: device.name, notes: {}, spaces: {} }
  for (const note of workspace.notes) {
    const space = spaceOf(workspace, note)
    add(
      'note',
      note.id,
      cached(note, () => noteValue(workspace, note), workspace.spaces),
      scope.include.notes && selected(space)
    )
    if (note.filePath && scope.include.notes && selected(space))
      links.notes[note.id] = note.filePath
  }
  for (const space of spaces)
    if (space.gitFolder) links.spaces[space.id] = space.gitFolder
  if (workspace.settings.git.folder) links.git = workspace.settings.git.folder
  add('links', device.id, links, true)
  return items
}

// ------------------------------------------------------------------- Apply

export interface Base {
  rev: number
  hash: string
  deleted: boolean
  value?: unknown
}

export interface IncomingChange {
  kind: RecordKind
  itemId: string
  deleted: boolean
  value?: unknown
  /** The device that wrote it, and when (its clock). */
  device: string
  time: number
  base?: Base
}

export type Outcome =
  | 'applied'
  | 'merged'
  | 'kept-local'
  | 'conflict-copy'
  | 'unchanged'
  | 'skipped'

export interface ApplyResult {
  workspace: Workspace
  outcomes: {
    kind: RecordKind
    itemId: string
    outcome: Outcome
    copyId?: string
    /** The other device's version as read here: the next merge base. */
    value?: unknown
  }[]
}

export interface ApplyContext {
  /** When this device last changed the item, if it has unsent changes. */
  localTime(kind: RecordKind, itemId: string): number | undefined
  deviceName(device: string): string
  now: number
  newId(): string
}

function pathMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 10_000) return null
  const result: Record<string, string> = {}
  for (const [id, path] of entries) {
    if (typeof path !== 'string' || !path || path.length > 32_768) return null
    result[id.slice(0, 256)] = path
  }
  return result
}

function parseLinks(value: unknown): DeviceLinks | null {
  if (!value || typeof value !== 'object') return null
  const links = value as Record<string, unknown>
  const notes = pathMap(links.notes)
  const spaces = pathMap(links.spaces)
  if (typeof links.name !== 'string' || !notes || !spaces) return null
  return {
    name: links.name.slice(0, 128),
    notes,
    spaces,
    ...(typeof links.git === 'string' && links.git
      ? { git: links.git.slice(0, 32_768) }
      : {}),
  }
}

/** Validate an item from another device; null when this version cannot read it. */
export function parseIncoming(
  kind: RecordKind,
  itemId: string,
  value: unknown,
  settings: NotebookSettings
): unknown {
  try {
    switch (kind) {
      case 'note': {
        const note = syncParsers.note(value)
        return note.id === itemId ? note : null
      }
      case 'folder': {
        const folder = syncParsers.folder(value)
        return folder.id === itemId ? folder : null
      }
      case 'tag': {
        const tag = syncParsers.tag(value)
        return tag.id === itemId ? tag : null
      }
      case 'space': {
        const space = syncParsers.space(value)
        return space.id === itemId ? space : null
      }
      case 'source': {
        const source = syncParsers.source(value)
        return source.id === itemId ? source : null
      }
      case 'package': {
        const context = syncParsers.contextPackage(value)
        return context.id === itemId ? context : null
      }
      case 'layout':
        return Array.isArray(value) &&
          value.length <= 64 &&
          value.every(item => typeof item === 'string')
          ? value
          : null
      case 'setting': {
        if (!(SYNCED_SETTINGS as readonly string[]).includes(itemId))
          return null
        const key = itemId as SyncedSetting
        const incoming =
          key === 'profiles'
            ? { ...(value as object), local: settings.profiles.local }
            : value
        const parsed = syncParsers.settings({
          ...defaultSettings(),
          ...settings,
          [key]: incoming,
        })
        return settingValue(parsed, key)
      }
      case 'links':
        return parseLinks(value)
    }
  } catch {
    return null
  }
}

function currentValue(
  workspace: Workspace,
  kind: RecordKind,
  itemId: string
): unknown {
  switch (kind) {
    case 'note': {
      const note = workspace.notes.find(item => item.id === itemId)
      return note && noteValue(workspace, note)
    }
    case 'folder': {
      const folder = workspace.folders?.find(item => item.id === itemId)
      return folder && folderValue(workspace, folder)
    }
    case 'tag': {
      const tag = workspace.tags?.find(item => item.id === itemId)
      return tag && tagValue(workspace, tag)
    }
    case 'space': {
      const space = spaceList(workspace).find(item => item.id === itemId)
      return space && spaceValue(space)
    }
    case 'layout':
      return spaceList(workspace).map(space => space.id)
    case 'source':
      return workspace.contextLibrary?.find(item => item.id === itemId)
    case 'package':
      return workspace.contextPackages?.find(item => item.id === itemId)
    case 'setting':
      return (SYNCED_SETTINGS as readonly string[]).includes(itemId)
        ? settingValue(workspace.settings, itemId as SyncedSetting)
        : undefined
    case 'links':
      return undefined
  }
}

function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] {
  const items = list ?? []
  const index = items.findIndex(entry => entry.id === item.id)
  if (index < 0) return [...items, item]
  const next = items.slice()
  next[index] = item
  return next
}

function remove<T extends { id: string }>(
  list: T[] | undefined,
  id: string
): T[] {
  return (list ?? []).filter(entry => entry.id !== id)
}

/** Put one item into the notebook, keeping what belongs to this device. */
function write(
  workspace: Workspace,
  kind: RecordKind,
  itemId: string,
  value: unknown | undefined
): Workspace {
  switch (kind) {
    case 'note': {
      if (value === undefined) {
        const closed = closeNote(workspace, itemId)
        return {
          ...closed,
          notes: remove(closed.notes, itemId),
          spaces: closed.spaces?.map(space =>
            space.openNoteIds?.includes(itemId) || space.activeNoteId === itemId
              ? {
                  ...space,
                  openNoteIds: space.openNoteIds?.filter(id => id !== itemId),
                  activeNoteId:
                    space.activeNoteId === itemId ? null : space.activeNoteId,
                }
              : space
          ),
        }
      }
      const incoming = value as Note
      const local = workspace.notes.find(note => note.id === itemId)
      const note: Note = {
        ...incoming,
        ...(local?.filePath ? { filePath: local.filePath } : {}),
        ...(local?.exportedAt !== undefined
          ? { exportedAt: local.exportedAt }
          : {}),
      }
      return { ...workspace, notes: upsert(workspace.notes, note) }
    }
    case 'folder': {
      if (value === undefined)
        return { ...workspace, folders: remove(workspace.folders, itemId) }
      const local = workspace.folders?.find(folder => folder.id === itemId)
      const folder = {
        ...(value as NoteFolder),
        ...(local?.collapsed ? { collapsed: true } : {}),
      }
      return { ...workspace, folders: upsert(workspace.folders, folder) }
    }
    case 'tag':
      return {
        ...workspace,
        tags:
          value === undefined
            ? remove(workspace.tags, itemId)
            : upsert(workspace.tags, value as NoteTag),
      }
    case 'space': {
      const spaces = workspace.spaces?.length
        ? workspace.spaces
        : spaceList(workspace)
      if (value === undefined) {
        const rest = remove(spaces, itemId)
        // The last workspace always stays.
        if (!rest.length) return workspace
        return {
          ...workspace,
          spaces: rest,
          activeSpaceId:
            activeSpace(workspace).id === itemId
              ? rest[0]!.id
              : workspace.activeSpaceId,
        }
      }
      const local = spaces.find(space => space.id === itemId)
      const space: NoteSpace = {
        ...(value as NoteSpace),
        ...(local?.gitFolder ? { gitFolder: local.gitFolder } : {}),
        ...(local?.openNoteIds ? { openNoteIds: local.openNoteIds } : {}),
        ...(local?.activeNoteId !== undefined
          ? { activeNoteId: local.activeNoteId }
          : {}),
      }
      return { ...workspace, spaces: upsert(spaces, space) }
    }
    case 'layout': {
      if (!Array.isArray(value) || !workspace.spaces?.length) return workspace
      const order = value as string[]
      const position = (id: string) => {
        const index = order.indexOf(id)
        return index < 0 ? order.length : index
      }
      const spaces = workspace.spaces
        .map((space, index) => ({ space, index }))
        .sort(
          (a, b) =>
            position(a.space.id) - position(b.space.id) || a.index - b.index
        )
        .map(entry => entry.space)
      return { ...workspace, spaces }
    }
    case 'source':
      return {
        ...workspace,
        contextLibrary:
          value === undefined
            ? remove(workspace.contextLibrary, itemId)
            : upsert(workspace.contextLibrary, value as ContextSource),
      }
    case 'package':
      return {
        ...workspace,
        contextPackages:
          value === undefined
            ? remove(workspace.contextPackages, itemId)
            : upsert(workspace.contextPackages, value as ContextPackage),
      }
    case 'setting': {
      if (value === undefined) return workspace
      const key = itemId as SyncedSetting
      const next =
        key === 'profiles'
          ? { ...(value as object), local: workspace.settings.profiles.local }
          : value
      return { ...workspace, settings: { ...workspace.settings, [key]: next } }
    }
    case 'links':
      return workspace
  }
}

/** A copy of the other device's text, beside the note, when both changed the same words. */
function conflictCopy(
  remote: Note,
  deviceName: string,
  context: ApplyContext
): Note {
  const title = `${remote.title || 'Untitled'} (${deviceName})`
  const { autoTitle: _auto, ...rest } = remote
  void _auto
  return {
    ...rest,
    id: context.newId(),
    title,
    createdAt: context.now,
    updatedAt: context.now,
  }
}

function mergeNote(
  base: Note | undefined,
  local: Note,
  remote: Note
): { note: Note; conflicts: number } {
  const newer = remote.updatedAt > local.updatedAt ? 'remote' : 'local'
  let content: string
  let conflicts = 0
  if (base) {
    const merged = mergeText(base.content, local.content, remote.content)
    content = merged.text
    conflicts = merged.conflicts
  } else {
    // No common version: keep the newer text, and the other as a copy.
    content = newer === 'remote' ? remote.content : local.content
    conflicts = local.content === remote.content ? 0 : 1
  }
  const fields = mergeFields(
    base as unknown as Record<string, unknown> | undefined,
    local as unknown as Record<string, unknown>,
    remote as unknown as Record<string, unknown>,
    newer,
    0
  ) as unknown as Note
  const tags = mergeIds(base?.tags, local.tags, remote.tags)
  const contextFolderIds = mergeIds(
    base?.contextFolderIds,
    local.contextFolderIds,
    remote.contextFolderIds
  )
  const { tags: _tags, contextFolderIds: _folders, ...rest } = fields
  void _tags
  void _folders
  return {
    note: {
      ...rest,
      content,
      ...(tags.length ? { tags } : {}),
      ...(contextFolderIds.length ? { contextFolderIds } : {}),
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    },
    conflicts,
  }
}

/**
 * Apply changes from another device. A change to an item this device has
 * not touched since its last sync replaces it. Otherwise the two versions
 * merge: notes word by word, everything else field by field. Edits always
 * win over deletions. Nothing written here is ever lost: when both devices
 * changed the same words, the other device's note becomes a copy beside it.
 */
export function applyChanges(
  workspace: Workspace,
  changes: IncomingChange[],
  context: ApplyContext
): ApplyResult {
  const outcomes: ApplyResult['outcomes'] = []
  let next = workspace
  const ordered = changes
    .slice()
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  for (const change of ordered) {
    const { kind, itemId } = change
    let parsed: unknown
    const record = (outcome: Outcome, copyId?: string) =>
      outcomes.push({
        kind,
        itemId,
        outcome,
        ...(copyId ? { copyId } : {}),
        ...(parsed !== undefined ? { value: parsed } : {}),
      })
    if (kind === 'links') {
      parsed = change.deleted
        ? undefined
        : (parseIncoming(kind, itemId, change.value, next.settings) ??
          undefined)
      record(parsed === undefined && !change.deleted ? 'skipped' : 'applied')
      continue
    }
    const local = currentValue(next, kind, itemId)
    const localHash = local === undefined ? null : valueHash(local)
    const base = change.base
    const baseHash = base && !base.deleted ? base.hash : null
    const localChanged = base ? localHash !== baseHash : local !== undefined
    if (change.deleted) {
      if (local === undefined) record('unchanged')
      else if (!localChanged) {
        next = write(next, kind, itemId, undefined)
        record('applied')
      } else record('kept-local')
      continue
    }
    const incoming = parseIncoming(kind, itemId, change.value, next.settings)
    if (incoming === null) {
      record('skipped')
      continue
    }
    parsed = incoming
    if (local === undefined || !localChanged) {
      if (local !== undefined && sameValue(local, incoming)) record('unchanged')
      else {
        next = write(next, kind, itemId, incoming)
        record('applied')
      }
      continue
    }
    if (sameValue(local, incoming)) {
      record('unchanged')
      continue
    }
    if (kind === 'note') {
      const remote = incoming as Note
      const merged = mergeNote(
        base?.deleted ? undefined : (base?.value as Note | undefined),
        local as Note,
        remote
      )
      next = write(next, kind, itemId, merged.note)
      if (merged.conflicts) {
        const copy = conflictCopy(
          base
            ? remote
            : remote.updatedAt > (local as Note).updatedAt
              ? (local as Note)
              : remote,
          context.deviceName(change.device),
          context
        )
        next = write(next, 'note', copy.id, copy)
        record('conflict-copy', copy.id)
      } else record('merged')
      continue
    }
    if (kind === 'layout') {
      const order = mergeIds(
        base?.value as string[] | undefined,
        local as string[],
        incoming as string[]
      )
      next = write(next, kind, itemId, order)
      record('merged')
      continue
    }
    // Field by field; where both changed one field, the later change wins.
    const localTime = context.localTime(kind, itemId)
    const prefer =
      localTime !== undefined && localTime > change.time ? 'local' : 'remote'
    let value: unknown
    if (
      local &&
      typeof local === 'object' &&
      !Array.isArray(local) &&
      incoming &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming)
    ) {
      value = mergeFields(
        base?.deleted
          ? undefined
          : (base?.value as Record<string, unknown> | undefined),
        local as Record<string, unknown>,
        incoming as Record<string, unknown>,
        prefer
      )
      if (kind === 'package') {
        const merged = value as ContextPackage
        const before = base?.value as ContextPackage | undefined
        value = {
          ...merged,
          sourceIds: mergeIds(
            before?.sourceIds,
            (local as ContextPackage).sourceIds,
            (incoming as ContextPackage).sourceIds
          ),
        }
      }
    } else value = prefer === 'local' ? local : incoming
    if (sameValue(value, local)) record('kept-local')
    else {
      next = write(next, kind, itemId, value)
      record('merged')
    }
  }
  return { workspace: next, outcomes }
}
