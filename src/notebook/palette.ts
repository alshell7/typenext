import type { NotebookSettings, PaletteColors } from '../types/notebook'

export const LIGHT_PALETTES = {
  contrast: { page: '#ffffff', sidebar: '#e6e8eb', accent: '#123d77' },
  paper: { page: '#ffffff', sidebar: '#f3f4f1', accent: '#42644d' },
  linen: { page: '#faf6ef', sidebar: '#eee7db', accent: '#805f44' },
  mist: { page: '#f4f7fa', sidebar: '#e7edf3', accent: '#426482' },
} satisfies Record<string, PaletteColors>

export const DARK_PALETTES = {
  black: { page: '#000000', sidebar: '#101114', accent: '#c1c9d6' },
  contrast: { page: '#0b0b0e', sidebar: '#22252d', accent: '#c3d9ff' },
  graphite: { page: '#212121', sidebar: '#17191c', accent: '#a6b6c8' },
  midnight: { page: '#151c28', sidebar: '#111722', accent: '#91acce' },
  forest: { page: '#202921', sidebar: '#172019', accent: '#a8bf9d' },
} satisfies Record<string, PaletteColors>

export type PaletteTokens = Record<`--${string}`, string>
type RGB = [number, number, number]

export function validHex(value: string): boolean {
  return value.length === 7 && /^#[\da-f]{6}$/iu.test(value)
}

function hex(value: string, fallback: string): string {
  return validHex(value) ? value.toLowerCase() : fallback
}

function rgb(value: string): RGB {
  return [1, 3, 5].map(position =>
    parseInt(value.slice(position, position + 2), 16)
  ) as RGB
}

export function blend(from: string, to: string, amount: number): string {
  const left = rgb(from)
  const right = rgb(to)
  const weight = Math.max(0, Math.min(1, amount))
  return (
    '#' +
    left
      .map((component, index) =>
        Math.round(
          component + ((right[index] ?? component) - component) * weight
        )
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

function luminance(color: string): number {
  const [red, green, blue] = rgb(color).map(component => {
    const channel = component / 255
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return (red ?? 0) * 0.2126 + (green ?? 0) * 0.7152 + (blue ?? 0) * 0.0722
}

export function contrastRatio(first: string, second: string): number {
  const left = luminance(first)
  const right = luminance(second)
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
}

function readable(desired: string, backgrounds: string[]): string {
  const minimum = (color: string) =>
    Math.min(...backgrounds.map(background => contrastRatio(color, background)))
  if (minimum(desired) >= 4.5) return desired
  const target = minimum('#000000') > minimum('#ffffff') ? '#000000' : '#ffffff'
  for (let step = 1; step <= 25; step++) {
    const color = blend(desired, target, step / 25)
    if (minimum(color) >= 4.5) return color
  }
  return target
}

function surfaceColors(
  background: string,
  accent: string,
  highContrast = false
) {
  const target =
    contrastRatio('#ffffff', background) > contrastRatio('#000000', background)
      ? '#ffffff'
      : '#000000'
  const ink = readable(blend(background, target, highContrast ? 1 : 0.86), [
    background,
  ])
  // Preserve tonal depth while preventing a custom mid-gray surface from
  // crossing the contrast boundary for its already readable foreground.
  const safeBackground = (candidate: string) => readable(candidate, [ink])
  const surface = safeBackground(blend(background, target, 0.035))
  const hover = safeBackground(blend(background, target, 0.07))
  const soft = safeBackground(blend(background, accent, 0.13))
  const selection = safeBackground(blend(background, accent, 0.19))
  const backgrounds = [background, surface, hover, soft, selection]
  const secondary = readable(
    blend(background, target, highContrast ? 0.86 : 0.67),
    backgrounds
  )
  const muted = readable(
    blend(background, target, highContrast ? 0.76 : 0.56),
    backgrounds
  )
  return {
    ink,
    surface,
    hover,
    soft,
    selection,
    secondary,
    muted,
    accent: readable(accent, backgrounds),
    line: blend(background, target, highContrast ? 0.4 : 0.14),
    error: readable(target === '#ffffff' ? '#eea29a' : '#a13d37', backgrounds),
  }
}

export function selectedPalette(
  settings: NotebookSettings,
  dark: boolean
): PaletteColors {
  const fallback = dark ? DARK_PALETTES.graphite : LIGHT_PALETTES.paper
  const selected = dark ? settings.palette.dark : settings.palette.light
  const colors =
    selected === 'custom'
      ? dark
        ? settings.palette.customDark
        : settings.palette.customLight
      : dark
        ? DARK_PALETTES[selected as keyof typeof DARK_PALETTES]
        : LIGHT_PALETTES[selected as keyof typeof LIGHT_PALETTES]
  return {
    page: hex(colors?.page ?? '', fallback.page),
    sidebar: hex(colors?.sidebar ?? '', fallback.sidebar),
    accent: hex(colors?.accent ?? '', fallback.accent),
  }
}

export function paletteTokens(
  colors: PaletteColors,
  highContrast = false
): PaletteTokens {
  const safe = {
    page: hex(colors.page, LIGHT_PALETTES.paper.page),
    sidebar: hex(colors.sidebar, LIGHT_PALETTES.paper.sidebar),
    accent: hex(colors.accent, LIGHT_PALETTES.paper.accent),
  }
  const page = surfaceColors(safe.page, safe.accent, highContrast)
  const sidebar = surfaceColors(safe.sidebar, safe.accent, highContrast)
  const onAccent = readable(
    contrastRatio('#ffffff', safe.accent) >
      contrastRatio('#000000', safe.accent)
      ? '#ffffff'
      : '#000000',
    [safe.accent]
  )
  return {
    '--paper': safe.page,
    '--sidebar': safe.sidebar,
    '--surface': page.surface,
    '--hover': page.hover,
    '--ink': page.ink,
    '--secondary': page.secondary,
    '--muted': page.muted,
    '--ghost': page.muted,
    '--line': page.line,
    '--accent': page.accent,
    '--accent-fill': safe.accent,
    '--accent-hover': readable(blend(safe.accent, onAccent, 0.07), [onAccent]),
    '--accent-soft': page.soft,
    '--on-accent': onAccent,
    '--error': page.error,
    '--editor-caret': page.accent,
    '--editor-selection': page.selection,
    '--sidebar-ink': sidebar.ink,
    '--sidebar-secondary': sidebar.secondary,
    '--sidebar-muted': sidebar.muted,
    '--sidebar-surface': sidebar.surface,
    '--sidebar-hover': sidebar.hover,
    '--sidebar-line': sidebar.line,
    '--sidebar-accent': sidebar.accent,
    '--sidebar-accent-soft': sidebar.soft,
    '--sidebar-error': sidebar.error,
    '--shadow':
      luminance(safe.page) < 0.18
        ? '0 24px 90px rgb(0 0 0 / 36%)'
        : '0 20px 80px rgb(31 40 30 / 16%)',
  }
}

export function applyPalette(
  root: HTMLElement,
  settings: NotebookSettings,
  dark: boolean
): void {
  const colors = selectedPalette(settings, dark)
  for (const [name, value] of Object.entries(
    paletteTokens(
      colors,
      (dark ? settings.palette.dark : settings.palette.light) === 'contrast'
    )
  ))
    root.style.setProperty(name, value)
  root.style.colorScheme = luminance(colors.page) < 0.18 ? 'dark' : 'light'
  root.dataset.palette = dark ? settings.palette.dark : settings.palette.light
}
