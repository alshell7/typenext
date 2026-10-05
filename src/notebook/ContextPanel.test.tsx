import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextSource, Note } from '../types/notebook'
import * as retrieval from '../services/retrieval'
import { ContextPanel } from './ContextPanel'
import { libraryReference } from './context-library'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function note(sources: ContextSource[]): Note {
  return {
    id: 'search-draft',
    title: 'Draft',
    sources,
    content: '',
    context: '',
    objective: '',
    createdAt: 1,
    updatedAt: 1,
  }
}
const library: ContextSource[] = [
  {
    id: 'garden',
    name: 'Garden.md',
    kind: 'markdown',
    text: 'The evening garden held the scent of blue lavender after the rain.',
    enabled: true,
    addedAt: 1,
  },
  {
    id: 'excluded',
    name: 'Excluded.txt',
    kind: 'text',
    text: 'Lavender unrelated evidence that is not included.',
    enabled: true,
    addedAt: 1,
  },
]

describe('explicit attached-context search', () => {
  it('runs actual BM25 only on submit, resolves library text and excludes unchecked references', async () => {
    const spy = vi.spyOn(retrieval, 'retrieveContext')
    const user = userEvent.setup()
    const onLibrary = vi.fn()
    const sources = [
      libraryReference(library[0]!),
      libraryReference(library[1]!, false),
    ]
    render(
      <ContextPanel
        note={note(sources)}
        notes={[]}
        library={library}
        importing={false}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        onFiles={vi.fn().mockResolvedValue(undefined)}
        onWebsite={vi.fn()}
        onUseNote={vi.fn()}
        onLibrary={onLibrary}
      />
    )
    await user.click(
      screen.getByRole('button', { name: 'Choose from library' })
    )
    expect(onLibrary).toHaveBeenCalledTimes(1)
    await user.click(screen.getByText('Find in attached context'))
    expect(
      screen.getByText(
        'BM25 finds relevant passages on this device; model receives only matching excerpts.'
      )
    ).toBeVisible()
    await user.type(
      screen.getByRole('searchbox', { name: 'Search attached references' }),
      'blue lavender'
    )
    expect(spy).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Find passages' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[2]).toBe(4)
    expect(screen.getByText('1 matching passage')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Garden.md' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Excluded.txt' })).toBeNull()
    expect(screen.getByText(library[0]!.text)).toBeVisible()
    await user.type(
      screen.getByRole('searchbox', { name: 'Search attached references' }),
      ' changed'
    )
    expect(spy).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Garden.md' })).toBeNull()
  })

  it('invalidates visible passages when included source text changes and does not rerun retrieval automatically', async () => {
    const spy = vi.spyOn(retrieval, 'retrieveContext')
    const user = userEvent.setup()
    const current = note([libraryReference(library[0]!)])
    const props = {
      note: current,
      notes: [],
      library,
      importing: false,
      onUpdate: vi.fn(),
      onClose: vi.fn(),
      onFiles: vi.fn().mockResolvedValue(undefined),
      onWebsite: vi.fn(),
      onUseNote: vi.fn(),
    }
    const { rerender } = render(<ContextPanel {...props} />)
    await user.click(screen.getByText('Find in attached context'))
    await user.type(
      screen.getByRole('searchbox', { name: 'Search attached references' }),
      'lavender'
    )
    await user.click(screen.getByRole('button', { name: 'Find passages' }))
    rerender(
      <ContextPanel
        {...props}
        library={[
          {
            ...library[0]!,
            text: 'Changed writing with no old lavender passage.',
          },
        ]}
      />
    )
    expect(
      screen.getByText('References changed. Search again for current passages.')
    ).toBeVisible()
    expect(screen.queryByText(library[0]!.text)).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
