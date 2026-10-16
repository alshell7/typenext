import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotebookSettings } from '../types/notebook'
import { defaultSettings } from './model'
import { ModelChooser } from './ModelChooser'

vi.mock('../services/builtin-engine', () => {
  const state = {
    status: 'idle',
    cached: true,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 1,
    backend: null,
    identity: 'fixture',
  }
  return {
    getBuiltinState: () => state,
    subscribeBuiltinState: () => () => {},
  }
})

afterEach(cleanup)

function settings(): NotebookSettings {
  const base = defaultSettings()
  return {
    ...base,
    profiles: {
      ...base.profiles,
      openai: {
        ...base.profiles.openai,
        model: 'gpt-4.1-mini',
        savedModels: ['gpt-4.1-mini', 'gpt-4.1'],
      },
      anthropic: { ...base.profiles.anthropic, model: '' },
    },
  }
}

function renderChooser(initial = settings()) {
  const props = {
    onOpenChange: vi.fn(),
    onChange: vi.fn(),
    onConfigure: vi.fn(),
    onConfigureLocal: vi.fn(),
  }
  render(<ModelChooser open settings={initial} {...props} />)
  return props
}

describe('model chooser', () => {
  it('lists engines by group with the active one checked', () => {
    renderChooser()
    expect(
      screen.getByRole('group', { name: 'On this device' })
    ).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument()
    const recall = screen.getByRole('option', {
      name: 'Writing starters & recall',
    })
    expect(recall).toHaveAccessibleDescription(/^Active/)
    expect(recall).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('option', { name: 'Built-in SmolLM2' })
    ).toBeInTheDocument()
  })

  it('activates an external model with the arrow keys and Enter', async () => {
    const user = userEvent.setup()
    const props = renderChooser()
    const search = screen.getByRole('combobox', {
      name: 'Search engines and models',
    })
    expect(search).toHaveFocus()
    await user.type(search, 'gpt')
    expect(screen.getAllByRole('option')).toHaveLength(2)
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'gpt-4.1' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByText(/nearby writing/)).toBeInTheDocument()
    await user.keyboard('{Enter}')
    const next = props.onChange.mock.calls[0]?.[0] as NotebookSettings
    expect(next.provider).toBe('openai')
    expect(next.externalAutoEnabled).toBe(true)
    expect(next.profiles.openai.model).toBe('gpt-4.1')
    expect(next.profiles.openai.savedModels?.[0]).toBe('gpt-4.1')
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('returns to this device and opens setup for unconfigured providers', async () => {
    const user = userEvent.setup()
    const active = {
      ...settings(),
      provider: 'openai' as const,
      externalAutoEnabled: true,
    }
    const props = renderChooser(active)
    expect(
      screen.getByRole('option', { name: 'gpt-4.1-mini' })
    ).toHaveAccessibleDescription(/^Active/)
    await user.click(screen.getByRole('option', { name: 'Built-in SmolLM2' }))
    const local = props.onChange.mock.calls[0]?.[0] as NotebookSettings
    expect(local.provider).toBe('local')
    expect(local.externalAutoEnabled).toBe(false)
    expect(local.localEngine).toBe('embedded')

    await user.click(screen.getByRole('option', { name: 'Set up Anthropic' }))
    expect(
      (props.onChange.mock.calls[1]?.[0] as NotebookSettings).externalProvider
    ).toBe('anthropic')
    expect(props.onConfigure).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: /Manage models/ }))
    expect(props.onConfigure).toHaveBeenCalledTimes(2)
  })

  it('opens local setup for a server without a model', async () => {
    const user = userEvent.setup()
    const props = renderChooser()
    await user.type(
      screen.getByRole('combobox', { name: 'Search engines and models' }),
      'server'
    )
    await user.keyboard('{Enter}')
    expect(props.onConfigureLocal).toHaveBeenCalledOnce()
    expect(props.onChange).not.toHaveBeenCalled()
  })
})
