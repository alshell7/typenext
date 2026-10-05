import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextPackage, ContextSource, Note } from '../types/notebook'
import { ContextLibrary, type ContextLibraryProps } from './ContextLibrary'
import {
  CONTEXT_PREVIEW_CHARACTERS,
  contextLibraryFolders,
  contextPackageUsage,
  filterContextLibrary,
} from './context-library'

vi.mock('./context-library', async importOriginal => {
  const original = await importOriginal<typeof import('./context-library')>()
  return {
    ...original,
    contextLibraryFolders: vi.fn(original.contextLibraryFolders),
    contextPackageUsage: vi.fn(original.contextPackageUsage),
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
function note(
  id: string,
  title: string,
  contextPackageIds: string[] = []
): Note {
  return {
    id,
    title,
    contextPackageIds,
    sources: [],
    content: `${title} writing.`,
    context: '',
    objective: '',
    createdAt: 1,
    updatedAt: 1,
  }
}
function context(
  id: string,
  name: string,
  sourceIds: string[] = []
): ContextPackage {
  return { id, name, sourceIds, createdAt: 1, updatedAt: 1 }
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
    packages: [
      context('research', 'Research', ['one', 'two']),
      context('voice', 'Voice', ['two']),
    ],
    notes: [active],
    activeNote: active,
    importing: false,
    onCreatePackage: vi.fn().mockReturnValue('created'),
    onRenamePackage: vi.fn(),
    onRemovePackage: vi.fn(),
    onAttachPackage: vi.fn(),
    onDetachPackage: vi.fn(),
    onRemoveSource: vi.fn(),
    onFiles: vi.fn().mockResolvedValue(undefined),
    onWebsite: vi.fn(),
    onUseNote: vi.fn(),
    ...overrides,
  }
  return {
    ...render(<ContextLibrary {...props} />),
    props,
    user: userEvent.setup(),
  }
}

describe('named context packages', () => {
  it('attaches several packages independently while browsing and shared source previews change no attachments', async () => {
    const { props, user, rerender } = mount()
    const research = screen.getByRole('checkbox', {
      name: 'Use Research in this note',
    })
    const voice = screen.getByRole('checkbox', {
      name: 'Use Voice in this note',
    })
    await user.click(research)
    await user.click(voice)
    expect(props.onAttachPackage).toHaveBeenNthCalledWith(1, 'research')
    expect(props.onAttachPackage).toHaveBeenNthCalledWith(2, 'voice')
    const attached = {
      ...props.activeNote!,
      contextPackageIds: ['research', 'voice'],
    }
    rerender(
      <ContextLibrary {...props} activeNote={attached} notes={[attached]} />
    )
    expect(research).toBeChecked()
    expect(voice).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Open Voice context' }))
    expect(
      screen.queryByRole('button', { name: 'Preview First.txt' })
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Preview Second.md' }))
    expect(
      screen.getByText('Second.md contains useful evidence.')
    ).toBeVisible()
    expect(props.onAttachPackage).toHaveBeenCalledTimes(2)
    await user.click(voice)
    expect(props.onDetachPackage).toHaveBeenCalledWith('voice')
  })

  it('creates and renames a context inline without opening another dialog or attaching it implicitly', async () => {
    const { props, user, rerender } = mount()
    await user.click(screen.getByRole('button', { name: 'New context' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Create context' })
    ).toBeDisabled()
    await user.type(
      screen.getByRole('textbox', { name: 'Context name' }),
      '  Field notes  '
    )
    await user.click(screen.getByRole('button', { name: 'Create context' }))
    expect(props.onCreatePackage).toHaveBeenCalledWith('Field notes')
    expect(props.onAttachPackage).not.toHaveBeenCalled()
    const created = context('created', 'Field notes')
    rerender(
      <ContextLibrary {...props} packages={[...props.packages, created]} />
    )
    expect(screen.getByRole('heading', { name: 'Field notes' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Rename Field notes' }))
    await user.clear(screen.getByRole('textbox', { name: 'Context name' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Context name' }),
      'Interviews'
    )
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(props.onRenamePackage).toHaveBeenCalledWith('created', 'Interviews')
    rerender(
      <ContextLibrary
        {...props}
        packages={[...props.packages, { ...created, name: 'Interviews' }]}
      />
    )
    expect(screen.getByRole('heading', { name: 'Interviews' })).toBeVisible()
  })

  it('reports creation failure without losing the requested name', async () => {
    const { user } = mount({
      packages: [],
      onCreatePackage: vi.fn().mockReturnValue(null),
    })
    await user.click(
      screen.getByRole('button', { name: 'Create your first context' })
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Context name' }),
      'Keep this name'
    )
    await user.click(screen.getByRole('button', { name: 'Create context' }))
    expect(screen.getByRole('alert')).toHaveTextContent('could not be created')
    expect(screen.getByRole('textbox', { name: 'Context name' })).toHaveValue(
      'Keep this name'
    )
  })

  it('filters named packages and sources inside a selected folder without copying or reattaching sources', async () => {
    const { user, props } = mount()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Folder' }),
      'Research/Interviews'
    )
    expect(
      screen.queryByRole('button', { name: 'Preview First.txt' })
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Preview Second.md' }))
    expect(props.onAttachPackage).not.toHaveBeenCalled()
    await user.type(
      screen.getByRole('searchbox', { name: 'Find a source' }),
      'missing'
    )
    expect(screen.getByText('No sources match.')).toBeVisible()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Folder' }),
      ''
    )
    await user.clear(screen.getByRole('searchbox', { name: 'Find a source' }))
    expect(
      screen.getByRole('button', { name: 'Preview First.txt' })
    ).toBeVisible()
    await user.type(
      screen.getByRole('searchbox', { name: 'Find a context' }),
      'voice'
    )
    expect(
      screen.queryByRole('button', { name: 'Open Research context' })
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open Voice context' }))
    expect(screen.getByRole('heading', { name: 'Voice' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Preview Second.md' })
    ).toBeVisible()
  })

  it('confirms removal using affected notes and preserves the distinction between package and source removal', async () => {
    const first = note('first', 'First', ['research', 'voice'])
    const second = note('second', 'Second', ['research'])
    const { props, user } = mount({ activeNote: first, notes: [first, second] })
    const trigger = screen.getByRole('button', {
      name: 'Remove Research context',
    })
    await user.click(trigger)
    const confirmation = screen.getByRole('group', {
      name: 'Confirm context removal',
    })
    expect(confirmation).toHaveTextContent('This detaches it from 2 notes.')
    const cancel = within(confirmation).getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveFocus()
    await user.click(cancel)
    expect(trigger).toHaveFocus()
    expect(props.onRemovePackage).not.toHaveBeenCalled()
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Remove context' }))
    expect(props.onRemovePackage).toHaveBeenCalledWith('research')
    expect(props.onRemoveSource).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: 'Remove Second.md from Research' })
    )
    expect(
      screen.getByRole('group', { name: 'Confirm context removal' })
    ).toHaveTextContent('Other contexts keep sources they share.')
    await user.click(screen.getByRole('button', { name: 'Remove source' }))
    expect(props.onRemoveSource).toHaveBeenCalledWith('research', 'two')
    expect(props.onRemovePackage).toHaveBeenCalledTimes(1)
  })

  it('routes file and directory snapshots into the selected package and prevents overlapping imports', async () => {
    const { props, user, rerender } = mount()
    const file = new File(['Evidence'], 'Reference.txt', { type: 'text/plain' })
    const files = screen.getByLabelText(
      'Add files to this context'
    ) as HTMLInputElement
    const folder = screen.getByLabelText(
      'Add folder to this context'
    ) as HTMLInputElement
    expect(folder.webkitdirectory).toBe(true)
    await user.upload(files, file)
    expect(props.onFiles).toHaveBeenCalledTimes(1)
    expect(vi.mocked(props.onFiles).mock.calls[0]?.[0]?.item(0)?.name).toBe(
      'Reference.txt'
    )
    expect(vi.mocked(props.onFiles).mock.calls[0]?.[1]).toBe('research')
    await user.click(screen.getByRole('button', { name: 'Open Voice context' }))
    fireEvent.change(folder, { target: { files: [file] } })
    expect(vi.mocked(props.onFiles).mock.calls[1]?.[1]).toBe('voice')
    await user.click(screen.getByRole('button', { name: 'Add a website' }))
    expect(props.onWebsite).toHaveBeenCalledWith('voice')
    rerender(<ContextLibrary {...props} importing />)
    expect(
      screen.getByRole('button', { name: 'Reading sources…' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add a website' })).toBeDisabled()
  })

  it('offers current note titles per package and explains why a self reference is left out', async () => {
    const draft = note('draft', 'My draft')
    const research = note('reference', 'Live research')
    const { props, user, rerender } = mount({
      notes: [draft, research],
      activeNote: draft,
    })
    await user.click(screen.getByRole('button', { name: 'Use a note' }))
    await user.type(
      screen.getByRole('searchbox', { name: 'Search notes' }),
      'research'
    )
    await user.click(
      screen.getByRole('button', { name: 'Add Live research to Research' })
    )
    expect(props.onUseNote).toHaveBeenCalledWith('reference', 'research')
    const live: ContextSource = {
      ...source('live', 'Earlier title'),
      kind: 'note',
      linkedNoteId: draft.id,
      text: '',
    }
    rerender(
      <ContextLibrary
        {...props}
        library={[...props.library, live]}
        packages={[{ ...props.packages[0]!, sourceIds: ['live'] }]}
      />
    )
    expect(
      screen.getByText('Live note · Left out for its own note')
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Preview My draft' }))
    expect(screen.getByText('My draft writing.')).toBeVisible()
  })

  it('bounds a large preview and expands only after an explicit request', async () => {
    const large = {
      ...source('large', 'Large.md'),
      text: 'a'.repeat(CONTEXT_PREVIEW_CHARACTERS + 20),
    }
    const { user } = mount({
      library: [large],
      packages: [context('large-context', 'Large context', ['large'])],
    })
    await user.click(screen.getByRole('button', { name: 'Preview Large.md' }))
    const text = document.querySelector('.context-library-preview-text')!
    expect(text.textContent).toHaveLength(CONTEXT_PREVIEW_CHARACTERS)
    await user.click(screen.getByRole('button', { name: /Show more/ }))
    expect(text.textContent).toHaveLength(large.text.length)
  })

  it('performs no note, source or helper scans while closed and resolves fresh content on reopening', async () => {
    const draft = note('draft', 'Draft', ['research'])
    const research = note('reference', 'Earlier research')
    const sourceIds = vi.fn(() => ['live'])
    const researchId = vi.fn(() => 'reference')
    const chosen = context('research', 'Research', ['live'])
    Object.defineProperty(chosen, 'sourceIds', { get: sourceIds })
    Object.defineProperty(research, 'id', { get: researchId })
    const live: ContextSource = {
      ...source('live', 'Earlier title'),
      kind: 'note',
      linkedNoteId: 'reference',
      text: '',
    }
    const { props, rerender, user } = mount({
      open: false,
      packages: [chosen],
      library: [live],
      notes: [draft, research],
      activeNote: draft,
    })
    function expectNoScans() {
      expect(contextLibraryFolders).not.toHaveBeenCalled()
      expect(contextPackageUsage).not.toHaveBeenCalled()
      expect(filterContextLibrary).not.toHaveBeenCalled()
      expect(sourceIds).not.toHaveBeenCalled()
      expect(researchId).not.toHaveBeenCalled()
    }
    expectNoScans()
    const edited = {
      ...research,
      title: 'Updated research',
      content: 'Current evidence.',
    }
    Object.defineProperty(edited, 'id', { get: researchId })
    const current = {
      ...props,
      activeNote: { ...draft, content: 'Typed writing.' },
      notes: [draft, edited],
    }
    vi.clearAllMocks()
    rerender(<ContextLibrary {...current} />)
    expectNoScans()
    rerender(<ContextLibrary {...current} open />)
    expect(
      screen.getByRole('checkbox', { name: 'Use Research in this note' })
    ).toBeChecked()
    await user.click(
      screen.getByRole('button', { name: 'Preview Updated research' })
    )
    expect(screen.getByText('Current evidence.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Use a note' }))
    vi.clearAllMocks()
    rerender(<ContextLibrary {...current} open={false} />)
    expectNoScans()
    rerender(
      <ContextLibrary
        {...current}
        open={false}
        packages={[...current.packages]}
        notes={[...current.notes]}
        library={[...current.library]}
      />
    )
    expectNoScans()
  })

  it('supports managing contexts before any note exists', async () => {
    const { user, props } = mount({ activeNote: null, notes: [] })
    expect(
      screen.getByRole('checkbox', { name: 'Use Research in this note' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add files' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Use a note' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add a website' }))
    expect(props.onWebsite).toHaveBeenCalledWith('research')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })
})
