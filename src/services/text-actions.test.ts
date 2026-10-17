import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../notebook/model'
import type { NotebookSettings } from '../types/notebook'
import { getSecret, requestJson } from './native'
import { aiEngine, cleanRewrite, runTextAction } from './text-actions'

vi.mock('./native', () => ({
  getSecret: vi.fn(),
  requestJson: vi.fn(),
  isDesktop: () => false,
  asError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
}))

function external(): NotebookSettings {
  const settings = defaultSettings()
  settings.provider = 'openai'
  settings.externalAutoEnabled = true
  settings.profiles.openai = {
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
    protocol: 'chat',
  }
  return settings
}

function lastBody() {
  return vi.mocked(requestJson).mock.calls.at(-1)?.[1]?.body as {
    messages: { role: string; content: string }[]
  }
}

beforeEach(() => {
  vi.mocked(requestJson).mockReset()
  vi.mocked(getSecret).mockResolvedValue('test-key')
})

describe('aiEngine', () => {
  it('uses only an activated chat model', () => {
    expect(aiEngine(defaultSettings())).toBeNull()
    expect(aiEngine(external())).toEqual({
      provider: 'openai',
      label: 'OpenAI · gpt-5.4-mini',
    })
    const local = defaultSettings()
    local.localEngine = 'server'
    local.profiles.local.model = 'qwen3-4b'
    expect(aiEngine(local)?.provider).toBe('local')
    local.profiles.local.protocol = 'fim'
    expect(aiEngine(local)).toBeNull()
    const embedded = defaultSettings()
    embedded.localEngine = 'embedded'
    expect(aiEngine(embedded)).toBeNull()
    const off = external()
    off.ai.selectionActions = false
    expect(aiEngine(off)).toBeNull()
  })

  it('ignores a remembered cloud model that was never activated', () => {
    const settings = external()
    settings.externalAutoEnabled = false
    settings.provider = 'local'
    expect(aiEngine(settings)).toBeNull()
  })
})

describe('cleanRewrite', () => {
  it('removes labels, fences and wrapping quotes and keeps the outer spaces', () => {
    expect(cleanRewrite('Here is the polished passage:\nA calm sea.', ' A calm sea ')).toBe(
      ' A calm sea. '
    )
    expect(cleanRewrite('```\nNew text\n```', 'old\n')).toBe('New text\n')
    expect(cleanRewrite('“A line.”', 'A line')).toBe('A line.')
    expect(cleanRewrite('<think>hmm</think>Done.', 'x')).toBe('Done.')
    expect(cleanRewrite('   ', 'x')).toBe('')
  })

  it('keeps quotes that belong to the passage', () => {
    expect(cleanRewrite('"Stay," she said.', '"stay" she said')).toBe(
      '"Stay," she said.'
    )
  })
})

describe('runTextAction', () => {
  it('sends the selection as data with its context and returns the edit', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      choices: [{ message: { content: 'The river runs clear.' } }],
    })
    const result = await runTextAction(
      {
        action: 'grammar',
        text: 'The river run clear.',
        before: 'Morning. ',
        after: ' Birds sing.',
        noteTitle: 'Walk',
      },
      external()
    )
    expect(result).toBe('The river runs clear.')
    const body = lastBody()
    expect(body.messages[0]?.content).toContain('Correct only spelling')
    expect(JSON.parse(body.messages[1]!.content)).toEqual({
      noteTitle: 'Walk',
      before: 'Morning. ',
      passage: 'The river run clear.',
      after: ' Birds sing.',
    })
  })

  it('passes the writer’s own instruction as quoted data', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      choices: [{ message: { content: 'Bonjour.' } }],
    })
    await runTextAction(
      {
        action: { instruction: 'Translate to French' },
        text: 'Hello.',
        before: '',
        after: '',
        noteTitle: '',
      },
      external()
    )
    expect(lastBody().messages[0]?.content).toContain('"Translate to French"')
  })

  it('refuses without a model, without text and for very long selections', async () => {
    const request = {
      action: 'polish' as const,
      text: 'x',
      before: '',
      after: '',
      noteTitle: '',
    }
    await expect(runTextAction(request, defaultSettings())).rejects.toThrow(
      /Activate a chat model/u
    )
    await expect(
      runTextAction({ ...request, text: '  ' }, external())
    ).rejects.toThrow(/Select some text/u)
    await expect(
      runTextAction({ ...request, text: 'x'.repeat(8_001) }, external())
    ).rejects.toThrow(/8,000/u)
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('reports an empty answer instead of erasing the selection', async () => {
    vi.mocked(requestJson).mockResolvedValue({
      choices: [{ message: { content: '' } }],
    })
    await expect(
      runTextAction(
        {
          action: 'rewrite',
          text: 'Keep me.',
          before: '',
          after: '',
          noteTitle: '',
        },
        external()
      )
    ).rejects.toThrow(/no text/u)
  })
})
