import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch, Plus, Trash2, Users } from 'lucide-react'
import type { NoteSpace, OrganizeColor } from '../../types/notebook'
import { isDesktop } from '../../services/native'
import { Modal } from '../Modal'
import { ORGANIZE_COLORS } from '../organize/organize'
import { SpaceAvatar } from './WorkspaceSwitcher'
import { IconPicker } from './IconPicker'

/**
 * Workspaces in one place: name, colour, sharing, a Git repository each,
 * and removal with a choice of where the notes go.
 */
export function WorkspaceManager({
  open,
  onOpenChange,
  spaces,
  activeId,
  initialId,
  counts,
  homeGitFolder,
  gitEnabled,
  onUpdate,
  onCreate,
  onDelete,
  onSwitch,
  onOpenSync,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  spaces: NoteSpace[]
  activeId: string
  initialId?: string
  counts: Map<string, { notes: number; folders: number }>
  /** The first workspace's folder, from Preferences → Sync. */
  homeGitFolder: string
  gitEnabled: boolean
  onUpdate(
    id: string,
    patch: Partial<
      Pick<NoteSpace, 'name' | 'color' | 'shared' | 'gitFolder'> & {
        icon: string | null
      }
    >
  ): void
  onCreate(shared: boolean): string | null
  onDelete(id: string, moveTo: string | null): void
  onSwitch(id: string): void
  onOpenSync(): void
}) {
  const [selectedId, setSelectedId] = useState(initialId ?? activeId)
  const [confirm, setConfirm] = useState(false)
  const [moveTo, setMoveTo] = useState<string>('')
  const [picking, setPicking] = useState(false)
  const avatar = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) setSelectedId(initialId ?? activeId)
    // When it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const selected = spaces.find(space => space.id === selectedId) ?? spaces[0]!
  const home = spaces[0]!
  const others = spaces.filter(space => space.id !== selected.id)
  useEffect(() => {
    setConfirm(false)
    setMoveTo(others[0]?.id ?? '')
    // When the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.id])
  const count = counts.get(selected.id) ?? { notes: 0, folders: 0 }
  const isHome = selected.id === home.id
  const folder = isHome ? homeGitFolder : (selected.gitFolder ?? '')

  const chooseFolder = async () => {
    const { open: pick } = await import('@tauri-apps/plugin-dialog')
    const value = await pick({
      directory: true,
      multiple: false,
      title: `Choose a Git folder for ${selected.name}`,
    })
    if (typeof value === 'string') onUpdate(selected.id, { gitFolder: value })
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Workspaces"
      description="Each workspace keeps its own notes, folders, tags and contexts. A shared workspace appears inside every other one."
      className="space-manager"
      onEscapeKeyDown={event => {
        if (confirm) {
          event.preventDefault()
          setConfirm(false)
        }
      }}
    >
      <div className="space-manager-body">
        <div
          className="space-manager-list"
          role="listbox"
          aria-label="Your workspaces"
        >
          {spaces.map(space => (
            <button
              key={space.id}
              type="button"
              role="option"
              aria-selected={space.id === selected.id}
              className="space-manager-item"
              onClick={() => setSelectedId(space.id)}
            >
              <SpaceAvatar space={space} />
              <span>
                <strong>{space.name}</strong>
                <small>
                  {space.id === activeId
                    ? 'Open now'
                    : `${counts.get(space.id)?.notes ?? 0} notes`}
                </small>
              </span>
            </button>
          ))}
          <div className="space-manager-add">
            <button
              type="button"
              className="space-menu-action"
              onClick={() => {
                const id = onCreate(false)
                if (id) setSelectedId(id)
              }}
            >
              <Plus size={14} aria-hidden="true" /> New workspace
            </button>
            <button
              type="button"
              className="space-menu-action"
              onClick={() => {
                const id = onCreate(true)
                if (id) setSelectedId(id)
              }}
            >
              <Users size={14} aria-hidden="true" /> New shared
            </button>
          </div>
        </div>
        <section
          className="space-manager-detail"
          aria-label={`${selected.name} settings`}
        >
          <div className="space-manager-title">
            <button
              ref={avatar}
              type="button"
              className="space-manager-avatar"
              aria-label="Choose an icon"
              title="Choose an icon"
              aria-haspopup="dialog"
              aria-expanded={picking}
              onClick={() => setPicking(value => !value)}
            >
              <SpaceAvatar space={selected} size="large" />
            </button>
            <IconPicker
              anchor={avatar.current}
              open={picking}
              onClose={() => setPicking(false)}
              space={selected}
              onChoose={icon => onUpdate(selected.id, { icon })}
            />
            <input
              key={selected.id}
              className="space-manager-name"
              aria-label="Workspace name"
              defaultValue={selected.name}
              maxLength={60}
              onBlur={event =>
                onUpdate(selected.id, { name: event.target.value })
              }
              onKeyDown={event => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          </div>
          <p className="space-manager-meta">
            {count.notes} {count.notes === 1 ? 'note' : 'notes'} ·{' '}
            {count.folders} {count.folders === 1 ? 'folder' : 'folders'}
            {selected.id !== activeId && (
              <button
                type="button"
                className="org-link-button"
                onClick={() => {
                  onSwitch(selected.id)
                  onOpenChange(false)
                }}
              >
                Open this workspace
              </button>
            )}
          </p>
          <div
            className="space-manager-colors"
            role="group"
            aria-label="Workspace colour"
          >
            {ORGANIZE_COLORS.map(color => (
              <button
                key={color.id}
                type="button"
                className={`org-swatch org-${color.id}`}
                aria-label={color.name}
                aria-pressed={selected.color === color.id}
                title={color.name}
                onClick={() =>
                  onUpdate(selected.id, { color: color.id as OrganizeColor })
                }
              />
            ))}
          </div>
          <label className="space-manager-row">
            <span>
              <strong>Share with every workspace</strong>
              <small>
                Its notes, folders and tags appear in all your other workspaces,
                under their own heading. Good for a handbook, templates or
                reference notes.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="pref-switch"
              checked={Boolean(selected.shared)}
              onChange={event =>
                onUpdate(selected.id, { shared: event.target.checked })
              }
            />
          </label>
          <div className="space-manager-row is-git">
            <span>
              <strong>
                <GitBranch size={13} aria-hidden="true" /> Git repository
              </strong>
              <small>
                {!isDesktop()
                  ? 'Git sync is part of the desktop app.'
                  : folder
                    ? gitEnabled
                      ? 'This workspace’s notes sync to their own repository.'
                      : 'Turn on Git sync in Preferences → Sync to start syncing.'
                    : 'Choose a folder to keep this workspace in its own repository.'}
              </small>
              {folder && <code className="space-manager-folder">{folder}</code>}
            </span>
            {isDesktop() &&
              (isHome ? (
                <button
                  type="button"
                  className="button secondary is-compact"
                  onClick={onOpenSync}
                >
                  Sync settings
                </button>
              ) : (
                <span className="space-manager-git-actions">
                  <button
                    type="button"
                    className="button secondary is-compact"
                    onClick={() => void chooseFolder()}
                  >
                    <FolderOpen size={14} />{' '}
                    {folder ? 'Change' : 'Choose folder'}
                  </button>
                  {folder && (
                    <button
                      type="button"
                      className="button subtle is-compact"
                      onClick={() => onUpdate(selected.id, { gitFolder: '' })}
                    >
                      Stop
                    </button>
                  )}
                </span>
              ))}
          </div>
          <div className="space-manager-danger">
            {confirm ? (
              <div
                className="space-manager-confirm"
                role="group"
                aria-label="Remove workspace"
              >
                <p>
                  Remove <strong>{selected.name}</strong>? Its {count.notes}{' '}
                  {count.notes === 1 ? 'note' : 'notes'}:
                </p>
                <select
                  aria-label="What happens to its notes"
                  value={moveTo}
                  onChange={event => setMoveTo(event.target.value)}
                >
                  {others.map(space => (
                    <option key={space.id} value={space.id}>
                      Move to {space.name}
                    </option>
                  ))}
                  <option value="">Delete with the workspace</option>
                </select>
                <span className="space-manager-confirm-actions">
                  <button
                    type="button"
                    className="button subtle is-compact"
                    onClick={() => setConfirm(false)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="button destructive is-compact"
                    onClick={() => {
                      onDelete(selected.id, moveTo || null)
                      setConfirm(false)
                      setSelectedId(others[0]?.id ?? activeId)
                    }}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ) : (
              <button
                type="button"
                className="button subtle is-compact space-manager-remove"
                disabled={spaces.length <= 1}
                title={
                  spaces.length <= 1 ? 'Your only workspace stays' : undefined
                }
                onClick={() => setConfirm(true)}
              >
                <Trash2 size={14} /> Remove workspace
              </button>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
