/**
 * A small subsequence matcher for short names. Higher scores favour prefix,
 * word-start and consecutive matches. Returns null when the query does not
 * occur as a subsequence.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 0
  const haystack = text.toLocaleLowerCase()
  const direct = haystack.indexOf(needle)
  if (direct === 0) return 1_000 - haystack.length
  if (direct > 0)
    return (
      (/[\s\-_./]/u.test(haystack[direct - 1] ?? '') ? 800 : 600) -
      direct -
      haystack.length / 100
    )
  let score = 0
  let position = 0
  let previous = -2
  for (const character of needle) {
    if (/\s/u.test(character)) continue
    const index = haystack.indexOf(character, position)
    if (index < 0) return null
    if (index === previous + 1) score += 6
    if (index === 0 || /[\s\-_./]/u.test(haystack[index - 1] ?? '')) score += 8
    score -= Math.min(index - position, 10)
    previous = index
    position = index + 1
  }
  return score
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string
): T[] {
  if (!query.trim()) return items.slice()
  return items
    .map((item, index) => ({
      item,
      index,
      score: fuzzyScore(query, text(item)),
    }))
    .filter(
      (entry): entry is { item: T; index: number; score: number } =>
        entry.score !== null
    )
    .sort(
      (first, second) =>
        second.score - first.score || first.index - second.index
    )
    .map(entry => entry.item)
}
