import { Sparkles, X } from 'lucide-react'

/** Shown when media is chosen while semantic search with media is off. */
export function MediaHint({
  onOpenSettings,
  onDismiss,
}: {
  onOpenSettings?(): void
  onDismiss(): void
}) {
  return (
    <div className="context-media-hint" role="status">
      <Sparkles size={14} aria-hidden="true" />
      <p>
        Images, audio and video are understood through semantic search. Turn on
        semantic search with media in Preferences → Knowledge to add them.
        {onOpenSettings && (
          <>
            {' '}
            <button type="button" onClick={onOpenSettings}>
              Open Knowledge settings
            </button>
          </>
        )}
      </p>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss media hint"
        onClick={onDismiss}
      >
        <X size={12} />
      </button>
    </div>
  )
}
