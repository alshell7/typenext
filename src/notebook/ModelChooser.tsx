import { useEffect, useRef, useState } from 'react'
import {
  Cloud,
  Download,
  Monitor,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import type { NotebookSettings, ProviderId } from '../types/notebook'
import { PROVIDERS } from './model'
import { Modal } from './Modal'
import './model-chooser.css'

export function ModelChooser({
  open,
  onOpenChange,
  settings,
  onChange,
  onConfigure,
  onConfigureLocal,
  onActivated,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  settings: NotebookSettings
  onChange(settings: NotebookSettings): void
  onConfigure(): void
  onConfigureLocal(): void
  onActivated?(): void
}) {
  const [selected, setSelected] = useState<ProviderId>(
    settings.provider === 'local'
      ? settings.externalProvider
      : settings.provider
  )
  const pendingActivation = useRef(false)
  useEffect(() => {
    if (open)
      setSelected(
        settings.provider === 'local'
          ? settings.externalProvider
          : settings.provider
      )
  }, [open, settings.externalProvider, settings.provider])
  const profile = settings.profiles[selected]
  const external = selected !== 'local'
  const chooseModel = (model: string) =>
    onChange({
      ...settings,
      profiles: { ...settings.profiles, [selected]: { ...profile, model } },
    })
  const activate = (provider: ProviderId) => {
    const current = settings.profiles[provider]
    onChange({
      ...settings,
      provider,
      externalAutoEnabled: provider !== 'local',
      ...(provider !== 'local' ? { externalProvider: provider } : {}),
      profiles: {
        ...settings.profiles,
        [provider]: {
          ...current,
          savedModels: [
            ...new Set([current.model, ...(current.savedModels ?? [])]),
          ]
            .filter(Boolean)
            .slice(0, 32),
        },
      },
    })
    pendingActivation.current = true
    onOpenChange(false)
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={event => {
        if (pendingActivation.current) {
          pendingActivation.current = false
          event.preventDefault()
          onActivated?.()
        }
      }}
      title="Choose your suggestion engine"
      description="Switch whenever you like. Your choice stays active as you write."
      className="model-chooser"
    >
      <button
        className={`engine-local ${settings.provider === 'local' ? 'selected' : ''}`}
        onClick={() => activate('local')}
      >
        <ShieldCheck size={20} />
        <span>
          <strong>On this device</strong>
          <small>
            {settings.localEngine === 'embedded'
              ? 'Downloaded model'
              : settings.localEngine === 'server' &&
                  settings.profiles.local.model
                ? settings.profiles.local.model
                : 'Writing starters & reference recall'}
          </small>
        </span>
        <span>{settings.provider === 'local' ? 'Active' : 'Use local'}</span>
      </button>
      <button
        className="button subtle engine-local-setup"
        onClick={() => {
          onOpenChange(false)
          onConfigureLocal()
        }}
      >
        <Download size={14} />
        {settings.localEngine === 'recall'
          ? 'Download a small offline model'
          : 'Local model settings'}
      </button>
      <div
        className="engine-provider-tabs"
        role="group"
        aria-label="External providers"
      >
        {(['openrouter', 'openai', 'anthropic', 'custom'] as const).map(id => (
          <button
            key={id}
            aria-pressed={selected === id}
            className={selected === id ? 'selected' : ''}
            onClick={() => setSelected(id)}
          >
            {PROVIDERS[id]}
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor="quick-model">
        Model
      </label>
      <input
        id="quick-model"
        list="quick-model-list"
        value={profile.model}
        maxLength={256}
        spellCheck={false}
        onChange={event => chooseModel(event.target.value)}
        placeholder="Choose a saved model or paste its identifier"
      />
      <datalist id="quick-model-list">
        {[...new Set([profile.model, ...(profile.savedModels ?? [])])]
          .filter(Boolean)
          .map(id => (
            <option key={id} value={id} />
          ))}
      </datalist>
      {!!profile.savedModels?.length && (
        <div className="saved-models" aria-label="Saved models">
          {profile.savedModels.map(id => (
            <button
              key={id}
              className={profile.model === id ? 'selected' : ''}
              title={id}
              onClick={() => chooseModel(id)}
            >
              {id}
            </button>
          ))}
        </div>
      )}
      <p className="engine-disclosure">
        <Cloud size={16} />
        <span>
          While {PROVIDERS[selected]} is active, nearby writing, your objective,
          instructions, and relevant attached context are sent there for
          suggestions. Its privacy and billing terms apply. Return to{' '}
          <strong>On this device</strong> at any time.
        </span>
      </p>
      <div className="dialog-footer">
        <button
          className="button subtle"
          onClick={() => {
            onOpenChange(false)
            onConfigure()
          }}
        >
          <SlidersHorizontal size={15} /> Keys & models
        </button>
        <button
          className="button primary"
          disabled={
            !external || !profile.model.trim() || !profile.endpoint.trim()
          }
          onClick={() => activate(selected)}
        >
          <Monitor size={15} /> Use {PROVIDERS[selected]} continuously
        </button>
      </div>
    </Modal>
  )
}
