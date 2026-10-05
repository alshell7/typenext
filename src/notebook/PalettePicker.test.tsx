import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotebookSettings } from '../types/notebook'
import { defaultSettings } from './model'
import { PalettePicker } from './PalettePicker'

afterEach(cleanup)

function Harness({
  initial = defaultSettings(),
  onChange,
}: {
  initial?: NotebookSettings
  onChange(settings: NotebookSettings): void
}) {
  const [settings, setSettings] = useState(initial)
  return (
    <PalettePicker
      settings={settings}
      onChange={next => {
        setSettings(next)
        onChange(next)
      }}
    />
  )
}

describe('palette preferences', () => {
  it('offers both labelled radio groups and previews a checked dark preset from light mode', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const initial = defaultSettings()
    initial.theme = 'light'
    render(<Harness initial={initial} onChange={onChange} />)
    const light = screen.getByRole('group', { name: 'Light palette' })
    const dark = screen.getByRole('group', { name: 'Dark palette' })
    expect(within(light).getAllByRole('radio')).toHaveLength(4)
    expect(within(dark).getAllByRole('radio')).toHaveLength(4)
    expect(within(light).getByRole('radio', { name: 'Paper' })).toBeChecked()
    expect(within(dark).getByRole('radio', { name: 'Graphite' })).toBeChecked()
    await user.click(within(light).getByRole('radio', { name: 'Linen' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'light',
        provider: 'local',
        palette: expect.objectContaining({ light: 'linen' }),
      })
    )
    await user.click(within(dark).getByRole('radio', { name: 'Graphite' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: 'dark',
        provider: 'local',
        palette: expect.objectContaining({ light: 'linen', dark: 'graphite' }),
      })
    )
  })

  it('keeps incomplete custom HEX input out of settings and reports how to fix it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await user.click(
      within(screen.getByRole('group', { name: 'Light palette' })).getByRole(
        'radio',
        { name: 'Custom' }
      )
    )
    const page = screen.getByRole('textbox', { name: 'Light page color' })
    onChange.mockClear()
    await user.clear(page)
    await user.type(page, '#abc')
    expect(onChange).not.toHaveBeenCalled()
    await user.tab()
    expect(page).toHaveAttribute('aria-invalid', 'true')
    expect(page).toHaveAccessibleDescription('Use # and six hex digits.')
    await user.clear(page)
    await user.type(page, '#ABC123')
    expect(page).not.toHaveAttribute('aria-invalid')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        palette: expect.objectContaining({
          customLight: expect.objectContaining({ page: '#abc123' }),
        }),
      })
    )
    expect(
      screen.queryByRole('textbox', { name: 'Dark page color' })
    ).not.toBeInTheDocument()
  })

  it('changes each custom surface independently and lets Escape recover an incomplete field', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await user.click(
      within(screen.getByRole('group', { name: 'Dark palette' })).getByRole(
        'radio',
        { name: 'Custom' }
      )
    )
    const sidebar = screen.getByRole('textbox', { name: 'Dark sidebar color' })
    await user.clear(sidebar)
    await user.type(sidebar, '#FFFFFF')
    const latest = onChange.mock.lastCall?.[0] as NotebookSettings
    expect(latest.theme).toBe('dark')
    expect(latest.palette.customDark).toEqual({
      page: '#212121',
      sidebar: '#ffffff',
      accent: '#a6b6c8',
    })
    expect(latest.palette.customLight).toEqual(
      defaultSettings().palette.customLight
    )
    onChange.mockClear()
    await user.clear(sidebar)
    await user.type(sidebar, 'broken')
    await user.keyboard('{Escape}')
    expect(sidebar).toHaveValue('#ffffff')
    expect(sidebar).not.toHaveAttribute('aria-invalid')
    expect(onChange).not.toHaveBeenCalled()
    expect(sidebar).toHaveAttribute('maxlength', '7')
    expect(sidebar).toHaveAttribute('type', 'text')
  })
})
