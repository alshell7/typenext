import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  Monitor,
  ShieldCheck,
} from 'lucide-react'
import { getSecret, isDesktop, setSecret } from '../services/native'
import {
  testProvider,
  getProviderModels,
  type ProviderModel,
} from '../services/completion'
import type { NotebookSettings, ProviderId } from '../types/notebook'
import { FONTS, PROVIDERS } from './model'
import { Modal } from './Modal'
import { PalettePicker } from './PalettePicker'
import { BuiltinModelPanel } from './BuiltinModelPanel'

export type PreferencePane = 'writing' | 'local' | 'external'

function KeyField({ id, label = 'API key' }: { id: string; label?: string }) {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(false)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let active = true
    void getSecret(id)
      .then(secret => {
        if (active) setValue(secret)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [id])
  const save = async () => {
    setSaving(true)
    try {
      await setSecret(id, value.trim(), remember)
      setMessage(
        value.trim()
          ? remember && isDesktop()
            ? 'Saved in your device credential vault.'
            : 'Ready for this session.'
          : 'Key removed.'
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="key-field">
      <label className="field-label" htmlFor={`key-${id}`}>
        {label}
      </label>
      <div className="input-action">
        <input
          id={`key-${id}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={event => {
            setValue(event.target.value)
            setMessage('')
          }}
          placeholder="Paste your key"
        />
        <button
          className="button subtle"
          disabled={saving}
          onClick={() => {
            void save()
          }}
        >
          {saving ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}{' '}
          Save key
        </button>
      </div>
      {isDesktop() && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={remember}
            onChange={event => setRemember(event.target.checked)}
          />
          Remember in the device credential vault
        </label>
      )}
      <p className="field-help" role="status">
        {message ||
          'Keys stay in memory unless you choose to remember them on desktop.'}
      </p>
    </div>
  )
}

function Connection({
  provider,
  settings,
  onChange,
}: {
  provider: ProviderId
  settings: NotebookSettings
  onChange(settings: NotebookSettings): void
}) {
  const profile = settings.profiles[provider]
  const [models, setModels] = useState<ProviderModel[]>([])
  const [freeOnly, setFreeOnly] = useState(true)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    request.current?.abort()
    request.current = null
    setTesting(false)
    setModels([])
    setStatus('')
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [provider, profile.endpoint])
  const [status, setStatus] = useState('')
  const [testing, setTesting] = useState(false)
  const update = (patch: Partial<typeof profile>) =>
    onChange({
      ...settings,
      ...(provider === 'local' && patch.model?.trim()
        ? { localEngine: 'server' as const }
        : {}),
      profiles: { ...settings.profiles, [provider]: { ...profile, ...patch } },
    })
  const test = async () => {
    setTesting(true)
    setStatus('')
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const available =
        provider === 'local' || provider === 'custom'
          ? (
              await testProvider({ ...settings, provider }, controller.signal)
            ).map(id => ({
              id,
              name: id,
            }))
          : await getProviderModels(provider, profile, controller.signal)
      if (request.current !== controller || controller.signal.aborted) return
      setModels(available)
      setStatus(
        available.length
          ? `Connected. ${available.length} model${available.length === 1 ? '' : 's'} available.`
          : 'Connection is ready.'
      )
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      if (request.current === controller) {
        request.current = null
        setTesting(false)
      }
    }
  }
  return (
    <div className="connection-form">
      {provider === 'local' && (
        <div className="server-presets" aria-label="Local server presets">
          {[
            ['LM Studio', 'http://localhost:1234/v1'],
            ['Jan', 'http://127.0.0.1:1337/v1'],
            ['Lemonade', 'http://localhost:13305/v1'],
            ['llama.cpp', 'http://localhost:8080/v1'],
          ].map(([name, endpoint]) => (
            <button
              className={`preset-button ${profile.endpoint === endpoint ? 'selected' : ''}`}
              key={name}
              onClick={() => update({ endpoint })}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      <label className="field-label" htmlFor={`endpoint-${provider}`}>
        Server address
      </label>
      <input
        id={`endpoint-${provider}`}
        value={profile.endpoint}
        type="url"
        spellCheck={false}
        onChange={event => update({ endpoint: event.target.value })}
        placeholder="http://localhost:1234/v1"
      />
      <label className="field-label" htmlFor={`model-${provider}`}>
        Model
      </label>
      <input
        id={`model-${provider}`}
        list={`models-${provider}`}
        value={profile.model}
        spellCheck={false}
        onChange={event => update({ model: event.target.value })}
        placeholder={
          provider === 'local'
            ? 'Your loaded model identifier'
            : 'Model identifier from your provider'
        }
      />
      <datalist id={`models-${provider}`}>
        {models
          .filter(model => provider !== 'openrouter' || !freeOnly || model.free)
          .map(model => (
            <option value={model.id} key={model.id}>
              {model.name}
            </option>
          ))}
      </datalist>
      {provider === 'openrouter' && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={freeOnly}
            onChange={event => setFreeOnly(event.target.checked)}
          />{' '}
          Show free models in the model list
        </label>
      )}
      <div className="saved-models">
        {(profile.savedModels ?? []).map(model => (
          <button
            key={model}
            className={profile.model === model ? 'selected' : ''}
            onClick={() => update({ model })}
          >
            {model}
          </button>
        ))}
        <button
          disabled={!profile.model.trim()}
          onClick={() =>
            update({
              savedModels: [
                ...new Set([
                  profile.model.trim(),
                  ...(profile.savedModels ?? []),
                ]),
              ].slice(0, 32),
            })
          }
        >
          Save this model
        </button>
      </div>
      <p className="field-help">
        {provider === 'local'
          ? 'Start your local server, test the connection, then choose a loaded model. A small instruction model is a good starting point.'
          : 'Use the identifier supported by your account. Configure every provider here; your keys and saved models remain available when you switch.'}
      </p>
      <KeyField
        key={provider}
        id={`provider:${provider}`}
        label={
          provider === 'local'
            ? 'API key (if your local server requires one)'
            : 'API key'
        }
      />
      {(provider === 'local' || provider === 'custom') && (
        <details className="advanced-details">
          <summary>
            Advanced protocol <ChevronDown size={14} />
          </summary>
          <label className="field-label" htmlFor={`protocol-${provider}`}>
            Completion protocol
          </label>
          <select
            id={`protocol-${provider}`}
            value={profile.protocol}
            onChange={event =>
              update({ protocol: event.target.value as 'chat' | 'fim' })
            }
          >
            <option value="chat">
              Instruction model (recommended for prose)
            </option>
            <option value="fim">Native FIM through llama.cpp /infill</option>
          </select>
          <p className="field-help">
            FIM needs a model trained for infill and a server with the /infill
            endpoint. Many FIM models are trained for code.
          </p>
        </details>
      )}
      <div className="connection-test">
        <button
          className="button secondary"
          onClick={() => {
            void test()
          }}
          disabled={testing || !profile.endpoint}
        >
          {testing ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Monitor size={15} />
          )}{' '}
          {testing
            ? 'Connecting…'
            : provider === 'local' || provider === 'custom'
              ? 'Test connection'
              : 'Load available models'}
        </button>
        <p role="status">{status}</p>
      </div>
    </div>
  )
}

export function Preferences({
  open,
  onOpenChange,
  pane,
  onPaneChange,
  settings,
  onChange,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  pane: PreferencePane
  onPaneChange(pane: PreferencePane): void
  settings: NotebookSettings
  onChange(settings: NotebookSettings): void
}) {
  const tabs = useRef<Record<PreferencePane, HTMLButtonElement | null>>({
    writing: null,
    local: null,
    external: null,
  })
  const latestSettings = useRef(settings)
  latestSettings.current = settings
  const update = (patch: Partial<NotebookSettings>) =>
    onChange({ ...latestSettings.current, ...patch })
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Make yourself at home"
      description="A few preferences for your writing space."
      className="preferences-dialog"
      onEscapeKeyDown={event => {
        // Radix sees Escape before the input's own key handler. Let an invalid
        // colour draft restore its last saved value before closing Preferences.
        if (
          event.target instanceof HTMLElement &&
          event.target.dataset.invalidPaletteDraft === 'true'
        )
          event.preventDefault()
      }}
    >
      <div className="preference-tabs" role="tablist" aria-label="Preferences">
        {(
          [
            ['writing', 'Writing'],
            ['local', 'Local suggestions'],
            ['external', 'External models'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            ref={element => {
              tabs.current[id] = element
            }}
            id={`tab-${id}`}
            role="tab"
            tabIndex={pane === id ? 0 : -1}
            aria-selected={pane === id}
            aria-controls={`pane-${id}`}
            onClick={() => onPaneChange(id)}
            onKeyDown={event => {
              const order: PreferencePane[] = ['writing', 'local', 'external']
              const index = order.indexOf(id)
              const next =
                event.key === 'ArrowRight'
                  ? order[(index + 1) % order.length]
                  : event.key === 'ArrowLeft'
                    ? order[(index + order.length - 1) % order.length]
                    : event.key === 'Home'
                      ? order[0]
                      : event.key === 'End'
                        ? order[order.length - 1]
                        : undefined
              if (next) {
                event.preventDefault()
                onPaneChange(next)
                tabs.current[next]?.focus()
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="preference-body"
        role="tabpanel"
        id={`pane-${pane}`}
        aria-labelledby={`tab-${pane}`}
      >
        {pane === 'writing' && (
          <>
            <div className="field-grid">
              <div>
                <label className="field-label" htmlFor="writer-font">
                  Typeface
                </label>
                <select
                  id="writer-font"
                  value={settings.fontFamily}
                  onChange={event =>
                    update({
                      fontFamily: event.target.value,
                      ...(event.target.value === 'Times New Roman'
                        ? { fontSize: 16 }
                        : {}),
                    })
                  }
                >
                  {FONTS.map(font => (
                    <option key={font.name}>{font.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="writer-size">
                  Size (px)
                </label>
                <input
                  id="writer-size"
                  type="number"
                  min={12}
                  max={32}
                  value={settings.fontSize}
                  onChange={event =>
                    update({
                      fontSize: Math.min(
                        32,
                        Math.max(12, Number(event.target.value) || 17)
                      ),
                    })
                  }
                />
              </div>
            </div>
            <div
              className="font-preview"
              style={{
                fontFamily: FONTS.find(
                  font => font.name === settings.fontFamily
                )?.family,
                fontSize: settings.fontSize,
              }}
            >
              A thought becomes a sentence.
              <br />A sentence becomes a beginning.
            </div>
            <label className="field-label" htmlFor="writer-theme">
              Appearance
            </label>
            <select
              id="writer-theme"
              value={settings.theme}
              onChange={event =>
                update({
                  theme: event.target.value as NotebookSettings['theme'],
                })
              }
            >
              <option value="system">Follow system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <PalettePicker settings={settings} onChange={onChange} />
            <label className="setting-row">
              <span>
                <strong>Autosave</strong>
                <small>Keep a local copy as you write.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.autoSave}
                onChange={event => update({ autoSave: event.target.checked })}
              />
            </label>
            <div className="keyboard-reference">
              <span>
                New note <kbd>Ctrl / ⌘ N</kbd>
              </span>
              <span>
                Open <kbd>Ctrl / ⌘ O</kbd>
              </span>
              <span>
                Save <kbd>Ctrl / ⌘ S</kbd>
              </span>
              <span>
                Focus mode <kbd>Ctrl / ⌘ Shift F</kbd>
              </span>
            </div>
          </>
        )}
        {pane === 'local' && (
          <>
            <div className="privacy-note">
              <ShieldCheck size={18} />
              <p>
                Everyday suggestions stay on this device. With no model
                connected, TypeNext offers short writing starters and recalls
                phrases from your writing or references. Attachments are
                optional.
              </p>
            </div>
            <label className="setting-row">
              <span>
                <strong>Inline suggestions</strong>
                <small>You choose what enters the page.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.suggestionsEnabled}
                onChange={event =>
                  update({ suggestionsEnabled: event.target.checked })
                }
              />
            </label>
            <label className="setting-row">
              <span>
                <strong>Suggest after a pause</strong>
                <small>Use Ctrl / ⌘ Space to choose a continuation.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.autoSuggest}
                onChange={event =>
                  update({ autoSuggest: event.target.checked })
                }
              />
            </label>
            <div className="field-grid">
              <div>
                <label className="field-label" htmlFor="suggestion-length">
                  Suggestion length
                </label>
                <select
                  id="suggestion-length"
                  value={settings.suggestionLength}
                  onChange={event =>
                    update({
                      suggestionLength: event.target
                        .value as NotebookSettings['suggestionLength'],
                    })
                  }
                >
                  <option value="adaptive">Adapt to the sentence</option>
                  <option value="short">Just a few words</option>
                  <option value="sentence">Up to one sentence</option>
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="suggestion-pause">
                  Pause before suggesting
                </label>
                <select
                  id="suggestion-pause"
                  value={settings.suggestionDelay}
                  onChange={event =>
                    update({ suggestionDelay: Number(event.target.value) })
                  }
                >
                  <option value={650}>Quick (0.65s)</option>
                  <option value={1100}>Natural (1.1s)</option>
                  <option value={1800}>Unhurried (1.8s)</option>
                </select>
              </div>
            </div>
            <label className="field-label" htmlFor="suggestion-temperature">
              Creativity{' '}
              <span className="label-value">
                {settings.temperature.toFixed(2)}
              </span>
            </label>
            <input
              id="suggestion-temperature"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.temperature}
              onChange={event =>
                update({ temperature: Number(event.target.value) })
              }
            />
            <div className="range-labels">
              <span>Stay close</span>
              <span>Explore a little</span>
            </div>
            <h3 className="form-section-title">Suggestion instructions</h3>
            <label className="field-label" htmlFor="suggestion-instructions">
              How should the model continue your writing?
            </label>
            <textarea
              id="suggestion-instructions"
              rows={4}
              maxLength={2000}
              value={settings.suggestionInstructions}
              onChange={event =>
                update({ suggestionInstructions: event.target.value })
              }
              placeholder="Keep my voice. Prefer concrete language. For a few words, finish the phrase; for a line, add one concise sentence."
            />
            <p className="field-help">
              Applied to local and external models with the chosen suggestion
              length. These instructions never change your text by themselves.
            </p>
            <BuiltinModelPanel
              active={
                settings.localEngine === 'embedded' &&
                settings.provider === 'local'
              }
              onUse={() =>
                update({
                  localEngine: 'embedded',
                  provider: 'local',
                  externalAutoEnabled: false,
                })
              }
              onDisable={() => update({ localEngine: 'recall' })}
            />
            <h3 className="form-section-title">Local engine</h3>
            <label className="field-label" htmlFor="local-engine">
              Use on this device
            </label>
            <select
              id="local-engine"
              value={settings.localEngine}
              onChange={event =>
                update({
                  localEngine: event.target
                    .value as NotebookSettings['localEngine'],
                })
              }
            >
              <option value="recall">
                Writing starters & reference recall
              </option>
              <option value="embedded">Downloaded model inside TypeNext</option>
              <option value="server">Connect a local server</option>
            </select>
            <h3 className="form-section-title">Connect a local model</h3>
            <Connection
              provider="local"
              settings={settings}
              onChange={onChange}
            />
            <p className="field-help">
              Model downloads and inference are managed by your chosen local
              server.{' '}
              <a
                href="https://github.com/ggml-org/llama.cpp"
                target="_blank"
                rel="noreferrer"
              >
                About llama.cpp <ExternalLink size={12} />
              </a>
            </p>
          </>
        )}
        {pane === 'external' && (
          <>
            <div className="privacy-note">
              <ShieldCheck size={18} />
              <p>
                Configure providers independently, then choose a model beside
                the editor. Enabling an external model keeps it active for
                automatic and manual suggestions until you switch back to local.
              </p>
            </div>
            <label className="field-label" htmlFor="external-instructions">
              Suggestion instructions
            </label>
            <textarea
              id="external-instructions"
              rows={3}
              maxLength={2000}
              value={settings.suggestionInstructions}
              onChange={event =>
                update({ suggestionInstructions: event.target.value })
              }
              placeholder="Keep my voice. Suggest only a few words or one concise line."
            />
            <p className="field-help">
              Applies to every model. Choose a few words or a sentence in Local
              suggestions.
            </p>
            <label className="field-label" htmlFor="external-provider">
              Configure provider
            </label>
            <select
              id="external-provider"
              value={settings.externalProvider}
              onChange={event =>
                update({
                  externalProvider: event.target
                    .value as NotebookSettings['externalProvider'],
                })
              }
            >
              {(['openrouter', 'openai', 'anthropic', 'custom'] as const).map(
                id => (
                  <option key={id} value={id}>
                    {PROVIDERS[id]}
                  </option>
                )
              )}
            </select>
            <Connection
              key={settings.externalProvider}
              provider={settings.externalProvider}
              settings={settings}
              onChange={onChange}
            />
            <details className="advanced-details">
              <summary>
                Website import service <ChevronDown size={14} />
              </summary>
              <p className="field-help">
                Ordinary websites can be read directly. Firecrawl can help with
                sites that need JavaScript; it receives the website URL.
              </p>
              <label className="field-label" htmlFor="website-importer">
                Website importer
              </label>
              <select
                id="website-importer"
                value={settings.websiteImporter}
                onChange={event =>
                  update({
                    websiteImporter: event.target
                      .value as NotebookSettings['websiteImporter'],
                  })
                }
              >
                <option value="direct">Direct import</option>
                <option value="firecrawl">Firecrawl (external service)</option>
              </select>
              <KeyField id="firecrawl" label="Firecrawl API key" />
            </details>
          </>
        )}
      </div>
      <div className="dialog-footer">
        <span className="field-help">
          Preferences are saved with your notebook.
        </span>
        <button className="button primary" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </div>
    </Modal>
  )
}
