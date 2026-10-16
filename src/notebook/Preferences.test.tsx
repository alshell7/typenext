import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltinState } from '../services/builtin-engine'
import type { EmbeddingRuntimeStatus } from '../services/embedding-runtime'
import type { NotebookSettings } from '../types/notebook'
import { defaultSettings } from './model'
import { Preferences, type PreferencePane } from './Preferences'

const mocked = vi.hoisted(() => ({
  desktop: false,
  secrets: new Map<string, string>(),
  builtin: null as BuiltinState | null,
  runtime: null as EmbeddingRuntimeStatus | null,
  runtimeListeners: new Set<() => void>(),
  install: vi.fn(),
  cancel: vi.fn(async () => {}),
  providerModels: vi.fn(),
  testProvider: vi.fn(),
}))

vi.mock('../services/native', () => ({
  isDesktop: () => mocked.desktop,
  getSecret: vi.fn(async (id: string) => mocked.secrets.get(id) ?? ''),
  setSecret: vi.fn(async (id: string, value: string) => {
    mocked.secrets.set(id, value)
  }),
}))

vi.mock('../services/builtin-engine', () => ({
  getBuiltinState: () => mocked.builtin!,
  getBuiltinBackendPreference: () => 'wasm',
  subscribeBuiltinState: () => () => {},
  checkBuiltinCache: vi.fn(async () => false),
  downloadBuiltinModel: vi.fn(async () => {}),
  loadBuiltinModel: vi.fn(async () => {}),
  removeBuiltinModel: vi.fn(async () => {}),
  unloadBuiltinModel: vi.fn(),
}))

vi.mock('../services/completion', () => ({
  getProviderModels: mocked.providerModels,
  testProvider: mocked.testProvider,
}))

vi.mock('../services/embedding-runtime', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../services/embedding-runtime')>()
  return {
    ...actual,
    getEmbeddingRuntimeStatus: () => mocked.runtime!,
    subscribeEmbeddingRuntime: (listener: () => void) => {
      mocked.runtimeListeners.add(listener)
      return () => mocked.runtimeListeners.delete(listener)
    },
    refreshEmbeddingRuntime: vi.fn(async () => mocked.runtime!),
    installEmbeddingRuntime: mocked.install,
    cancelEmbeddingInstall: mocked.cancel,
    startEmbeddingRuntime: vi.fn(async () => mocked.runtime!),
    stopEmbeddingRuntime: vi.fn(async () => mocked.runtime!),
    removeEmbeddingRuntime: vi.fn(async () => mocked.runtime!),
    resolveEmbeddingEndpoint: vi.fn(async () => ({
      endpoint: 'http://127.0.0.1:8080',
      media: false,
    })),
  }
})

vi.mock('../services/embedding-client', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/embedding-client')>()),
  checkEmbeddingServer: vi.fn(async () => ({
    modalities: { vision: false, audio: false, video: false },
    latencyMs: 42,
  })),
}))

vi.mock('../services/semantic-retrieval', async importOriginal => {
  const index = { state: 'indexing', indexed: 120, total: 300 } as const
  return {
    ...(await importOriginal<
      typeof import('../services/semantic-retrieval')
    >()),
    getSemanticIndexStatus: () => index,
    subscribeSemanticIndex: () => () => {},
  }
})

function publishRuntime(next: Partial<EmbeddingRuntimeStatus>) {
  act(() => {
    mocked.runtime = { ...mocked.runtime!, ...next }
    mocked.runtimeListeners.forEach(listener => listener())
  })
}

let latest: NotebookSettings
let currentPane: PreferencePane

function Harness({
  initial = defaultSettings(),
  pane = 'writing',
}: {
  initial?: NotebookSettings
  pane?: PreferencePane
}) {
  const [settings, setSettings] = useState(initial)
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState<PreferencePane>(pane)
  latest = settings
  currentPane = active
  return (
    <Preferences
      open={open}
      onOpenChange={setOpen}
      pane={active}
      onPaneChange={setActive}
      settings={settings}
      onChange={setSettings}
    />
  )
}

const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mocked.desktop = false
  mocked.secrets.clear()
  mocked.runtimeListeners.clear()
  mocked.builtin = {
    status: 'idle',
    cached: false,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 139_000_000,
    backend: null,
    identity: 'fixture',
  }
  mocked.runtime = {
    state: 'idle',
    installed: { runtime: false, models: [], media: false },
    diskBytes: 0,
  }
  Element.prototype.scrollIntoView = scrollIntoView
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    callback(0)
    return 0
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('preferences navigation', () => {
  it('moves through the vertical rail with arrows, Home and End', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const writing = screen.getByRole('tab', { name: 'Writing' })
    expect(writing).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('tablist', { name: 'Preferences' })
    ).toHaveAttribute('aria-orientation', 'vertical')
    writing.focus()
    await user.keyboard('{ArrowDown}')
    const editor = screen.getByRole('tab', { name: 'Editor' })
    expect(editor).toHaveFocus()
    expect(editor).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'tab-editor'
    )
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Shortcuts' })).toHaveFocus()
    expect(currentPane).toBe('shortcuts')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('tab', { name: 'Writing' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(currentPane).toBe('shortcuts')
    await user.keyboard('{Home}')
    expect(currentPane).toBe('writing')
    await user.click(screen.getByRole('tab', { name: 'Models' }))
    expect(
      screen.getByRole('heading', { level: 2, name: 'Models' })
    ).toBeInTheDocument()
  })

  it.each([
    ['local', 'models-local'],
    ['external', 'models-external'],
  ] as const)(
    'opens the legacy %s pane as Models scrolled to its section',
    (pane, section) => {
      render(<Harness pane={pane} />)
      expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      expect(scrollIntoView).toHaveBeenCalled()
      expect(scrollIntoView.mock.instances.at(-1)).toBe(
        document.getElementById(section)
      )
    }
  )

  it('keeps one suggestion instructions field and the zen level control', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(
      within(screen.getByRole('radiogroup', { name: 'Zen mode' })).getByRole(
        'radio',
        { name: 'Full' }
      )
    )
    expect(latest.zenLevel).toBe('full')
    await user.click(screen.getByRole('tab', { name: 'Suggestions' }))
    expect(screen.getAllByLabelText('Suggestion instructions')).toHaveLength(1)
    await user.type(
      screen.getByLabelText('Suggestion instructions'),
      'Keep my voice.'
    )
    expect(latest.suggestionInstructions).toBe('Keep my voice.')
  })
})

describe('editor preferences', () => {
  it('adds, edits and deletes a custom command', async () => {
    const user = userEvent.setup()
    render(<Harness pane="editor" />)
    await user.click(screen.getByRole('button', { name: 'Add command' }))
    await user.click(screen.getByRole('button', { name: 'Save command' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Give the command a name.'
    )
    await user.type(screen.getByLabelText('Command name'), 'Sign-off')
    await user.type(screen.getByLabelText('Text to insert'), 'Best, ')
    await user.click(screen.getByRole('button', { name: '{cursor}' }))
    await user.click(screen.getByRole('button', { name: 'Save command' }))
    expect(latest.editor.customCommands).toEqual([
      expect.objectContaining({ name: 'Sign-off', template: 'Best, {cursor}' }),
    ])
    const list = screen.getByRole('list', { name: 'Custom commands' })
    expect(list).toHaveTextContent('Sign-off')

    await user.click(screen.getByRole('button', { name: 'Edit Sign-off' }))
    const name = screen.getByLabelText('Command name')
    await user.clear(name)
    await user.type(name, 'Table')
    await user.click(screen.getByRole('button', { name: 'Save command' }))
    expect(latest.editor.customCommands).toHaveLength(1)
    expect(latest.editor.customCommands[0]?.name).toBe('Table')

    await user.click(screen.getByRole('button', { name: 'Delete Table' }))
    expect(latest.editor.customCommands).toEqual([])
    expect(screen.getByText(/No custom commands yet/)).toBeInTheDocument()
  })

  it('saves only a single symbol as the insert menu trigger', async () => {
    const user = userEvent.setup()
    render(<Harness pane="editor" />)
    const trigger = screen.getByLabelText('Trigger character')
    await user.clear(trigger)
    await user.type(trigger, 'a')
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(latest.editor.slashTrigger).toBe('/')
    await user.clear(trigger)
    await user.type(trigger, ';')
    expect(latest.editor.slashTrigger).toBe(';')
    await user.click(screen.getByRole('radio', { name: 'Notes' }))
    expect(latest.editor.linkPreviews).toBe('notes')
  })
})

describe('knowledge preferences', () => {
  it('downloads with progress, cancels, and shows runtime errors', async () => {
    mocked.desktop = true
    const settings = defaultSettings()
    settings.semantic = { ...settings.semantic, runtime: 'managed' }
    let finish!: () => void
    mocked.install.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const user = userEvent.setup()
    render(<Harness initial={settings} pane="knowledge" />)
    await user.click(screen.getByRole('button', { name: 'Download 196 MB' }))
    expect(mocked.install).toHaveBeenCalledWith('UD-Q4_K_XL', false)
    publishRuntime({
      state: 'downloading',
      progress: {
        file: 'embeddinggemma-2-UD-Q4_K_XL.gguf',
        downloadedBytes: 87_836_928,
        totalBytes: 175_673_856,
      },
    })
    const bar = screen.getByRole('progressbar', {
      name: 'Embedding model download',
    })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText(/88 MB of 176 MB · 50%/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel download' }))
    expect(mocked.cancel).toHaveBeenCalledOnce()
    await act(async () => finish())
    publishRuntime({ state: 'idle', progress: undefined })

    mocked.install.mockRejectedValueOnce('embedding_runtime_install not found')
    await user.click(screen.getByRole('button', { name: 'Download 196 MB' }))
    expect(
      await screen.findByText('embedding_runtime_install not found')
    ).toBeInTheDocument()
  })

  it('shows the llama-server command and current index in server mode', async () => {
    const settings = defaultSettings()
    settings.semantic = { ...settings.semantic, enabled: true }
    const user = userEvent.setup()
    render(<Harness initial={settings} pane="knowledge" />)
    expect(
      screen.getByRole('radio', { name: 'Inside TypeNext' })
    ).toBeDisabled()
    expect(screen.getByLabelText('Server command')).toHaveTextContent(
      'llama-server -m embeddinggemma-2-UD-Q4_K_XL.gguf --embeddings --pooling mean --ctx-size 8192 --batch-size 8192 --ubatch-size 8192 --host 127.0.0.1 --port 8080'
    )
    expect(screen.getByText('Indexed 120 of 300 passages')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: /^Images, audio/ }))
    expect(screen.getByLabelText('Server command')).toHaveTextContent(
      '--mmproj mmproj-Q8_0.gguf'
    )
    await user.click(screen.getByRole('button', { name: 'Check connection' }))
    expect(
      await screen.findByText('Connected in 42 ms. Reads text.')
    ).toBeInTheDocument()
  })
})

describe('web facts preferences', () => {
  it('toggles web facts, chooses a model and links to the OpenAI key', async () => {
    const user = userEvent.setup()
    render(<Harness pane="web" />)
    await user.click(screen.getByRole('switch', { name: /^Web facts/ }))
    expect(latest.webFacts.enabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'gpt-6-luna' }))
    expect(latest.webFacts.model).toBe('gpt-6-luna')
    const model = screen.getByLabelText('Search model')
    await user.clear(model)
    await user.type(model, 'gpt-custom')
    expect(latest.webFacts.model).toBe('gpt-custom')
    await user.click(screen.getByRole('switch', { name: /^Also ground Ctrl/ }))
    expect(latest.webFacts.withSuggestions).toBe(true)
    await user.click(
      await screen.findByRole('button', { name: 'Add OpenAI key' })
    )
    expect(latest.externalProvider).toBe('openai')
    expect(currentPane).toBe('external')
  })
})

describe('model preferences', () => {
  it('saves a provider key, picks a listed model and activates it', async () => {
    mocked.providerModels.mockResolvedValueOnce([
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' },
    ])
    const user = userEvent.setup()
    render(<Harness pane="models" />)
    const external = screen.getByRole('region', { name: 'External providers' })
    await user.click(within(external).getByRole('radio', { name: 'OpenAI' }))
    expect(latest.externalProvider).toBe('openai')
    await user.type(within(external).getByLabelText('API key'), 'sk-test')
    await user.click(within(external).getByRole('button', { name: 'Save key' }))
    expect(
      await within(external).findByText('Ready for this session.')
    ).toBeInTheDocument()
    expect(mocked.secrets.get('provider:openai')).toBe('sk-test')

    await user.click(
      within(external).getByRole('button', { name: 'Load models' })
    )
    const search = await within(external).findByRole('combobox', {
      name: 'Search models',
    })
    await user.type(search, 'mini')
    expect(
      within(within(external).getByRole('listbox')).getAllByRole('option')
    ).toHaveLength(1)
    await user.keyboard('{Enter}')
    expect(latest.profiles.openai.model).toBe('gpt-4.1-mini')

    await user.click(
      within(external).getByRole('button', { name: 'Use OpenAI continuously' })
    )
    expect(latest.provider).toBe('openai')
    expect(latest.externalAutoEnabled).toBe(true)
    expect(latest.profiles.openai.savedModels).toEqual(['gpt-4.1-mini'])
    const engine = screen.getByRole('group', { name: 'Active engine' })
    expect(engine).toHaveTextContent('OpenAI')
    expect(engine).toHaveTextContent('gpt-4.1-mini')
    await user.click(
      within(engine).getByRole('button', { name: /Switch to this device/ })
    )
    expect(latest.provider).toBe('local')
    expect(latest.externalAutoEnabled).toBe(false)
  })

  it('selects a local engine and detects server models', async () => {
    mocked.testProvider.mockResolvedValueOnce(['qwen-writer'])
    const user = userEvent.setup()
    render(<Harness pane="models" />)
    const local = screen.getByRole('region', { name: 'On this device' })
    await user.click(within(local).getByRole('radio', { name: 'Local server' }))
    expect(latest.localEngine).toBe('server')
    await user.click(within(local).getByRole('button', { name: /LM Studio/ }))
    await user.click(
      within(local).getByRole('button', { name: 'Detect models' })
    )
    await user.click(await within(local).findByRole('option', { name: /qwen/ }))
    expect(latest.profiles.local.model).toBe('qwen-writer')
    expect(latest.profiles.local.endpoint).toBe('http://localhost:1234/v1')
  })
})

describe('shipped model catalog', () => {
  it('offers recommended Claude models in a dropdown without loading', async () => {
    const user = userEvent.setup()
    render(<Harness pane="models" />)
    const external = screen.getByRole('region', { name: 'External providers' })
    await user.click(within(external).getByRole('radio', { name: 'Anthropic' }))
    const select = within(external).getByLabelText('Choose a model')
    expect(
      within(select).getByRole('option', { name: /Claude Haiku 5\.5/ })
    ).toBeInTheDocument()
    await user.selectOptions(select, 'claude-sonnet-5-5')
    expect(latest.profiles.anthropic.model).toBe('claude-sonnet-5-5')
  })

  it('asks for a Cloudflare account ID and validates it', async () => {
    const user = userEvent.setup()
    render(<Harness pane="models" />)
    const external = screen.getByRole('region', { name: 'External providers' })
    await user.click(
      within(external).getByRole('radio', { name: 'Cloudflare' })
    )
    const account = within(external).getByLabelText('Account ID')
    await user.type(account, 'not-an-id')
    expect(
      within(external).getByText('An account ID has 32 letters and numbers.')
    ).toBeInTheDocument()
    await user.clear(account)
    await user.type(account, '0123456789abcdef0123456789abcdef')
    expect(latest.profiles.cloudflare.accountId).toBe(
      '0123456789abcdef0123456789abcdef'
    )
    expect(
      within(within(external).getByLabelText('Choose a model')).getByRole(
        'option',
        { name: /Llama 3\.3 70B/ }
      )
    ).toBeInTheDocument()
  })
})
