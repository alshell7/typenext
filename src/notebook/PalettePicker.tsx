import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { ColorPicker } from './ColorPicker'
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
    { id: 'contrast', name: 'Light contrast', colors: LIGHT_PALETTES.contrast },
  ],
  dark: [
    { id: 'graphite', name: 'Graphite', colors: DARK_PALETTES.graphite },
    { id: 'black', name: 'Pure black', colors: DARK_PALETTES.black },
    { id: 'contrast', name: 'Dark contrast', colors: DARK_PALETTES.contrast },
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

const PRESETS: Record<Appearance, Record<ColorRole, readonly string[]>> = {
  light: {
    page: [
      '#ffffff',
      '#fbf9f4',
      '#f7f4ec',
      '#f4f7fa',
      '#f6f4fb',
      '#f2f6f1',
      '#fff8f1',
      '#f7f2f2',
    ],
    sidebar: [
      '#f3f4f1',
      '#eee7db',
      '#e7edf3',
      '#e6e8eb',
      '#ece9f6',
      '#e9efe7',
      '#f4ebe0',
      '#efe5e5',
    ],
    accent: [
      '#42644d',
      '#805f44',
      '#426482',
      '#123d77',
      '#5b4b8a',
      '#8a3b5c',
      '#9a5b13',
      '#2f6f6a',
    ],
  },
  dark: {
    page: [
      '#212121',
      '#151c28',
      '#202921',
      '#000000',
      '#0b0b0e',
      '#1d1a24',
      '#24201c',
      '#1b1f23',
    ],
    sidebar: [
      '#17191c',
      '#111722',
      '#172019',
      '#101114',
      '#22252d',
      '#16131c',
      '#1b1815',
      '#14181c',
    ],
    accent: [
      '#a6b6c8',
      '#91acce',
      '#a8bf9d',
      '#c3d9ff',
      '#c4b5fd',
      '#f0a6c0',
      '#e6c07b',
      '#8fd3c7',
    ],
  },
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
  const [picking, setPicking] = useState(false)
  const swatch = useRef<HTMLButtonElement>(null)
  const name = `${appearance === 'light' ? 'Light' : 'Dark'} ${role}`
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
        <button
          ref={swatch}
          type="button"
          className="palette-color-swatch"
          style={{ backgroundColor: valid ? draft : value }}
          aria-label={`Choose the ${name.toLocaleLowerCase()} colour`}
          aria-haspopup="dialog"
          aria-expanded={picking}
          onClick={() => setPicking(open => !open)}
        >
          <ChevronDown size={11} strokeWidth={2.6} aria-hidden="true" />
        </button>
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
      <ColorPicker
        anchor={swatch.current}
        open={picking}
        onClose={() => setPicking(false)}
        value={value}
        onChange={next => onChange(next)}
        label={`${name} colour`}
        presets={PRESETS[appearance][role]}
      />
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
