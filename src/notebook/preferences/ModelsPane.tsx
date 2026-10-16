import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  Cloud,
  Feather,
  HardDrive,
  Server,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import {
  getBuiltinState,
  subscribeBuiltinState,
} from '../../services/builtin-engine'
import { getSecret } from '../../services/native'
import type { NotebookSettings } from '../../types/notebook'
import { BuiltinModelPanel } from '../BuiltinModelPanel'
import { PROVIDERS } from '../model'
import { Callout, Pill, Section, TileGroup, type TileOption } from './controls'
import {
  activateExternal,
  activateLocal,
  canActivate,
  engineSummary,
  usingExternal,
} from './engine'
import { LocalServerForm, ProviderDetail } from './ProviderForms'
import {
  EXTERNAL_PROVIDERS,
  type ExternalProvider,
  type PaneProps,
} from './types'

type KeyState = Partial<Record<ExternalProvider, boolean>>

/** Which hosted providers have a key in this session or the vault. */
function useProviderKeys() {
  const [keys, setKeys] = useState<KeyState>({})
  useEffect(() => {
    let alive = true
    for (const provider of EXTERNAL_PROVIDERS)
      void getSecret(`provider:${provider}`)
        .then(secret => Boolean(secret.trim()))
        .catch(() => false)
        .then(present => {
          if (alive) setKeys(current => ({ ...current, [provider]: present }))
        })
    return () => {
      alive = false
    }
  }, [])
  const mark = (provider: ExternalProvider, present: boolean) =>
    setKeys(current => ({ ...current, [provider]: present }))
  return [keys, mark] as const
}

function ActiveEngine({
  settings,
  keys,
  onUseLocal,
  onUseExternal,
  onOpenSuggestions,
}: {
  settings: NotebookSettings
  keys: KeyState
  onUseLocal(): void
  onUseExternal(provider: ExternalProvider): void
  onOpenSuggestions(): void
}) {
  const summary = engineSummary(settings)
  const candidate = settings.externalProvider
  const candidateReady =
    canActivate(settings, candidate) &&
    (candidate === 'custom' || keys[candidate] === true)
  return (
    <div
      className={`pref-engine ${summary.external ? 'is-external' : ''}`}
      aria-label="Active engine"
      role="group"
    >
      <span className="pref-engine-icon" aria-hidden="true">
        {summary.external ? <Cloud size={18} /> : <ShieldCheck size={18} />}
      </span>
      <div className="pref-engine-text">
        <span className="pref-eyebrow">Suggestions come from</span>
        <strong>{summary.title}</strong>
        <span className="pref-engine-detail">
          {summary.detail}
          {!settings.suggestionsEnabled && (
            <>
              {' · '}
              <button
                type="button"
                className="pref-link"
                onClick={onOpenSuggestions}
              >
                inline suggestions are off
              </button>
            </>
          )}
        </span>
      </div>
      <div className="pref-engine-side">
        <Pill tone={summary.external ? 'external' : 'ok'}>
          {summary.external ? 'External' : 'On this device'}
        </Pill>
        {summary.external ? (
          <button
            type="button"
            className="button secondary is-compact"
            onClick={onUseLocal}
          >
            <ShieldCheck size={14} /> Switch to this device
          </button>
        ) : (
          candidateReady && (
            <button
              type="button"
              className="button subtle is-compact"
              onClick={() => onUseExternal(candidate)}
            >
              <Cloud size={14} /> Use {PROVIDERS[candidate]}
            </button>
          )
        )}
      </div>
    </div>
  )
}

function builtinMeta(status: ReturnType<typeof getBuiltinState>) {
  if (status.status === 'ready' || status.status === 'generating')
    return <Pill tone="ok">Loaded</Pill>
  if (status.status === 'downloading')
    return <Pill tone="busy">{Math.floor(status.progress)}%</Pill>
  if (status.status === 'loading' || status.status === 'checking')
    return <Pill tone="busy">Checking</Pill>
  if (status.cached) return <Pill>Downloaded</Pill>
  return <Pill>139 MB download</Pill>
}

function providerMeta(
  settings: NotebookSettings,
  provider: ExternalProvider,
  keys: KeyState
) {
  const profile = settings.profiles[provider]
  if (usingExternal(settings) && settings.provider === provider)
    return <Pill tone="ok">In use</Pill>
  if (provider === 'custom' && !profile.endpoint.trim())
    return <Pill>Add an endpoint</Pill>
  const key = keys[provider]
  if (key === undefined && provider !== 'custom')
    return <Pill tone="busy">Checking</Pill>
  if (!key && provider !== 'custom') return <Pill>Add a key</Pill>
  if (!profile.model.trim()) return <Pill>Choose a model</Pill>
  return <Pill tone="ok">Ready</Pill>
}

const PROVIDER_BLURBS: Record<ExternalProvider, string> = {
  openrouter: 'Many models with one key, including free ones.',
  openai: 'GPT models with your OpenAI key.',
  anthropic: 'Claude models with your Anthropic key.',
  custom: 'Any OpenAI-compatible endpoint.',
}

export function ModelsPane(
  props: PaneProps & { focus?: 'local' | 'external' }
) {
  const { settings, update, latest, onPaneChange, focus } = props
  const [keys, markKey] = useProviderKeys()
  const builtin = useSyncExternalStore(
    subscribeBuiltinState,
    getBuiltinState,
    getBuiltinState
  )
  // The detail beneath the local options follows the writer's last choice,
  // so unloading the built-in model does not collapse the panel they used.
  const [viewing, setViewing] = useState(settings.localEngine)
  const external = usingExternal(settings)
  useEffect(() => {
    if (!focus) return
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(`models-${focus}`)
        ?.scrollIntoView?.({ block: 'start' })
    )
    return () => cancelAnimationFrame(frame)
  }, [focus])
  const apply = (next: NotebookSettings) => update(next)
  const localOptions: TileOption<NotebookSettings['localEngine']>[] = [
    {
      value: 'recall',
      title: 'Writing starters & recall',
      description: 'Short starters and phrases recalled from your writing.',
      icon: <Feather size={16} />,
      meta: <Pill tone="ok">No setup</Pill>,
    },
    {
      value: 'embedded',
      title: 'Built-in model',
      description: 'SmolLM2 runs inside TypeNext, fully offline.',
      icon: <HardDrive size={16} />,
      meta: builtinMeta(builtin),
    },
    {
      value: 'server',
      title: 'Local server',
      description: 'LM Studio, Jan, Lemonade or llama.cpp on this computer.',
      icon: <Server size={16} />,
      meta: settings.profiles.local.model.trim() ? (
        <Pill tone="ok">{settings.profiles.local.model}</Pill>
      ) : (
        <Pill>Not connected</Pill>
      ),
    },
  ]
  return (
    <>
      <ActiveEngine
        settings={settings}
        keys={keys}
        onUseLocal={() => apply(activateLocal(latest()))}
        onUseExternal={provider => apply(activateExternal(latest(), provider))}
        onOpenSuggestions={() => onPaneChange('suggestions')}
      />
      <Section
        id="models-local"
        title="On this device"
        description="Private by default. Nothing you write leaves your computer."
      >
        {external && (
          <Callout
            icon={<Cloud size={16} />}
            tone="external"
            action={
              <button
                type="button"
                className="button secondary is-compact"
                onClick={() => apply(activateLocal(latest()))}
              >
                Use on this device
              </button>
            }
          >
            {PROVIDERS[settings.provider]} writes suggestions right now. Your
            choice here applies when you switch back.
          </Callout>
        )}
        <TileGroup
          label="Use on this device"
          value={settings.localEngine}
          options={localOptions}
          className="is-three"
          onChange={engine => {
            setViewing(engine)
            update({ localEngine: engine })
          }}
        />
        <div className="pref-reveal" key={viewing}>
          {viewing === 'recall' && (
            <div className="pref-card pref-explainer">
              <Sparkles size={16} aria-hidden="true" />
              <p>
                With no model connected, TypeNext offers short writing starters
                and recalls phrases from your note and its references. Attach
                references in Contexts to give recall more to draw on.
              </p>
            </div>
          )}
          {viewing === 'embedded' && (
            <BuiltinModelPanel
              active={
                settings.localEngine === 'embedded' &&
                settings.provider === 'local'
              }
              onUse={() => apply(activateLocal(latest(), 'embedded'))}
              onDisable={() => update({ localEngine: 'recall' })}
            />
          )}
          {viewing === 'server' && <LocalServerForm {...props} />}
        </div>
      </Section>
      <Section
        id="models-external"
        title="External providers"
        description="Hosted models can write richer suggestions. They are used only after you turn one on."
      >
        <TileGroup
          label="Configure provider"
          value={settings.externalProvider}
          className="is-four"
          options={EXTERNAL_PROVIDERS.map(provider => ({
            value: provider,
            title: PROVIDERS[provider],
            description: PROVIDER_BLURBS[provider],
            meta: providerMeta(settings, provider, keys),
          }))}
          onChange={provider => update({ externalProvider: provider })}
        />
        <div className="pref-reveal" key={settings.externalProvider}>
          <ProviderDetail
            provider={settings.externalProvider}
            settings={settings}
            update={update}
            latest={latest}
            active={external && settings.provider === settings.externalProvider}
            onKeySaved={present => markKey(settings.externalProvider, present)}
            onActivate={() =>
              apply(activateExternal(latest(), settings.externalProvider))
            }
            onDeactivate={() => apply(activateLocal(latest()))}
          />
        </div>
      </Section>
    </>
  )
}
