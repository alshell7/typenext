import { useCallback, useEffect, useRef } from 'react'
import type { Note, RevisionSettings } from '../../types/notebook'
import {
  largeDeletion,
  REVISION_PAUSE_MS,
  SAFETY_INTERVAL_MS,
  shouldCapture,
} from './policy'
import { addRevision, latestRevision, type RevisionKind } from './store'

interface Options {
  /** The open note, as stored. */
  note: Note | undefined
  settings: RevisionSettings
  /** The current note by id, read at capture time. */
  noteById(id: string): Note | undefined
  notify(message: string): void
}

/**
 * Takes revisions while the writer works: after a pause once enough has
 * changed, when the writer leaves a note or the window, and as a safety copy
 * before a large deletion. Capturing never blocks typing; storage failures
 * are reported once and writing continues.
 */
export function useRevisions({ note, settings, noteById, notify }: Options) {
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const noteByIdRef = useRef(noteById)
  noteByIdRef.current = noteById
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const failed = useRef(false)
  const lastSafety = useRef(0)
  const seen = useRef<{ id: string; content: string } | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const store = useCallback(
    (
      target: Note,
      text: string,
      kind: RevisionKind,
      extra: { label?: string; reason?: string } = {}
    ) => {
      const task = queue.current
        .catch(() => undefined)
        .then(() =>
          addRevision({
            noteId: target.id,
            title: target.title,
            text,
            kind,
            keep: settingsRef.current.keep,
            ...extra,
          })
        )
        .catch(error => {
          if (failed.current) return null
          failed.current = true
          notifyRef.current(
            `Revisions could not be saved: ${error instanceof Error ? error.message : String(error)}`
          )
          return null
        })
      queue.current = task
      return task
    },
    []
  )

  /** Consider an automatic revision of a note as it is now. */
  const consider = useCallback(
    async (id: string) => {
      const current = settingsRef.current
      if (!current.enabled || current.mode !== 'automatic') return
      const target = noteByIdRef.current(id)
      if (!target) return
      const previous = await latestRevision(id).catch(() => null)
      if (
        shouldCapture({
          settings: current,
          previous,
          current: target.content,
          now: Date.now(),
        })
      )
        await store(target, target.content, 'auto')
    },
    [store]
  )

  const noteId = note?.id
  const content = note?.content
  useEffect(() => {
    if (!settings.enabled || noteId === undefined || content === undefined)
      return
    const before = seen.current
    seen.current = { id: noteId, content }
    if (
      before?.id === noteId &&
      Date.now() - lastSafety.current > SAFETY_INTERVAL_MS &&
      largeDeletion(before.content, content, settings)
    ) {
      lastSafety.current = Date.now()
      const target = noteByIdRef.current(noteId)
      if (target)
        void store(target, before.content, 'safety', {
          reason: 'Before a large deletion',
        })
    }
    if (settings.mode !== 'automatic') return
    const timer = setTimeout(() => void consider(noteId), REVISION_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [noteId, content, settings, consider, store])

  // Leaving a note or the window counts as a pause.
  useEffect(() => {
    if (!noteId) return
    const hidden = () => {
      if (document.visibilityState === 'hidden') void consider(noteId)
    }
    document.addEventListener('visibilitychange', hidden)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      void consider(noteId)
    }
  }, [noteId, consider])

  /** Save the note as it is now, by hand. */
  const saveRevision = useCallback(
    async (label?: string) => {
      if (!noteId) return null
      const target = noteByIdRef.current(noteId)
      if (!target) return null
      return store(target, target.content, 'manual', label ? { label } : {})
    },
    [noteId, store]
  )

  /** Keep the text before an AI edit or a restore. */
  const safetyCopy = useCallback(
    (id: string, reason: string) => {
      const current = settingsRef.current
      if (!current.enabled || !current.safetyNet) return Promise.resolve(null)
      const target = noteByIdRef.current(id)
      if (!target) return Promise.resolve(null)
      return store(target, target.content, 'safety', { reason })
    },
    [store]
  )

  return { saveRevision, safetyCopy }
}
