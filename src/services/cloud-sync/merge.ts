import {
  diffSequence,
  splitLines,
  wordTokens,
} from '../../notebook/revisions/diff'

/**
 * Three-way merges for cloud sync. Two devices that changed different parts
 * of a note both keep their writing. Only edits to the same words conflict.
 */

interface Edit<T> {
  start: number
  end: number
  items: T[]
}

/** Changes from base to next, as replacements of base ranges. */
function edits<T>(base: readonly T[], next: readonly T[]): Edit<T>[] {
  const result: Edit<T>[] = []
  let position = 0
  let current: Edit<T> | null = null
  for (const part of diffSequence(base, next)) {
    if (part.op === 'equal') {
      if (current) result.push(current)
      current = null
      position += part.items.length
      continue
    }
    current ??= { start: position, end: position, items: [] }
    if (part.op === 'delete') {
      position += part.items.length
      current.end = position
    } else current.items.push(...part.items)
  }
  if (current) result.push(current)
  return result
}

function sameItems<T>(a: readonly T[], b: readonly T[]) {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function overlaps<T>(a: Edit<T>, b: Edit<T>) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  if (a.start === a.end) return a.start > b.start && a.start < b.end
  if (b.start === b.end) return b.start > a.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}

export interface MergeChunk<T> {
  /** Both sides changed this part differently. */
  conflict: boolean
  base: T[]
  local: T[]
  remote: T[]
}

/** diff3 over any sequence. Non-conflicting chunks hold the merged items. */
export function merge3<T>(
  base: readonly T[],
  local: readonly T[],
  remote: readonly T[]
): MergeChunk<T>[] {
  const ours = edits(base, local)
  const theirs = edits(base, remote)
  const chunks: MergeChunk<T>[] = []
  let position = 0
  let i = 0
  let j = 0
  const keep = (until: number) => {
    if (until > position)
      chunks.push({
        conflict: false,
        base: base.slice(position, until),
        local: base.slice(position, until),
        remote: base.slice(position, until),
      })
    position = Math.max(position, until)
  }
  while (i < ours.length || j < theirs.length) {
    const a = ours[i]
    const b = theirs[j]
    if (!a || !b || !overlaps(a, b)) {
      // The earlier edit goes first; at one position, an insertion first.
      const takeA =
        a !== undefined &&
        (b === undefined ||
          a.start < b.start ||
          (a.start === b.start && a.start === a.end))
      const edit = (takeA ? a : b)!
      keep(edit.start)
      chunks.push({
        conflict: false,
        base: base.slice(edit.start, edit.end),
        local: edit.items,
        remote: edit.items,
      })
      position = edit.end
      if (takeA) i++
      else j++
      continue
    }
    // Overlap: gather every edit that touches the combined range.
    let start = Math.min(a!.start, b!.start)
    let end = Math.max(a!.end, b!.end)
    const mine: Edit<T>[] = [a!]
    const others: Edit<T>[] = [b!]
    i++
    j++
    for (;;) {
      const nextA = ours[i]
      const nextB = theirs[j]
      const range = { start, end, items: [] as T[] }
      if (nextA && overlaps(range, nextA)) {
        mine.push(nextA)
        end = Math.max(end, nextA.end)
        i++
      } else if (nextB && overlaps(range, nextB)) {
        others.push(nextB)
        end = Math.max(end, nextB.end)
        j++
      } else break
    }
    start = Math.min(
      start,
      ...mine.map(edit => edit.start),
      ...others.map(edit => edit.start)
    )
    keep(start)
    const apply = (list: Edit<T>[]) => {
      const output: T[] = []
      let at = start
      for (const edit of list) {
        output.push(...base.slice(at, edit.start), ...edit.items)
        at = edit.end
      }
      output.push(...base.slice(at, end))
      return output
    }
    const localSide = apply(mine)
    const remoteSide = apply(others)
    const same = sameItems(localSide, remoteSide)
    chunks.push({
      conflict: !same,
      base: base.slice(start, end),
      local: localSide,
      remote: remoteSide,
    })
    position = end
  }
  keep(base.length)
  return chunks
}

export interface TextMerge {
  text: string
  /** Places where both devices changed the same words. Local text is kept there. */
  conflicts: number
}

/** Lines first, then words inside lines both devices changed. */
export function mergeText(
  base: string,
  local: string,
  remote: string
): TextMerge {
  if (local === remote) return { text: local, conflicts: 0 }
  if (local === base) return { text: remote, conflicts: 0 }
  if (remote === base) return { text: local, conflicts: 0 }
  const lineEnd = (lines: string[]) =>
    lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line))
  const chunks = merge3(
    lineEnd(splitLines(base)),
    lineEnd(splitLines(local)),
    lineEnd(splitLines(remote))
  )
  let text = ''
  let conflicts = 0
  for (const chunk of chunks) {
    if (!chunk.conflict) {
      text += chunk.local.join('')
      continue
    }
    const words = merge3(
      wordTokens(chunk.base.join('')),
      wordTokens(chunk.local.join('')),
      wordTokens(chunk.remote.join(''))
    )
    for (const part of words) {
      text += part.local.join('')
      if (part.conflict) conflicts++
    }
  }
  return { text, conflicts }
}

/** Ids both sides added stay; ids either side removed go. Local order first. */
export function mergeIds(
  base: readonly string[] | undefined,
  local: readonly string[] | undefined,
  remote: readonly string[] | undefined
): string[] {
  const before = new Set(base ?? [])
  const mine = local ?? []
  const theirs = remote ?? []
  const removed = new Set([
    ...[...before].filter(id => !mine.includes(id)),
    ...[...before].filter(id => !theirs.includes(id)),
  ])
  return [...new Set([...mine, ...theirs])].filter(id => !removed.has(id))
}

function canonical(value: unknown): string {
  return stableJson(value)
}

/** JSON with sorted keys and no undefined values: equal data, equal text. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map(item => (item === undefined ? 'null' : stableJson(item))).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      key =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )
  return `{${entries.join(',')}}`
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || canonical(a) === canonical(b)
}

/**
 * Field by field: a field only one side changed takes that change. A field
 * both changed takes the preferred side. Nested plain objects merge one
 * level deeper, so two preferences in one section never overwrite each other.
 */
export function mergeFields<T extends Record<string, unknown>>(
  base: T | undefined,
  local: T,
  remote: T,
  prefer: 'local' | 'remote',
  depth = 1
): T {
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const before = base?.[key]
    const mine = local[key]
    const theirs = remote[key]
    let value: unknown
    if (sameValue(mine, theirs)) value = mine
    else if (base && sameValue(before, mine)) value = theirs
    else if (base && sameValue(before, theirs)) value = mine
    else if (
      depth > 0 &&
      isPlainObject(mine) &&
      isPlainObject(theirs) &&
      (before === undefined || isPlainObject(before))
    )
      value = mergeFields(
        before as Record<string, unknown> | undefined,
        mine,
        theirs,
        prefer,
        depth - 1
      )
    else value = prefer === 'local' ? mine : theirs
    if (value !== undefined) result[key] = value
  }
  return result as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
