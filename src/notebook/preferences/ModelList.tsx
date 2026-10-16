import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { ProviderModel } from '../../services/completion'

/** Long catalogs are capped; typing narrows the list instead of scrolling. */
export const MODEL_LIST_LIMIT = 100

/**
 * A searchable list of available models. The search field is a combobox
 * that keeps focus while the arrow keys move through the options.
 */
export function ModelList({
  models,
  value,
  onPick,
  freeFilter = false,
}: {
  models: ProviderModel[]
  value: string
  onPick(id: string): void
  freeFilter?: boolean
}) {
  const id = useId()
  const listId = `${id}-list`
  const hasFree = freeFilter && models.some(model => model.free)
  const [query, setQuery] = useState('')
  const [freeOnly, setFreeOnly] = useState(true)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement | null>(null)
  const filtered = useMemo(() => {
    const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
    return models.filter(model => {
      if (hasFree && freeOnly && !model.free) return false
      const haystack = `${model.name} ${model.id}`.toLocaleLowerCase()
      return terms.every(term => haystack.includes(term))
    })
  }, [models, query, freeOnly, hasFree])
  const shown = filtered.slice(0, MODEL_LIST_LIMIT)
  const current = Math.min(active, Math.max(0, shown.length - 1))
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [current])
  return (
    <div className="pref-models">
      <div className="pref-models-toolbar">
        <span className="pref-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            role="combobox"
            aria-label="Search models"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              shown.length ? `${id}-option-${current}` : undefined
            }
            placeholder={`Search ${models.length} models`}
            spellCheck={false}
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={event => {
              const last = shown.length - 1
              const next =
                event.key === 'ArrowDown'
                  ? Math.min(last, current + 1)
                  : event.key === 'ArrowUp'
                    ? Math.max(0, current - 1)
                    : event.key === 'PageDown'
                      ? Math.min(last, current + 8)
                      : event.key === 'PageUp'
                        ? Math.max(0, current - 8)
                        : undefined
              if (next !== undefined) {
                event.preventDefault()
                setActive(next)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const model = shown[current]
                if (model) onPick(model.id)
              }
            }}
          />
        </span>
        {hasFree && (
          <button
            type="button"
            className="pref-chip"
            aria-pressed={freeOnly}
            onClick={() => {
              setFreeOnly(value => !value)
              setActive(0)
            }}
          >
            {freeOnly && <Check size={12} aria-hidden="true" />}
            Free only
          </button>
        )}
      </div>
      <div
        className="pref-models-list"
        role="listbox"
        id={listId}
        aria-label="Available models"
        ref={list}
      >
        {shown.map((model, index) => {
          const chosen = model.id === value
          return (
            <div
              key={model.id}
              id={`${id}-option-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === current}
              className={`pref-model-option ${chosen ? 'is-chosen' : ''}`}
              onMouseMove={() => {
                if (index !== current) setActive(index)
              }}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                setActive(index)
                onPick(model.id)
              }}
            >
              <span className="pref-model-text">
                <span className="pref-model-name">{model.name}</span>
                {model.name !== model.id && (
                  <span className="pref-model-id">{model.id}</span>
                )}
              </span>
              {model.free && <span className="pref-badge">Free</span>}
              <span className="pref-model-check" aria-hidden="true">
                {chosen && <Check size={14} />}
              </span>
            </div>
          )
        })}
        {!shown.length && (
          <p className="pref-models-empty">
            {query
              ? `No models match “${query}”.`
              : 'No free models are listed. Turn off Free only to see all.'}
          </p>
        )}
      </div>
      <p className="pref-models-count" aria-live="polite">
        {filtered.length > shown.length
          ? `Showing ${shown.length} of ${filtered.length}. Keep typing to narrow the list.`
          : `${filtered.length} model${filtered.length === 1 ? '' : 's'}`}
      </p>
    </div>
  )
}
