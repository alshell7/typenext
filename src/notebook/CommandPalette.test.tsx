import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Note } from '../types/notebook'
import {
  CommandPalette,
  type PaletteAction,
  type PaletteHeading,
} from './CommandPalette'

afterEach(cleanup)

const NOW = Date.now()
const DAY = 86_400_000

function note(id: string, title: string, content = '', age = 1): Note {
  return {
    id,
    title,
    objective: '',
    context: '',
    content,
    sources: [],
    createdAt: NOW - age * DAY,
    updatedAt: NOW - age * DAY,
  }
}

const notes = [
  note('active', 'Morning pages', '', 0),
  note('garden', 'Garden plans', 'Tomatoes, basil and beans', 1),
  note('letters', 'Letters', 'Write to the garden club', 2),
  note('trip', 'Trip to Lisbon', 'Trams and tiles', 3),
]

const headings: PaletteHeading[] = [
  { level: 1, text: 'Overview', from: 0 },
  { level: 2, text: 'Planting schedule', from: 120 },
]

function setup(
  overrides: Partial<{
    actions: PaletteAction[]
    headings: PaletteHeading[]
  }> = {}
) {
  const run = { newNote: vi.fn(), zen: vi.fn(), exportNote: vi.fn() }
  const actions: PaletteAction[] = overrides.actions ?? [
    {
      id: 'new',
      title: 'New note',
      section: 'Actions',
      shortcut: '⌘ N',
      run: run.newNote,
    },
    {
      id: 'zen',
      title: 'Zen mode: Hide toolbars',
      section: 'Actions',
      keywords: ['focus'],
      run: run.zen,
    },
    {
      id: 'export',
      title: 'Export Markdown',
      section: 'Actions',
      disabled: true,
      run: run.exportNote,
    },
  ]
  const props = {
    onOpenNote: vi.fn(),
    onCreateNote: vi.fn(),
    onJumpToHeading: vi.fn(),
    onOpenChange: vi.fn(),
  }
  function Harness() {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open palette
        </button>
        <CommandPalette
          open={open}
          onOpenChange={next => {
            props.onOpenChange(next)
            setOpen(next)
          }}
          notes={notes}
          activeNoteId="active"
          headings={overrides.headings ?? headings}
          actions={actions}
          onOpenNote={props.onOpenNote}
          onCreateNote={props.onCreateNote}
          onJumpToHeading={props.onJumpToHeading}
        />
      </>
    )
  }
  render(<Harness />)
  return { ...props, run, user: userEvent.setup() }
}

const field = () => screen.getByRole('combobox', { name: /search notes/i })
const selectedOption = () =>
  screen
    .getAllByRole('option')
    .find(option => option.getAttribute('aria-selected') === 'true')

describe('command palette', () => {
  it('is a labelled dialog with an autofocused combobox', async () => {
    setup()
    expect(
      screen.getByRole('dialog', { name: 'Command palette' })
    ).toBeInTheDocument()
    await waitFor(() => expect(field()).toHaveFocus())
    const listbox = screen.getByRole('listbox')
    expect(field()).toHaveAttribute('aria-controls', listbox.id)
    expect(field()).toHaveAttribute(
      'aria-activedescendant',
      selectedOption()!.id
    )
  })

  it('shows recent notes without the active one, then actions', () => {
    setup()
    const recent = screen.getByRole('group', { name: 'Recent notes' })
    const titles = within(recent)
      .getAllByRole('option')
      .map(option => option.textContent)
    expect(titles[0]).toContain('Garden plans')
    expect(titles.join(' ')).not.toContain('Morning pages')
    expect(titles[0]).toContain('Yesterday')
    const actions = screen.getByRole('group', { name: 'Actions' })
    expect(within(actions).getByText('⌘ N')).toBeInTheDocument()
    // Disabled actions are not suggested before the writer searches.
    expect(within(actions).queryByText('Export Markdown')).toBeNull()
  })

  it('ranks notes, highlights matches and shows a content snippet', async () => {
    const { user } = setup()
    await user.type(field(), 'garden')
    const group = screen.getByRole('group', { name: 'Notes' })
    const options = within(group).getAllByRole('option')
    expect(options[0]).toHaveTextContent('Garden plans')
    expect(options[0]!.querySelector('mark')).toHaveTextContent('Garden')
    expect(options[1]).toHaveTextContent('Letters')
    expect(
      options[1]!.querySelector('.cmd-snippet mark')
    ).toHaveTextContent('garden')
    expect(screen.getByRole('status')).toHaveTextContent('2 results')
  })

  it('opens the highlighted note with Enter after closing', async () => {
    const { user, onOpenNote, onOpenChange } = setup()
    await user.type(field(), 'lisb{Enter}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith('trip'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves with arrows, wrapping at both ends', async () => {
    const { user } = setup()
    await user.type(field(), '>')
    expect(selectedOption()).toHaveTextContent('New note')
    await user.keyboard('{ArrowUp}')
    expect(selectedOption()).toHaveTextContent('Export Markdown')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(selectedOption()).toHaveTextContent('Zen mode')
  })

  it('jumps between groups with Tab and keeps focus in the field', async () => {
    const { user } = setup()
    expect(selectedOption()).toHaveTextContent('Garden plans')
    await user.keyboard('{Tab}')
    expect(selectedOption()).toHaveTextContent('New note')
    expect(field()).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(selectedOption()).toHaveTextContent('Garden plans')
  })

  it('runs actions found by keyword and ignores disabled ones', async () => {
    const { user, run } = setup()
    await user.type(field(), '> focus{Enter}')
    await waitFor(() => expect(run.zen).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Open palette' }))
    await user.type(field(), '> export')
    const option = screen.getByRole('option', { name: /Export Markdown/ })
    expect(option).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Enter}')
    await user.click(option)
    expect(run.exportNote).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('limits # to headings and jumps to the chosen one', async () => {
    const { user, onJumpToHeading } = setup()
    await user.type(field(), '# plant')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('H2')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(onJumpToHeading).toHaveBeenCalledWith(headings[1])
    )
  })

  it('explains an empty heading list', async () => {
    const { user } = setup({ headings: [] })
    await user.type(field(), '#')
    expect(
      screen.getByText('This note has no headings yet.')
    ).toBeInTheDocument()
  })

  it('offers to create a note from the query', async () => {
    const { user, onCreateNote } = setup()
    await user.type(field(), 'Packing list')
    const create = screen.getByRole('option', { name: /Create note/ })
    expect(create).toHaveTextContent('Create note “Packing list”')
    expect(selectedOption()).toBe(create)
    expect(screen.getByRole('status')).toHaveTextContent('No matches')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(onCreateNote).toHaveBeenCalledWith('Packing list')
    )
  })

  it('highlights on hover and runs on click', async () => {
    const { user, onOpenNote } = setup()
    const letters = screen.getByRole('option', { name: /Letters/ })
    await user.hover(letters)
    expect(letters).toHaveAttribute('aria-selected', 'true')
    await user.click(letters)
    await waitFor(() => expect(onOpenNote).toHaveBeenCalledWith('letters'))
  })

  it('switches modes from the hint row', async () => {
    const { user } = setup()
    await user.type(field(), 'zen')
    await user.click(screen.getByRole('button', { name: /actions/ }))
    expect(field()).toHaveValue('> zen')
    expect(field()).toHaveFocus()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: /actions/ }))
    expect(field()).toHaveValue('zen')
  })

  it('closes with Escape without running anything', async () => {
    const { user, onOpenNote, run } = setup()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onOpenNote).not.toHaveBeenCalled()
    expect(run.newNote).not.toHaveBeenCalled()
  })

  it('starts fresh each time it opens', async () => {
    const { user } = setup()
    await user.type(field(), 'garden')
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Open palette' }))
    expect(field()).toHaveValue('')
    expect(
      screen.getByRole('group', { name: 'Recent notes' })
    ).toBeInTheDocument()
  })
})
