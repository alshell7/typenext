import { useEffect, useState } from 'react'
import { CloudOff, GitBranch, LoaderCircle, TriangleAlert } from 'lucide-react'
import { syncNow, useGitSyncState } from './useGitSync'

function ago(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : 'over a day ago'
}

/** A quiet sync line for the sidebar. Click to sync now or to fix a problem. */
export function GitSyncStatus({ onOpenSettings }: { onOpenSettings(): void }) {
  const sync = useGitSyncState()
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 60_000)
    return () => clearInterval(timer)
  }, [])
  if (sync.phase === 'off') return null
  const problem = sync.phase === 'error'
  const label =
    sync.phase === 'syncing'
      ? 'Syncing with Git…'
      : problem
        ? 'Git sync needs attention'
        : sync.phase === 'offline'
          ? 'Git offline · saved locally'
          : sync.phase === 'waiting'
            ? 'Changes wait for Git sync'
            : sync.at
              ? `Synced ${ago(sync.at)}`
              : 'Git sync on'
  return (
    <button
      type="button"
      className={`git-sync-status ${problem ? 'is-error' : ''}`}
      title={sync.message ?? (problem ? 'Open Sync settings' : 'Sync now')}
      onClick={() => (problem ? onOpenSettings() : void syncNow())}
    >
      {sync.phase === 'syncing' ? (
        <LoaderCircle size={13} className="spin" />
      ) : problem ? (
        <TriangleAlert size={13} />
      ) : sync.phase === 'offline' ? (
        <CloudOff size={13} />
      ) : (
        <GitBranch size={13} />
      )}
      <span>{label}</span>
    </button>
  )
}
