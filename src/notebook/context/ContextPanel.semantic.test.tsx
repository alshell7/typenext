import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ContextSource,
  Note,
  NotebookSettings,
} from '../../types/notebook'
import * as retrieval from '../../services/retrieval'
import { ContextPanel } from '../ContextPanel'

const semantic = vi.hoisted(() => ({
  status: { state: 'indexing', indexed: 40, total: 120 } as {
    state: string
    indexed: number
    total: number
  },
  listeners: new Set<() => void>(),
}))

vi.mock('../../services/semantic-retrieval', () => ({
  retrieveHybrid: vi.fn(async () => [
    {
      sourceId: 'garden',
      sourceName: 'Garden.md',
      text: 'Blue lavender after the rain.',
      score: 1,
      match: 'hybrid',
    },
    {
      sourceId: 'photo',
      sourceName: 'Harbour.jpg',
      text: 'Boats at dawn.',
      score: 0.8,
      match: 'semantic',
      mediaKind: 'image',
    },
    {
      sourceId: 'garden',
      sourceName: 'Notes.txt',
      text: 'Rain on the path.',
      score: 0.5,
      match: 'lexical',
    },
  ]),
  getSemanticIndexStatus: () => semantic.status,
  subscribeSemanticIndex: (listener: () => void) => {
    semantic.listeners.add(listener)
    return () => semantic.listeners.delete(listener)
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const source: ContextSource = {
  id: 'garden',
  name: 'Garden.md',
  kind: 'markdown',
  text: 'The evening garden held the scent of blue lavender after the rain.',
  enabled: true,
  addedAt: 1,
}
const current: Note = {
  id: 'draft',
  title: 'Draft',
  objective: '',
  context: '',
  content: '',
  sources: [source],
  createdAt: 1,
  updatedAt: 1,
}
function settings(enabled: boolean) {
  return {
    semantic: { enabled, media: true },
  } as unknown as NotebookSettings
}
function mount(value: NotebookSettings) {
  return render(
    <ContextPanel
      note={current}
      notes={[current]}
      importing={false}
      settings={value}
      onUpdate={vi.fn()}
      onClose={vi.fn()}
      onFiles={vi.fn().mockResolvedValue(undefined)}
      onWebsite={vi.fn()}
      onUseNote={vi.fn()}
    />
  )
}

describe('hybrid attached-context search', () => {
  it('uses hybrid retrieval with match badges and shows index progress', async () => {
    const { retrieveHybrid } = await import('../../services/semantic-retrieval')
    const lexical = vi.spyOn(retrieval, 'retrieveContext')
    const user = userEvent.setup()
    mount(settings(true))
    await user.click(screen.getByText('Find in attached context'))
    expect(screen.getByText('Indexing 40 of 120 passages')).toBeVisible()
    await user.type(
      screen.getByRole('searchbox', { name: 'Search attached references' }),
      'lavender'
    )
    await user.click(screen.getByRole('button', { name: 'Find passages' }))
    expect(await screen.findByText('3 matching passages')).toBeVisible()
    expect(retrieveHybrid).toHaveBeenCalledTimes(1)
    expect(vi.mocked(retrieveHybrid).mock.calls[0]?.[1]).toBe('lavender')
    expect(vi.mocked(retrieveHybrid).mock.calls[0]?.[3]).toMatchObject({
      limit: 4,
    })
    expect(lexical).not.toHaveBeenCalled()
    const results = screen.getByLabelText('Matching context passages')
    const garden = within(results)
      .getByRole('heading', { name: 'Garden.md' })
      .closest('article')!
    expect(within(garden).getByText('both')).toHaveAttribute(
      'title',
      'Matched words and meaning'
    )
    const photo = within(results)
      .getByRole('heading', { name: 'Harbour.jpg' })
      .closest('article')!
    expect(within(photo).getByText('meaning')).toBeVisible()
    const words = within(results)
      .getByRole('heading', { name: 'Notes.txt' })
      .closest('article')!
    expect(within(words).getByText('words')).toBeVisible()
  })

  it('keeps BM25 without badges while semantic search is off', async () => {
    const { retrieveHybrid } = await import('../../services/semantic-retrieval')
    const lexical = vi.spyOn(retrieval, 'retrieveContext')
    const user = userEvent.setup()
    mount(settings(false))
    await user.click(screen.getByText('Find in attached context'))
    expect(screen.queryByText(/Indexing/)).toBeNull()
    await user.type(
      screen.getByRole('searchbox', { name: 'Search attached references' }),
      'lavender'
    )
    await user.click(screen.getByRole('button', { name: 'Find passages' }))
    expect(screen.getByText('1 matching passage')).toBeVisible()
    expect(lexical).toHaveBeenCalledTimes(1)
    expect(retrieveHybrid).not.toHaveBeenCalled()
    expect(screen.queryByText('words')).toBeNull()
  })
})
