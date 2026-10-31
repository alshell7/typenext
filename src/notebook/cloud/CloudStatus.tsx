import { useEffect, useState } from 'react'
import {
  Cloud,
  CloudOff,
  KeyRound,
  Laptop,
  LoaderCircle,
  Monitor,
  Smartphone,
  Tablet,
  TriangleAlert,
  Globe,
  type LucideIcon,
} from 'lucide-react'
import type {
  DevicePresence,
  Platform,
} from '../../services/cloud-sync/session'
import { cloudSyncNow, useCloudSyncState } from './useCloudSync'
import './cloud.css'

export function platformIcon(platform: Platform): LucideIcon {
  switch (platform) {
    case 'mac':
      return Laptop
    case 'windows':
    case 'linux':
      return Monitor
    case 'iphone':
    case 'android':
      return Smartphone
    case 'ipad':
      return Tablet
    case 'web':
      return Globe
  }
}

export function ago(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function useMinuteTick() {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 30_000)
    return () => clearInterval(timer)
  }, [])
}

/** A quiet line above the workspace switcher: sync state and devices online. */
export function CloudStatus({ onOpenSettings }: { onOpenSettings(): void }) {
  const sync = useCloudSyncState()
  useMinuteTick()
  if (sync.phase === 'off') return null
  const others = sync.devices.filter(device => !device.self && device.active)
  const attention = sync.phase === 'attention' || sync.phase === 'error'
  const label =
    sync.phase === 'syncing'
      ? 'Syncing…'
      : sync.phase === 'attention'
        ? Object.values(sync.targets).some(target => target.phase === 'locked')
          ? 'Sync needs your key'
          : 'Sync needs attention'
        : sync.phase === 'error'
          ? 'Sync needs attention'
          : sync.phase === 'offline'
            ? 'Offline · saved here'
            : sync.pending
              ? `${sync.pending} ${sync.pending === 1 ? 'change' : 'changes'} to send`
              : sync.at
                ? `Synced ${ago(Date.now() - sync.at)}`
                : 'Cloud sync on'
  const Icon =
    sync.phase === 'syncing'
      ? LoaderCircle
      : sync.phase === 'attention'
        ? KeyRound
        : sync.phase === 'error'
          ? TriangleAlert
          : sync.phase === 'offline'
            ? CloudOff
            : Cloud
  const devicesText = others.length
    ? `${others.map(device => device.name).join(', ')} ${others.length === 1 ? 'is' : 'are'} online`
    : ''
  return (
    <button
      type="button"
      className={`git-sync-status cloud-sync-status ${attention ? 'is-error' : ''}`}
      title={[
        sync.message,
        devicesText,
        attention ? 'Open Cloud sync settings' : 'Sync now',
      ]
        .filter(Boolean)
        .join('\n')}
      aria-label={`Cloud sync: ${label}${devicesText ? `. ${devicesText}` : ''}`}
      onClick={() => (attention ? onOpenSettings() : void cloudSyncNow())}
      onContextMenu={event => {
        event.preventDefault()
        onOpenSettings()
      }}
    >
      <Icon
        size={13}
        className={sync.phase === 'syncing' ? 'spin' : undefined}
      />
      <span className="cloud-sync-label">{label}</span>
      {others.length > 0 && (
        <span className="cloud-device-dots" aria-hidden="true">
          {others.slice(0, 3).map(device => (
            <span
              key={device.id}
              className={`cloud-device-dot ${device.editing ? 'is-editing' : ''}`}
            />
          ))}
        </span>
      )}
    </button>
  )
}

/**
 * Other devices on the note shown here. Writing on two devices at once is
 * safe (edits merge word by word), but the writer should know.
 */
export function NotePresence({ noteId }: { noteId: string }) {
  const sync = useCloudSyncState()
  useMinuteTick()
  const here = sync.devices.filter(
    (device: DevicePresence) =>
      !device.self && device.active && device.noteId === noteId
  )
  if (!here.length) return null
  const editing = here.filter(device => device.editing)
  const names = (list: DevicePresence[]) =>
    list.length === 1 ? list[0]!.name : `${list.length} devices`
  const text = editing.length
    ? `${names(editing)} ${editing.length === 1 ? 'is' : 'are'} editing`
    : `Open on ${names(here)}`
  return (
    <div
      className={`note-presence ${editing.length ? 'is-editing' : ''}`}
      role="status"
      title={`${here
        .map(
          device =>
            `${device.name}${device.editing ? ' · editing now' : ' · viewing'}`
        )
        .join(
          '\n'
        )}\nChanges from every device merge as you write. If the same words change in two places, both versions are kept.`}
    >
      <span className="note-presence-avatars" aria-hidden="true">
        {here.slice(0, 3).map(device => {
          const Icon = platformIcon(device.platform)
          return (
            <span key={device.id} className="note-presence-avatar">
              <Icon size={11} />
            </span>
          )
        })}
      </span>
      <span className="note-presence-text">{text}</span>
    </div>
  )
}
