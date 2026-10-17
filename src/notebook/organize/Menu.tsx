import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { OrganizeColor } from '../../types/notebook'
import { Popover, type Placement } from '../Popover'
import { ORGANIZE_COLORS } from './organize'

export type MenuItem =
  | {
      kind?: 'item'
      label: string
      icon?: ReactNode
      hint?: string
      danger?: boolean
      disabled?: boolean
      checked?: boolean
      /** Opens a second list in place of this one. */
      items?: MenuItem[]
      onSelect?(): void
    }
  | { kind: 'separator' }
  | { kind: 'heading'; label: string }
  | {
      kind: 'colors'
      label: string
      value?: OrganizeColor
      onSelect(color: OrganizeColor): void
    }

/**
 * A menu of actions. Arrow keys move, Enter chooses, Right or Enter opens a
 * nested list and Left or Escape goes back.
 */
export function Menu({
  anchor,
  open,
  onClose,
  items,
  label,
  placement = 'bottom-start',
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose(): void
  items: MenuItem[]
  label: string
  placement?: Placement
}) {
  const [stack, setStack] = useState<{ label: string; items: MenuItem[] }[]>([])
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const level = stack.at(-1) ?? { label, items }
  const choices = useMemo(
    () =>
      level.items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            (item.kind === undefined || item.kind === 'item') && !item.disabled
        ),
    [level.items]
  )

  useEffect(() => {
    if (!open) {
      setStack([])
      setActive(0)
    }
  }, [open])
  useEffect(() => {
    setActive(0)
  }, [stack.length])
  useLayoutEffect(() => {
    if (!open) return
    const target = list.current?.querySelector<HTMLElement>(
      `[data-index="${choices[active]?.index}"]`
    )
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  }, [open, active, stack.length, choices])

  const choose = (item: MenuItem) => {
    if (item.kind && item.kind !== 'item') return
    if (item.disabled) return
    if (item.items) {
      setStack(value => [...value, { label: item.label, items: item.items! }])
      return
    }
    onClose()
    item.onSelect?.()
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(
        value => (value + step + choices.length) % Math.max(1, choices.length)
      )
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActive(choices.length - 1)
    } else if (event.key === 'ArrowRight') {
      const item = choices[active]?.item
      if (
        item &&
        (item.kind === undefined || item.kind === 'item') &&
        item.items
      ) {
        event.preventDefault()
        choose(item)
      }
    } else if (
      (event.key === 'ArrowLeft' || event.key === 'Escape') &&
      stack.length
    ) {
      event.preventDefault()
      event.stopPropagation()
      setStack(value => value.slice(0, -1))
    }
  }

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      label={label}
      role="menu"
      placement={placement}
      className="org-menu"
      initialFocus={false}
    >
      <div ref={list} onKeyDown={onKey} className="org-menu-list">
        {stack.length > 0 && (
          <button
            type="button"
            className="org-menu-back"
            onClick={() => setStack(value => value.slice(0, -1))}
          >
            <ChevronLeft size={14} aria-hidden="true" />
            {level.label}
          </button>
        )}
        {level.items.map((item, index) => {
          if (item.kind === 'separator')
            return (
              <div
                key={index}
                className="org-menu-separator"
                role="separator"
              />
            )
          if (item.kind === 'heading')
            return (
              <div key={index} className="org-menu-heading">
                {item.label}
              </div>
            )
          if (item.kind === 'colors')
            return (
              <div
                key={index}
                className="org-menu-colors"
                role="group"
                aria-label={item.label}
              >
                {ORGANIZE_COLORS.map(color => (
                  <button
                    key={color.id}
                    type="button"
                    className={`org-swatch org-${color.id}`}
                    aria-label={color.name}
                    aria-pressed={item.value === color.id}
                    title={color.name}
                    onClick={() => {
                      item.onSelect(color.id)
                      onClose()
                    }}
                  >
                    {item.value === color.id && (
                      <Check size={11} strokeWidth={3} />
                    )}
                  </button>
                ))}
              </div>
            )
          const position = choices.findIndex(choice => choice.index === index)
          return (
            <button
              key={index}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              data-index={index}
              tabIndex={position === active ? 0 : -1}
              disabled={item.disabled}
              className={`org-menu-item${item.danger ? ' is-danger' : ''}`}
              onMouseEnter={() => position >= 0 && setActive(position)}
              onClick={() => choose(item)}
            >
              <span className="org-menu-icon" aria-hidden="true">
                {item.checked ? <Check size={14} /> : item.icon}
              </span>
              <span className="org-menu-label">{item.label}</span>
              {item.hint && <span className="org-menu-hint">{item.hint}</span>}
              {item.items && <ChevronRight size={14} aria-hidden="true" />}
            </button>
          )
        })}
      </div>
    </Popover>
  )
}
