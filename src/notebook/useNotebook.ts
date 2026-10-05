import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import {
  flushBrowserWorkspace,
  loadWorkspace,
  persistWorkspace,
} from '../services/storage'
import type { Workspace } from '../types/notebook'
import { emptyWorkspace, normalizeWorkspace } from './model'

export const AUTOSAVE_IDLE_MS = 650
export const AUTOSAVE_MAX_WAIT_MS = 2000
interface Snapshot {
  workspace: Workspace
  revision: number
}

export function useNotebook() {
  const [workspace, setWorkspaceState] = useState(emptyWorkspace)
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState<
    'saved' | 'saving' | 'unsaved' | 'error'
  >('saved')
  const [storageError, setStorageError] = useState('')
  const [loadError, setLoadError] = useState(false)
  const current = useRef<Snapshot>({ workspace, revision: 0 })
  const savedRevision = useRef(0)
  const requestedRevision = useRef(0)
  const requested = useRef<Snapshot | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const dirtySince = useRef<number | null>(null)
  const getWorkspace = useCallback(() => current.current.workspace, [])
  const waitForPendingSave = useCallback(
    () => inFlight.current ?? Promise.resolve(),
    []
  )
  // Evaluate updates before dispatch: immediate save/close and checked imports
  // see the latest edits even before React commits its next render.
  const setWorkspace = useCallback((action: SetStateAction<Workspace>) => {
    const previous = current.current
    const next =
      typeof action === 'function' ? action(previous.workspace) : action
    if (next === previous.workspace) return
    current.current = { workspace: next, revision: previous.revision + 1 }
    dirtySince.current ??= Date.now()
    setWorkspaceState(next)
  }, [])
  const hasUnsavedChanges = useCallback(
    () =>
      !loading &&
      !loadError &&
      current.current.revision > savedRevision.current,
    [loading, loadError]
  )

  useEffect(() => {
    let active = true
    loadWorkspace()
      .then(value => {
        if (!active) return
        const loaded = value ? normalizeWorkspace(value) : emptyWorkspace()
        current.current = { workspace: loaded, revision: 0 }
        savedRevision.current = 0
        requestedRevision.current = 0
        dirtySince.current = null
        setWorkspaceState(loaded)
      })
      .catch(error => {
        if (active) {
          setStorageError(String(error))
          setSaveStatus('error')
          setLoadError(true)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const saveNow = useCallback((): Promise<void> => {
    if (loadError)
      return Promise.reject(
        new Error(
          'Restore or repair your saved notebook before writing a new copy.'
        )
      )
    if (loading)
      return Promise.reject(
        new Error('Wait for your notebook to finish opening before saving.')
      )
    const snapshot = current.current
    if (snapshot.revision <= savedRevision.current && !inFlight.current)
      return Promise.resolve()
    requested.current = snapshot
    requestedRevision.current = snapshot.revision
    dirtySince.current = null
    if (inFlight.current) return inFlight.current
    setSaveStatus('saving')
    // Keep one active write and one latest requested snapshot. Slow disks cannot
    // build a queue retaining every obsolete version of a large document.
    const task = Promise.resolve().then(async () => {
      try {
        while (requested.current) {
          const next = requested.current
          requested.current = null
          if (next.revision <= savedRevision.current) continue
          await persistWorkspace(next.workspace)
          savedRevision.current = Math.max(savedRevision.current, next.revision)
        }
        setStorageError('')
        setSaveStatus(
          current.current.revision === savedRevision.current
            ? 'saved'
            : 'unsaved'
        )
      } catch (error) {
        requested.current = null
        requestedRevision.current = savedRevision.current
        setStorageError(error instanceof Error ? error.message : String(error))
        setSaveStatus('error')
        throw error
      } finally {
        // Clear ownership in the same job that finishes the drain. A new
        // request must never receive an ending promise with no active writer.
        inFlight.current = null
      }
    })
    inFlight.current = task
    return task
  }, [loadError, loading])

  useEffect(() => {
    if (
      loading ||
      loadError ||
      current.current.revision <= savedRevision.current
    )
      return
    setSaveStatus(inFlight.current ? 'saving' : 'unsaved')
    if (!workspace.settings.autoSave) return
    if (current.current.revision <= requestedRevision.current) return
    const elapsed = Date.now() - (dirtySince.current ?? Date.now())
    const delay = Math.max(
      0,
      Math.min(AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS - elapsed)
    )
    const timer = setTimeout(() => {
      void saveNow().catch(() => undefined)
    }, delay)
    return () => clearTimeout(timer)
  }, [workspace, loading, loadError, saveNow])

  useEffect(() => {
    const flush = () => {
      if (
        !loading &&
        !loadError &&
        current.current.workspace.settings.autoSave &&
        current.current.revision > savedRevision.current
      ) {
        const snapshot = current.current
        try {
          if (flushBrowserWorkspace(snapshot.workspace)) {
            savedRevision.current = Math.max(
              savedRevision.current,
              snapshot.revision
            )
            requestedRevision.current = Math.max(
              requestedRevision.current,
              snapshot.revision
            )
            dirtySince.current = null
            setStorageError('')
            setSaveStatus('saved')
          } else void saveNow().catch(() => undefined)
        } catch (error) {
          setStorageError(
            error instanceof Error ? error.message : String(error)
          )
          setSaveStatus('error')
        }
      }
    }
    const protect = (event: BeforeUnloadEvent) => {
      if (
        !loading &&
        !loadError &&
        current.current.revision > savedRevision.current
      ) {
        flush()
        if (current.current.revision > savedRevision.current) {
          event.preventDefault()
          event.returnValue = ''
        }
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', protect)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', flush)
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', protect)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [loading, loadError, saveNow])

  return {
    workspace,
    getWorkspace,
    waitForPendingSave,
    setWorkspace,
    loading,
    loadError,
    saveNow,
    saveStatus,
    storageError,
    hasUnsavedChanges,
  }
}
