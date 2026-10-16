import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const secrets = new Map<string, string>()
vi.mock('../services/native', () => ({
  isDesktop: () => false,
  getSecret: vi.fn(async (id: string) => secrets.get(id) ?? ''),
  setSecret: vi.fn(async (id: string, value: string) => {
    secrets.set(id, value)
  }),
  requestJson: vi.fn(),
  requestText: vi.fn(),
}))

const embedding = {
  listeners: new Set<() => void>(),
  status: {
    state: 'idle',
    installed: { runtime: false, models: [], media: false },
    diskBytes: 0,
  } as Record<string, unknown>,
}
vi.mock('../services/embedding-runtime', () => ({
  EMBEDDING_RUNTIME: { modelRepository: 'unsloth/embeddinggemma-2-GGUF' },
  getEmbeddingRuntimeStatus: () => embedding.status,
  subscribeEmbeddingRuntime: (listener: () => void) => {
    embedding.listeners.add(listener)
    return () => embedding.listeners.delete(listener)
  },
}))

const {
  huggingFaceHeaders,
  huggingFaceIssue,
  resetHuggingFaceForTests,
  promptForHuggingFaceError,
} = await import('../services/huggingface')
const { HuggingFaceGuide } = await import('./HuggingFaceGuide')

beforeEach(() => {
  secrets.clear()
  resetHuggingFaceForTests()
  embedding.status = {
    state: 'idle',
    installed: { runtime: false, models: [], media: false },
    diskBytes: 0,
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Hugging Face tokens', () => {
  it('recognizes refusals from status codes and error text', () => {
    expect(huggingFaceIssue(401)).toBe('auth')
    expect(huggingFaceIssue(403)).toBe('auth')
    expect(huggingFaceIssue(429)).toBe('rate-limit')
    expect(huggingFaceIssue(500)).toBeNull()
    expect(huggingFaceIssue('huggingface-auth')).toBe('auth')
    expect(huggingFaceIssue('Access to model google/x is restricted')).toBe(
      'auth'
    )
    expect(huggingFaceIssue('The connection failed')).toBeNull()
  })

  it('sends the token only to huggingface.co', async () => {
    secrets.set('huggingface', 'hf_secret')
    expect(
      await huggingFaceHeaders('https://huggingface.co/a/b/resolve/x/f.gguf')
    ).toEqual({ Authorization: 'Bearer hf_secret' })
    expect(await huggingFaceHeaders('https://github.com/x/y')).toEqual({})
    expect(
      await huggingFaceHeaders('https://huggingface.co.evil.example/f')
    ).toEqual({})
    secrets.clear()
    expect(await huggingFaceHeaders('https://huggingface.co/f')).toEqual({})
  })

  it('opens the guide when a download is refused, then verifies and saves the token', async () => {
    const retry = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://huggingface.co/api/whoami-v2')
        const auth = (init?.headers as Record<string, string>).Authorization
        return auth === 'Bearer hf_good'
          ? new Response(JSON.stringify({ name: 'writer' }))
          : new Response('{}', { status: 401 })
      })
    )
    render(<HuggingFaceGuide onRetry={retry} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => {
      embedding.status = {
        ...embedding.status,
        state: 'error',
        error: 'Hugging Face asks for a sign-in token for this model.',
        errorCode: 'huggingface-auth',
      }
      embedding.listeners.forEach(listener => listener())
    })
    expect(
      await screen.findByRole('dialog', {
        name: 'Hugging Face asks you to sign in',
      })
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Model page/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/unsloth/embeddinggemma-2-GGUF'
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Hugging Face token'), 'hf_bad')
    await user.click(
      screen.getByRole('button', { name: 'Check and save token' })
    )
    expect(
      await screen.findByText(/did not accept this token/u)
    ).toBeInTheDocument()
    expect(secrets.get('huggingface')).toBeUndefined()
    await user.clear(screen.getByLabelText('Hugging Face token'))
    await user.type(screen.getByLabelText('Hugging Face token'), 'hf_good')
    await user.click(
      screen.getByRole('button', { name: 'Check and save token' })
    )
    expect(
      await screen.findByText('Saved. Signed in as writer.')
    ).toBeInTheDocument()
    expect(secrets.get('huggingface')).toBe('hf_good')
    await user.click(
      screen.getByRole('button', { name: /Try the download again/ })
    )
    expect(retry).toHaveBeenCalledWith('embedding')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains rate limits differently and ignores other errors', async () => {
    render(<HuggingFaceGuide />)
    act(() => {
      expect(
        promptForHuggingFaceError(new Error('Disk full'), 'Fluid Speech Mini')
      ).toBe(false)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => {
      expect(
        promptForHuggingFaceError(
          new Error('HTTP 429 Too Many Requests'),
          'Fluid Speech Mini'
        )
      ).toBe(true)
    })
    expect(
      await screen.findByRole('dialog', {
        name: 'Hugging Face is limiting downloads',
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Model page/ })).toBeNull()
  })
})
