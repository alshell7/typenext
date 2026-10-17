import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { Check, Plus, Settings2, Tag } from 'lucide-react'
import type { NoteTag } from '../../types/notebook'
import { Popover } from '../Popover'
import { byName, cleanTagName, findTag } from './organize'

/**
 * Find or create tags for a note. Type to filter; Enter toggles the
 * highlighted tag, or creates the typed one. Several tags can be chosen
 * without closing.
 */
export function TagPicker({
  anchor,
  open,
  onClose,
  tags,
  chosen,
  counts,
  onToggle,
  onCreate,
  onManage,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose(): void
  tags: readonly NoteTag[]
  chosen: readonly string[]
  counts: Map<string, number>
  onToggle(id: string, on: boolean): void
  onCreate(name: string): void
  onManage(): void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  const clean = cleanTagName(query)
  const options = useMemo(() => {
    const key = clean.toLocaleLowerCase()
    const sorted = [...tags].sort(byName)
    const matches = key
      ? sorted.filter(tag => tag.name.toLocaleLowerCase().includes(key))
      : // Chosen tags first, then the most used.
        sorted.sort(
          (left, right) =>
            Number(chosen.includes(right.id)) -
              Number(chosen.includes(left.id)) ||
            (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0)
        )
    return matches.slice(0, 50)
  }, [tags, clean, chosen, counts])
  const canCreate = Boolean(clean) && !findTag(tags, clean)
  const total = options.length + (canCreate ? 1 : 0)
  useEffect(() => {
    setActive(value => Math.min(value, Math.max(0, total - 1)))
  }, [total])

  const choose = (index: number) => {
    if (index < options.length) {
      const tag = options[index]!
      onToggle(tag.id, !chosen.includes(tag.id))
    } else if (canCreate) {
      onCreate(clean)
      setQuery('')
    }
  }

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(value => (value + step + total) % Math.max(1, total))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (total) choose(canCreate && !options.length ? 0 : active)
    }
  }

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      label="Tags"
      className="org-tag-picker"
    >
      <div className="org-tag-search">
        <Tag size={14} aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="org-tag-options"
          aria-activedescendant={total ? `org-tag-option-${active}` : undefined}
          aria-label="Find or create a tag"
          placeholder="Find or create a tag"
          value={query}
          maxLength={60}
          onChange={event => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKey}
        />
      </div>
      <div
        className="org-tag-options"
        role="listbox"
        id="org-tag-options"
        aria-label="Tags"
        aria-multiselectable="true"
      >
        {options.map((tag, index) => {
          const on = chosen.includes(tag.id)
          return (
            <div
              key={tag.id}
              id={`org-tag-option-${index}`}
              role="option"
              aria-selected={on}
              className={`org-tag-option${index === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <span className={`org-dot org-${tag.color}`} aria-hidden="true" />
              <span className="org-tag-option-name">{tag.name}</span>
              <span className="org-tag-option-count">
                {counts.get(tag.id) ?? 0}
              </span>
              <span className="org-tag-check" aria-hidden="true">
                {on && <Check size={13} strokeWidth={2.6} />}
              </span>
            </div>
          )
        })}
        {canCreate && (
          <div
            id={`org-tag-option-${options.length}`}
            role="option"
            aria-selected={false}
            className={`org-tag-option is-create${active === options.length ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(options.length)}
            onMouseDown={event => event.preventDefault()}
            onClick={() => choose(options.length)}
          >
            <Plus size={14} aria-hidden="true" />
            <span className="org-tag-option-name">
              Create <strong>{clean}</strong>
            </span>
          </div>
        )}
        {!total && (
          <p className="org-tag-empty">
            {tags.length
              ? 'No tag matches.'
              : 'Type a name to create your first tag.'}
          </p>
        )}
      </div>
      <div className="org-tag-foot">
        <span>
          <kbd>↵</kbd> choose
        </span>
        <button
          type="button"
          className="org-link-button"
          onClick={() => {
            onClose()
            onManage()
          }}
        >
          <Settings2 size={13} aria-hidden="true" /> Manage tags
        </button>
      </div>
    </Popover>
  )
}
