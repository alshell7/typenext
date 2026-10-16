import { useEffect, useRef, useState } from 'react'

export type PresenceState = 'present' | 'entering' | 'leaving'
export interface Presence<T> {
  key: string
  item: T
  state: PresenceState
}

export const PRESENCE_MS = 200

export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Keep removed items briefly so they can fade out, and mark items that arrive
 * after the first render so only real attachments animate in.
 */
export function usePresence<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  duration = PRESENCE_MS
): Presence<T>[] {
  const initial = useRef<Set<string> | null>(null)
  if (initial.current === null) initial.current = new Set(items.map(keyOf))
  const [leaving, setLeaving] = useState<
    Map<string, { item: T; index: number }>
  >(() => new Map())
  const previous = useRef<{ key: string; item: T }[]>(
    items.map(item => ({ key: keyOf(item), item }))
  )
  const keys = items.map(keyOf)
  const signature = keys.join('\u0000')

  useEffect(() => {
    const current = new Set(signature ? signature.split('\u0000') : [])
    const removed = previous.current
      .map((entry, index) => ({ ...entry, index }))
      .filter(entry => !current.has(entry.key))
    previous.current = items.map(item => ({ key: keyOf(item), item }))
    if (!removed.length || duration <= 0 || prefersReducedMotion()) {
      if (removed.length) setLeaving(new Map())
      return
    }
    setLeaving(value => {
      const next = new Map(value)
      for (const entry of removed)
        next.set(entry.key, { item: entry.item, index: entry.index })
      for (const key of current) next.delete(key)
      return next
    })
    const timer = window.setTimeout(() => {
      setLeaving(value => {
        const next = new Map(value)
        for (const entry of removed) next.delete(entry.key)
        return next
      })
    }, duration)
    return () => window.clearTimeout(timer)
    // items and keyOf are read through the stable signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, duration])

  const result: Presence<T>[] = items.map((item, index) => ({
    key: keys[index]!,
    item,
    state: initial.current!.has(keys[index]!) ? 'present' : 'entering',
  }))
  const present = new Set(keys)
  for (const [key, { item, index }] of leaving) {
    if (present.has(key)) continue
    result.splice(Math.min(index, result.length), 0, {
      key,
      item,
      state: 'leaving',
    })
  }
  return result
}
