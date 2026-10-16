import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextSource, Note, NotebookSettings } from '../types/notebook'
import * as retrieval from '../services/retrieval'
import { ContextPanel } from './ContextPanel'
import { libraryReference } from './context-library'
import { CONTEXT_DRAG_TYPE } from './context/ConnectionBoard'

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
    await user.click(screen.getByRole('button', { name: 'Manage contexts' }))
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

  it('prioritizes named packages and retrieves their shared sources once while keeping direct editing raw', async () => {
    const spy = vi.spyOn(retrieval, 'retrieveContext')
    const user = userEvent.setup()
    const current = { ...note([]), contextPackageIds: ['research', 'voice'] }
    const packages = [
      {
        id: 'research',
        name: 'Research',
        sourceIds: ['garden'],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'voice',
        name: 'Voice',
        sourceIds: ['garden'],
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const onLibrary = vi.fn()
    const onUpdate = vi.fn()
    const onDetachPackage = vi.fn()
    render(
      <ContextPanel
        note={current}
        notes={[current]}
        packages={packages}
        library={library}
        importing={false}
        onUpdate={onUpdate}
        onClose={vi.fn()}
        onFiles={vi.fn().mockResolvedValue(undefined)}
        onWebsite={vi.fn()}
        onUseNote={vi.fn()}
        onLibrary={onLibrary}
        onDetachPackage={onDetachPackage}
      />
    )
    expect(
      screen.getByRole('button', { name: 'Manage Research' })
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Manage Voice' }))
    expect(onLibrary).toHaveBeenCalledWith('voice')
    await user.click(screen.getByRole('button', { name: 'Detach Voice' }))
    expect(onDetachPackage).toHaveBeenCalledWith('voice')
    expect(onUpdate).not.toHaveBeenCalled()
    await user.click(screen.getByText('Find in attached context'))
    await user.type(
      screen.getByRole('searchbox', { name: 'Search attached references' }),
      'blue lavender'
    )
    await user.click(screen.getByRole('button', { name: 'Find passages' }))
    expect(spy.mock.calls[0]?.[0].sources).toHaveLength(1)
    expect(screen.getByText('1 matching passage')).toBeVisible()
    expect(current.sources).toEqual([])
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

const research = {
  id: 'research',
  name: 'Research',
  sourceIds: ['garden'],
  createdAt: 1,
  updatedAt: 1,
}
const voice = {
  id: 'voice',
  name: 'Voice',
  sourceIds: ['excluded'],
  createdAt: 1,
  updatedAt: 1,
}

/** A minimal DataTransfer for jsdom drag events. */
function transfer(files: File[] = []) {
  const data = new Map<string, string>()
  const types: string[] = files.length ? ['Files'] : []
  const list = Object.assign([...files], {
    item: (index: number) => files[index] ?? null,
  })
  return {
    types,
    files: list,
    dropEffect: 'none',
    effectAllowed: 'all',
    setData(type: string, value: string) {
      data.set(type, value)
      if (!types.includes(type)) types.push(type)
    },
    getData: (type: string) => data.get(type) ?? '',
    setDragImage: vi.fn(),
  }
}

function mountBoard(
  overrides: Partial<Parameters<typeof ContextPanel>[0]> = {}
) {
  const current = { ...note([]), contextPackageIds: ['research'] }
  const props = {
    note: current,
    notes: [current],
    packages: [research, voice],
    library,
    importing: false,
    onUpdate: vi.fn(),
    onClose: vi.fn(),
    onFiles: vi.fn().mockResolvedValue(undefined),
    onWebsite: vi.fn(),
    onUseNote: vi.fn(),
    onLibrary: vi.fn(),
    onAttachPackage: vi.fn(),
    onDetachPackage: vi.fn(),
    ...overrides,
  }
  return {
    ...render(<ContextPanel {...props} />),
    props,
    user: userEvent.setup(),
  }
}

describe('connections board', () => {
  it('attaches from the tray and detaches attached contexts with the keyboard, announcing each change', async () => {
    const { props, user } = mountBoard()
    const attachedList = screen.getByRole('list', { name: 'Attached contexts' })
    expect(
      within(attachedList).getByRole('button', { name: 'Manage Research' })
    ).toBeVisible()
    const tray = screen.getByRole('list', { name: 'Available contexts' })
    expect(
      within(tray).queryByRole('button', { name: 'Attach Research' })
    ).toBeNull()
    within(tray).getByRole('button', { name: 'Attach Voice' }).focus()
    await user.keyboard('{Enter}')
    expect(props.onAttachPackage).toHaveBeenCalledWith('voice')
    expect(await screen.findByText('Voice attached')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Manage Research' }).focus()
    await user.keyboard('{Delete}')
    expect(props.onDetachPackage).toHaveBeenCalledWith('research')
    expect(await screen.findByText('Research detached')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Detach Research' }))
    expect(props.onDetachPackage).toHaveBeenCalledTimes(2)
    expect(props.onUpdate).not.toHaveBeenCalled()
  })

  it('filters the tray with a fuzzy quick field, attaches the first match on Enter and can create a context', async () => {
    const onCreatePackage = vi.fn().mockReturnValue('created')
    const { props, user } = mountBoard({
      note: note([]),
      onCreatePackage,
    })
    const quick = screen.getByRole('searchbox', { name: 'Attach a context' })
    await user.type(quick, 'vce')
    const tray = screen.getByRole('list', { name: 'Available contexts' })
    expect(
      within(tray).queryByRole('button', { name: 'Attach Research' })
    ).toBeNull()
    expect(
      within(tray).getByRole('button', { name: 'Attach Voice' })
    ).toBeVisible()
    await user.keyboard('{Enter}')
    expect(props.onAttachPackage).toHaveBeenCalledWith('voice')
    expect(quick).toHaveValue('')
    await user.type(quick, 'Field notes{Enter}')
    expect(onCreatePackage).toHaveBeenCalledWith('Field notes')
    expect(props.onAttachPackage).toHaveBeenLastCalledWith('created')
  })

  it('falls back to updating the note when no attach handler is provided', async () => {
    const onUpdate = vi.fn()
    const { user } = mountBoard({ onAttachPackage: undefined, onUpdate })
    await user.click(screen.getByRole('button', { name: 'Attach Voice' }))
    expect(onUpdate).toHaveBeenCalledWith({
      contextPackageIds: ['research', 'voice'],
    })
  })

  it('attaches a tray context dragged onto the note and detaches one dragged back to the tray', () => {
    const { props } = mountBoard()
    const card = screen
      .getByRole('button', { name: 'Attach Voice' })
      .closest('li')!
    const board = screen.getByRole('group', {
      name: 'This note, Draft',
    }).parentElement!
    const data = transfer()
    fireEvent.dragStart(card, { dataTransfer: data })
    expect(data.getData(CONTEXT_DRAG_TYPE)).toBe('attach:voice')
    fireEvent.dragEnter(board, { dataTransfer: data })
    fireEvent.dragOver(board, { dataTransfer: data })
    expect(board).toHaveClass('is-over')
    expect(screen.getByText('Release to attach')).toBeVisible()
    fireEvent.drop(board, { dataTransfer: data })
    expect(props.onAttachPackage).toHaveBeenCalledWith('voice')
    expect(board).not.toHaveClass('is-over')

    const attached = screen
      .getByRole('button', { name: 'Manage Research' })
      .closest('li')!
    const tray = screen
      .getByRole('searchbox', { name: 'Attach a context' })
      .closest('.context-tray')!
    const back = transfer()
    fireEvent.dragStart(attached, { dataTransfer: back })
    fireEvent.dragOver(tray, { dataTransfer: back })
    expect(tray).toHaveClass('is-over')
    fireEvent.drop(tray, { dataTransfer: back })
    expect(props.onDetachPackage).toHaveBeenCalledWith('research')
  })

  it('routes files dropped on a context card into that context and other drops into the note', () => {
    const { props } = mountBoard()
    const panel = screen.getByRole('complementary', { name: 'Note context' })
    const file = new File(['Evidence'], 'Field.txt', { type: 'text/plain' })
    const onCard = transfer([file])
    fireEvent.dragEnter(panel, { dataTransfer: onCard })
    expect(screen.getByText('Drop your references here')).toBeInTheDocument()
    const card = screen
      .getByRole('button', { name: 'Attach Voice' })
      .closest('li')!
    fireEvent.dragOver(card, { dataTransfer: onCard })
    expect(card).toHaveClass('is-file-over')
    expect(screen.getByText(/Add files to/)).toBeVisible()
    fireEvent.drop(card, { dataTransfer: onCard })
    expect(props.onFiles).toHaveBeenCalledTimes(1)
    expect(props.onFiles).toHaveBeenCalledWith(onCard.files, 'voice')
    expect(screen.queryByText('Drop your references here')).toBeNull()

    const loose = transfer([file])
    fireEvent.dragEnter(panel, { dataTransfer: loose })
    fireEvent.drop(panel, { dataTransfer: loose })
    expect(props.onFiles).toHaveBeenCalledTimes(2)
    expect(vi.mocked(props.onFiles).mock.calls[1]).toEqual([loose.files])
  })
})

describe('intent and direct references', () => {
  it('collapses intent to a one-line summary once an objective exists', async () => {
    const user = userEvent.setup()
    render(
      <ContextPanel
        note={{ ...note([]), objective: 'Persuade a hesitant reader.' }}
        notes={[]}
        importing={false}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        onFiles={vi.fn().mockResolvedValue(undefined)}
        onWebsite={vi.fn()}
        onUseNote={vi.fn()}
      />
    )
    const toggle = screen.getByRole('button', { name: 'Intent' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAccessibleDescription('Persuade a hesitant reader.')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Objective')).toHaveValue(
      'Persuade a hesitant reader.'
    )
  })

  it('opens intent for a new note and edits the objective and voice', async () => {
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(
      <ContextPanel
        note={note([])}
        notes={[]}
        importing={false}
        onUpdate={onUpdate}
        onClose={vi.fn()}
        onFiles={vi.fn().mockResolvedValue(undefined)}
        onWebsite={vi.fn()}
        onUseNote={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Intent' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    await user.type(screen.getByLabelText('Background & voice'), 'W')
    expect(onUpdate).toHaveBeenCalledWith({ context: 'W' })
  })

  it('renders media references with thumbnails and durations and previews their caption', async () => {
    const thumbnail = 'data:image/jpeg;base64,AAAA'
    const sources: ContextSource[] = [
      {
        id: 'photo',
        name: 'Harbour.jpg',
        kind: 'image',
        text: 'Fishing boats in a quiet harbour at dawn.',
        enabled: true,
        addedAt: 1,
        media: {
          mime: 'image/jpeg',
          bytes: 2_400_000,
          width: 1200,
          height: 800,
          thumbnail,
        },
      },
      {
        id: 'clip',
        name: 'Waves.mp4',
        kind: 'video',
        text: 'Waves rolling over pebbles.',
        enabled: false,
        addedAt: 1,
        media: {
          mime: 'video/mp4',
          bytes: 9_000_000,
          durationSeconds: 75,
          thumbnail,
        },
      },
      {
        id: 'memo',
        name: 'Memo.m4a',
        kind: 'audio',
        text: 'A short spoken memo.',
        enabled: true,
        addedAt: 1,
        media: { mime: 'audio/mp4', bytes: 300_000, durationSeconds: 9 },
      },
    ]
    const onUpdate = vi.fn()
    const user = userEvent.setup()
    render(
      <ContextPanel
        note={note(sources)}
        notes={[]}
        importing={false}
        onUpdate={onUpdate}
        onClose={vi.fn()}
        onFiles={vi.fn().mockResolvedValue(undefined)}
        onWebsite={vi.fn()}
        onUseNote={vi.fn()}
      />
    )
    const list = screen.getByRole('list', { name: 'Direct references' })
    expect(within(list).getByText('Image · 1200×800')).toBeVisible()
    expect(within(list).getByText('Video · 1:15 · Left out')).toBeVisible()
    expect(within(list).getByText('Audio · 0:09')).toBeVisible()
    expect(list.querySelectorAll(`img[src="${thumbnail}"]`)).toHaveLength(2)
    expect(screen.getByText('2 of 3 included')).toBeVisible()
    await user.click(
      screen.getByRole('checkbox', { name: 'Use Waves.mp4 as context' })
    )
    expect(onUpdate.mock.calls[0]?.[0].sources[1].enabled).toBe(true)
    await user.click(
      screen.getByRole('button', { name: 'Preview Harbour.jpg' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Harbour.jpg' })
    expect(
      within(dialog).getByRole('img', { name: 'Image preview of Harbour.jpg' })
    ).toHaveAttribute('src', thumbnail)
    expect(dialog).toHaveTextContent(
      'Image · 1200×800 · 2.3 MB · Embedded on this device'
    )
    expect(dialog.querySelector('.source-preview-text')).toHaveTextContent(
      'Fishing boats in a quiet harbour at dawn.'
    )
  })

  it('accepts media files and explains how to enable media search when it is off', async () => {
    const onFiles = vi.fn().mockResolvedValue(undefined)
    const onOpenKnowledgeSettings = vi.fn()
    const user = userEvent.setup()
    const settings = {
      semantic: { enabled: true, media: false },
    } as unknown as NotebookSettings
    render(
      <ContextPanel
        note={note([])}
        notes={[]}
        importing={false}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        onFiles={onFiles}
        onWebsite={vi.fn()}
        onUseNote={vi.fn()}
        settings={settings}
        onOpenKnowledgeSettings={onOpenKnowledgeSettings}
      />
    )
    const input = screen.getByLabelText('Attach reference files')
    expect(input.getAttribute('accept')).toContain('.pdf')
    expect(input.getAttribute('accept')).toContain('.png')
    expect(input.getAttribute('accept')).toContain('.mp4')
    expect(screen.getByText(/video up to 50 MB and 45 seconds/)).toBeVisible()
    await user.upload(
      input,
      new File(['x'], 'photo.png', { type: 'image/png' })
    )
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Turn on semantic search with media/)).toBeVisible()
    await user.click(
      screen.getByRole('button', { name: 'Open Knowledge settings' })
    )
    expect(onOpenKnowledgeSettings).toHaveBeenCalledTimes(1)
  })
})
