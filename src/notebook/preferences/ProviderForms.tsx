import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  Cloud,
  LoaderCircle,
  Plus,
  Radar,
  RefreshCw,
  X,
} from 'lucide-react'
import {
  cloudflareAccounts,
  getProviderModels,
  testProvider,
  type ProviderModel,
} from '../../services/completion'
import type {
  NotebookSettings,
  ProviderId,
  ProviderProfile,
} from '../../types/notebook'
import { PROVIDERS } from '../model'
import { StatusLine, errorText, type Tone } from './controls'
import { KEY_LINKS } from './engine'
import { KeyField } from './KeyField'
import { ModelList } from './ModelList'
import type { ExternalProvider, PaneProps } from './types'
import { catalogFor, catalogModel } from '../provider-catalog'

export const SERVER_PRESETS = [
  { name: 'LM Studio', endpoint: 'http://localhost:1234/v1' },
  { name: 'Jan', endpoint: 'http://127.0.0.1:1337/v1' },
  { name: 'Lemonade', endpoint: 'http://localhost:13305/v1' },
  { name: 'llama.cpp', endpoint: 'http://localhost:8080/v1' },
] as const

function hostOf(endpoint: string) {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** Deliberate catalog requests, cancelled when the target changes. */
function useModelDiscovery(provider: ProviderId, endpoint: string) {
  // Cloudflare's endpoint includes the account; callers pass both joined.
  const [models, setModels] = useState<ProviderModel[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ tone: Tone; text: string }>({
    tone: 'neutral',
    text: '',
  })
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    request.current?.abort()
    request.current = null
    setLoading(false)
    setModels(null)
    setStatus({ tone: 'neutral', text: '' })
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [provider, endpoint])
  const load = async (settings: NotebookSettings) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setStatus({ tone: 'busy', text: 'Connecting…' })
    try {
      const available =
        provider === 'local' || provider === 'custom'
          ? (
              await testProvider({ ...settings, provider }, controller.signal)
            ).map(id => ({ id, name: id }))
          : await getProviderModels(
              provider,
              settings.profiles[provider],
              controller.signal
            )
      if (request.current !== controller || controller.signal.aborted) return
      setModels(available)
      setStatus({
        tone: 'ok',
        text: available.length
          ? `Connected. ${available.length} model${available.length === 1 ? '' : 's'} available.`
          : 'Connection is ready.',
      })
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        setStatus({
          tone: 'error',
          text: errorText(error, 'The connection did not respond.'),
        })
    } finally {
      if (request.current === controller) {
        request.current = null
        setLoading(false)
      }
    }
  }
  return { models, loading, status, load }
}

function patchProfile(
  props: Pick<PaneProps, 'update' | 'latest'>,
  provider: ProviderId,
  patch: Partial<ProviderProfile>,
  extra: Partial<NotebookSettings> = {}
) {
  const settings = props.latest()
  props.update({
    ...extra,
    profiles: {
      ...settings.profiles,
      [provider]: { ...settings.profiles[provider], ...patch },
    },
  })
}

function ProtocolField({
  provider,
  profile,
  onChange,
}: {
  provider: ProviderId
  profile: ProviderProfile
  onChange(protocol: ProviderProfile['protocol']): void
}) {
  return (
    <>
      <label className="pref-field-label" htmlFor={`protocol-${provider}`}>
        Completion protocol
      </label>
      <select
        id={`protocol-${provider}`}
        value={profile.protocol}
        onChange={event =>
          onChange(event.target.value as ProviderProfile['protocol'])
        }
      >
        <option value="chat">Instruction model (recommended for prose)</option>
        <option value="fim">Native FIM through llama.cpp /infill</option>
      </select>
      <p className="pref-help">
        FIM needs a model trained for infill and a server with the /infill
        endpoint. Many FIM models are trained for code.
      </p>
    </>
  )
}

function ModelField({
  provider,
  value,
  placeholder,
  loading,
  canLoad,
  loadLabel,
  onLoad,
  onChange,
}: {
  provider: ProviderId
  value: string
  placeholder: string
  loading: boolean
  canLoad: boolean
  loadLabel: string
  onLoad(): void
  onChange(value: string): void
}) {
  return (
    <>
      <label className="pref-field-label" htmlFor={`model-${provider}`}>
        Model
      </label>
      <div className="pref-input-action">
        <input
          id={`model-${provider}`}
          value={value}
          maxLength={512}
          spellCheck={false}
          autoComplete="off"
          onChange={event => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="button secondary is-compact"
          disabled={loading || !canLoad}
          onClick={onLoad}
        >
          {loading ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {loadLabel}
        </button>
      </div>
    </>
  )
}

/** Endpoint presets, model detection and a searchable list for a local server. */
export function LocalServerForm({ settings, update, latest }: PaneProps) {
  const profile = settings.profiles.local
  const discovery = useModelDiscovery('local', profile.endpoint)
  const patch = (next: Partial<ProviderProfile>) =>
    patchProfile(
      { update, latest },
      'local',
      next,
      next.model?.trim() ? { localEngine: 'server' } : {}
    )
  return (
    <div className="pref-card pref-form">
      <span className="pref-field-label" id="local-presets-label">
        Server app
      </span>
      <div
        className="pref-presets"
        role="group"
        aria-labelledby="local-presets-label"
      >
        {SERVER_PRESETS.map(preset => (
          <button
            key={preset.name}
            type="button"
            className="pref-preset"
            aria-pressed={profile.endpoint === preset.endpoint}
            onClick={() => patch({ endpoint: preset.endpoint })}
          >
            <span>{preset.name}</span>
            <small>{hostOf(preset.endpoint)}</small>
          </button>
        ))}
      </div>
      <label className="pref-field-label" htmlFor="endpoint-local">
        Server address
      </label>
      <div className="pref-input-action">
        <input
          id="endpoint-local"
          value={profile.endpoint}
          type="url"
          spellCheck={false}
          onChange={event => patch({ endpoint: event.target.value })}
          placeholder="http://localhost:1234/v1"
        />
        <button
          type="button"
          className="button secondary is-compact"
          disabled={discovery.loading || !profile.endpoint.trim()}
          onClick={() => {
            void discovery.load(latest())
          }}
        >
          {discovery.loading ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Radar size={14} />
          )}
          Detect models
        </button>
      </div>
      <StatusLine tone={discovery.status.tone}>
        {discovery.status.text ||
          'Start your server app, load a model, then detect it here.'}
      </StatusLine>
      <label className="pref-field-label" htmlFor="model-local">
        Model
      </label>
      <input
        id="model-local"
        value={profile.model}
        maxLength={512}
        spellCheck={false}
        autoComplete="off"
        onChange={event => patch({ model: event.target.value })}
        placeholder="Pick a detected model or paste its identifier"
      />
      {discovery.models && discovery.models.length > 0 && (
        <ModelList
          models={discovery.models}
          value={profile.model}
          onPick={model => patch({ model })}
        />
      )}
      <details className="pref-disclosure">
        <summary>
          Advanced server options <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div className="pref-disclosure-body">
          <KeyField
            id="provider:local"
            label="API key (if your local server requires one)"
            placeholder="Usually not needed"
          />
          <ProtocolField
            provider="local"
            profile={profile}
            onChange={protocol => patch({ protocol })}
          />
        </div>
      </details>
      <p className="pref-help">
        A small instruction model is a good start. Your server manages downloads
        and inference.{' '}
        <a
          href="https://github.com/ggml-org/llama.cpp"
          target="_blank"
          rel="noreferrer"
        >
          About llama.cpp <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      </p>
    </div>
  )
}

/** A dropdown of models TypeNext ships for this provider. */
function CatalogSelect({
  provider,
  value,
  onChange,
}: {
  provider: ProviderId
  value: string
  onChange(value: string): void
}) {
  const catalog = catalogFor(provider)
  const known = catalog.some(model => model.id === value.trim())
  const chosen = catalogModel(provider, value)
  const recommended = catalog.filter(model => model.recommended)
  const others = catalog.filter(model => !model.recommended)
  return (
    <div className="pref-catalog">
      <label className="pref-field-label" htmlFor={`catalog-${provider}`}>
        Choose a model
      </label>
      <select
        id={`catalog-${provider}`}
        value={known ? value.trim() : ''}
        onChange={event => {
          if (event.target.value) onChange(event.target.value)
        }}
      >
        <option value="">
          {value.trim() ? `Other: ${value.trim()}` : 'Choose…'}
        </option>
        <optgroup label="Recommended">
          {recommended.map(model => (
            <option key={model.id} value={model.id}>
              {model.name} — {model.note}
            </option>
          ))}
        </optgroup>
        {others.length > 0 && (
          <optgroup label="More models">
            {others.map(model => (
              <option key={model.id} value={model.id}>
                {model.name} — {model.note}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {chosen && <p className="pref-help">{chosen.id}</p>}
    </div>
  )
}

/** Cloudflare needs the account that owns Workers AI. */
function CloudflareAccountField({
  value,
  onChange,
}: {
  value: string
  onChange(value: string): void
}) {
  const [status, setStatus] = useState<{ tone: Tone; text: string }>({
    tone: 'neutral',
    text: '',
  })
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([])
  const valid = !value || /^[a-f0-9]{32}$/iu.test(value.trim())
  const detect = async () => {
    setStatus({ tone: 'busy', text: 'Looking for accounts…' })
    try {
      const found = await cloudflareAccounts()
      setAccounts(found)
      if (found.length === 1) onChange(found[0]!.id)
      setStatus(
        found.length
          ? {
              tone: 'ok',
              text:
                found.length === 1
                  ? `Using ${found[0]!.name}.`
                  : 'Choose an account below.',
            }
          : {
              tone: 'neutral',
              text: 'This token cannot list accounts. Copy the account ID from the Cloudflare dashboard (Workers AI → Use REST API), or add “Account Settings: Read” to the token.',
            }
      )
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return (
    <div className="pref-cloudflare-account">
      <label className="pref-field-label" htmlFor="cloudflare-account">
        Account ID
      </label>
      <div className="pref-input-action">
        <input
          id="cloudflare-account"
          value={value}
          spellCheck={false}
          autoComplete="off"
          maxLength={64}
          aria-invalid={!valid}
          placeholder="32 characters, for example 0123456789abcdef0123456789abcdef"
          onChange={event => onChange(event.target.value.trim())}
        />
        <button
          type="button"
          className="button secondary is-compact"
          onClick={() => void detect()}
        >
          <RefreshCw size={14} /> Find
        </button>
      </div>
      {accounts.length > 1 && (
        <select
          aria-label="Cloudflare account"
          value={value}
          onChange={event => onChange(event.target.value)}
        >
          <option value="">Choose an account…</option>
          {accounts.map(account => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      )}
      <StatusLine tone={valid ? status.tone : 'error'}>
        {valid
          ? status.text ||
            'Find it in the Cloudflare dashboard under Workers AI → Use REST API. Save the token first to use Find.'
          : 'An account ID has 32 letters and numbers.'}
      </StatusLine>
    </div>
  )
}

/** Key, model and activation for one hosted provider. */
export function ProviderDetail({
  provider,
  settings,
  update,
  latest,
  active,
  onKeySaved,
  onActivate,
  onDeactivate,
}: Pick<PaneProps, 'settings' | 'update' | 'latest'> & {
  provider: ExternalProvider
  active: boolean
  onKeySaved(present: boolean): void
  onActivate(): void
  onDeactivate(): void
}) {
  const profile = settings.profiles[provider]
  const name = PROVIDERS[provider]
  const discovery = useModelDiscovery(
    provider,
    `${profile.endpoint}\u0000${profile.accountId ?? ''}`
  )
  const patch = (next: Partial<ProviderProfile>) =>
    patchProfile({ update, latest }, provider, next)
  const saved = profile.savedModels ?? []
  const catalog = catalogFor(provider)
  const model = profile.model.trim()
  const ready = Boolean(model && profile.endpoint.trim())
  const endpointField = (
    <>
      <label className="pref-field-label" htmlFor={`endpoint-${provider}`}>
        Server address
      </label>
      <input
        id={`endpoint-${provider}`}
        value={profile.endpoint}
        type="url"
        spellCheck={false}
        onChange={event => patch({ endpoint: event.target.value })}
        placeholder="https://api.example.com/v1"
      />
    </>
  )
  return (
    <div
      className="pref-card pref-form"
      role="group"
      aria-label={`${name} settings`}
    >
      <div className="pref-card-heading">
        <h4>{name}</h4>
        {KEY_LINKS[provider] && (
          <a href={KEY_LINKS[provider]} target="_blank" rel="noreferrer">
            Get a key <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        )}
      </div>
      {provider === 'custom' && (
        <>
          {endpointField}
          <p className="pref-help">
            Any OpenAI-compatible endpoint over HTTPS.
          </p>
        </>
      )}
      <KeyField
        id={`provider:${provider}`}
        label={
          provider === 'custom'
            ? 'API key (if required)'
            : provider === 'cloudflare'
              ? 'API token'
              : 'API key'
        }
        onSaved={onKeySaved}
      />
      {provider === 'cloudflare' && (
        <CloudflareAccountField
          value={profile.accountId ?? ''}
          onChange={accountId => patch({ accountId })}
        />
      )}
      {catalog.length > 0 && (
        <CatalogSelect
          provider={provider}
          value={profile.model}
          onChange={value => patch({ model: value })}
        />
      )}
      <ModelField
        provider={provider}
        value={profile.model}
        placeholder={
          catalog.length
            ? 'Or paste any model identifier'
            : 'Load the list or paste a model identifier'
        }
        loading={discovery.loading}
        canLoad={Boolean(profile.endpoint.trim())}
        loadLabel={discovery.models ? 'Reload' : 'Load models'}
        onLoad={() => {
          void discovery.load(latest())
        }}
        onChange={value => patch({ model: value })}
      />
      <StatusLine tone={discovery.status.tone}>
        {discovery.status.text ||
          (catalog.length
            ? 'Choose a model above, or load every model your account can use.'
            : 'Save your key, then load the models your account can use.')}
      </StatusLine>
      {discovery.models && discovery.models.length > 0 && (
        <ModelList
          models={discovery.models}
          value={profile.model}
          freeFilter={provider === 'openrouter'}
          onPick={id => patch({ model: id })}
        />
      )}
      <div className="pref-saved">
        <span className="pref-field-label" id={`saved-${provider}`}>
          Saved models
        </span>
        <div
          className="pref-saved-list"
          role="group"
          aria-labelledby={`saved-${provider}`}
        >
          {saved.map(item => (
            <span
              key={item}
              className={`pref-saved-chip ${item === profile.model ? 'is-chosen' : ''}`}
            >
              <button
                type="button"
                title={item}
                aria-pressed={item === profile.model}
                onClick={() => patch({ model: item })}
              >
                {item}
              </button>
              <button
                type="button"
                className="pref-saved-remove"
                aria-label={`Remove ${item}`}
                onClick={() =>
                  patch({
                    savedModels: saved.filter(entry => entry !== item),
                  })
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="pref-chip is-dashed"
            disabled={!model || saved.includes(model)}
            onClick={() =>
              patch({
                savedModels: [...new Set([model, ...saved])].slice(0, 32),
              })
            }
          >
            <Plus size={12} aria-hidden="true" />
            Save this model
          </button>
        </div>
        <p className="pref-help">
          Saved models appear in the quick switcher beside the editor.
        </p>
      </div>
      {provider !== 'custom' ? (
        <details className="pref-disclosure">
          <summary>
            Connection details <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="pref-disclosure-body">
            {endpointField}
            <p className="pref-help">
              Change this only for a compatible proxy or gateway.
            </p>
          </div>
        </details>
      ) : (
        <details className="pref-disclosure">
          <summary>
            Connection details <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="pref-disclosure-body">
            <ProtocolField
              provider={provider}
              profile={profile}
              onChange={protocol => patch({ protocol })}
            />
          </div>
        </details>
      )}
      <div className={`pref-activation ${active ? 'is-active' : ''}`}>
        <Cloud size={16} aria-hidden="true" />
        <p>
          While {name} is active, nearby writing, your objective, instructions
          and relevant attached context are sent there for suggestions. Its
          privacy and billing terms apply.
        </p>
        {active ? (
          <button
            type="button"
            className="button secondary is-compact"
            onClick={onDeactivate}
          >
            Switch to this device
          </button>
        ) : (
          <button
            type="button"
            className="button primary is-compact"
            disabled={!ready}
            title={ready ? undefined : 'Choose a model first'}
            onClick={onActivate}
          >
            Use {name} continuously
          </button>
        )}
      </div>
    </div>
  )
}
