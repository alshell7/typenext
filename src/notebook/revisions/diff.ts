/**
 * Text differences for revisions and AI previews. Lines are compared first,
 * then words inside each changed block, so prose reads as one sentence with
 * its changes marked rather than as two whole paragraphs.
 */

export type DiffOp = 'equal' | 'delete' | 'insert'

export interface DiffPart<T> {
  op: DiffOp
  items: T[]
}

/** Above this many edits, a block is shown as one replacement. */
const MAX_EDITS = 2_000
/** Above this many items after trimming, a block is one replacement. */
const MAX_ITEMS = 40_000

function push<T>(parts: DiffPart<T>[], op: DiffOp, item: T) {
  const last = parts.at(-1)
  if (last?.op === op) last.items.push(item)
  else parts.push({ op, items: [item] })
}

/**
 * Myers' O(ND) difference of two sequences. Equal runs at both ends are
 * trimmed first; very different or very long middles fall back to one
 * delete and one insert, which is still a correct difference.
 */
export function diffSequence<T>(
  a: readonly T[],
  b: readonly T[]
): DiffPart<T>[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const parts: DiffPart<T>[] = []
  for (let index = 0; index < start; index++) push(parts, 'equal', a[index]!)
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  for (const part of middle(middleA, middleB))
    for (const item of part.items) push(parts, part.op, item)
  for (let index = endA; index < a.length; index++)
    push(parts, 'equal', a[index]!)
  return parts
}

function replacement<T>(a: readonly T[], b: readonly T[]): DiffPart<T>[] {
  return [
    ...(a.length ? [{ op: 'delete' as const, items: [...a] }] : []),
    ...(b.length ? [{ op: 'insert' as const, items: [...b] }] : []),
  ]
}

function middle<T>(a: readonly T[], b: readonly T[]): DiffPart<T>[] {
  const n = a.length
  const m = b.length
  if (!n || !m || n + m > MAX_ITEMS) return replacement(a, b)
  const max = Math.min(n + m, MAX_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return replacement(a, b)
  // Walk back through the saved frontiers, newest first.
  const reversed: { op: DiffOp; item: T }[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const frontier = trace[d]!
    const at = (k: number) => frontier[k + d + 1]!
    const k = x - y
    const previousK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const previousX = d === 0 ? 0 : at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      reversed.push({ op: 'equal', item: a[x - 1]! })
      x--
      y--
    }
    if (d > 0) {
      if (x === previousX) reversed.push({ op: 'insert', item: b[y - 1]! })
      else reversed.push({ op: 'delete', item: a[x - 1]! })
    }
    x = previousX
    y = previousY
  }
  const parts: DiffPart<T>[] = []
  for (let index = reversed.length - 1; index >= 0; index--)
    push(parts, reversed[index]!.op, reversed[index]!.item)
  return parts
}

// ------------------------------------------------------------------ Words

/** Words, runs of spaces and single marks: the units a writer changes. */
export function wordTokens(text: string): string[] {
  return (
    text.match(/\s+|[\p{L}\p{M}\p{N}_’'-]+|[^\s\p{L}\p{M}\p{N}_’'-]/gu) ?? []
  )
}

export interface TextSegment {
  op: DiffOp
  text: string
}

/** Word-level changes from `before` to `after`, as runs of text. */
export function wordDiff(before: string, after: string): TextSegment[] {
  const parts = diffSequence(wordTokens(before), wordTokens(after))
  const segments: TextSegment[] = parts.map(part => ({
    op: part.op,
    text: part.items.join(''),
  }))
  // A lone space kept between two changes reads as part of the change.
  const merged: TextSegment[] = []
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    const previous = merged.at(-1)
    const next = segments[index + 1]
    if (
      segment.op === 'equal' &&
      /^ $/u.test(segment.text) &&
      previous &&
      previous.op !== 'equal' &&
      next &&
      next.op !== 'equal'
    ) {
      merged.push({ op: 'delete', text: ' ' }, { op: 'insert', text: ' ' })
      continue
    }
    merged.push(segment)
  }
  // Join neighbours of the same kind, and order each change as delete, insert.
  const result: TextSegment[] = []
  let deleted = ''
  let inserted = ''
  const flush = () => {
    if (deleted) result.push({ op: 'delete', text: deleted })
    if (inserted) result.push({ op: 'insert', text: inserted })
    deleted = ''
    inserted = ''
  }
  for (const segment of merged) {
    if (segment.op === 'delete') deleted += segment.text
    else if (segment.op === 'insert') inserted += segment.text
    else {
      flush()
      const last = result.at(-1)
      if (last?.op === 'equal') last.text += segment.text
      else result.push({ ...segment })
    }
  }
  flush()
  return result
}

// ------------------------------------------------------------------ Lines

export interface Hunk {
  /** Stable within one comparison: the index of the change. */
  id: number
  /** First changed line in the older text (0-based). */
  oldStart: number
  oldLines: string[]
  /** First changed line in the newer text (0-based). */
  newStart: number
  newLines: string[]
}

export interface LineDiff {
  hunks: Hunk[]
  /** Every line with its operation, in reading order. */
  parts: DiffPart<string>[]
  added: number
  removed: number
}

export function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Line changes from an older text to a newer one, grouped into hunks. */
export function lineDiff(older: string, newer: string): LineDiff {
  const parts = diffSequence(splitLines(older), splitLines(newer))
  const hunks: Hunk[] = []
  let oldLine = 0
  let newLine = 0
  let open: Hunk | null = null
  for (const part of parts) {
    if (part.op === 'equal') {
      open = null
      oldLine += part.items.length
      newLine += part.items.length
      continue
    }
    if (!open) {
      open = {
        id: hunks.length,
        oldStart: oldLine,
        oldLines: [],
        newStart: newLine,
        newLines: [],
      }
      hunks.push(open)
    }
    if (part.op === 'delete') {
      open.oldLines.push(...part.items)
      oldLine += part.items.length
    } else {
      open.newLines.push(...part.items)
      newLine += part.items.length
    }
  }
  const counts = wordChanges(older, newer)
  return { hunks, parts, added: counts.added, removed: counts.removed }
}

/**
 * Put the older version of the chosen hunks back into the newer text. This
 * is how a writer merges parts of a revision into the current note.
 */
export function revertHunks(
  newer: string,
  hunks: readonly Hunk[],
  chosen: ReadonlySet<number>
): string {
  const lines = splitLines(newer)
  const selected = hunks
    .filter(hunk => chosen.has(hunk.id))
    .sort((left, right) => right.newStart - left.newStart)
  for (const hunk of selected)
    lines.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines)
  return lines.join('\n')
}

/** Characters inserted plus characters removed, cheaply bounded. */
export function changeSize(before: string, after: string): number {
  if (before === after) return 0
  let start = 0
  const limit = Math.min(before.length, after.length)
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start))
    start++
  let endBefore = before.length
  let endAfter = after.length
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--
    endAfter--
  }
  return endBefore - start + (endAfter - start)
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}_’'-]*/gu)?.length ?? 0
}

/** Words added and removed between two texts. */
export function wordChanges(
  before: string,
  after: string
): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 }
  // Very long texts: compare word counts of the changed middle only.
  if (before.length + after.length > 400_000) {
    const difference = countWords(after) - countWords(before)
    return { added: Math.max(0, difference), removed: Math.max(0, -difference) }
  }
  let added = 0
  let removed = 0
  // Markdown marks such as # and - are not words.
  const words = (text: string) =>
    (text.match(/\S+/gu) ?? []).filter(token => /[\p{L}\p{N}]/u.test(token))
  for (const part of diffSequence(words(before), words(after))) {
    if (part.op === 'insert') added += part.items.length
    else if (part.op === 'delete') removed += part.items.length
  }
  return { added, removed }
}
