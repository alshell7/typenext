import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowUpCircle,
  Check,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import type { UpdateSettings } from '../../types/notebook'
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  updatesAvailable,
  useUpdateState,
  type UpdateState,
} from '../../services/updater'
import { relativeDate } from '../model'
import { Callout, Group, Row, Section, SwitchRow, type Tone } from './controls'
import type { PaneProps } from './types'

const RELEASES = 'https://github.com/alshell7/typenext/releases'

/** A live status that sits in a row description like any other text. */
function RowStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pref-row-status tone-${tone}`} role="status">
      {tone === 'busy' && (
        <LoaderCircle size={12} className="spin" aria-hidden="true" />
      )}
      {tone === 'error' && <CircleAlert size={12} aria-hidden="true" />}
      {tone === 'ok' && <Check size={12} aria-hidden="true" />}
      <span>{children}</span>
    </span>
  )
}

function when(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`
  return relativeDate(time).toLocaleLowerCase()
}

export function updateStatus(update: UpdateState): {
  tone: Tone
  text: string
} {
  switch (update.phase) {
    case 'checking':
      return { tone: 'busy', text: 'Looking for a new version…' }
    case 'current':
      return { tone: 'ok', text: 'You have the latest version.' }
    case 'available':
      return {
        tone: 'neutral',
        text: `TypeNext ${update.version} is available.`,
      }
    case 'downloading':
      return {
        tone: 'busy',
        text:
          update.progress === null
            ? `Downloading TypeNext ${update.version}…`
            : `Downloading TypeNext ${update.version} · ${Math.round(update.progress * 100)}%`,
      }
    case 'ready':
      return {
        tone: 'ok',
        text: `TypeNext ${update.version} is downloaded and verified.`,
      }
    case 'installing':
      return { tone: 'busy', text: 'Installing and restarting…' }
    case 'error':
      return { tone: 'error', text: update.error }
    default:
      return {
        tone: 'neutral',
        text: update.checkedAt
          ? `Last checked ${when(update.checkedAt)}.`
          : 'Not checked yet.',
      }
  }
}

export function UpdatesPane({ settings, update, latest }: PaneProps) {
  const state = useUpdateState()
  const [version, setVersion] = useState('')
  const patch = (next: Partial<UpdateSettings>) =>
    update({ updates: { ...latest().updates, ...next } })

  useEffect(() => {
    if (!updatesAvailable()) return
    let live = true
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(value => {
        if (live) setVersion(value)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (!updatesAvailable())
    return (
      <Section
        title="Updates"
        description="Updates are part of the desktop app."
      >
        <p className="pref-help">
          The browser preview always runs the version it was built from.
          Downloads and release notes are on{' '}
          <a href={RELEASES} target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </Section>
    )

  const status = updateStatus(state)
  const busy =
    state.phase === 'checking' ||
    state.phase === 'downloading' ||
    state.phase === 'installing'

  return (
    <>
      <Section
        title="This version"
        description="New versions come from the TypeNext releases on GitHub."
        aside={
          <a
            className="pref-aside-link"
            href={RELEASES}
            target="_blank"
            rel="noreferrer"
          >
            Release notes <ExternalLink size={13} aria-hidden="true" />
          </a>
        }
      >
        <Group>
          <Row
            label={version ? `TypeNext ${version}` : 'TypeNext'}
            description={
              <RowStatus tone={status.tone}>{status.text}</RowStatus>
            }
          >
            {state.phase === 'ready' ? (
              <button
                type="button"
                className="button primary is-compact"
                onClick={() => void installUpdate()}
              >
                <ArrowUpCircle size={14} /> Restart to update
              </button>
            ) : state.phase === 'available' ? (
              <button
                type="button"
                className="button primary is-compact"
                onClick={() => void downloadUpdate(true)}
              >
                <ArrowUpCircle size={14} /> Download
              </button>
            ) : (
              <button
                type="button"
                className="button secondary is-compact"
                disabled={busy}
                onClick={() =>
                  void checkForUpdates({
                    manual: true,
                    download: latest().updates.autoDownload,
                  })
                }
              >
                <RefreshCw
                  size={14}
                  className={state.phase === 'checking' ? 'spin' : ''}
                />
                Check now
              </button>
            )}
          </Row>
        </Group>
      </Section>
      <Section
        title="Automatic updates"
        description="TypeNext always asks before it restarts."
      >
        <Group>
          <SwitchRow
            label="Check for updates automatically"
            description="Shortly after launch and every six hours. Only the version number is requested from GitHub; no notes or settings are sent."
            checked={settings.updates.autoCheck}
            onChange={autoCheck => patch({ autoCheck })}
          />
          <SwitchRow
            label="Download updates in the background"
            description="A found version downloads quietly, then a small notice offers a restart."
            checked={settings.updates.autoDownload}
            disabled={!settings.updates.autoCheck}
            onChange={autoDownload => patch({ autoDownload })}
          />
        </Group>
        <Callout icon={<ShieldCheck size={16} />}>
          Every update is checked against TypeNext’s signing key before it
          installs. Your notes are saved first.
        </Callout>
      </Section>
    </>
  )
}
