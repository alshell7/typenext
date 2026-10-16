import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Focus } from 'lucide-react'
import type { ZenLevel } from '../types/notebook'

export const ZEN_LEVELS: { id: ZenLevel; label: string; detail: string }[] = [
  {
    id: 'sidebars',
    label: 'Hide side panels',
    detail: 'Notes and context step aside',
  },
  {
    id: 'chrome',
    label: 'Hide toolbars',
    detail: 'Also tabs and status bar. Move to an edge to show them',
  },
  {
    id: 'full',
    label: 'Full screen',
    detail: 'Only the page, in full screen',
  },
]

/** A split button: enter zen at the saved level, or choose another level. */
export function ZenMenu({
  active,
  level,
  onToggle,
  onChoose,
}: {
  active: boolean
  level: ZenLevel
  onToggle(): void
  onChoose(level: ZenLevel): void
}) {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => {
    if (open) items.current[focused]?.focus()
  }, [open, focused])

  const choose = (next: ZenLevel) => {
    setOpen(false)
    onChoose(next)
  }

  return (
    <div className="zen-menu" ref={root}>
      <button
        className={`icon-button zen-toggle${active ? ' selected' : ''}`}
        aria-label={active ? 'Leave zen mode' : 'Enter zen mode'}
        aria-pressed={active}
        title="Zen mode (Ctrl / ⌘ Shift F)"
        onClick={onToggle}
      >
        <Focus size={17} />
      </button>
      <button
        ref={trigger}
        className="icon-button zen-choose"
        aria-label="Choose zen mode level"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setFocused(
            Math.max(
              0,
              ZEN_LEVELS.findIndex(item => item.id === level)
            )
          )
          setOpen(value => !value)
        }}
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="zen-menu-list"
          role="menu"
          aria-label="Zen mode level"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
              trigger.current?.focus()
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              setFocused(
                value => (value + step + ZEN_LEVELS.length) % ZEN_LEVELS.length
              )
            } else if (event.key === 'Home') {
              event.preventDefault()
              setFocused(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              setFocused(ZEN_LEVELS.length - 1)
            } else if (event.key === 'Tab') setOpen(false)
          }}
        >
          {ZEN_LEVELS.map((item, index) => (
            <button
              key={item.id}
              ref={element => {
                items.current[index] = element
              }}
              role="menuitemradio"
              aria-checked={item.id === level}
              tabIndex={index === focused ? 0 : -1}
              className="zen-menu-item"
              onClick={() => choose(item.id)}
            >
              <span className="zen-menu-check" aria-hidden="true">
                {item.id === level && <Check size={13} />}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
