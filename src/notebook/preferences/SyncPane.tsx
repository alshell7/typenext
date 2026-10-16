import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react'
import type { GitSyncSettings } from '../../types/notebook'
import {
  checkGitRepository,
  gitInstallHint,
  gitSyncAvailable,
  initGitRepository,
  type GitRepoStatus,
} from '../../services/git-sync'
import { syncNow, useGitSyncState } from '../useGitSync'
import { relativeDate } from '../model'
import {
  Callout,
  CommandBlock,
  Group,
  Pill,
  Row,
  Section,
  StatusLine,
  SwitchRow,
  errorText,
  type Tone,
} from './controls'
import type { PaneProps } from './types'

function when(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return relativeDate(time).toLocaleLowerCase()
}

export function SyncPane({ settings, update, latest }: PaneProps) {
  const git = settings.git
  const sync = useGitSyncState()
  const [repo, setRepo] = useState<GitRepoStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [remote, setRemote] = useState('')
  const [message, setMessage] = useState<{ tone: Tone; text: string }>({
    tone: 'neutral',
    text: '',
  })
  const patch = (next: Partial<GitSyncSettings>) =>
    update({ git: { ...latest().git, ...next } })
  const check = useCallback(async (folder: string) => {
    setChecking(true)
    try {
      setRepo(await checkGitRepository(folder || '.'))
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'Git could not be checked.'),
      })
    } finally {
      setChecking(false)
    }
  }, [])
  useEffect(() => {
    if (gitSyncAvailable()) void check(git.folder)
  }, [check, git.folder, sync.at])

  if (!gitSyncAvailable())
    return (
      <Section
        title="Git sync"
        description="Git sync needs the TypeNext desktop app."
      >
        <p className="pref-help">
          The browser preview keeps notes in this browser only.
        </p>
      </Section>
    )

  const choose = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const folder = await open({
      directory: true,
      multiple: false,
      title: 'Choose a folder for your notes',
    })
    if (typeof folder === 'string') patch({ folder })
  }
  const setUp = async () => {
    setMessage({ tone: 'busy', text: 'Setting up the repository…' })
    try {
      setRepo(await initGitRepository(git.folder, remote))
      setMessage({ tone: 'ok', text: 'The repository is ready.' })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'The repository could not be set up.'),
      })
    }
  }
  const hint = gitInstallHint()
  const ready = Boolean(repo?.gitInstalled && repo.isRepo && git.folder)
  const statusPill =
    sync.phase === 'syncing' ? (
      <Pill tone="busy">Syncing</Pill>
    ) : sync.phase === 'error' ? (
      <Pill tone="error">Needs attention</Pill>
    ) : sync.phase === 'offline' ? (
      <Pill tone="neutral">Offline · saved locally</Pill>
    ) : sync.at ? (
      <Pill tone="ok">Synced {when(sync.at)}</Pill>
    ) : git.enabled ? (
      <Pill>Waiting</Pill>
    ) : (
      <Pill>Off</Pill>
    )

  return (
    <>
      <div className="pref-hero">
        <span className="pref-hero-icon" aria-hidden="true">
          <GitBranch size={18} />
        </span>
        <p>
          TypeNext can keep every note as a Markdown file in a Git repository.
          It commits after you stop writing, brings in changes from your other
          computers, and keeps both versions when the same note changed in two
          places.
        </p>
      </div>
      <Section title="Repository" aside={statusPill}>
        {repo && !repo.gitInstalled && (
          <Callout tone="error" icon={<GitBranch size={16} />}>
            <p>
              <strong>Git is not installed.</strong> {hint.text}
            </p>
            {hint.command && (
              <CommandBlock command={hint.command} label="Install command" />
            )}
            <p>
              <a href={hint.url} target="_blank" rel="noreferrer">
                Download Git
              </a>
            </p>
          </Callout>
        )}
        {repo?.gitInstalled && (
          <p className="pref-help">Using {repo.gitVersion ?? 'git'}.</p>
        )}
        <label className="pref-field-label" htmlFor="git-folder">
          Folder
        </label>
        <div className="pref-input-action">
          <input
            id="git-folder"
            value={git.folder}
            readOnly
            placeholder="Choose a folder"
          />
          <button
            type="button"
            className="button secondary is-compact"
            onClick={() => void choose()}
          >
            <FolderOpen size={14} /> Choose
          </button>
        </div>
        {git.folder && repo?.gitInstalled && !repo.isRepo && (
          <div className="pref-card pref-form">
            <p>This folder is not a Git repository yet.</p>
            <label className="pref-field-label" htmlFor="git-remote">
              Remote address (optional)
            </label>
            <input
              id="git-remote"
              value={remote}
              spellCheck={false}
              placeholder="git@github.com:you/notes.git"
              onChange={event => setRemote(event.target.value)}
            />
            <p className="pref-help">
              Use an empty private repository. TypeNext uses your existing Git
              sign-in (SSH key or credential helper) and never stores passwords.
            </p>
            <button
              type="button"
              className="button primary is-compact"
              onClick={() => void setUp()}
            >
              Set up repository
            </button>
          </div>
        )}
        {ready && repo && (
          <dl className="pref-facts">
            <div>
              <dt>Branch</dt>
              <dd>{repo.branch ?? '—'}</dd>
            </div>
            <div>
              <dt>Remote</dt>
              <dd>{repo.remote ?? 'None. Commits stay on this computer.'}</dd>
            </div>
            <div>
              <dt>Last commit</dt>
              <dd>
                {repo.lastCommit
                  ? `${repo.lastCommit.message} · ${when(repo.lastCommit.time)}`
                  : 'None yet'}
              </dd>
            </div>
            {(repo.ahead > 0 || repo.behind > 0) && (
              <div>
                <dt>Waiting</dt>
                <dd>
                  {repo.ahead} to send · {repo.behind} to receive
                </dd>
              </div>
            )}
          </dl>
        )}
        <StatusLine tone={sync.phase === 'error' ? 'error' : message.tone}>
          {sync.phase === 'error' ? sync.message : sync.message || message.text}
        </StatusLine>
      </Section>
      <Section title="Sync">
        <Group>
          <SwitchRow
            label="Sync notes with Git"
            description="Notes are written to the notes folder of the repository."
            checked={git.enabled}
            disabled={!ready}
            onChange={enabled => patch({ enabled })}
          />
          <SwitchRow
            label="Sync after writing pauses"
            description="Otherwise sync only on start, on the interval, or with Sync now."
            checked={git.autoSync}
            disabled={!git.enabled}
            onChange={autoSync => patch({ autoSync })}
          />
          <Row label="Wait after writing" htmlFor="git-delay">
            <select
              id="git-delay"
              value={git.delaySeconds}
              onChange={event =>
                patch({ delaySeconds: Number(event.target.value) })
              }
            >
              <option value={15}>15 seconds</option>
              <option value={60}>1 minute</option>
              <option value={300}>5 minutes</option>
              <option value={900}>15 minutes</option>
            </select>
          </Row>
          <Row label="Look for remote changes" htmlFor="git-pull">
            <select
              id="git-pull"
              value={git.pullMinutes}
              onChange={event =>
                patch({ pullMinutes: Number(event.target.value) })
              }
            >
              <option value={0}>Only on start</option>
              <option value={5}>Every 5 minutes</option>
              <option value={10}>Every 10 minutes</option>
              <option value={30}>Every 30 minutes</option>
            </select>
          </Row>
          <SwitchRow
            label="Send commits to the remote"
            description="Turn off to keep commits on this computer."
            checked={git.push}
            disabled={!git.enabled}
            onChange={push => patch({ push })}
          />
        </Group>
        <div className="pref-actions">
          <button
            type="button"
            className="button secondary is-compact"
            disabled={!git.enabled || sync.phase === 'syncing'}
            onClick={() => void syncNow()}
          >
            {sync.phase === 'syncing' ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Sync now
          </button>
          <button
            type="button"
            className="button subtle is-compact"
            disabled={checking || !git.folder}
            onClick={() => void check(git.folder)}
          >
            Check repository
          </button>
        </div>
      </Section>
    </>
  )
}
