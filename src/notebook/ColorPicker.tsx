import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { Check, Pipette } from 'lucide-react'
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from './color'
import { Popover } from './Popover'
import './color-picker.css'

interface EyeDropperWindow extends Window {
  EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> }
}

function eyeDropper() {
  return typeof window === 'undefined'
    ? undefined
    : (window as EyeDropperWindow).EyeDropper
}

/**
 * A colour picker: a saturation and brightness field, a hue strip, a hex
 * field and a few suggested colours. Keyboard: arrows move the field and the
 * strip, Shift moves further. Changes apply as you move, at most once a frame.
 */
export function ColorPicker({
  anchor,
  open,
  onClose,
  value,
  onChange,
  label,
  presets = [],
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose(): void
  value: string
  onChange(value: string): void
  label: string
  presets?: readonly string[]
}) {
  const [hsv, setHsv] = useState<Hsv>(
    () => hexToHsv(value) ?? { h: 0, s: 0, v: 1 }
  )
  const [draft, setDraft] = useState(value)
  const original = useRef(value)
  const frame = useRef(0)
  const pending = useRef<string | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    original.current = value
    setHsv(hexToHsv(value) ?? { h: 0, s: 0, v: 1 })
    setDraft(value)
    // Only when the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Follow a value set elsewhere (the hex field next to the swatch) without
  // losing the hue of a grey while dragging.
  useEffect(() => {
    if (!open || value === hsvToHex(hsv)) return
    const next = hexToHsv(value)
    if (next)
      setHsv(current => (next.s === 0 ? { ...next, h: current.h } : next))
    setDraft(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const commit = useCallback(
    (next: Hsv) => {
      setHsv(next)
      const hex = hsvToHex(next)
      setDraft(hex)
      pending.current = hex
      if (frame.current) return
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        if (pending.current) onChange(pending.current)
        pending.current = null
      })
    },
    [onChange]
  )
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const dragArea = (event: PointerEvent<HTMLDivElement>) => {
    const box = area.current?.getBoundingClientRect()
    if (!box) return
    const s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    const v =
      1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
    commit({ ...hsv, s, v })
  }
  const dragStrip = (event: PointerEvent<HTMLDivElement>) => {
    const box = strip.current?.getBoundingClientRect()
    if (!box) return
    const h = Math.min(
      359.9,
      Math.max(0, ((event.clientX - box.left) / box.width) * 360)
    )
    commit({ ...hsv, h })
  }
  const pointer = (drag: (event: PointerEvent<HTMLDivElement>) => void) => ({
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.focus({ preventScroll: true })
      drag(event)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) drag(event)
    },
  })

  const areaKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02
    const next = { ...hsv }
    if (event.key === 'ArrowLeft') next.s = Math.max(0, hsv.s - step)
    else if (event.key === 'ArrowRight') next.s = Math.min(1, hsv.s + step)
    else if (event.key === 'ArrowUp') next.v = Math.min(1, hsv.v + step)
    else if (event.key === 'ArrowDown') next.v = Math.max(0, hsv.v - step)
    else return
    event.preventDefault()
    commit(next)
  }
  const stripKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 15 : 2
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
      commit({ ...hsv, h: (hsv.h - step + 360) % 360 })
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
      commit({ ...hsv, h: (hsv.h + step) % 360 })
    else return
    event.preventDefault()
  }

  const current = hsvToHex(hsv)
  const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 })
  const Dropper = eyeDropper()

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      label={label}
      className="color-picker"
    >
      <div
        ref={area}
        className="color-area"
        role="slider"
        tabIndex={0}
        data-autofocus
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ '--hue': pure } as CSSProperties}
        onKeyDown={areaKey}
        {...pointer(dragArea)}
      >
        <span
          className="color-area-thumb"
          style={
            {
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
              background: current,
            } as CSSProperties
          }
        />
      </div>
      <div
        ref={strip}
        className="color-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuenow={Math.round(hsv.h)}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuetext={`${Math.round(hsv.h)} degrees`}
        onKeyDown={stripKey}
        {...pointer(dragStrip)}
      >
        <span
          className="color-hue-thumb"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: pure }}
        />
      </div>
      <div className="color-row">
        <span
          className="color-compare"
          aria-hidden="true"
          title="Before and after"
        >
          <span style={{ background: original.current }} />
          <span style={{ background: current }} />
        </span>
        <label className="color-hex">
          <span>#</span>
          <input
            aria-label="Hex value"
            value={draft.replace(/^#/u, '')}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              setDraft(`#${event.target.value.replace(/^#/u, '')}`)
              const hex = normalizeHex(event.target.value)
              if (hex) {
                const next = hexToHsv(hex)
                if (next) setHsv(next)
                onChange(hex)
              }
            }}
            onBlur={() => setDraft(current)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onClose()
                anchor?.focus({ preventScroll: true })
              }
            }}
          />
        </label>
        {Dropper && (
          <button
            type="button"
            className="color-icon-button"
            aria-label="Pick a colour from the screen"
            title="Pick a colour from the screen"
            onClick={() => {
              void new Dropper()
                .open()
                .then(result => {
                  const hex = normalizeHex(result.sRGBHex)
                  if (!hex) return
                  const next = hexToHsv(hex)
                  if (next) commit(next)
                })
                .catch(() => undefined)
            }}
          >
            <Pipette size={14} />
          </button>
        )}
      </div>
      {presets.length > 0 && (
        <div
          className="color-presets"
          role="group"
          aria-label="Suggested colours"
        >
          {presets.map(preset => (
            <button
              key={preset}
              type="button"
              className="color-preset"
              style={{ background: preset }}
              aria-label={`Use ${preset}`}
              aria-pressed={preset === current}
              onClick={() => {
                const next = hexToHsv(preset)
                if (next) commit(next)
              }}
            >
              {preset === current && <Check size={11} strokeWidth={3} />}
            </button>
          ))}
        </div>
      )}
      <div className="color-actions">
        <button
          type="button"
          className="button subtle is-compact"
          disabled={current === original.current}
          onClick={() => {
            const next = hexToHsv(original.current)
            if (next) commit(next)
          }}
        >
          Reset
        </button>
        <button
          type="button"
          className="button primary is-compact"
          onClick={() => {
            onClose()
            anchor?.focus({ preventScroll: true })
          }}
        >
          Done
        </button>
      </div>
    </Popover>
  )
}
