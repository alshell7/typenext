import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  ArrowRight,
  Check,
  Cloud,
  Feather,
  HardDrive,
  Search,
  Server,
  Settings2,
  ShieldCheck,
} from 'lucide-react'
import {
  getBuiltinState,
  subscribeBuiltinState,
} from '../services/builtin-engine'
import type { NotebookSettings } from '../types/notebook'
import { PROVIDERS } from './model'
import { Modal } from './Modal'
import {
  activateExternal,
  activateLocal,
  usingExternal,
} from './preferences/engine'
import { EXTERNAL_PROVIDERS } from './preferences/types'
import './model-chooser.css'

interface EngineItem {
  key: string
  group: string
  title: string
  detail: string
  icon: ReactNode
  external: boolean
  active: boolean
  /** Setup items open Preferences instead of switching. */
  setup: boolean
  run(): void
}

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
  const id = useId()
  const builtin = useSyncExternalStore(
    subscribeBuiltinState,
    getBuiltinState,
    getBuiltinState
  )
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const pendingActivation = useRef(false)
  const list = useRef<HTMLDivElement | null>(null)

  const items = useMemo<EngineItem[]>(() => {
    const external = usingExternal(settings)
    const activate = (next: NotebookSettings) => {
      onChange(next)
      pendingActivation.current = true
      onOpenChange(false)
    }
    const configure = (provider?: NotebookSettings['externalProvider']) => {
      if (provider) onChange({ ...settings, externalProvider: provider })
      onOpenChange(false)
      if (provider) onConfigure()
      else onConfigureLocal()
    }
    const localModel = settings.profiles.local.model.trim()
    const builtinReady =
      builtin.status === 'ready' || builtin.status === 'generating'
    const local: EngineItem[] = [
      {
        key: 'local:recall',
        group: 'On this device',
        title: 'Writing starters & recall',
        detail: 'No setup · private',
        icon: <Feather size={15} />,
        external: false,
        active:
          !external &&
          (settings.localEngine === 'recall' ||
            (settings.localEngine === 'server' && !localModel)),
        setup: false,
        run: () => activate(activateLocal(settings, 'recall')),
      },
      builtin.cached || builtinReady
        ? {
            key: 'local:embedded',
            group: 'On this device',
            title: 'Built-in SmolLM2',
            detail: builtinReady ? 'Loaded · offline' : 'Downloaded · offline',
            icon: <HardDrive size={15} />,
            external: false,
            active: !external && settings.localEngine === 'embedded',
            setup: false,
            run: () => activate(activateLocal(settings, 'embedded')),
          }
        : {
            key: 'local:embedded',
            group: 'On this device',
            title: 'Built-in SmolLM2',
            detail: 'Download once to use offline',
            icon: <HardDrive size={15} />,
            external: false,
            active: false,
            setup: true,
            run: () => configure(),
          },
      localModel
        ? {
            key: 'local:server',
            group: 'On this device',
            title: localModel,
            detail: 'Local server',
            icon: <Server size={15} />,
            external: false,
            active: !external && settings.localEngine === 'server',
            setup: false,
            run: () => activate(activateLocal(settings, 'server')),
          }
        : {
            key: 'local:server',
            group: 'On this device',
            title: 'Local server',
            detail: 'Connect LM Studio, Jan or llama.cpp',
            icon: <Server size={15} />,
            external: false,
            active: false,
            setup: true,
            run: () => configure(),
          },
    ]
    const hosted = EXTERNAL_PROVIDERS.flatMap<EngineItem>(provider => {
      const profile = settings.profiles[provider]
      const name = PROVIDERS[provider]
      const models = [
        ...new Set(
          [profile.model, ...(profile.savedModels ?? [])].map(model =>
            model.trim()
          )
        ),
      ].filter(Boolean)
      if (!profile.endpoint.trim() || !models.length)
        return [
          {
            key: `${provider}:setup`,
            group: name,
            title: `Set up ${name}`,
            detail: 'Add a key and choose a model',
            icon: <Settings2 size={15} />,
            external: true,
            active: false,
            setup: true,
            run: () => configure(provider),
          },
        ]
      return models.map(model => ({
        key: `${provider}:${model}`,
        group: name,
        title: model,
        detail: name,
        icon: <Cloud size={15} />,
        external: true,
        active:
          external &&
          settings.provider === provider &&
          profile.model.trim() === model,
        setup: false,
        run: () => activate(activateExternal(settings, provider, model)),
      }))
    })
    return [...local, ...hosted]
  }, [settings, builtin, onChange, onOpenChange, onConfigure, onConfigureLocal])

  const filtered = useMemo(() => {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    if (!terms.length) return items
    return items.filter(item => {
      const haystack =
        `${item.title} ${item.detail} ${item.group}`.toLocaleLowerCase()
      return terms.every(term => haystack.includes(term))
    })
  }, [items, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(
      Math.max(
        0,
        items.findIndex(item => item.active)
      )
    )
    // Only reset when the chooser opens, not on every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const current = Math.min(highlight, Math.max(0, filtered.length - 1))
  const selected = filtered[current]
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [current, open])

  const groups = filtered.reduce<{ name: string; items: number[] }[]>(
    (result, item, index) => {
      const last = result[result.length - 1]
      if (last?.name === item.group) last.items.push(index)
      else result.push({ name: item.group, items: [index] })
      return result
    },
    []
  )
  const external = selected?.external ?? usingExternal(settings)

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
      <div className="chooser-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          role="combobox"
          aria-label="Search engines and models"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            selected ? `${id}-option-${current}` : undefined
          }
          placeholder="Search engines and models"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setHighlight(0)
          }}
          onKeyDown={event => {
            const count = filtered.length
            if (!count) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setHighlight(
                (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
              )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              selected?.run()
            }
          }}
        />
      </div>
      <div
        className="chooser-list"
        role="listbox"
        id={`${id}-list`}
        aria-label="Suggestion engines"
        ref={list}
      >
        {groups.map((group, groupIndex) => (
          <div
            role="group"
            key={group.name}
            aria-labelledby={`${id}-group-${groupIndex}`}
            className="chooser-group"
          >
            <div
              className="chooser-group-label"
              id={`${id}-group-${groupIndex}`}
              role="presentation"
            >
              {group.name}
            </div>
            {group.items.map(index => {
              const item = filtered[index]!
              const optionId = `${id}-option-${index}`
              return (
                <div
                  key={item.key}
                  id={optionId}
                  data-index={index}
                  role="option"
                  aria-selected={index === current}
                  aria-labelledby={`${optionId}-title`}
                  aria-describedby={`${optionId}-detail`}
                  className={`chooser-option ${item.active ? 'is-active' : ''} ${item.setup ? 'is-setup' : ''}`}
                  onMouseMove={() => {
                    if (index !== current) setHighlight(index)
                  }}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => item.run()}
                >
                  <span className="chooser-option-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="chooser-option-text">
                    <span id={`${optionId}-title`}>{item.title}</span>
                    <small id={`${optionId}-detail`}>
                      {item.active ? 'Active · ' : ''}
                      {item.detail}
                    </small>
                  </span>
                  <span className="chooser-option-end" aria-hidden="true">
                    {item.active ? (
                      <Check size={15} />
                    ) : item.setup ? (
                      <ArrowRight size={14} />
                    ) : null}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
        {!filtered.length && (
          <p className="chooser-empty">Nothing matches “{query}”.</p>
        )}
      </div>
      <p className={`chooser-disclosure ${external ? 'is-external' : ''}`}>
        {external ? (
          <Cloud size={15} aria-hidden="true" />
        ) : (
          <ShieldCheck size={15} aria-hidden="true" />
        )}
        <span>
          {external
            ? `While ${selected?.group ?? PROVIDERS[settings.provider]} is active, nearby writing, your objective, instructions and relevant attached context are sent there for suggestions. Its privacy and billing terms apply.`
            : 'Nothing leaves this device. External models receive nearby writing, your objective and relevant context only while you keep one active.'}
        </span>
      </p>
      <div className="chooser-footer">
        <span className="chooser-keys" aria-hidden="true">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> use <kbd>esc</kbd> close
        </span>
        <button
          type="button"
          className="button subtle is-compact"
          onClick={() => {
            onOpenChange(false)
            onConfigure()
          }}
        >
          <Settings2 size={14} /> Manage models…
        </button>
      </div>
    </Modal>
  )
}
