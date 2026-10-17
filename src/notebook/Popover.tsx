import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './popover.css'

const OFFSCREEN: CSSProperties = { left: -10_000, top: -10_000 }

export type Placement =
  'bottom-start' | 'bottom-end' | 'top-start' | 'right-start'

/**
 * A small floating panel next to an element. Inside a dialog it renders in
 * the dialog, so focus stays there and a click in it does not close the
 * dialog. It flips to stay on screen, closes on Escape or an outside click,
 * and gives focus back to its anchor.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  placement = 'bottom-start',
  className = '',
  label,
  role = 'dialog',
  initialFocus = true,
  offset = 6,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose(): void
  children: ReactNode
  placement?: Placement
  className?: string
  label: string
  role?: 'dialog' | 'menu' | 'listbox'
  /** Focus the first control when it opens. */
  initialFocus?: boolean
  offset?: number
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>(OFFSCREEN)
  const container =
    (anchor?.closest('.dialog-content') as HTMLElement | null) ??
    (typeof document === 'undefined' ? null : document.body)

  const place = useCallback(() => {
    const element = panel.current
    if (!element || !anchor) return
    const box = anchor.getBoundingClientRect()
    const own = element.getBoundingClientRect()
    // A transformed dialog is the containing block of fixed children.
    const frame =
      container && container !== document.body
        ? container.getBoundingClientRect()
        : { left: 0, top: 0 }
    // Stay inside a dialog, which clips its children, or the window.
    const bounds =
      container && container !== document.body
        ? container.getBoundingClientRect()
        : {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
          }
    let left =
      placement === 'bottom-end'
        ? box.right - own.width
        : placement === 'right-start'
          ? box.right + offset
          : box.left
    let top =
      placement === 'top-start'
        ? box.top - own.height - offset
        : placement === 'right-start'
          ? box.top
          : box.bottom + offset
    if (top + own.height > bounds.bottom - 8 && placement !== 'top-start')
      top = Math.max(bounds.top + 8, box.top - own.height - offset)
    if (top < bounds.top + 8)
      top = Math.min(bounds.bottom - own.height - 8, box.bottom + offset)
    if (left + own.width > bounds.right - 8) left = bounds.right - own.width - 8
    if (left < bounds.left + 8) left = bounds.left + 8
    setStyle({ left: left - frame.left, top: top - frame.top })
  }, [anchor, container, placement, offset])

  useLayoutEffect(() => {
    if (!open) {
      setStyle(OFFSCREEN)
      return
    }
    place()
    // Focus before the first paint, so a fast first key lands here.
    if (initialFocus)
      panel.current
        ?.querySelector<HTMLElement>(
          '[data-autofocus], input, button:not([disabled]), [tabindex="0"]'
        )
        ?.focus({ preventScroll: true })
  }, [open, place, initialFocus])

  useEffect(() => {
    if (!open) return
    const resize = new ResizeObserver(() => place())
    if (panel.current) resize.observe(panel.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      resize.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (panel.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, anchor, onClose])

  if (!open || !container) return null
  return createPortal(
    <div
      ref={panel}
      className={`popover ${className}`}
      role={role}
      aria-label={label}
      style={style}
      // Escape closes this panel only, not a dialog around it.
      data-escape-local="true"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          anchor?.focus({ preventScroll: true })
        }
      }}
    >
      {children}
    </div>,
    container
  )
}
