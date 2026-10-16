import { useEffect, useState } from 'react'
import { repoApi } from '../content'

const KEY = 'typenext-site-stars'
const MAX_AGE = 30 * 60 * 1000

let pending: Promise<number | null> | null = null

function readCache(): number | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const { count, at } = JSON.parse(raw) as { count: number; at: number }
    return Date.now() - at < MAX_AGE && Number.isFinite(count) ? count : null
  } catch {
    return null
  }
}

function load(): Promise<number | null> {
  pending ??= fetch(repoApi, { headers: { Accept: 'application/vnd.github+json' } })
    .then(response => (response.ok ? response.json() : null))
    .then((body: { stargazers_count?: number } | null) => {
      const count = typeof body?.stargazers_count === 'number' ? body.stargazers_count : null
      if (count !== null) {
        try {
          sessionStorage.setItem(KEY, JSON.stringify({ count, at: Date.now() }))
        } catch {
          // The count is only a convenience.
        }
      }
      return count
    })
    .catch(() => null)
  return pending
}

/** The repository star count, or null while it loads or when GitHub is unavailable. */
export function useGitHubStars(): number | null {
  const [count, setCount] = useState<number | null>(readCache)
  useEffect(() => {
    if (count !== null) return
    let alive = true
    void load().then(value => {
      if (alive) setCount(value)
    })
    return () => {
      alive = false
    }
  }, [count])
  return count
}

export const formatStars = (count: number) =>
  count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(count)
