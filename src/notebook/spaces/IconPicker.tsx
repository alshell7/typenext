import { useEffect, useMemo, useState } from 'react'
import { Check, Search } from 'lucide-react'
import type { NoteSpace } from '../../types/notebook'
import { Popover } from '../Popover'
import { SPACE_ICON_GROUPS } from './space-icons'

/** A grid of workspace icons, with a search and the plain initial. */
export function IconPicker({
  anchor,
  open,
  onClose,
  space,
  onChoose,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose(): void
  space: NoteSpace
  onChoose(icon: string | null): void
}) {
  const [query, setQuery] = useState('')
  // Each opening starts with every icon.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])
  const groups = useMemo(() => {
    const key = query.trim().toLocaleLowerCase()
    return SPACE_ICON_GROUPS.map(group => ({
      ...group,
      icons: group.icons.filter(
        item =>
          !key ||
          item.label.toLocaleLowerCase().includes(key) ||
          item.id.includes(key)
      ),
    })).filter(group => group.icons.length)
  }, [query])
  const initial = [...space.name.trim()][0]?.toLocaleUpperCase() ?? '·'
  const choose = (icon: string | null) => {
    onChoose(icon)
    onClose()
    anchor?.focus({ preventScroll: true })
  }
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      label="Workspace icon"
      className="space-icon-picker"
    >
      <label className="space-icon-search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="Find an icon"
          placeholder="Find an icon"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </label>
      <div className="space-icon-scroll">
        {!query && (
          <button
            type="button"
            className={`space-icon-letter org-${space.color}`}
            aria-pressed={!space.icon}
            onClick={() => choose(null)}
          >
            <span className="space-icon-letter-mark">{initial}</span>
            First letter
            {!space.icon && <Check size={13} aria-hidden="true" />}
          </button>
        )}
        {groups.map(group => (
          <section key={group.name} aria-label={group.name}>
            <h4>{group.name}</h4>
            <div className="space-icon-grid">
              {group.icons.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={`space-icon-option org-${space.color}`}
                  aria-label={label}
                  aria-pressed={space.icon === id}
                  title={label}
                  onClick={() => choose(id)}
                >
                  <Icon size={17} strokeWidth={2} />
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <p className="space-icon-empty">No icon matches.</p>}
      </div>
    </Popover>
  )
}
