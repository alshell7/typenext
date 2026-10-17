import { useMemo, useState } from 'react'
import { Check, Plus, Tag, Trash2 } from 'lucide-react'
import type { NoteTag, OrganizeColor } from '../../types/notebook'
import { Modal } from '../Modal'
import { byName, cleanTagName, findTag, ORGANIZE_COLORS } from './organize'

/** Every tag in one place: rename, recolour, merge by renaming, delete. */
export function TagManager({
  open,
  onOpenChange,
  tags,
  counts,
  onCreate,
  onRename,
  onColor,
  onDelete,
  onFilter,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  tags: readonly NoteTag[]
  counts: Map<string, number>
  onCreate(name: string): void
  onRename(id: string, name: string): void
  onColor(id: string, color: OrganizeColor): void
  onDelete(id: string): void
  onFilter(id: string): void
}) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const sorted = useMemo(() => {
    const key = query.trim().toLocaleLowerCase()
    return [...tags]
      .sort(byName)
      .filter(tag => !key || tag.name.toLocaleLowerCase().includes(key))
  }, [tags, query])
  const clean = cleanTagName(draft)
  const merging = editing
    ? findTag(tags, name)?.id !== editing && Boolean(findTag(tags, name))
    : false

  return (
    <Modal
      open={open}
      onOpenChange={value => {
        onOpenChange(value)
        if (!value) {
          setEditing(null)
          setConfirm(null)
        }
      }}
      title="Tags"
      description="Name, colour and tidy the tags on your notes. Renaming a tag to another tag's name merges them."
      className="org-tag-manager"
      onEscapeKeyDown={event => {
        if (editing || confirm) {
          event.preventDefault()
          setEditing(null)
          setConfirm(null)
        }
      }}
    >
      <form
        className="org-manager-new"
        onSubmit={event => {
          event.preventDefault()
          if (!clean) return
          onCreate(clean)
          setDraft('')
        }}
      >
        <Tag size={15} aria-hidden="true" />
        <input
          aria-label="New tag name"
          placeholder="New tag"
          value={draft}
          maxLength={60}
          onChange={event => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="button primary is-compact"
          disabled={!clean || Boolean(findTag(tags, clean))}
        >
          <Plus size={14} /> Add
        </button>
      </form>
      {tags.length > 8 && (
        <input
          className="org-manager-filter"
          aria-label="Filter tags"
          placeholder="Filter tags"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      )}
      <ul className="org-manager-list" aria-label="Your tags">
        {sorted.map(tag => (
          <li key={tag.id} className="org-manager-row">
            <span
              className={`org-dot is-large org-${tag.color}`}
              aria-hidden="true"
            />
            {editing === tag.id ? (
              <form
                className="org-manager-rename"
                onSubmit={event => {
                  event.preventDefault()
                  if (cleanTagName(name)) onRename(tag.id, name)
                  setEditing(null)
                }}
              >
                <input
                  autoFocus
                  aria-label={`Rename ${tag.name}`}
                  value={name}
                  maxLength={60}
                  onChange={event => setName(event.target.value)}
                  onBlur={event => {
                    if (
                      !event.currentTarget.form?.contains(
                        event.relatedTarget as Node
                      )
                    )
                      setEditing(null)
                  }}
                />
                <button type="submit" className="button primary is-compact">
                  <Check size={14} /> {merging ? 'Merge' : 'Save'}
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="org-manager-name"
                title="Rename"
                onClick={() => {
                  setEditing(tag.id)
                  setName(tag.name)
                  setConfirm(null)
                }}
              >
                {tag.name}
              </button>
            )}
            <button
              type="button"
              className="org-manager-count"
              title="Show these notes"
              onClick={() => {
                onFilter(tag.id)
                onOpenChange(false)
              }}
            >
              {counts.get(tag.id) ?? 0}{' '}
              {(counts.get(tag.id) ?? 0) === 1 ? 'note' : 'notes'}
            </button>
            <span
              className="org-manager-colors"
              role="group"
              aria-label={`Colour of ${tag.name}`}
            >
              {ORGANIZE_COLORS.map(color => (
                <button
                  key={color.id}
                  type="button"
                  className={`org-swatch is-small org-${color.id}`}
                  aria-label={color.name}
                  aria-pressed={tag.color === color.id}
                  title={color.name}
                  onClick={() => onColor(tag.id, color.id)}
                />
              ))}
            </span>
            {confirm === tag.id ? (
              <span className="org-manager-confirm">
                <button
                  type="button"
                  className="button destructive is-compact"
                  onClick={() => {
                    onDelete(tag.id)
                    setConfirm(null)
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="button subtle is-compact"
                  onClick={() => setConfirm(null)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="pref-icon-button"
                aria-label={`Delete tag ${tag.name}`}
                title="Delete tag (notes stay)"
                onClick={() => setConfirm(tag.id)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
        {!sorted.length && (
          <li className="org-manager-empty">
            {tags.length
              ? 'No tag matches.'
              : 'No tags yet. Add one above, or from a note.'}
          </li>
        )}
      </ul>
    </Modal>
  )
}
