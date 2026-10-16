import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ContextSource, Note } from '../types/notebook'
import {
  GraphView,
  NoteGraph,
  defaultGraphOptions,
  deriveGraph,
  resetGraphView,
  searchGraph,
  type GraphViewCallbacks,
} from './NoteGraph'
import { positionCache } from './note-graph-layout'
import { buildNoteGraph } from './note-links'

beforeAll(() => {
  // jsdom has no canvas; the view must cope with a missing context.
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => null
  ) as unknown as HTMLCanvasElement['getContext']
})

afterEach(() => {
  cleanup()
  positionCache.clear()
})

function note(
  id: string,
  title: string,
  content = '',
  extra: Partial<Note> = {}
): Note {
  return {
    id,
    title,
    objective: '',
    context: '',
    content,
    sources: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

const contextSource = (linkedNoteId: string): ContextSource => ({
  id: `src-${linkedNoteId}`,
  name: 'note',
  kind: 'note',
  text: '',
  linkedNoteId,
  enabled: true,
  addedAt: 1,
})

const sample = (): Note[] => [
  note('a', 'Garden', 'See [[Harvest]] and [[Someday]].'),
  note('b', 'Harvest', 'Back to [[garden]].'),
  note('c', 'Compost', '', { sources: [contextSource('a')] }),
  note('d', 'Loose thought'),
]

function Harness({
  notes = sample(),
  activeNoteId = 'a',
  onOpenNote = vi.fn(),
  onCreateNote,
  onOpenChange = vi.fn(),
}: {
  notes?: Note[]
  activeNoteId?: string | null
  onOpenNote?(id: string): void
  onCreateNote?(title: string): void
  onOpenChange?(open: boolean): void
}) {
  const [open, setOpen] = useState(true)
  return (
    <NoteGraph
      open={open}
      onOpenChange={value => {
        setOpen(value)
        onOpenChange(value)
      }}
      notes={notes}
      activeNoteId={activeNoteId}
      onOpenNote={onOpenNote}
      onCreateNote={onCreateNote}
    />
  )
}

const counts = () =>
  screen.getByText(/notes? · \d+ links?/u).textContent?.replace(/\s+/gu, ' ')

describe('NoteGraph dialog', () => {
  beforeEach(() => resetGraphView())

  it('renders an accessible full-window graph with counts and a legend', () => {
    render(<Harness />)
    const dialog = screen.getByRole('dialog', { name: 'Graph' })
    expect(within(dialog).getByRole('application')).toHaveAccessibleName(
      'Note graph: 4 notes, 3 links'
    )
    expect(counts()).toBe('4 notes · 3 links')
    const legend = screen.getByRole('list', { name: 'Legend' })
    expect(legend).toHaveTextContent('Link')
    expect(legend).toHaveTextContent('Used as context')
    expect(legend).toHaveTextContent('Not yet written')
    expect(
      screen.getByRole('searchbox', { name: 'Find a note' })
    ).toBeInTheDocument()
    expect(document.activeElement).toBe(within(dialog).getByRole('application'))
  })

  it('filters context links, unresolved links and unlinked notes', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Context links' }))
    expect(counts()).toBe('4 notes · 2 links')
    expect(screen.getByRole('list', { name: 'Legend' })).not.toHaveTextContent(
      'Used as context'
    )
    await user.click(screen.getByRole('button', { name: 'Unresolved links' }))
    expect(counts()).toBe('4 notes · 1 link')
    await user.click(screen.getByRole('button', { name: 'Unlinked notes' }))
    // Compost lost its only (context) link; Loose thought never had one.
    expect(counts()).toBe('2 notes · 1 link')
    expect(
      screen.getByRole('button', { name: 'Unlinked notes' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the neighbourhood of the active note with a depth stepper', async () => {
    const user = userEvent.setup()
    const notes = [
      note('a', 'One', '[[Two]]'),
      note('b', 'Two', '[[Three]]'),
      note('c', 'Three', '[[Four]]'),
      note('d', 'Four'),
    ]
    render(<Harness notes={notes} activeNoteId="a" />)
    expect(
      screen.queryByRole('group', { name: 'Steps from this note' })
    ).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Around this note' }))
    expect(counts()).toBe('2 notes · 1 link')
    const stepper = screen.getByRole('group', { name: 'Steps from this note' })
    expect(
      within(stepper).getByRole('button', { name: 'Fewer steps' })
    ).toBeDisabled()
    await user.click(
      within(stepper).getByRole('button', { name: 'More steps' })
    )
    expect(counts()).toBe('3 notes · 2 links')
    expect(
      within(stepper).getByRole('button', { name: 'More steps' })
    ).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'All notes' }))
    expect(counts()).toBe('4 notes · 3 links')
  })

  it('disables the local view without an open note', () => {
    render(<Harness activeNoteId={null} />)
    expect(
      screen.getByRole('button', { name: 'Around this note' })
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'All notes' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('keeps a screen-reader list of notes and their connections', () => {
    render(<Harness />)
    const list = screen.getByRole('region', {
      name: 'Notes and their connections',
    })
    expect(list).toHaveClass('visually-hidden')
    expect(list).toHaveTextContent(
      'Garden: connected to Harvest, Someday, Compost'
    )
    expect(list).toHaveTextContent('Someday (not written yet)')
    // Hidden rows are text, so they add no invisible tab stops.
    expect(within(list).queryAllByRole('button')).toHaveLength(0)
  })

  it('opens a note from the visible list and closes', async () => {
    const user = userEvent.setup()
    const onOpenNote = vi.fn()
    const onOpenChange = vi.fn()
    render(<Harness onOpenNote={onOpenNote} onOpenChange={onOpenChange} />)
    await user.click(screen.getByRole('button', { name: 'List' }))
    const list = screen.getByRole('region', {
      name: 'Notes and their connections',
    })
    expect(list).not.toHaveClass('visually-hidden')
    await user.click(within(list).getByRole('button', { name: 'Open Harvest' }))
    expect(onOpenNote).toHaveBeenCalledWith('b')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a connected note from a row’s links', async () => {
    const user = userEvent.setup()
    const onOpenNote = vi.fn()
    render(<Harness onOpenNote={onOpenNote} />)
    await user.click(screen.getByRole('button', { name: 'List' }))
    const links = screen.getByRole('list', { name: 'Connected to Compost' })
    await user.click(within(links).getByRole('button', { name: 'Garden' }))
    expect(onOpenNote).toHaveBeenCalledWith('a')
  })

  it('creates an unwritten note from the list', async () => {
    const user = userEvent.setup()
    const onCreateNote = vi.fn()
    render(<Harness onCreateNote={onCreateNote} />)
    await user.click(screen.getByRole('button', { name: 'List' }))
    await user.click(screen.getByRole('button', { name: 'Create Someday' }))
    expect(onCreateNote).toHaveBeenCalledWith('Someday')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cannot create placeholders without a create handler', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(
      screen.getByRole('button', { name: 'Create Someday' })
    ).toBeDisabled()
  })

  it('filters by search, opens the best match on Enter', async () => {
    const user = userEvent.setup()
    const onOpenNote = vi.fn()
    render(<Harness onOpenNote={onOpenNote} />)
    await user.click(screen.getByRole('button', { name: 'List' }))
    const search = screen.getByRole('searchbox', { name: 'Find a note' })
    await user.type(search, 'har')
    const list = screen.getByRole('region', {
      name: 'Notes and their connections',
    })
    const titles = within(list)
      .getAllByRole('button', { name: /^(Open|Create) / })
      .map(button => button.getAttribute('aria-label'))
    expect(titles).toEqual(['Open Harvest'])
    expect(screen.getByText('1 note matches.')).toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'zzz')
    expect(within(list).getByText('No notes match.')).toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'gar{Enter}')
    expect(onOpenNote).toHaveBeenCalledWith('a')
  })

  it('focuses search with / and clears it before closing on Escape', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    const search = screen.getByRole('searchbox', { name: 'Find a note' })
    await user.keyboard('/')
    expect(document.activeElement).toBe(search)
    await user.type(search, 'gar')
    await user.keyboard('{Escape}')
    expect(search).toHaveValue('')
    expect(onOpenChange).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the active note from the keyboard', async () => {
    const user = userEvent.setup()
    const onOpenNote = vi.fn()
    render(<Harness onOpenNote={onOpenNote} activeNoteId="b" />)
    const canvas = screen.getByRole('application')
    canvas.focus()
    await user.keyboard('{ArrowRight}')
    expect(
      screen.getByText(/^Harvest\. 1 connection: Garden\.$/u)
    ).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(onOpenNote).toHaveBeenCalledWith('b')
  })

  it('closes with the graph shortcut', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<Harness onOpenChange={onOpenChange} />)
    await user.keyboard('{Control>}{Shift>}G{/Shift}{/Control}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('explains links when nothing is connected', () => {
    render(<Harness notes={[note('a', 'Alone'), note('b', 'Also alone')]} />)
    const message = screen.getByRole('note')
    expect(message).toHaveTextContent('No connections yet')
    expect(message).toHaveTextContent('[[Note title]]')
    expect(message).toHaveTextContent('used as context')
  })

  it('explains an empty notebook', () => {
    render(<Harness notes={[]} activeNoteId={null} />)
    expect(screen.getByRole('note')).toHaveTextContent('Your graph is empty')
    expect(counts()).toBe('0 notes · 0 links')
  })

  it('renders nothing while closed', () => {
    render(
      <NoteGraph
        open={false}
        onOpenChange={vi.fn()}
        notes={sample()}
        activeNoteId={null}
        onOpenNote={vi.fn()}
      />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('deriveGraph and searchGraph', () => {
  it('recomputes degrees after filtering and keeps the active note', () => {
    const notes = sample()
    const graph = deriveGraph(notes, [], [], 'd', {
      ...defaultGraphOptions,
      contextLinks: false,
      unlinked: false,
    })
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('a')?.degree).toBe(2)
    expect(byId.has('c')).toBe(false)
    expect(byId.has('d')).toBe(true)
    expect(graph.totalEdges).toBe(3)
    expect(graph.local).toBe(false)
  })

  it('falls back to all notes when the local centre is missing', () => {
    const graph = deriveGraph(sample(), [], [], 'missing', {
      ...defaultGraphOptions,
      scope: 'local',
    })
    expect(graph.local).toBe(false)
    expect(graph.nodes).toHaveLength(5)
  })

  it('ranks exact, prefix, word and substring matches', () => {
    const nodes = buildNoteGraph([
      note('1', 'Seed catalogue'),
      note('2', 'Seeds', '[[Seed catalogue]]'),
      note('3', 'Saving seeds'),
      note('4', 'Linseed oil'),
      note('5', 'Unrelated'),
    ]).nodes
    expect(searchGraph(nodes, 'seeds').best).toBe('2')
    expect(searchGraph(nodes, 'seed').best).toBe('1')
    expect([...searchGraph(nodes, 'seed').matches].sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
    expect(searchGraph(nodes, '  ').best).toBeNull()
    expect(searchGraph(nodes, 'zz').matches.size).toBe(0)
  })
})

describe('GraphView without a canvas context', () => {
  function mount() {
    const host = document.createElement('div')
    const canvas = document.createElement('canvas')
    host.append(canvas)
    document.body.append(host)
    const callbacks: { current: GraphViewCallbacks } = {
      current: { onHover: vi.fn(), onActivate: vi.fn() },
    }
    const view = new GraphView(canvas, host, null, callbacks)
    const graph = buildNoteGraph(sample())
    view.setGraph(graph)
    return { host, canvas, view, callbacks }
  }

  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
    })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    return event
  }

  it('reports clicks on nodes and on the background', () => {
    const { canvas, view, callbacks, host } = mount()
    const position = view.screenPosition('b')!
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', position.x, position.y))
      canvas.dispatchEvent(pointer('pointerup', position.x, position.y))
    })
    expect(callbacks.current.onActivate).toHaveBeenLastCalledWith('b')
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 5_000, 5_000))
      canvas.dispatchEvent(pointer('pointerup', 5_000, 5_000))
    })
    expect(callbacks.current.onActivate).toHaveBeenLastCalledWith(null)
    view.destroy()
    host.remove()
  })

  it('reports hover, and drags without activating', () => {
    const { canvas, view, callbacks, host } = mount()
    const position = view.screenPosition('a')!
    act(() => {
      canvas.dispatchEvent(pointer('pointermove', position.x, position.y))
    })
    expect(callbacks.current.onHover).toHaveBeenLastCalledWith('a')
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', position.x, position.y))
      canvas.dispatchEvent(
        pointer('pointermove', position.x + 40, position.y + 10)
      )
      canvas.dispatchEvent(
        pointer('pointerup', position.x + 40, position.y + 10)
      )
    })
    expect(callbacks.current.onActivate).not.toHaveBeenCalled()
    view.destroy()
    // Positions are kept for the next open.
    expect(positionCache.has('a')).toBe(true)
    host.remove()
  })

  it('moves between nodes in a direction', () => {
    const { view, host } = mount()
    const start = view.startNode('a')
    expect(start).toBe('a')
    const directions: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]
    const reachable = directions
      .map(([dx, dy]) => view.neighbourInDirection('a', dx, dy))
      .filter(Boolean)
    expect(reachable.length).toBeGreaterThan(0)
    expect(reachable).not.toContain('a')
    view.destroy()
    host.remove()
  })
})
