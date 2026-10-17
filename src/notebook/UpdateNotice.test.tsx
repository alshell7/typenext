import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const desktop = vi.hoisted(() => ({ value: true }))
const check = vi.hoisted(() => vi.fn())
vi.mock('../services/native', () => ({ isDesktop: () => desktop.value }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => {}) }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }))

import { UpdateNotice } from './UpdateNotice'
import { UpdatesPane } from './preferences/UpdatesPane'
import { defaultSettings } from './model'
import { checkForUpdates, resetUpdatesForTests } from '../services/updater'
import { validateWorkspace } from '../services/storage'

function found() {
  return {
    version: '0.3.0',
    body: '- Calmer suggestions\n- Faster graph',
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  desktop.value = true
  check.mockReset()
  resetUpdatesForTests()
})
afterEach(() => {
  cleanup()
  resetUpdatesForTests()
})

describe('the update notice', () => {
  it('stays away until a version is ready, then offers a restart and notes', async () => {
    check.mockResolvedValue(found())
    render(<UpdateNotice hidden={false} onOpenSettings={() => {}} />)
    expect(screen.queryByRole('region', { name: 'Update' })).toBeNull()
    await act(() => checkForUpdates({ download: true }))
    const notice = screen.getByRole('region', { name: 'Update' })
    expect(notice).toHaveTextContent('TypeNext 0.3.0 is ready')
    expect(
      screen.getByRole('button', { name: 'Restart to update' })
    ).toBeVisible()
    const toggle = screen.getByRole('button', { name: /What’s new/u })
    expect(screen.getByText('Calmer suggestions')).not.toBeVisible()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Calmer suggestions')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('region', { name: 'Update' })).toBeNull()
  })

  it('offers a download when background downloads are off, and hides in zen', async () => {
    check.mockResolvedValue(found())
    const { rerender } = render(
      <UpdateNotice hidden={false} onOpenSettings={() => {}} />
    )
    await act(() => checkForUpdates())
    expect(screen.getByRole('region', { name: 'Update' })).toHaveTextContent(
      'TypeNext 0.3.0 is available'
    )
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible()
    rerender(<UpdateNotice hidden onOpenSettings={() => {}} />)
    expect(screen.queryByRole('region', { name: 'Update' })).toBeNull()
  })
})

describe('the Updates pane', () => {
  const props = () => {
    let settings = defaultSettings()
    return {
      settings,
      update: vi.fn(patch => {
        settings = { ...settings, ...patch }
      }),
      latest: () => settings,
      onPaneChange: vi.fn(),
    }
  }

  it('checks on request and turns the switches into settings', async () => {
    check.mockResolvedValue(null)
    const pane = props()
    render(<UpdatesPane {...pane} />)
    expect(await screen.findByText('TypeNext 0.2.0')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Check now/u }))
    expect(
      await screen.findByText('You have the latest version.')
    ).toBeVisible()
    fireEvent.click(
      screen.getByRole('switch', {
        name: /^Download updates in the background/u,
      })
    )
    expect(pane.update).toHaveBeenCalledWith({
      updates: { autoCheck: true, autoDownload: false },
    })
  })

  it('explains that the browser preview does not update itself', () => {
    desktop.value = false
    render(<UpdatesPane {...props()} />)
    expect(
      screen.getByText('Updates are part of the desktop app.')
    ).toBeVisible()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('update settings', () => {
  it('default to on and repair bad values', () => {
    expect(defaultSettings().updates).toEqual({
      autoCheck: true,
      autoDownload: true,
    })
    const workspace = validateWorkspace({
      version: 1,
      notes: [],
      openNoteIds: [],
      activeNoteId: null,
      settings: { ...defaultSettings(), updates: { autoCheck: false } },
    })
    expect(workspace.settings.updates).toEqual({
      autoCheck: false,
      autoDownload: true,
    })
  })
})
