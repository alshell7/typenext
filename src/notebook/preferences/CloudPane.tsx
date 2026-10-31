import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  Check,
  Cloud,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderSymlink,
  KeyRound,
  Link2,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wand2,
  Zap,
} from 'lucide-react'
import type { CloudSyncSettings, CloudTarget, Note } from '../../types/notebook'
import { isDesktop } from '../../services/native'
import { saveMarkdownFile } from '../../services/storage'
import { newNote } from '../model'
import { spaceList } from '../spaces/spaces'
import {
  WrongKeyError,
  suggestSyncKey,
  syncKeyProblem,
  syncKeyStrength,
} from '../../services/cloud-sync/crypto'
import {
  attachVault,
  changeSyncKey,
  createVaultIn,
  deviceId,
  defaultDeviceName,
  discoverVaults,
  forgetTargetSecrets,
  lockDevice,
  newTargetId,
  pathsExist,
  readHeader,
  rememberedKeyring,
  renewRecoveryKeys,
  revokeDevice,
  saveTargetSecret,
  targetLabel,
  transportFor,
  unlockVault,
  type FoundVault,
} from '../../services/cloud-sync/session'
import {
  D1Transport,
  NeonTransport,
  createD1Database,
  d1Available,
  listD1Databases,
  parseNeonConnection,
  type D1Database,
  type SyncTransport,
} from '../../services/cloud-sync/transport'
import { clearTargetState } from '../../services/cloud-sync/state'
import { ago, platformIcon } from '../cloud/CloudStatus'
import {
  cloudSyncNow,
  reloadCloudSync,
  useCloudSyncState,
} from '../cloud/useCloudSync'
import type { TargetStatus } from '../cloud/controller'
import {
  Callout,
  Group,
  Pill,
  Row,
  Section,
  Segmented,
  StatusLine,
  SwitchRow,
  errorText,
  type Tone,
} from './controls'
import type { PaneProps } from './types'

type Message = { tone: Tone; text: string }
const QUIET: Message = { tone: 'neutral', text: '' }

/** A password-style field with show and hide. */
function SecretInput({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
  invalid,
  describedBy,
}: {
  id: string
  value: string
  onChange(value: string): void
  placeholder?: string
  autoFocus?: boolean
  invalid?: boolean
  describedBy?: string
}) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="pref-key-row">
      <input
        id={id}
        type={reveal ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={event => onChange(event.target.value)}
      />
      <button
        type="button"
        className="pref-icon-button"
        aria-label={reveal ? 'Hide' : 'Show'}
        aria-pressed={reveal}
        onClick={() => setReveal(value => !value)}
      >
        {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

function StrengthMeter({ value }: { value: string }) {
  const strength = value ? Math.max(1, syncKeyStrength(value)) : 0
  const words = ['', 'Weak', 'Fair', 'Good', 'Strong']
  return (
    <div
      className="cloud-strength"
      data-strength={strength}
      aria-hidden={!value}
    >
      <span className="cloud-strength-bars">
        {[1, 2, 3, 4].map(level => (
          <span key={level} className={level <= strength ? 'is-on' : ''} />
        ))}
      </span>
      <span className="cloud-strength-text">{words[strength]}</span>
    </div>
  )
}

/** Choose the sync key that encrypts everything. */
function SyncKeyForm({
  submitLabel,
  busy,
  onSubmit,
  intro,
}: {
  submitLabel: string
  busy: boolean
  onSubmit(passphrase: string): void
  intro?: ReactNode
}) {
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const problem = syncKeyProblem(passphrase)
  const mismatch = confirm.length > 0 && confirm !== passphrase
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (problem || passphrase !== confirm) return
    onSubmit(passphrase)
  }
  return (
    <form className="pref-form cloud-key-form" onSubmit={submit}>
      {intro}
      <label className="pref-field-label" htmlFor="cloud-new-key">
        Sync key
      </label>
      <SecretInput
        id="cloud-new-key"
        value={passphrase}
        onChange={setPassphrase}
        placeholder="At least 10 characters"
        autoFocus
        invalid={touched && Boolean(problem)}
      />
      <div className="cloud-key-meta">
        <StrengthMeter value={passphrase} />
        <button
          type="button"
          className="button subtle is-compact"
          onClick={() => {
            const suggestion = suggestSyncKey()
            setPassphrase(suggestion)
            setConfirm('')
          }}
        >
          <Wand2 size={13} /> Suggest one
        </button>
      </div>
      <label className="pref-field-label" htmlFor="cloud-confirm-key">
        Type it again
      </label>
      <SecretInput
        id="cloud-confirm-key"
        value={confirm}
        onChange={setConfirm}
        invalid={mismatch || (touched && confirm !== passphrase)}
      />
      <StatusLine tone="error" reserve={false}>
        {touched && problem
          ? problem
          : mismatch || (touched && confirm !== passphrase)
            ? 'The two entries differ.'
            : ''}
      </StatusLine>
      <p className="pref-help">
        Every device asks for this key once. TypeNext cannot recover it for you.
        Your recovery keys can.
      </p>
      <div className="pref-form-actions">
        <button
          type="submit"
          className="button primary is-compact"
          disabled={busy}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <KeyRound size={14} />
          )}
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

/** Shown once: the keys that can reset the sync key. */
function RecoveryKeys({
  keys,
  onDone,
  doneLabel = 'Done',
}: {
  keys: string[]
  onDone(): void
  doneLabel?: string
}) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = [
    'TypeNext recovery keys',
    '',
    'Each key can open your encrypted notebook and set a new sync key.',
    'Keep them somewhere safe and private, apart from your devices.',
    '',
    ...keys.map((key, index) => `${index + 1}. ${key}`),
    '',
    `Made ${new Date().toLocaleString()}`,
  ].join('\n')
  return (
    <div className="cloud-recovery" role="group" aria-label="Recovery keys">
      <Callout tone="external" icon={<ShieldCheck size={16} />}>
        <p>
          <strong>Save your recovery keys now.</strong> If you forget the sync
          key, any one of them opens your notebook. They are shown only once.
        </p>
      </Callout>
      <ol className="cloud-recovery-list">
        {keys.map(key => (
          <li key={key}>
            <code>{key}</code>
          </li>
        ))}
      </ol>
      <div className="pref-actions">
        <button
          type="button"
          className="button secondary is-compact"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy all'}
        </button>
        <button
          type="button"
          className="button secondary is-compact"
          onClick={() => {
            const note: Note = {
              ...newNote('TypeNext recovery keys'),
              content: text,
            }
            void saveMarkdownFile(note, true).catch(() => undefined)
          }}
        >
          <Download size={14} /> Save as a file
        </button>
      </div>
      <label className="pref-check">
        <input
          type="checkbox"
          checked={saved}
          onChange={event => setSaved(event.target.checked)}
        />
        I have stored my recovery keys
      </label>
      <div className="pref-form-actions">
        <button
          type="button"
          className="button primary is-compact"
          disabled={!saved}
          onClick={onDone}
        >
          {doneLabel}
        </button>
      </div>
    </div>
  )
}

/** Open the encrypted notebook with the sync key or a recovery key. */
function UnlockForm({
  found,
  onUnlocked,
  submitLabel = 'Open',
}: {
  found: FoundVault
  onUnlocked(via: 'sync-key' | 'recovery-key'): void
  submitLabel?: string
}) {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(QUIET)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!secret.trim()) return
    setBusy(true)
    setMessage({ tone: 'busy', text: 'Opening…' })
    try {
      const { via } = await unlockVault(found.header, secret, deviceId())
      setMessage(QUIET)
      onUnlocked(via)
    } catch (error) {
      setMessage({
        tone: 'error',
        text:
          error instanceof WrongKeyError
            ? error.message
            : errorText(error, 'The notebook could not be opened.'),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="pref-form" onSubmit={event => void submit(event)}>
      <label className="pref-field-label" htmlFor="cloud-unlock">
        Sync key or recovery key
      </label>
      <SecretInput
        id="cloud-unlock"
        value={secret}
        onChange={setSecret}
        autoFocus
      />
      <p className="pref-help">
        Created {new Date(found.header.createdAt).toLocaleDateString()}. The key
        stays on this device, so you enter it only once.
      </p>
      <StatusLine tone={message.tone} reserve={false}>
        {message.text}
      </StatusLine>
      <div className="pref-form-actions">
        <button
          type="submit"
          className="button primary is-compact"
          disabled={busy || !secret.trim()}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Lock size={14} />
          )}
          {submitLabel}
        </button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------ Add database

type AddStep =
  | { name: 'connect' }
  | { name: 'unlock'; found: FoundVault[]; target: CloudTarget }
  | { name: 'create'; transport: SyncTransport; target: CloudTarget }
  | { name: 'recovery'; keys: string[]; target: CloudTarget }

function AddDatabase({
  kind,
  cloud,
  onCancel,
  onAdded,
}: {
  kind: CloudTarget['kind']
  cloud: CloudSyncSettings
  onCancel(): void
  onAdded(target: CloudTarget, message: string): void
}) {
  const [step, setStep] = useState<AddStep>({ name: 'connect' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(QUIET)
  const [connection, setConnection] = useState('')
  const [live, setLive] = useState(true)
  const [realtimeUrl, setRealtimeUrl] = useState('')
  const [realtimeSecret, setRealtimeSecret] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [databases, setDatabases] = useState<D1Database[] | null>(null)
  const [databaseId, setDatabaseId] = useState('new')
  const [pendingId] = useState(newTargetId)
  const [unlockIndex, setUnlockIndex] = useState(0)

  const cancel = () => {
    void forgetTargetSecrets(pendingId)
    onCancel()
  }

  const loadDatabases = async () => {
    setBusy(true)
    setMessage({ tone: 'busy', text: 'Loading your D1 databases…' })
    try {
      const list = await listD1Databases(accountId.trim(), apiSecret.trim())
      setDatabases(list)
      const existing = list.find(item => item.name === 'typenext-sync')
      setDatabaseId(existing?.uuid ?? 'new')
      setMessage({
        tone: 'ok',
        text: list.length
          ? `${list.length} databases in this account.`
          : 'No databases yet.',
      })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'The databases could not be loaded.'),
      })
    } finally {
      setBusy(false)
    }
  }

  /** The device already holds the key of a notebook in another database. */
  const knownVault = async () => {
    for (const target of cloud.targets) {
      if (!target.vaultId || !(await rememberedKeyring(target.vaultId)))
        continue
      try {
        const found = await readHeader(
          await transportFor(target),
          target.vaultId
        )
        if (found) return found
      } catch {
        // Try the next database.
      }
    }
    return null
  }

  const connect = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage({ tone: 'busy', text: 'Connecting…' })
    try {
      let transport: SyncTransport
      let target: CloudTarget
      if (kind === 'neon') {
        const parsed = parseNeonConnection(connection)
        if (
          live &&
          realtimeUrl.trim() &&
          !/^https:\/\//u.test(realtimeUrl.trim())
        )
          throw new Error('The Realtime URL starts with https://.')
        if (live && realtimeUrl.trim() && !realtimeSecret.trim())
          throw new Error(
            'Paste the Realtime secret too, or turn Live updates off.'
          )
        transport = new NeonTransport(connection.trim())
        await saveTargetSecret(pendingId, 'connection', connection)
        const useLive = live && realtimeUrl.trim() && realtimeSecret.trim()
        if (useLive)
          await saveTargetSecret(pendingId, 'realtime', realtimeSecret)
        target = {
          id: pendingId,
          kind,
          label: targetLabel(
            'neon',
            `${parsed.database} · ${parsed.host.split('.')[0]!.replace(/-pooler$/u, '')}`
          ),
          enabled: true,
          ...(useLive ? { realtimeUrl: realtimeUrl.trim() } : {}),
          addedAt: Date.now(),
        }
      } else {
        if (!/^[a-f0-9]{32}$/iu.test(accountId.trim()))
          throw new Error(
            'The account ID has 32 letters and digits. Find it in the Cloudflare dashboard.'
          )
        if (!apiSecret.trim())
          throw new Error('Paste an API token with D1 Edit permission.')
        let database = databases?.find(item => item.uuid === databaseId)
        if (!database) {
          setMessage({
            tone: 'busy',
            text: 'Creating the database typenext-sync…',
          })
          const list =
            databases ??
            (await listD1Databases(accountId.trim(), apiSecret.trim()))
          database =
            list.find(item => item.name === 'typenext-sync') ??
            (await createD1Database(
              accountId.trim(),
              apiSecret.trim(),
              'typenext-sync'
            ))
        }
        transport = new D1Transport(
          accountId.trim(),
          database.uuid,
          apiSecret.trim()
        )
        await saveTargetSecret(pendingId, 'api', apiSecret)
        target = {
          id: pendingId,
          kind,
          label: targetLabel('d1', database.name),
          enabled: true,
          accountId: accountId.trim().toLowerCase(),
          databaseId: database.uuid,
          addedAt: Date.now(),
        }
      }
      setMessage({ tone: 'busy', text: 'Looking for your encrypted notebook…' })
      const found = await discoverVaults(transport)
      const known = await knownVault()
      const match = found.find(
        item => known && item.header.vaultId === known.header.vaultId
      )
      if (match) {
        onAdded(
          { ...target, vaultId: match.header.vaultId },
          'Connected. This database already holds your notebook.'
        )
        return
      }
      if (found.length) {
        setMessage(QUIET)
        setStep({ name: 'unlock', found, target })
        return
      }
      if (known) {
        await attachVault(transport, known.header)
        onAdded(
          { ...target, vaultId: known.header.vaultId },
          'Connected. Your notebook is now kept in this database too, with the same keys.'
        )
        return
      }
      setMessage(QUIET)
      setStep({ name: 'create', transport, target })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'The database could not be reached.'),
      })
    } finally {
      setBusy(false)
    }
  }

  const create = async (passphrase: string) => {
    if (step.name !== 'create') return
    setBusy(true)
    setMessage({ tone: 'busy', text: 'Encrypting… this takes a moment.' })
    try {
      const vault = await createVaultIn(step.transport, passphrase)
      setMessage(QUIET)
      setStep({
        name: 'recovery',
        keys: vault.recoveryKeys,
        target: { ...step.target, vaultId: vault.header.vaultId },
      })
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'The notebook could not be created.'),
      })
    } finally {
      setBusy(false)
    }
  }

  const title = kind === 'neon' ? 'Neon Postgres' : 'Cloudflare D1'
  return (
    <div className="pref-card cloud-add pref-reveal">
      <div className="pref-card-heading">
        <div>
          <h4>
            {step.name === 'connect'
              ? `Connect ${title}`
              : step.name === 'unlock'
                ? 'Open your encrypted notebook'
                : step.name === 'create'
                  ? 'Create your sync key'
                  : 'Your recovery keys'}
          </h4>
          <p className="pref-help">
            {step.name === 'connect'
              ? 'Credentials stay in this device’s credential vault and are never synced.'
              : step.name === 'unlock'
                ? 'This database already holds a TypeNext notebook. Enter its key to join.'
                : step.name === 'create'
                  ? 'Everything is encrypted with this key before it leaves this device.'
                  : 'Each one can reset your sync key.'}
          </p>
        </div>
        <ol className="cloud-steps" aria-label="Steps">
          {['Connect', 'Key', 'Done'].map((label, index) => {
            const at =
              step.name === 'connect' ? 0 : step.name === 'recovery' ? 2 : 1
            return (
              <li
                key={label}
                className={
                  index < at ? 'is-done' : index === at ? 'is-current' : ''
                }
                aria-current={index === at ? 'step' : undefined}
              >
                {label}
              </li>
            )
          })}
        </ol>
      </div>

      {step.name === 'connect' && (
        <form className="pref-form" onSubmit={event => void connect(event)}>
          {kind === 'neon' ? (
            <>
              <label className="pref-field-label" htmlFor="cloud-neon">
                Connection string
              </label>
              <SecretInput
                id="cloud-neon"
                value={connection}
                onChange={setConnection}
                placeholder="postgresql://user:password@ep-….neon.tech/neondb"
                autoFocus
              />
              <p className="pref-help">
                In the Neon console: <em>Connect</em> → copy the connection
                string.
              </p>
              <Group className="cloud-live-switch">
                <SwitchRow
                  label="Live updates"
                  description="With Neon Realtime, changes from other devices arrive within a second, without polling."
                  checked={live}
                  onChange={setLive}
                />
              </Group>
              {live && (
                <div className="pref-reveal cloud-live-fields">
                  <label className="pref-field-label" htmlFor="cloud-rt-url">
                    Realtime URL
                  </label>
                  <input
                    id="cloud-rt-url"
                    value={realtimeUrl}
                    spellCheck={false}
                    placeholder="https://ep-….rt….neon.tech"
                    onChange={event => setRealtimeUrl(event.target.value)}
                  />
                  <label className="pref-field-label" htmlFor="cloud-rt-secret">
                    Realtime secret
                  </label>
                  <SecretInput
                    id="cloud-rt-secret"
                    value={realtimeSecret}
                    onChange={setRealtimeSecret}
                    placeholder="nrt_…"
                  />
                  <p className="pref-help">
                    In the Neon console: <em>Realtime</em>. Leave empty to check
                    for changes every few seconds instead.
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              {!d1Available() && (
                <Callout tone="error">
                  <p>Cloudflare D1 sync needs the TypeNext desktop app.</p>
                </Callout>
              )}
              <label className="pref-field-label" htmlFor="cloud-cf-account">
                Account ID
              </label>
              <input
                id="cloud-cf-account"
                value={accountId}
                spellCheck={false}
                autoFocus
                placeholder="32 letters and digits"
                onChange={event => {
                  setAccountId(event.target.value)
                  setDatabases(null)
                }}
              />
              <label className="pref-field-label" htmlFor="cloud-cf-secret">
                API token
              </label>
              <SecretInput
                id="cloud-cf-secret"
                value={apiSecret}
                onChange={value => {
                  setApiSecret(value)
                  setDatabases(null)
                }}
                placeholder="A token with D1 Edit permission"
              />
              <div className="pref-actions">
                <button
                  type="button"
                  className="button secondary is-compact"
                  disabled={busy || !accountId.trim() || !apiSecret.trim()}
                  onClick={() => void loadDatabases()}
                >
                  <Database size={14} />{' '}
                  {databases ? 'Reload databases' : 'Choose a database'}
                </button>
              </div>
              {databases && (
                <Row
                  label="Database"
                  htmlFor="cloud-cf-database"
                  description="TypeNext adds three tables. Other tables stay untouched."
                >
                  <select
                    id="cloud-cf-database"
                    value={databaseId}
                    onChange={event => setDatabaseId(event.target.value)}
                  >
                    {!databases.some(item => item.name === 'typenext-sync') && (
                      <option value="new">New database: typenext-sync</option>
                    )}
                    {databases.map(item => (
                      <option key={item.uuid} value={item.uuid}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
            </>
          )}
          <StatusLine tone={message.tone}>{message.text}</StatusLine>
          <div className="pref-form-actions">
            <button
              type="button"
              className="button subtle is-compact"
              onClick={cancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button primary is-compact"
              disabled={
                busy ||
                (kind === 'neon'
                  ? !connection.trim()
                  : !accountId.trim() || !apiSecret.trim() || !d1Available())
              }
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Link2 size={14} />
              )}
              Connect
            </button>
          </div>
        </form>
      )}

      {step.name === 'unlock' && (
        <>
          {step.found.length > 1 && (
            <Row label="Notebook" htmlFor="cloud-vault-choice">
              <select
                id="cloud-vault-choice"
                value={unlockIndex}
                onChange={event => setUnlockIndex(Number(event.target.value))}
              >
                {step.found.map((item, index) => (
                  <option key={item.header.vaultId} value={index}>
                    Created {new Date(item.header.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <UnlockForm
            found={step.found[unlockIndex] ?? step.found[0]!}
            submitLabel="Open and sync"
            onUnlocked={via =>
              onAdded(
                {
                  ...step.target,
                  vaultId: (step.found[unlockIndex] ?? step.found[0]!).header
                    .vaultId,
                },
                via === 'recovery-key'
                  ? 'Opened with a recovery key. Set a new sync key under Security below.'
                  : 'Connected. Your notes arrive in a moment.'
              )
            }
          />
          <div className="pref-form-actions">
            <button
              type="button"
              className="button subtle is-compact"
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {step.name === 'create' && (
        <>
          <SyncKeyForm
            submitLabel="Encrypt and create"
            busy={busy}
            onSubmit={passphrase => void create(passphrase)}
          />
          <StatusLine tone={message.tone}>{message.text}</StatusLine>
        </>
      )}

      {step.name === 'recovery' && (
        <RecoveryKeys
          keys={step.keys}
          doneLabel="Start syncing"
          onDone={() =>
            onAdded(
              step.target,
              'Sync is on. Add your other devices with the same sync key.'
            )
          }
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Targets

function statusPill(status: TargetStatus | undefined, target: CloudTarget) {
  if (!target.enabled) return <Pill>Paused</Pill>
  switch (status?.phase) {
    case 'syncing':
      return <Pill tone="busy">Syncing</Pill>
    case 'synced':
      return (
        <Pill tone="ok">
          {status.live
            ? 'Live'
            : status.at
              ? `Synced ${ago(Date.now() - status.at)}`
              : 'Synced'}
        </Pill>
      )
    case 'locked':
      return <Pill tone="error">Needs your key</Pill>
    case 'credentials':
      return <Pill tone="error">Needs credentials</Pill>
    case 'revoked':
      return <Pill tone="error">Removed</Pill>
    case 'offline':
      return <Pill>Offline</Pill>
    case 'error':
      return <Pill tone="error">Needs attention</Pill>
    case 'setup':
      return <Pill tone="error">Not set up</Pill>
    default:
      return <Pill tone="busy">Connecting</Pill>
  }
}

function CredentialsForm({
  target,
  onSaved,
}: {
  target: CloudTarget
  onSaved(): void
}) {
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const [message, setMessage] = useState<Message>(QUIET)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      if (target.kind === 'neon') {
        parseNeonConnection(first)
        await saveTargetSecret(target.id, 'connection', first)
        if (target.realtimeUrl && second.trim())
          await saveTargetSecret(target.id, 'realtime', second)
      } else await saveTargetSecret(target.id, 'api', first)
      onSaved()
    } catch (error) {
      setMessage({
        tone: 'error',
        text: errorText(error, 'The credentials could not be saved.'),
      })
    }
  }
  return (
    <form className="pref-form" onSubmit={event => void save(event)}>
      <label className="pref-field-label" htmlFor={`cred-${target.id}`}>
        {target.kind === 'neon' ? 'Connection string' : 'API token'}
      </label>
      <SecretInput
        id={`cred-${target.id}`}
        value={first}
        onChange={setFirst}
        autoFocus
      />
      {target.kind === 'neon' && target.realtimeUrl && (
        <>
          <label className="pref-field-label" htmlFor={`cred-rt-${target.id}`}>
            Realtime secret
          </label>
          <SecretInput
            id={`cred-rt-${target.id}`}
            value={second}
            onChange={setSecond}
          />
        </>
      )}
      <StatusLine tone={message.tone} reserve={false}>
        {message.text}
      </StatusLine>
      <div className="pref-form-actions">
        <button
          type="submit"
          className="button primary is-compact"
          disabled={!first.trim()}
        >
          Save and connect
        </button>
      </div>
    </form>
  )
}

function TargetCard({
  target,
  status,
  onToggle,
  onRemove,
}: {
  target: CloudTarget
  status: TargetStatus | undefined
  onToggle(enabled: boolean): void
  onRemove(erase: boolean): Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [erase, setErase] = useState(false)
  const [found, setFound] = useState<FoundVault | null>(null)
  const [message, setMessage] = useState<Message>(QUIET)
  const locked = status?.phase === 'locked'
  useEffect(() => {
    if (!locked || !target.vaultId) return
    let active = true
    void transportFor(target)
      .then(transport => readHeader(transport, target.vaultId!))
      .then(header => {
        if (active) setFound(header)
      })
      .catch(error => {
        if (active)
          setMessage({
            tone: 'error',
            text: errorText(error, 'The database could not be reached.'),
          })
      })
    return () => {
      active = false
    }
  }, [locked, target])
  const Icon = target.kind === 'neon' ? Zap : Database
  return (
    <div className="cloud-target">
      <div className="cloud-target-main">
        <span
          className={`cloud-target-icon is-${target.kind}`}
          aria-hidden="true"
        >
          <Icon size={16} />
        </span>
        <div className="cloud-target-text">
          <strong>{target.label}</strong>
          <small>
            {target.kind === 'neon'
              ? target.realtimeUrl
                ? status?.live
                  ? 'Live updates on'
                  : 'Live updates connecting'
                : 'Checks for changes every few seconds'
              : 'Checks for changes every few seconds'}
            {status?.message && status.phase !== 'synced'
              ? ` · ${status.message}`
              : ''}
          </small>
        </div>
        {statusPill(status, target)}
        <label
          className="cloud-target-switch"
          title={target.enabled ? 'Pause this database' : 'Resume'}
        >
          <input
            type="checkbox"
            role="switch"
            className="pref-switch"
            aria-label={`Sync with ${target.label}`}
            checked={target.enabled}
            onChange={event => onToggle(event.target.checked)}
          />
        </label>
        <button
          type="button"
          className="pref-icon-button is-danger"
          aria-label={`Remove ${target.label}`}
          onClick={() => setConfirming(value => !value)}
        >
          <Trash2 size={15} />
        </button>
      </div>
      {locked && found && (
        <div className="cloud-target-fix pref-reveal">
          <UnlockForm found={found} onUnlocked={() => void reloadCloudSync()} />
        </div>
      )}
      {status?.phase === 'credentials' && (
        <div className="cloud-target-fix pref-reveal">
          <p className="pref-help">
            This device has no credentials for this database yet.
          </p>
          <CredentialsForm
            target={target}
            onSaved={() => void reloadCloudSync()}
          />
        </div>
      )}
      <StatusLine tone={message.tone} reserve={false}>
        {message.text}
      </StatusLine>
      {confirming && (
        <div
          className="pref-inline-confirm cloud-confirm pref-reveal"
          role="group"
          aria-label="Remove database"
        >
          <p>
            Stop syncing with this database on this device? Your notes stay
            here.
          </p>
          <label className="pref-check">
            <input
              type="checkbox"
              checked={erase}
              onChange={event => setErase(event.target.checked)}
            />
            Also erase the encrypted notebook from the database (your other
            devices stop syncing through it)
          </label>
          <div className="pref-form-actions">
            <button
              type="button"
              className="button subtle is-compact"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="button destructive is-compact"
              onClick={() => {
                setMessage({
                  tone: 'busy',
                  text: erase ? 'Erasing…' : 'Removing…',
                })
                void onRemove(erase).catch(error =>
                  setMessage({
                    tone: 'error',
                    text: errorText(
                      error,
                      'The database could not be removed.'
                    ),
                  })
                )
              }}
            >
              {erase ? 'Remove and erase' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Pane

async function vaultTransports(cloud: CloudSyncSettings, vaultId: string) {
  const transports: SyncTransport[] = []
  for (const target of cloud.targets.filter(item => item.vaultId === vaultId))
    transports.push(await transportFor(target))
  if (!transports.length) throw new Error('No database holds this notebook.')
  return transports
}

function SecuritySection({
  cloud,
  vaultId,
}: {
  cloud: CloudSyncSettings
  vaultId: string
}) {
  const [mode, setMode] = useState<'none' | 'change' | 'recovery'>('none')
  const [current, setCurrent] = useState('')
  const [keys, setKeys] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(QUIET)
  const reset = () => {
    setMode('none')
    setCurrent('')
    setKeys(null)
  }
  const change = async (next: string) => {
    setBusy(true)
    setMessage({ tone: 'busy', text: 'Updating every database…' })
    try {
      await changeSyncKey(
        await vaultTransports(cloud, vaultId),
        vaultId,
        current,
        next
      )
      setMessage({
        tone: 'ok',
        text: 'The sync key changed. Other devices keep syncing; new devices use the new key.',
      })
      reset()
    } catch (error) {
      setMessage({
        tone: 'error',
        text:
          error instanceof WrongKeyError
            ? 'The current key or recovery key is wrong.'
            : errorText(error, 'The key could not be changed.'),
      })
    } finally {
      setBusy(false)
    }
  }
  const renew = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage({ tone: 'busy', text: 'Making new recovery keys…' })
    try {
      setKeys(
        await renewRecoveryKeys(
          await vaultTransports(cloud, vaultId),
          vaultId,
          current
        )
      )
      setMessage(QUIET)
    } catch (error) {
      setMessage({
        tone: 'error',
        text:
          error instanceof WrongKeyError
            ? 'The current key or recovery key is wrong.'
            : errorText(error, 'New keys could not be made.'),
      })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Security"
      description="End-to-end encrypted with AES-256-GCM. The databases store only ciphertext, random ids and times, never titles, text or names."
    >
      <div className="pref-actions">
        <button
          type="button"
          className="button secondary is-compact"
          aria-pressed={mode === 'change'}
          onClick={() => setMode(mode === 'change' ? 'none' : 'change')}
        >
          <KeyRound size={14} /> Change sync key
        </button>
        <button
          type="button"
          className="button secondary is-compact"
          aria-pressed={mode === 'recovery'}
          onClick={() => setMode(mode === 'recovery' ? 'none' : 'recovery')}
        >
          <ShieldCheck size={14} /> New recovery keys
        </button>
        <button
          type="button"
          className="button subtle is-compact"
          onClick={() => {
            void lockDevice(vaultId).then(() => reloadCloudSync())
            setMessage({
              tone: 'ok',
              text: 'This device forgot the key. Enter it to sync again.',
            })
          }}
        >
          <Lock size={14} /> Lock this device
        </button>
      </div>
      {mode !== 'none' && !keys && (
        <div className="pref-card pref-reveal cloud-security-card">
          <label className="pref-field-label" htmlFor="cloud-current-key">
            Current sync key or a recovery key
          </label>
          <SecretInput
            id="cloud-current-key"
            value={current}
            onChange={setCurrent}
            autoFocus
          />
          {mode === 'change' ? (
            <SyncKeyForm
              submitLabel="Change sync key"
              busy={busy}
              onSubmit={next => void change(next)}
            />
          ) : (
            <form onSubmit={event => void renew(event)}>
              <p className="pref-help">The old recovery keys stop working.</p>
              <div className="pref-form-actions">
                <button
                  type="submit"
                  className="button primary is-compact"
                  disabled={busy || !current.trim()}
                >
                  Make new recovery keys
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {keys && <RecoveryKeys keys={keys} onDone={reset} />}
      <StatusLine tone={message.tone} reserve={false}>
        {message.text}
      </StatusLine>
    </Section>
  )
}

/** Notes another device linked to files: map them to a folder here. */
function FileLinks({
  notes,
  onLink,
}: {
  notes: Note[]
  onLink(paths: Record<string, string>): void
}) {
  const sync = useCloudSyncState()
  const [message, setMessage] = useState<Message>(QUIET)
  const groups = useMemo(() => {
    const unlinked = new Set(
      notes.filter(note => !note.filePath).map(note => note.id)
    )
    return sync.peerLinks
      .map(peer => {
        const entries = Object.entries(peer.links.notes).filter(([id]) =>
          unlinked.has(id)
        )
        if (!entries.length) return null
        const separator =
          entries[0]![1].includes('\\') && !entries[0]![1].includes('/')
            ? '\\'
            : '/'
        const parts = entries.map(([, path]) =>
          path.split(separator).slice(0, -1)
        )
        let root = parts[0] ?? []
        for (const other of parts) {
          let index = 0
          while (index < root.length && root[index] === other[index]) index++
          root = root.slice(0, index)
        }
        return { peer, entries, root: root.join(separator), separator }
      })
      .filter((group): group is NonNullable<typeof group> => group !== null)
  }, [notes, sync.peerLinks])
  if (!groups.length) return null
  const map = async (group: (typeof groups)[number]) => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const folder = await open({
      directory: true,
      multiple: false,
      title: `Choose the folder that matches ${group.root || 'these files'}`,
    })
    if (typeof folder !== 'string') return
    const local = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
    const candidates = group.entries.map(([id, path]) => {
      const relative = path
        .slice(group.root.length)
        .split(group.separator)
        .filter(Boolean)
      return [
        id,
        [folder.replace(/[\\/]+$/u, ''), ...relative].join(local),
      ] as const
    })
    const exists = await pathsExist(candidates.map(([, path]) => path))
    const found = Object.fromEntries(
      candidates.filter((_, index) => exists[index])
    )
    const count = Object.keys(found).length
    if (count) onLink(found)
    setMessage(
      count
        ? {
            tone: 'ok',
            text: `Linked ${count} of ${candidates.length} notes to their files here.`,
          }
        : {
            tone: 'error',
            text: 'None of the files are in that folder. Choose the folder that holds them.',
          }
    )
  }
  return (
    <Section
      title="Files on your other devices"
      description="File links stay on the device that made them. Map them to the same files here to save notes back to them."
    >
      {groups.map(group => (
        <div key={group.peer.device} className="cloud-link-row">
          <FolderSymlink size={16} aria-hidden="true" />
          <div className="cloud-link-text">
            <strong>
              {group.entries.length}{' '}
              {group.entries.length === 1 ? 'note' : 'notes'} from{' '}
              {group.peer.name}
            </strong>
            <small title={group.root}>{group.root || 'Several folders'}</small>
          </div>
          {isDesktop() ? (
            <button
              type="button"
              className="button secondary is-compact"
              onClick={() => void map(group)}
            >
              Map to a folder…
            </button>
          ) : (
            <small className="pref-help">
              Use the desktop app to map files.
            </small>
          )}
        </div>
      ))}
      <StatusLine tone={message.tone} reserve={false}>
        {message.text}
      </StatusLine>
    </Section>
  )
}

export function CloudPane({
  settings,
  update,
  latest,
  notes,
  spaces,
  onLinkFiles,
}: PaneProps & {
  notes: Note[]
  spaces: ReturnType<typeof spaceList>
  onLinkFiles(paths: Record<string, string>): void
}) {
  const cloud = settings.cloud
  const sync = useCloudSyncState()
  const [adding, setAdding] = useState<CloudTarget['kind'] | null>(null)
  const [message, setMessage] = useState<Message>(QUIET)
  const [confirmDevice, setConfirmDevice] = useState<string | null>(null)
  const patch = (next: Partial<CloudSyncSettings>) =>
    update({ cloud: { ...latest().cloud, ...next } })
  const vaultId = cloud.targets.find(target => target.vaultId)?.vaultId
  const self = deviceId()
  const hasTargets = cloud.targets.length > 0

  const added = (target: CloudTarget, text: string) => {
    patch({
      enabled: true,
      targets: [
        ...latest().cloud.targets.filter(item => item.id !== target.id),
        target,
      ],
    })
    setAdding(null)
    setMessage({ tone: 'ok', text })
  }
  const remove = async (target: CloudTarget, erase: boolean) => {
    if (erase && target.vaultId)
      await (await transportFor(target)).erase(target.vaultId)
    await clearTargetState(target.id)
    await forgetTargetSecrets(target.id)
    const targets = latest().cloud.targets.filter(item => item.id !== target.id)
    if (
      target.vaultId &&
      !targets.some(item => item.vaultId === target.vaultId)
    )
      await lockDevice(target.vaultId)
    patch({ targets, ...(targets.length ? {} : { enabled: false }) })
    setMessage({
      tone: 'ok',
      text: erase ? 'Removed and erased.' : 'Removed from this device.',
    })
  }
  const others = sync.devices.filter(device => !device.self)

  return (
    <>
      <div className="pref-hero">
        <span className="pref-hero-icon" aria-hidden="true">
          <Cloud size={18} />
        </span>
        <p>
          Keep notes, folders, tags, workspaces, contexts and preferences the
          same on every device. Everything is encrypted on this device before it
          leaves, with a sync key only you know. Use one database or several at
          once.
        </p>
      </div>

      <Section
        title="Databases"
        aside={
          sync.phase !== 'off' ? (
            <button
              type="button"
              className="button secondary is-compact"
              disabled={sync.phase === 'syncing'}
              onClick={() => void cloudSyncNow()}
            >
              {sync.phase === 'syncing' ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              Sync now
            </button>
          ) : undefined
        }
      >
        {cloud.targets.map(target => (
          <TargetCard
            key={target.id}
            target={target}
            status={sync.targets[target.id]}
            onToggle={enabled =>
              patch({
                targets: latest().cloud.targets.map(item =>
                  item.id === target.id ? { ...item, enabled } : item
                ),
              })
            }
            onRemove={erase => remove(target, erase)}
          />
        ))}
        {adding ? (
          <AddDatabase
            key={adding}
            kind={adding}
            cloud={cloud}
            onCancel={() => setAdding(null)}
            onAdded={added}
          />
        ) : (
          <div
            className={`cloud-choices ${hasTargets ? 'is-compact' : ''}`}
            role="group"
            aria-label="Add a database"
          >
            <button
              type="button"
              className="cloud-choice"
              onClick={() => setAdding('neon')}
            >
              <span className="cloud-choice-icon is-neon" aria-hidden="true">
                <Zap size={18} />
              </span>
              <span className="cloud-choice-text">
                <strong>
                  {hasTargets ? 'Add Neon Postgres' : 'Neon Postgres'}
                </strong>
                <small>
                  Serverless Postgres. Live updates with Neon Realtime.
                </small>
              </span>
              <Plus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="cloud-choice"
              onClick={() => setAdding('d1')}
            >
              <span className="cloud-choice-icon is-d1" aria-hidden="true">
                <Database size={18} />
              </span>
              <span className="cloud-choice-text">
                <strong>
                  {hasTargets ? 'Add Cloudflare D1' : 'Cloudflare D1'}
                </strong>
                <small>SQLite at the edge, in your Cloudflare account.</small>
              </span>
              <Plus size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        <StatusLine tone={message.tone} reserve={false}>
          {message.text}
        </StatusLine>
        {hasTargets && (
          <Group className="cloud-device-switch">
            <SwitchRow
              label="Sync this device"
              description="Turn off to keep this device’s notebook to itself for now."
              checked={cloud.enabled}
              onChange={enabled => patch({ enabled })}
            />
          </Group>
        )}
      </Section>

      {hasTargets && (
        <>
          <Section
            title="When to sync"
            aside={
              sync.pending ? <Pill>{sync.pending} to send</Pill> : undefined
            }
          >
            <Segmented
              label="When to sync"
              value={cloud.cadence}
              options={[
                { value: 'live', label: 'Live' },
                { value: 'interval', label: 'On a schedule' },
                { value: 'manual', label: 'Only when I ask' },
              ]}
              onChange={cadence => patch({ cadence })}
            />
            <p className="pref-help cloud-cadence-help">
              {cloud.cadence === 'live'
                ? 'Moments after you pause, and at once when another device changes something. When two devices share a note, edits travel within a second.'
                : cloud.cadence === 'interval'
                  ? 'On start and on a fixed schedule. Fewer requests to your database.'
                  : 'Only with Sync now. Devices still see where each other are.'}
            </p>
            {cloud.cadence === 'interval' && (
              <Group>
                <Row label="Sync every" htmlFor="cloud-interval">
                  <select
                    id="cloud-interval"
                    value={cloud.intervalMinutes}
                    onChange={event =>
                      patch({ intervalMinutes: Number(event.target.value) })
                    }
                  >
                    {[1, 5, 15, 30, 60, 240].map(minutes => (
                      <option key={minutes} value={minutes}>
                        {minutes < 60
                          ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
                          : `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
            )}
          </Section>

          <Section
            title="What to sync"
            description="API keys, file paths, Git folders, local model servers and this setup always stay on this device."
          >
            <Group>
              <SwitchRow
                label="Notes"
                checked={cloud.include.notes}
                onChange={notes =>
                  patch({ include: { ...latest().cloud.include, notes } })
                }
              />
              <SwitchRow
                label="Folders, tags and workspaces"
                checked={cloud.include.organize}
                onChange={organize =>
                  patch({ include: { ...latest().cloud.include, organize } })
                }
              />
              <SwitchRow
                label="Contexts"
                description="The context library and its contexts, with the text of each source."
                checked={cloud.include.contexts}
                onChange={contexts =>
                  patch({ include: { ...latest().cloud.include, contexts } })
                }
              />
              <SwitchRow
                label="Preferences"
                description="Appearance, editor, suggestions, models (without keys), history and shortcuts."
                checked={cloud.include.settings}
                onChange={value =>
                  patch({
                    include: { ...latest().cloud.include, settings: value },
                  })
                }
              />
            </Group>
            {spaces.length > 1 && (
              <div
                className="cloud-spaces"
                role="group"
                aria-label="Workspaces to sync"
              >
                <span className="pref-field-label">Workspaces</span>
                <div className="pref-suggested">
                  <button
                    type="button"
                    className="pref-chip"
                    aria-pressed={!cloud.spaceIds.length}
                    onClick={() => patch({ spaceIds: [] })}
                  >
                    All
                  </button>
                  {spaces.map(space => {
                    const on = cloud.spaceIds.includes(space.id)
                    return (
                      <button
                        key={space.id}
                        type="button"
                        className="pref-chip"
                        aria-pressed={on}
                        onClick={() => {
                          const next = on
                            ? cloud.spaceIds.filter(id => id !== space.id)
                            : [...cloud.spaceIds, space.id]
                          patch({
                            spaceIds: next.length === spaces.length ? [] : next,
                          })
                        }}
                      >
                        {space.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </Section>

          <Section
            title="Devices"
            description="Devices seen in the last few minutes show as active, with the note they have open."
          >
            <Group>
              <Row label="This device’s name" htmlFor="cloud-device-name">
                <input
                  id="cloud-device-name"
                  value={cloud.deviceName}
                  placeholder={defaultDeviceName()}
                  maxLength={64}
                  onChange={event => patch({ deviceName: event.target.value })}
                />
              </Row>
              <SwitchRow
                label="Share where I am"
                description="Other devices see which note is open here and when you are writing, so nobody edits blind. Encrypted like everything else."
                checked={cloud.presence}
                onChange={presence => patch({ presence })}
              />
            </Group>
            <ul className="cloud-devices" aria-label="Devices">
              {(sync.devices.length ? sync.devices : []).map(device => {
                const Icon = platformIcon(device.platform)
                const note = device.noteId
                  ? notes.find(item => item.id === device.noteId)
                  : undefined
                return (
                  <li
                    key={device.id}
                    className={`cloud-device ${device.active ? 'is-active' : ''}`}
                  >
                    <span className="cloud-device-icon" aria-hidden="true">
                      <Icon size={16} />
                      <span
                        className={`cloud-device-state ${device.editing ? 'is-editing' : device.active ? 'is-active' : ''}`}
                      />
                    </span>
                    <span className="cloud-device-text">
                      <strong>
                        {device.name}
                        {device.self || device.id === self ? (
                          <span className="pref-badge">This device</span>
                        ) : null}
                      </strong>
                      <small>
                        {device.active
                          ? device.editing
                            ? `Writing in “${note?.title || 'a note'}”`
                            : note
                              ? `Active · “${note.title || 'Untitled'}” open`
                              : 'Active now'
                          : `Last seen ${ago(device.age)}`}
                        {device.app ? ` · TypeNext ${device.app}` : ''}
                      </small>
                    </span>
                    {!device.self &&
                      vaultId &&
                      (confirmDevice === device.id ? (
                        <span className="cloud-device-confirm">
                          <button
                            type="button"
                            className="button subtle is-compact"
                            onClick={() => setConfirmDevice(null)}
                          >
                            Keep
                          </button>
                          <button
                            type="button"
                            className="button destructive is-compact"
                            onClick={() => {
                              setConfirmDevice(null)
                              void vaultTransports(cloud, vaultId)
                                .then(transports =>
                                  revokeDevice(transports, vaultId, device.id)
                                )
                                .then(() =>
                                  setMessage({
                                    tone: 'ok',
                                    text: `${device.name} will stop syncing and forget the key.`,
                                  })
                                )
                                .catch(error =>
                                  setMessage({
                                    tone: 'error',
                                    text: errorText(
                                      error,
                                      'The device could not be removed.'
                                    ),
                                  })
                                )
                            }}
                          >
                            Remove
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="pref-icon-button is-danger"
                          aria-label={`Remove ${device.name}`}
                          onClick={() => setConfirmDevice(device.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      ))}
                  </li>
                )
              })}
              {!sync.devices.length && (
                <li className="cloud-device is-empty">
                  Devices appear here once they sync.
                </li>
              )}
            </ul>
            {others.length === 0 && sync.devices.length > 0 && (
              <p className="pref-help">
                Add another device: install TypeNext there, add the same
                database in Cloud sync, and enter your sync key.
              </p>
            )}
          </Section>

          <FileLinks notes={notes} onLink={onLinkFiles} />

          {vaultId && <SecuritySection cloud={cloud} vaultId={vaultId} />}
        </>
      )}
    </>
  )
}
