import { useEffect, useId, useState } from 'react'
import {
  ArrowUpCircle,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  X,
} from 'lucide-react'
import type { UpdateSettings } from '../types/notebook'
import {
  checkForUpdates,
  dismissUpdate,
  downloadUpdate,
  installUpdate,
  releaseHighlights,
  updatesAvailable,
  useUpdateState,
  type UpdateState,
} from '../services/updater'
import './update-notice.css'

const FIRST_CHECK_MS = 12_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Check after launch and every few hours while automatic checks are on.
 * A found version downloads in the background when that is on.
 */
export function useAutoUpdates(settings: UpdateSettings) {
  const { autoCheck, autoDownload } = settings
  useEffect(() => {
    if (!updatesAvailable() || !autoCheck) return
    const run = () => {
      void checkForUpdates({ download: autoDownload })
    }
    const first = setTimeout(run, FIRST_CHECK_MS)
    const every = setInterval(run, CHECK_EVERY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [autoCheck, autoDownload])
}

/** When the notice shows: never mid-check, and only when it helps. */
export function noticeVisible(update: UpdateState): boolean {
  if (update.version && update.dismissed === update.version) return false
  switch (update.phase) {
    case 'ready':
    case 'installing':
      return true
    case 'available':
      return true
    case 'downloading':
      return update.manual
    case 'error':
      return update.manual && Boolean(update.version)
    default:
      return false
  }
}

export function UpdateNotice({
  hidden,
  onOpenSettings,
}: {
  /** Zen mode and open dialogs keep the page quiet. */
  hidden: boolean
  onOpenSettings(): void
}) {
  const update = useUpdateState()
  const [notesOpen, setNotesOpen] = useState(false)
  const notesId = useId()
  const visible = !hidden && noticeVisible(update)
  const highlights = releaseHighlights(update.notes)

  if (!visible) return null
  const version = update.version ?? ''
  const percent =
    update.progress === null ? null : Math.round(update.progress * 100)

  let title: string
  let detail: string
  if (update.phase === 'ready') {
    title = `TypeNext ${version} is ready`
    detail = 'Restart to finish. Your notes are saved first.'
  } else if (update.phase === 'installing') {
    title = `Installing TypeNext ${version}`
    detail = 'Saving your notes and restarting…'
  } else if (update.phase === 'downloading') {
    title = `Downloading TypeNext ${version}`
    detail =
      percent === null
        ? 'Verifying as it arrives…'
        : `${percent}% · verified as it arrives`
  } else if (update.phase === 'error') {
    title = 'The update did not finish'
    detail = update.error
  } else {
    title = `TypeNext ${version} is available`
    detail = 'A short download. TypeNext asks before it restarts.'
  }

  return (
    <aside
      className={`update-notice is-${update.phase}`}
      aria-label="Update"
      role="region"
    >
      <div className="update-notice-head">
        <span className="update-notice-icon" aria-hidden="true">
          {update.phase === 'error' ? (
            <CircleAlert size={17} />
          ) : update.phase === 'downloading' ||
            update.phase === 'installing' ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <ArrowUpCircle size={17} />
          )}
        </span>
        <div className="update-notice-text" role="status" aria-live="polite">
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
        {update.phase !== 'installing' && (
          <button
            type="button"
            className="update-notice-close"
            aria-label="Remind me later"
            title="Later"
            onClick={dismissUpdate}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {update.phase === 'downloading' && (
        <div
          className={`update-progress ${percent === null ? 'is-indeterminate' : ''}`}
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <span style={{ width: `${percent ?? 35}%` }} />
        </div>
      )}

      {highlights.length > 0 && update.phase !== 'error' && (
        <div className="update-notes">
          <button
            type="button"
            className="update-notes-toggle"
            aria-expanded={notesOpen}
            aria-controls={notesId}
            onClick={() => setNotesOpen(open => !open)}
          >
            What’s new
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <ul id={notesId} hidden={!notesOpen}>
            {highlights.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="update-notice-actions">
        {update.phase === 'ready' && (
          <>
            <button
              type="button"
              className="button subtle is-compact"
              onClick={dismissUpdate}
            >
              Later
            </button>
            <button
              type="button"
              className="button primary is-compact"
              onClick={() => void installUpdate()}
            >
              Restart to update
            </button>
          </>
        )}
        {update.phase === 'available' && (
          <>
            <button
              type="button"
              className="button subtle is-compact"
              onClick={onOpenSettings}
            >
              Settings
            </button>
            <button
              type="button"
              className="button primary is-compact"
              onClick={() => void downloadUpdate(true)}
            >
              Download
            </button>
          </>
        )}
        {update.phase === 'error' && (
          <button
            type="button"
            className="button secondary is-compact"
            onClick={() =>
              void checkForUpdates({ manual: true, download: true })
            }
          >
            Try again
          </button>
        )}
      </div>
    </aside>
  )
}
