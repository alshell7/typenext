import { useMemo } from 'react'
import { X } from 'lucide-react'
import type { ContextSource } from '../../types/notebook'
import { wordCount } from '../model'
import { usePresence } from './usePresence'
import {
  isMediaSource,
  mediaDetail,
  sourceKindName,
  SourceThumb,
} from './source-kinds'

function WordTotal({ text }: { text: string }) {
  const count = useMemo(() => wordCount(text), [text])
  return <>{count.toLocaleString()} words</>
}

export function referenceDetail(source: ContextSource, available: boolean) {
  if (source.kind === 'note')
    return available
      ? 'Linked note · Live context'
      : 'Linked note · Unavailable'
  return null
}

/** Direct references: thumbnail, kind, size or duration, and a switch. */
export function ReferenceList({
  sources,
  isAvailable,
  onToggle,
  onPreview,
  onRemove,
}: {
  sources: ContextSource[]
  isAvailable(source: ContextSource): boolean
  onToggle(source: ContextSource, enabled: boolean): void
  onPreview(source: ContextSource): void
  onRemove(source: ContextSource): void
}) {
  const presence = usePresence(sources, source => source.id)
  return (
    <ul className="source-list" aria-label="Direct references">
      {presence.map(({ key, item, state }) => {
        const available = isAvailable(item)
        const gone = state === 'leaving'
        const detail = mediaDetail(item)
        return (
          <li
            className={`source-item is-${state} ${item.enabled ? '' : 'disabled'} ${available ? '' : 'is-unavailable'}`}
            key={key}
            aria-hidden={gone || undefined}
          >
            <button
              type="button"
              className="source-preview-button"
              aria-label={`Preview ${item.name}`}
              tabIndex={gone ? -1 : undefined}
              onClick={() => onPreview(item)}
            >
              <SourceThumb source={item} />
              <span className="source-item-copy">
                <strong title={item.name}>{item.name}</strong>
                <small>
                  {referenceDetail(item, available) ?? sourceKindName(item)}
                  {isMediaSource(item) ? (
                    detail && ` · ${detail}`
                  ) : (
                    <>
                      {' '}
                      · <WordTotal text={item.text} />
                    </>
                  )}
                  {item.libraryId && !available && ' · Unavailable'}
                  {!item.enabled && ' · Left out'}
                </small>
              </span>
            </button>
            <label
              className="context-switch"
              title={item.enabled ? 'Included' : 'Left out'}
            >
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={!available || gone}
                tabIndex={gone ? -1 : undefined}
                aria-label={`Use ${item.name} as context`}
                onChange={event => onToggle(item, event.target.checked)}
              />
              <span aria-hidden="true" />
            </label>
            <button
              type="button"
              className="icon-button source-item-remove"
              aria-label={`Remove ${item.name}`}
              tabIndex={gone ? -1 : undefined}
              onClick={() => onRemove(item)}
            >
              <X size={13} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export { WordTotal }
