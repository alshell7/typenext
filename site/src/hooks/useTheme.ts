import { useCallback, useSyncExternalStore } from 'react'
import { useMediaQuery } from './useMediaQuery'

export type Theme = 'light' | 'dark'
const KEY = 'typenext-site-theme'
const listeners = new Set<() => void>()

const readOverride = (): Theme | null => {
  const value = document.documentElement.dataset.theme
  return value === 'light' || value === 'dark' ? value : null
}

/** The visible theme: a saved choice, or the system appearance. */
export function useTheme() {
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const override = useSyncExternalStore(
    notify => {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    readOverride,
    () => null
  )
  const theme: Theme = override ?? (systemDark ? 'dark' : 'light')

  const setTheme = useCallback(
    (next: Theme) => {
      const system: Theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      const root = document.documentElement
      root.classList.add('theme-switching')
      if (next === system) delete root.dataset.theme
      else root.dataset.theme = next
      try {
        if (next === system) localStorage.removeItem(KEY)
        else localStorage.setItem(KEY, next)
      } catch {
        // Storage can be unavailable (private windows); the choice lasts for this page.
      }
      listeners.forEach(notify => notify())
      window.setTimeout(() => root.classList.remove('theme-switching'), 50)
    },
    []
  )

  return { theme, setTheme, followsSystem: override === null }
}
