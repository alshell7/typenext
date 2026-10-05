import { describe, expect, it } from 'vitest'
import type { PaletteColors } from '../types/notebook'
import { defaultSettings } from './model'
import {
  applyPalette,
  contrastRatio,
  DARK_PALETTES,
  LIGHT_PALETTES,
  paletteTokens,
  selectedPalette,
  validHex,
  type PaletteTokens,
} from './palette'

function token(tokens: PaletteTokens, name: `--${string}`): string {
  const value = tokens[name]
  if (!value) throw new Error(`Missing palette token ${name}`)
  return value
}

function assertReadable(colors: PaletteColors) {
  const tokens = paletteTokens(colors)
  const groups = [
    {
      text: [
        '--ink',
        '--secondary',
        '--muted',
        '--ghost',
        '--accent',
        '--error',
      ],
      backgrounds: [
        '--paper',
        '--surface',
        '--hover',
        '--accent-soft',
        '--editor-selection',
      ],
    },
    {
      text: [
        '--sidebar-ink',
        '--sidebar-secondary',
        '--sidebar-muted',
        '--sidebar-accent',
        '--sidebar-error',
      ],
      backgrounds: [
        '--sidebar',
        '--sidebar-surface',
        '--sidebar-hover',
        '--sidebar-accent-soft',
      ],
    },
  ]
  for (const group of groups) {
    for (const foreground of group.text) {
      for (const background of group.backgrounds) {
        expect(
          contrastRatio(
            token(tokens, foreground as `--${string}`),
            token(tokens, background as `--${string}`)
          ),
          `${foreground} on ${background} for ${JSON.stringify(colors)}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  }
  for (const background of ['--accent-fill', '--accent-hover'] as const) {
    expect(
      contrastRatio(token(tokens, '--on-accent'), token(tokens, background))
    ).toBeGreaterThanOrEqual(4.5)
  }
}

describe('writing palettes', () => {
  it('keeps the default paper and neutral charcoal palette colours exact', () => {
    const settings = defaultSettings()
    expect(selectedPalette(settings, false)).toEqual({
      page: '#ffffff',
      sidebar: '#f3f4f1',
      accent: '#42644d',
    })
    expect(selectedPalette(settings, true)).toEqual({
      page: '#212121',
      sidebar: '#17191c',
      accent: '#a6b6c8',
    })
  })

  it.each([
    ...Object.entries(LIGHT_PALETTES),
    ...Object.entries(DARK_PALETTES),
  ])(
    '%s preserves its colours and readable text across interactive surfaces',
    (_name, colors) => {
      const tokens = paletteTokens(colors)
      expect(tokens['--paper']).toBe(colors.page)
      expect(tokens['--sidebar']).toBe(colors.sidebar)
      expect(tokens['--accent-fill']).toBe(colors.accent)
      assertReadable(colors)
    }
  )

  it('adapts the page and sidebar separately for opposite custom surfaces', () => {
    const colors = { page: '#ffffff', sidebar: '#000000', accent: '#ffffff' }
    const tokens = paletteTokens(colors)
    expect(contrastRatio(token(tokens, '--ink'), '#ffffff')).toBeGreaterThan(12)
    expect(
      contrastRatio(token(tokens, '--sidebar-ink'), '#000000')
    ).toBeGreaterThan(12)
    expect(tokens['--ink']).not.toBe(tokens['--sidebar-ink'])
    expect(tokens['--accent-fill']).toBe('#ffffff')
    expect(tokens['--accent']).not.toBe('#ffffff')
    assertReadable(colors)
    assertReadable({ page: '#000000', sidebar: '#ffffff', accent: '#000000' })
  })

  it.each([
    '#737373',
    '#757575',
    '#777777',
    '#7f7f7f',
    '#888888',
    '#c5ba9b',
    '#ff0088',
    '#00ffff',
  ])(
    'keeps muted text, suggestions and button labels readable around %s',
    color => {
      assertReadable({ page: color, sidebar: '#17191c', accent: '#ffffff' })
      assertReadable({ page: '#ffffff', sidebar: color, accent: '#000000' })
      assertReadable({ page: '#737373', sidebar: '#777777', accent: color })
    }
  )

  it('requires exactly six hex digits and safely replaces malformed custom values', () => {
    for (const color of [
      '#fff',
      '#12345g',
      '#123456\n',
      ' #123456',
      '#123456; color:red',
    ]) {
      expect(validHex(color)).toBe(false)
    }
    expect(validHex('#AbC123')).toBe(true)
    const settings = defaultSettings()
    settings.palette.light = 'custom'
    settings.palette.customLight = {
      page: '#123456\n',
      sidebar: 'url(https://example.test)',
      accent: '#AbC123',
    }
    expect(selectedPalette(settings, false)).toEqual({
      ...LIGHT_PALETTES.paper,
      accent: '#abc123',
    })
  })

  it('applies the selected mode and computed properties without a stylesheet dependency', () => {
    const root = document.createElement('div')
    const settings = defaultSettings()
    settings.palette.light = 'mist'
    applyPalette(root, settings, false)
    expect(root.style.getPropertyValue('--paper')).toBe(
      LIGHT_PALETTES.mist.page
    )
    expect(root.dataset.palette).toBe('mist')
    expect(root.style.colorScheme).toBe('light')
    applyPalette(root, settings, true)
    expect(root.style.getPropertyValue('--paper')).toBe(
      DARK_PALETTES.graphite.page
    )
    expect(root.style.getPropertyValue('--sidebar')).toBe(
      DARK_PALETTES.graphite.sidebar
    )
    expect(root.dataset.palette).toBe('graphite')
    expect(root.style.colorScheme).toBe('dark')
    settings.palette.dark = 'custom'
    settings.palette.customDark.page = '#ffffff'
    applyPalette(root, settings, true)
    expect(root.style.colorScheme).toBe('light')
    expect(root.dataset.palette).toBe('custom')
  })
})
