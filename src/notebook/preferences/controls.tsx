import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, CircleAlert, Copy, LoaderCircle } from 'lucide-react'

export type Tone = 'neutral' | 'ok' | 'busy' | 'error' | 'external'

/** A titled block within a pane. Panes are a calm stack of sections. */
export function Section({
  id,
  title,
  description,
  aside,
  children,
}: {
  id?: string
  title: string
  description?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section className="pref-section" id={id} aria-labelledby={headingId}>
      <div className="pref-section-header">
        <div>
          <h3 id={headingId} tabIndex={-1}>
            {title}
          </h3>
          {description && <p>{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A rounded, hairline-bordered container of rows, as in macOS settings. */
export function Group({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`pref-group ${className}`}>{children}</div>
}

/**
 * A toggle row. The whole row is the label, so the accessible name starts
 * with the title and is followed by its description.
 */
export function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description?: ReactNode
  checked: boolean
  disabled?: boolean
  onChange(checked: boolean): void
}) {
  const id = useId()
  return (
    <label
      className={`pref-row pref-switch-row ${disabled ? 'is-disabled' : ''}`}
      htmlFor={id}
    >
      <span className="pref-row-text">
        <span className="pref-row-label">{label}</span>
        {description && <small>{description}</small>}
      </span>
      <input
        id={id}
        className="pref-switch"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
    </label>
  )
}

/** A row with a label on the left and a control on the right. */
export function Row({
  label,
  htmlFor,
  description,
  children,
  stacked = false,
}: {
  label: string
  htmlFor?: string
  description?: ReactNode
  children: ReactNode
  stacked?: boolean
}) {
  const descriptionId = useId()
  return (
    <div className={`pref-row ${stacked ? 'is-stacked' : ''}`}>
      <span className="pref-row-text">
        {htmlFor ? (
          <label className="pref-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="pref-row-label">{label}</span>
        )}
        {description && <small id={descriptionId}>{description}</small>}
      </span>
      <div className="pref-row-control">{children}</div>
    </div>
  )
}

export interface SegmentOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

/**
 * A segmented radio group with a sliding thumb. Arrow keys move and select,
 * like native segmented controls.
 */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  describedBy,
  size = 'regular',
}: {
  label: string
  value: T
  options: SegmentOption<T>[]
  onChange(value: T): void
  describedBy?: string
  size?: 'regular' | 'small'
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const index = Math.max(
    0,
    options.findIndex(option => option.value === value)
  )
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const enabled = options
      .map((option, position) => (option.disabled ? -1 : position))
      .filter(position => position >= 0)
    if (!enabled.length) return
    const at = Math.max(0, enabled.indexOf(from))
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? enabled[(at + 1) % enabled.length]
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? enabled[(at + enabled.length - 1) % enabled.length]
          : event.key === 'Home'
            ? enabled[0]
            : event.key === 'End'
              ? enabled[enabled.length - 1]
              : undefined
    if (next === undefined) return
    event.preventDefault()
    const option = options[next]
    if (!option) return
    onChange(option.value)
    buttons.current[next]?.focus()
  }
  return (
    <div
      className={`pref-segmented is-${size}`}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      style={
        {
          '--segments': options.length,
          '--segment': index,
        } as CSSProperties
      }
    >
      <span className="pref-segmented-thumb" aria-hidden="true" />
      {options.map((option, position) => (
        <button
          key={String(option.value)}
          ref={element => {
            buttons.current[position] = element
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          onKeyDown={event => move(event, position)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export interface TileOption<T extends string> {
  value: T
  title: string
  description?: ReactNode
  icon?: ReactNode
  meta?: ReactNode
}

/** Selectable option cards. A radio group with roving focus. */
export function TileGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  label: string
  value: T
  options: TileOption<T>[]
  onChange(value: T): void
  className?: string
}) {
  const baseId = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex(option => option.value === value)
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const count = options.length
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (from + 1) % count
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (from + count - 1) % count
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : undefined
    if (next === undefined) return
    event.preventDefault()
    const option = options[next]
    if (!option) return
    onChange(option.value)
    buttons.current[next]?.focus()
  }
  return (
    <div
      className={`pref-tiles ${className}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, position) => {
        const id = `${baseId}-${position}`
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={element => {
              buttons.current[position] = element
            }}
            type="button"
            role="radio"
            className="pref-tile"
            aria-checked={checked}
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-description ${id}-meta`}
            tabIndex={checked || (selected < 0 && position === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={event => move(event, position)}
          >
            <span className="pref-tile-top">
              {option.icon && (
                <span className="pref-tile-icon" aria-hidden="true">
                  {option.icon}
                </span>
              )}
              <span className="pref-tile-check" aria-hidden="true">
                <Check size={11} strokeWidth={3} />
              </span>
            </span>
            <span className="pref-tile-title" id={`${id}-title`}>
              {option.title}
            </span>
            <span className="pref-tile-description" id={`${id}-description`}>
              {option.description}
            </span>
            <span className="pref-tile-meta" id={`${id}-meta`}>
              {option.meta}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function Pill({
  tone = 'neutral',
  children,
  id,
}: {
  tone?: Tone
  children: ReactNode
  id?: string
}) {
  return (
    <span className={`pref-pill tone-${tone}`} id={id}>
      {tone === 'busy' ? (
        <LoaderCircle size={12} className="spin" aria-hidden="true" />
      ) : (
        <span className="pref-pill-dot" aria-hidden="true" />
      )}
      <span className="pref-pill-text">{children}</span>
    </span>
  )
}

/** A polite live message. Empty messages keep their space to avoid jumps. */
export function StatusLine({
  tone = 'neutral',
  children,
  reserve = true,
}: {
  tone?: Tone
  children?: ReactNode
  reserve?: boolean
}) {
  return (
    <p
      className={`pref-status tone-${tone} ${reserve ? 'is-reserved' : ''}`}
      role="status"
    >
      {children && tone === 'busy' && (
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
      )}
      {children && tone === 'error' && (
        <CircleAlert size={13} aria-hidden="true" />
      )}
      {children && tone === 'ok' && <Check size={13} aria-hidden="true" />}
      {children && <span>{children}</span>}
    </p>
  )
}

export function Callout({
  icon,
  tone = 'neutral',
  children,
  action,
}: {
  icon?: ReactNode
  tone?: 'neutral' | 'external' | 'error'
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className={`pref-callout tone-${tone}`}>
      {icon && <span className="pref-callout-icon">{icon}</span>}
      <div className="pref-callout-body">{children}</div>
      {action && <div className="pref-callout-action">{action}</div>}
    </div>
  )
}

/** A shell command with a copy button. */
export function CommandBlock({
  command,
  label,
}: {
  command: string
  label: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <div className="pref-command">
      <code aria-label={label}>{command}</code>
      <button
        type="button"
        className="pref-icon-button"
        aria-label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000)
    return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 0 : 1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`
  return `${bytes} B`
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
