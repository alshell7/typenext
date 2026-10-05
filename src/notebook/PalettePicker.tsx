import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react'
import { Check } from 'lucide-react'
import type { NotebookSettings, PaletteColors } from '../types/notebook'
import {
  DARK_PALETTES,
  LIGHT_PALETTES,
  paletteTokens,
  validHex,
} from './palette'

type Appearance = 'light' | 'dark'
type ColorRole = keyof PaletteColors

const choices = {
  light: [
    { id: 'paper', name: 'Paper', colors: LIGHT_PALETTES.paper },
    { id: 'linen', name: 'Linen', colors: LIGHT_PALETTES.linen },
    { id: 'mist', name: 'Mist', colors: LIGHT_PALETTES.mist },
  ],
  dark: [
    { id: 'graphite', name: 'Graphite', colors: DARK_PALETTES.graphite },
    { id: 'midnight', name: 'Midnight', colors: DARK_PALETTES.midnight },
    { id: 'forest', name: 'Forest', colors: DARK_PALETTES.forest },
  ],
} as const

function PalettePreview({ colors }: { colors: PaletteColors }) {
  const style = useMemo(() => {
    const tokens = paletteTokens(colors)
    return {
      '--preview-page': tokens['--paper'],
      '--preview-sidebar': tokens['--sidebar'],
      '--preview-ink': tokens['--ink'],
      '--preview-side-ink': tokens['--sidebar-ink'],
      '--preview-accent': tokens['--accent'],
    } as CSSProperties
  }, [colors])
  return (
    <span className="palette-preview" style={style} aria-hidden="true">
      <span className="palette-preview-sidebar">
        <span />
        <span />
        <span />
      </span>
      <span className="palette-preview-page">
        <span className="palette-preview-title" />
        <span />
        <span />
        <span />
      </span>
    </span>
  )
}

function HexField({
  appearance,
  role,
  value,
  onChange,
}: {
  appearance: Appearance
  role: ColorRole
  value: string
  onChange(value: string): void
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [showError, setShowError] = useState(false)
  useEffect(() => {
    setDraft(value)
    setShowError(false)
  }, [value])
  const title = role.charAt(0).toUpperCase() + role.slice(1)
  const valid = validHex(draft)
  return (
    <div className="palette-color-field">
      <label htmlFor={id}>{title}</label>
      <div className="palette-hex-input">
        <span
          className="palette-color-swatch"
          style={{ backgroundColor: valid ? draft : value }}
          aria-hidden="true"
        />
        <input
          id={id}
          type="text"
          aria-label={`${appearance === 'light' ? 'Light' : 'Dark'} ${role} color`}
          value={draft}
          maxLength={7}
          autoComplete="off"
          spellCheck={false}
          data-invalid-palette-draft={!valid ? 'true' : undefined}
          aria-invalid={showError && !valid ? true : undefined}
          aria-describedby={showError && !valid ? `${id}-error` : undefined}
          onChange={event => {
            const next = event.target.value
            setDraft(next)
            if (validHex(next)) {
              setShowError(false)
              onChange(next.toLowerCase())
            }
          }}
          onBlur={() => setShowError(!validHex(draft))}
          onKeyDown={event => {
            if (event.key === 'Escape' && !valid) {
              event.preventDefault()
              event.stopPropagation()
              setDraft(value)
              setShowError(false)
            }
          }}
        />
      </div>
      {showError && !valid && (
        <p id={`${id}-error`} className="palette-color-error" role="status">
          Use # and six hex digits.
        </p>
      )}
    </div>
  )
}

function PaletteGroup({
  appearance,
  settings,
  onChange,
}: {
  appearance: Appearance
  settings: NotebookSettings
  onChange(settings: NotebookSettings): void
}) {
  const id = useId()
  const name = appearance === 'light' ? 'Light' : 'Dark'
  const customKey = appearance === 'light' ? 'customLight' : 'customDark'
  const custom = settings.palette[customKey]
  const selected = settings.palette[appearance]
  const options = [
    ...choices[appearance],
    { id: 'custom', name: 'Custom', colors: custom },
  ] as const
  const choose = (palette: NotebookSettings['palette'][Appearance]) =>
    onChange({
      ...settings,
      provider: 'local',
      theme: appearance,
      palette: { ...settings.palette, [appearance]: palette },
    })
  return (
    <fieldset className="palette-group">
      <legend>{name} palette</legend>
      <div className="palette-options">
        {options.map(choice => (
          <label className="palette-option" key={choice.id}>
            <input
              type="radio"
              name={id}
              value={choice.id}
              checked={selected === choice.id}
              onClick={() => {
                if (selected === choice.id && settings.theme !== appearance)
                  choose(choice.id)
              }}
              onChange={() => choose(choice.id)}
            />
            <span className="palette-card">
              <PalettePreview colors={choice.colors} />
              <span className="palette-option-label">
                <span>{choice.name}</span>
                {selected === choice.id && (
                  <Check size={13} aria-hidden="true" />
                )}
              </span>
            </span>
          </label>
        ))}
      </div>
      {selected === 'custom' && (
        <div className="palette-custom">
          <div className="palette-color-fields">
            {(['page', 'sidebar', 'accent'] as const).map(role => (
              <HexField
                key={role}
                appearance={appearance}
                role={role}
                value={custom[role]}
                onChange={value =>
                  onChange({
                    ...settings,
                    provider: 'local',
                    theme: appearance,
                    palette: {
                      ...settings.palette,
                      [customKey]: { ...custom, [role]: value },
                    },
                  })
                }
              />
            ))}
          </div>
          <p className="field-help">
            Text adjusts to keep your colours readable.
          </p>
        </div>
      )}
    </fieldset>
  )
}

export function PalettePicker({
  settings,
  onChange,
}: {
  settings: NotebookSettings
  onChange(settings: NotebookSettings): void
}) {
  return (
    <div className="palette-picker">
      <PaletteGroup
        appearance="light"
        settings={settings}
        onChange={onChange}
      />
      <PaletteGroup appearance="dark" settings={settings} onChange={onChange} />
    </div>
  )
}
