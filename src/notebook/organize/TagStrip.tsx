import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Folder, Plus, X } from 'lucide-react'
import type { NoteFolder, NoteTag } from '../../types/notebook'
import { TagPicker } from './TagPicker'

export interface TagStripHandle {
  openPicker(): void
}

/** The note's folder and tags, under its title. */
export const TagStrip = forwardRef<
  TagStripHandle,
  {
    tags: readonly NoteTag[]
    chosen: readonly string[]
    counts: Map<string, number>
    folderPath: readonly NoteFolder[]
    onToggle(id: string, on: boolean): void
    onCreate(name: string): void
    onManage(): void
    onFolder(anchor: HTMLElement): void
  }
>(function TagStrip(
  { tags, chosen, counts, folderPath, onToggle, onCreate, onManage, onFolder },
  ref
) {
  const [open, setOpen] = useState(false)
  const add = useRef<HTMLButtonElement>(null)
  useImperativeHandle(ref, () => ({ openPicker: () => setOpen(true) }), [])
  const byId = new Map(tags.map(tag => [tag.id, tag]))
  const shown = chosen.map(id => byId.get(id)).filter(Boolean) as NoteTag[]
  const folder = folderPath.at(-1)
  return (
    <div className="org-strip" aria-label="Folder and tags">
      <button
        type="button"
        className={`org-strip-folder${folder ? ` org-${folder.color ?? 'slate'}` : ' is-empty'}`}
        onClick={event => onFolder(event.currentTarget)}
        title={
          folder
            ? folderPath.map(item => item.name).join(' › ')
            : 'Move to a folder'
        }
      >
        <Folder size={13} aria-hidden="true" />
        <span>{folder ? folder.name : 'No folder'}</span>
      </button>
      {shown.map(tag => (
        <span key={tag.id} className={`org-chip org-${tag.color}`}>
          <span className="org-chip-name">{tag.name}</span>
          <button
            type="button"
            className="org-chip-remove"
            aria-label={`Remove tag ${tag.name}`}
            onClick={() => onToggle(tag.id, false)}
          >
            <X size={11} strokeWidth={2.4} />
          </button>
        </span>
      ))}
      <button
        ref={add}
        type="button"
        className="org-strip-add"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Plus size={13} aria-hidden="true" />
        {shown.length ? 'Tag' : 'Add a tag'}
      </button>
      <TagPicker
        anchor={add.current}
        open={open}
        onClose={() => setOpen(false)}
        tags={tags}
        chosen={chosen}
        counts={counts}
        onToggle={onToggle}
        onCreate={onCreate}
        onManage={onManage}
      />
    </div>
  )
})
