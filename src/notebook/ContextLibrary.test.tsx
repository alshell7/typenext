import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextSource, Note } from '../types/notebook'
import { ContextLibrary, type ContextLibraryProps } from './ContextLibrary'
import {
  CONTEXT_PREVIEW_CHARACTERS,
  contextLibraryFolders,
  contextLibraryUsage,
  filterContextLibrary,
  libraryReference,
} from './context-library'

vi.mock('./context-library', async importOriginal => {
  const original = await importOriginal<typeof import('./context-library')>()
  return {
    ...original,
    contextLibraryFolders: vi.fn(original.contextLibraryFolders),
    contextLibraryUsage: vi.fn(original.contextLibraryUsage),
    filterContextLibrary: vi.fn(original.filterContextLibrary),
  }
})

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

function source(id: string, name: string, folder?: string): ContextSource {
  return {
    id,
    name,
    folder,
    kind: 'text',
    text: `${name} contains useful evidence.`,
    enabled: true,
    addedAt: 1,
  }
}
function note(id: string, title: string, sources: ContextSource[] = []): Note {
  return {
    id,
    title,
    sources,
    content: `${title} writing.`,
    context: '',
    objective: '',
    createdAt: 1,
    updatedAt: 1,
  }
}
function mount(overrides: Partial<ContextLibraryProps> = {}) {
  const active = note('draft', 'Draft')
  const props: ContextLibraryProps = {
    open: true,
    onOpenChange: vi.fn(),
    library: [
      source('one', 'First.txt', 'Research'),
      source('two', 'Second.md', 'Research/Interviews'),
    ],
    notes: [active],
    activeNote: active,
    importing: false,
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    onRemove: vi.fn(),
    onFiles: vi.fn().mockResolvedValue(undefined),
    onWebsite: vi.fn(),
    onUseNote: vi.fn(),
    ...overrides,
  }
  const result = render(<ContextLibrary {...props} />)
  return { ...result, props, user: userEvent.setup() }
}

describe('context library interface', () => {
  it('does no reference or note scans while closed, then opens with current linked writing and selections', async () => {
    const item = source('shared', 'Shared.txt')
    const reference = libraryReference(item)
    const draft = note('draft', 'Draft', [reference])
    const research = note('research', 'Original research')
    const draftSources = vi.fn(() => [reference])
    const researchId = vi.fn(() => 'research')
    Object.defineProperty(draft, 'sources', { get: draftSources })
    Object.defineProperty(research, 'id', { get: researchId })
    const live: ContextSource = {
      ...source('live', 'Earlier title'),
      kind: 'note',
      linkedNoteId: 'research',
      text: '',
    }
    const { props, rerender, user } = mount({
      open: false,
      library: [item, live],
      notes: [draft, research],
      activeNote: draft,
    })
    function expectNoScans() {
      expect(contextLibraryFolders).not.toHaveBeenCalled()
      expect(contextLibraryUsage).not.toHaveBeenCalled()
      expect(filterContextLibrary).not.toHaveBeenCalled()
      expect(draftSources).not.toHaveBeenCalled()
      expect(researchId).not.toHaveBeenCalled()
    }
    expectNoScans()

    const editedDraft = { ...draft, content: 'More of my writing.' }
    const editedResearch = {
      ...research,
      title: 'Updated research',
      content: 'Current evidence.',
    }
    Object.defineProperty(editedDraft, 'sources', { get: draftSources })
    Object.defineProperty(editedResearch, 'id', { get: researchId })
    const current = {
      ...props,
      activeNote: editedDraft,
      notes: [editedDraft, editedResearch],
    }
    vi.clearAllMocks()
    rerender(<ContextLibrary {...current} />)
    expectNoScans()

    rerender(<ContextLibrary {...current} open />)
    expect(contextLibraryFolders).toHaveBeenCalledTimes(1)
    expect(contextLibraryUsage).toHaveBeenCalledTimes(1)
    expect(filterContextLibrary).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('checkbox', { name: 'Use Shared.txt in this note' })
    ).toBeChecked()
    await user.click(
      screen.getByRole('button', { name: 'Preview Updated research' })
    )
    expect(screen.getByText('Current evidence.')).toBeVisible()

    // Closing while the picker is active must not leave its hidden scans alive.
    await user.click(screen.getByRole('button', { name: 'Use a note' }))
    vi.clearAllMocks()
    rerender(<ContextLibrary {...current} open={false} />)
    expectNoScans()
    rerender(
      <ContextLibrary
        {...current}
        open={false}
        notes={[...current.notes]}
        library={[...current.library]}
      />
    )
    expectNoScans()
  })

  it('selects several references for a note and detaches them independently', async () => {
    const { props, rerender, user } = mount()
    const first = screen.getByRole('checkbox', {
      name: 'Use First.txt in this note',
    })
    const second = screen.getByRole('checkbox', {
      name: 'Use Second.md in this note',
    })
    await user.click(first)
    await user.click(second)
    expect(props.onAttach).toHaveBeenNthCalledWith(1, 'one')
    expect(props.onAttach).toHaveBeenNthCalledWith(2, 'two')
    const attached = {
      ...props.activeNote!,
      sources: props.library.map(item => libraryReference(item)),
    }
    rerender(
      <ContextLibrary {...props} activeNote={attached} notes={[attached]} />
    )
    expect(first).toBeChecked()
    expect(second).toBeChecked()
    expect(screen.getByText('2 selected')).toBeVisible()
    await user.click(second)
    expect(props.onDetach).toHaveBeenCalledWith('two')
  })

  it('searches within a chosen folder and preserves selection while previews open', async () => {
    const { props, user } = mount()
    await user.click(
      screen.getByRole('button', { name: 'Folder Research/Interviews' })
    )
    expect(
      screen.queryByRole('button', { name: 'Preview First.txt' })
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Preview Second.md' }))
    expect(
      screen.getByText('Second.md contains useful evidence.')
    ).toBeVisible()
    expect(props.onAttach).not.toHaveBeenCalled()
    await user.type(
      screen.getByRole('searchbox', { name: 'Search references' }),
      'missing'
    )
    expect(screen.getByText('No references match.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /All references/ }))
    await user.clear(
      screen.getByRole('searchbox', { name: 'Search references' })
    )
    expect(
      screen.getByRole('button', { name: 'Preview First.txt' })
    ).toBeVisible()
  })

  it('requires an explicit remove action and shows the number of affected notes', async () => {
    const item = source('shared', 'Shared.txt')
    const first = note('first', 'First', [libraryReference(item)])
    const second = note('second', 'Second', [libraryReference(item, false)])
    const { props, user } = mount({
      library: [item],
      notes: [first, second],
      activeNote: first,
    })
    const remove = screen.getByRole('button', {
      name: 'Remove Shared.txt from library',
    })
    await user.click(remove)
    const confirmation = screen.getByRole('group', {
      name: 'Confirm reference removal',
    })
    expect(confirmation).toHaveTextContent('This detaches it from 2 notes.')
    expect(
      within(confirmation).getByRole('button', { name: 'Cancel' })
    ).toHaveFocus()
    expect(props.onRemove).not.toHaveBeenCalled()
    await user.click(
      within(confirmation).getByRole('button', { name: 'Cancel' })
    )
    expect(remove).toHaveFocus()
    await user.click(remove)
    await user.click(
      screen.getByRole('button', { name: 'Remove from library' })
    )
    expect(props.onRemove).toHaveBeenCalledWith('shared')
    expect(
      screen.getByRole('searchbox', { name: 'Search references' })
    ).toHaveFocus()
  })

  it('adds files and directory snapshots through the same bounded importer and disables repeated imports', async () => {
    const { props, user, rerender } = mount()
    const file = new File(['Evidence'], 'Reference.txt', { type: 'text/plain' })
    const files = screen.getByLabelText(
      'Add files to context library'
    ) as HTMLInputElement
    const folder = screen.getByLabelText(
      'Add folder to context library'
    ) as HTMLInputElement
    expect(folder.webkitdirectory).toBe(true)
    await user.upload(files, file)
    expect(props.onFiles).toHaveBeenCalledTimes(1)
    const received = vi.mocked(props.onFiles).mock.calls[0]?.[0]
    expect(received?.item(0)?.name).toBe('Reference.txt')
    fireEvent.change(folder, { target: { files: [file] } })
    expect(props.onFiles).toHaveBeenCalledTimes(2)
    rerender(<ContextLibrary {...props} importing />)
    expect(
      screen.getByRole('button', { name: 'Reading references…' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add a website' })).toBeDisabled()
  })

  it('offers an inline note picker with live titles and prevents a note from attaching itself', async () => {
    const draft = note('draft', 'My draft')
    const research = note('research', 'Live research')
    const { props, user, rerender } = mount({
      library: [],
      notes: [draft, research],
      activeNote: draft,
    })
    await user.click(screen.getByRole('button', { name: 'Use a note' }))
    await user.type(
      screen.getByRole('searchbox', { name: 'Search notes' }),
      'research'
    )
    await user.click(
      screen.getByRole('button', {
        name: 'Add Live research to context library',
      })
    )
    expect(props.onUseNote).toHaveBeenCalledWith('research')
    const live: ContextSource = {
      ...source('live', 'Earlier title'),
      kind: 'note',
      linkedNoteId: draft.id,
      text: '',
    }
    rerender(<ContextLibrary {...props} library={[live]} />)
    expect(
      screen.getByRole('checkbox', { name: 'Use My draft in this note' })
    ).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Preview My draft' }))
    expect(screen.getByText('My draft writing.')).toBeVisible()
  })

  it('bounds the initial large preview, and expands it only through an explicit action', async () => {
    const item = {
      ...source('large', 'Large.md'),
      text: 'a'.repeat(CONTEXT_PREVIEW_CHARACTERS + 20),
    }
    const { user } = mount({ library: [item] })
    await user.click(screen.getByRole('button', { name: 'Preview Large.md' }))
    const text = document.querySelector('.context-library-preview-text')!
    expect(text.textContent).toHaveLength(CONTEXT_PREVIEW_CHARACTERS)
    await user.click(screen.getByRole('button', { name: /Show more/ }))
    expect(text.textContent).toHaveLength(item.text.length)
  })

  it('supports library management without an open note and explains an empty library', async () => {
    const { user, props } = mount({ library: [], activeNote: null, notes: [] })
    expect(
      screen.getByText('A place for the details you return to.')
    ).toBeVisible()
    expect(
      screen.getByText('Open a note to choose its references.')
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use a note' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add a website' }))
    expect(props.onWebsite).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
