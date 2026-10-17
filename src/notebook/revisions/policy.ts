import type { RevisionSettings } from '../../types/notebook'
import { changeSize } from './diff'

/** How long writing must pause before an automatic revision is considered. */
export const REVISION_PAUSE_MS = 4_000
/** At most one safety copy for large deletions in this time. */
export const SAFETY_INTERVAL_MS = 30_000

export interface CaptureCheck {
  settings: RevisionSettings
  /** The newest stored revision, or null for a note without history. */
  previous: { createdAt: number; text: string } | null
  current: string
  now: number
}

/**
 * Automatic revisions: after a pause, once enough has changed and enough
 * time has passed since the last one. A new note's first revision waits
 * until it has as much text as the change threshold.
 */
export function shouldCapture({
  settings,
  previous,
  current,
  now,
}: CaptureCheck): boolean {
  if (!settings.enabled || settings.mode !== 'automatic') return false
  if (!previous) return current.trim().length >= settings.minChanges
  if (now - previous.createdAt < settings.minMinutes * 60_000) return false
  return changeSize(previous.text, current) >= settings.minChanges
}

/**
 * A large deletion in one edit: at least the change threshold and a fifth of
 * the note, or most of a short note. The text before it is worth keeping.
 */
export function largeDeletion(
  before: string,
  after: string,
  settings: RevisionSettings
): boolean {
  if (!settings.enabled || !settings.safetyNet) return false
  const removed = before.length - after.length
  if (removed <= 0) return false
  const threshold = Math.max(
    Math.min(settings.minChanges, 400),
    Math.ceil(before.length * 0.2)
  )
  return removed >= threshold && before.trim().length >= 40
}
