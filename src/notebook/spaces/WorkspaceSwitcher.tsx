import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  Check,
  ChevronsUpDown,
  Cloud,
  GitBranch,
  Plus,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { NoteSpace } from '../../types/notebook'
import { Popover } from '../Popover'
import { isMacPlatform } from '../shortcuts'
import { spaceIcon } from './space-icons'
import './spaces.css'

export function SpaceAvatar({
  space,
  size = 'regular',
}: {
  space: NoteSpace
  size?: 'regular' | 'small' | 'large'
}) {
  const initial = [...space.name.trim()][0]?.toLocaleUpperCase() ?? '·'
  const Icon = spaceIcon(space.icon)
  const iconSize = size === 'large' ? 22 : size === 'small' ? 11 : 15
  return (
    <span
      className={`space-avatar is-${size} org-${space.color}`}
      aria-hidden="true"
    >
      {Icon ? <Icon size={iconSize} strokeWidth={2.2} /> : initial}
      {space.shared && (
        <span className="space-avatar-badge">
          <Users size={8} strokeWidth={3} />
        </span>
      )}
    </span>
  )
}

/**
 * The workspace switcher at the foot of the sidebar. It also carries the
 * privacy line: where suggestions come from.
 */
export function WorkspaceSwitcher({
  spaces,
  activeId,
  counts,
  gitFolders,
  privacy,
  onSwitch,
  onCreate,
  onManage,
}: {
  spaces: NoteSpace[]
  activeId: string
  counts: Map<string, { notes: number; folders: number }>
  /** Spaces whose notes sync to a repository. */
  gitFolders: Set<string>
  privacy: { external: boolean; label: string; detail: string }
  onSwitch(id: string): void
  onCreate(name: string, shared: boolean): void
  onManage(id?: string): void
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState<null | 'private' | 'shared'>(null)
  const [name, setName] = useState('')
  const [active, setActive] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = spaces.find(space => space.id === activeId) ?? spaces[0]!
  const own = spaces.filter(space => !space.shared)
  const shared = spaces.filter(space => space.shared)
  const ordered = [...own, ...shared]
  const mac = isMacPlatform()

  useEffect(() => {
    if (!open) {
      setCreating(null)
      setName('')
      return
    }
    setActive(
      Math.max(
        0,
        ordered.findIndex(space => space.id === activeId)
      )
    )
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open || creating) return
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.focus({ preventScroll: true })
  }, [open, active, creating])

  const choose = (id: string) => {
    setOpen(false)
    if (id !== activeId) onSwitch(id)
    trigger.current?.focus({ preventScroll: true })
  }
  const onKey = (event: KeyboardEvent) => {
    if (creating) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive(value => (value + step + ordered.length) % ordered.length)
    }
  }
  const total = counts.get(current.id)?.notes ?? 0

  const row = (space: NoteSpace) => {
    const index = ordered.indexOf(space)
    const count = counts.get(space.id)?.notes ?? 0
    const number = index + 1
    return (
      <button
        key={space.id}
        type="button"
        role="menuitemradio"
        aria-checked={space.id === activeId}
        data-index={index}
        tabIndex={index === active ? 0 : -1}
        className="space-option"
        onMouseEnter={() => setActive(index)}
        onClick={() => choose(space.id)}
      >
        <SpaceAvatar space={space} />
        <span className="space-option-text">
          <strong>{space.name}</strong>
          <small>
            {count} {count === 1 ? 'note' : 'notes'}
            {gitFolders.has(space.id) && (
              <span className="space-option-git">
                <GitBranch size={10} aria-hidden="true" /> Git
              </span>
            )}
          </small>
        </span>
        {space.id === activeId ? (
          <Check size={14} className="space-option-check" aria-hidden="true" />
        ) : (
          number <= 9 && (
            <kbd className="space-option-key">
              {mac ? `⌘⌥${number}` : `Ctrl Alt ${number}`}
            </kbd>
          )
        )}
      </button>
    )
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="space-switcher"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        onClick={() => setOpen(value => !value)}
      >
        <SpaceAvatar space={current} />
        <span className="space-switcher-text">
          <strong>{current.name}</strong>
          <small>
            {privacy.external ? (
              <Cloud size={11} aria-hidden="true" />
            ) : (
              <ShieldCheck size={11} aria-hidden="true" />
            )}
            <span>
              {total} {total === 1 ? 'note' : 'notes'} · {privacy.label}
            </span>
          </small>
        </span>
        <ChevronsUpDown
          size={14}
          className="space-switcher-chevron"
          aria-hidden="true"
        />
      </button>
      <Popover
        anchor={trigger.current}
        open={open}
        onClose={() => setOpen(false)}
        label="Workspaces"
        role="menu"
        placement="top-start"
        className="space-menu"
        initialFocus={false}
      >
        <div ref={list} onKeyDown={onKey}>
          <div className="space-menu-heading">Workspaces</div>
          {own.map(row)}
          {shared.length > 0 && (
            <>
              <div className="space-menu-heading">
                <Users size={11} aria-hidden="true" /> Shared with every
                workspace
              </div>
              {shared.map(row)}
            </>
          )}
          <div className="space-menu-separator" role="separator" />
          {creating ? (
            <form
              className="space-create"
              onSubmit={event => {
                event.preventDefault()
                onCreate(name, creating === 'shared')
                setOpen(false)
              }}
            >
              <input
                autoFocus
                aria-label={
                  creating === 'shared'
                    ? 'Shared workspace name'
                    : 'Workspace name'
                }
                placeholder={
                  creating === 'shared'
                    ? 'Team handbook'
                    : 'Work, Novel, Studio…'
                }
                value={name}
                maxLength={60}
                onChange={event => setName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setCreating(null)
                  }
                }}
              />
              <button type="submit" className="button primary is-compact">
                Create
              </button>
            </form>
          ) : (
            <div className="space-menu-actions">
              <button
                type="button"
                className="space-menu-action"
                onClick={() => setCreating('private')}
              >
                <Plus size={14} aria-hidden="true" /> New workspace
              </button>
              <button
                type="button"
                className="space-menu-action"
                onClick={() => setCreating('shared')}
              >
                <Users size={14} aria-hidden="true" /> New shared workspace
              </button>
              <button
                type="button"
                className="space-menu-action"
                onClick={() => {
                  setOpen(false)
                  onManage(activeId)
                }}
              >
                <Settings2 size={14} aria-hidden="true" /> Manage workspaces
              </button>
            </div>
          )}
          <p className="space-menu-privacy">
            {privacy.external ? (
              <Cloud size={12} aria-hidden="true" />
            ) : (
              <ShieldCheck size={12} aria-hidden="true" />
            )}
            {privacy.detail}
          </p>
        </div>
      </Popover>
    </>
  )
}
