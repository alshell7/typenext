import {
  AudioLines,
  FileText,
  Film,
  Globe,
  Image as ImageIcon,
  Notebook,
} from 'lucide-react'
import type { ContextSource } from '../../types/notebook'

/** Writer-facing families. Several file formats share one visual family. */
export type SourceGroup = 'file' | 'web' | 'note' | 'image' | 'audio' | 'video'
export const SOURCE_GROUPS: SourceGroup[] = [
  'file',
  'web',
  'note',
  'image',
  'audio',
  'video',
]
const GROUP_NAMES: Record<SourceGroup, [string, string]> = {
  file: ['file', 'files'],
  web: ['website', 'websites'],
  note: ['note', 'notes'],
  image: ['image', 'images'],
  audio: ['recording', 'recordings'],
  video: ['video', 'videos'],
}

export function sourceGroup(kind: ContextSource['kind']): SourceGroup {
  if (kind === 'website') return 'web'
  if (kind === 'note' || kind === 'image' || kind === 'audio') return kind
  if (kind === 'video') return 'video'
  return 'file'
}

export function isMediaSource(source: Pick<ContextSource, 'kind'>) {
  return (
    source.kind === 'image' ||
    source.kind === 'audio' ||
    source.kind === 'video'
  )
}

export function groupLabel(group: SourceGroup, count: number) {
  const [one, many] = GROUP_NAMES[group]
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

export function GroupIcon({
  group,
  size = 14,
}: {
  group: SourceGroup
  size?: number
}) {
  const props = { size, strokeWidth: 1.6, 'aria-hidden': true } as const
  if (group === 'web') return <Globe {...props} />
  if (group === 'note') return <Notebook {...props} />
  if (group === 'image') return <ImageIcon {...props} />
  if (group === 'audio') return <AudioLines {...props} />
  if (group === 'video') return <Film {...props} />
  return <FileText {...props} />
}

/** Short kind name for metadata lines. */
export function sourceKindName(source: Pick<ContextSource, 'kind'>) {
  switch (source.kind) {
    case 'note':
      return 'Linked note'
    case 'website':
      return 'Website'
    case 'markdown':
      return 'Markdown'
    case 'text':
      return 'Text'
    case 'image':
      return 'Image'
    case 'audio':
      return 'Audio'
    case 'video':
      return 'Video'
    default:
      return source.kind.toUpperCase()
  }
}

export function formatDuration(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0)
    return ''
  const whole = Math.round(seconds)
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

export function formatBytes(bytes: number | undefined) {
  if (!bytes || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

/** Duration for timed media, dimensions for images. Empty for text sources. */
export function mediaDetail(source: ContextSource) {
  const media = source.media
  if (!media) return ''
  if (source.kind === 'audio' || source.kind === 'video')
    return formatDuration(media.durationSeconds)
  if (source.kind === 'image' && media.width && media.height)
    return `${media.width}×${media.height}`
  return ''
}

/** Only data URLs produced at import are rendered; nothing is fetched. */
export function safeThumbnail(source: Pick<ContextSource, 'media'>) {
  const thumbnail = source.media?.thumbnail
  return thumbnail && /^data:image\/(?:jpeg|png|webp);base64,/u.test(thumbnail)
    ? thumbnail
    : undefined
}

/** A square tile with a thumbnail for images and video posters, else an icon. */
export function SourceThumb({
  source,
  size = 'small',
}: {
  source: ContextSource
  size?: 'small' | 'card'
}) {
  const group = sourceGroup(source.kind)
  const thumbnail = safeThumbnail(source)
  const duration =
    source.kind === 'video' || source.kind === 'audio'
      ? formatDuration(source.media?.durationSeconds)
      : ''
  return (
    <span
      className={`source-thumb is-${group} is-${size} ${thumbnail ? 'has-image' : ''}`}
      aria-hidden="true"
    >
      {thumbnail ? (
        <img src={thumbnail} alt="" draggable={false} />
      ) : (
        <GroupIcon group={group} size={size === 'card' ? 20 : 15} />
      )}
      {thumbnail && source.kind === 'video' && (
        <span className="source-thumb-badge">
          <Film size={10} strokeWidth={2} />
          {duration}
        </span>
      )}
    </span>
  )
}

export function countGroups(sources: Iterable<Pick<ContextSource, 'kind'>>) {
  const counts = new Map<SourceGroup, number>()
  for (const source of sources) {
    const group = sourceGroup(source.kind)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  return counts
}

/** Compact icon + count pairs, in a stable family order. */
export function KindCluster({
  counts,
  className = '',
}: {
  counts: Map<SourceGroup, number>
  className?: string
}) {
  const entries = SOURCE_GROUPS.flatMap(group => {
    const count = counts.get(group)
    return count ? [[group, count] as const] : []
  })
  if (!entries.length) return null
  return (
    <span
      className={`kind-cluster ${className}`}
      aria-label={entries
        .map(([group, count]) => groupLabel(group, count))
        .join(', ')}
      role="img"
    >
      {entries.map(([group, count]) => (
        <span key={group} className={`kind-cluster-item is-${group}`}>
          <GroupIcon group={group} size={12} />
          {count}
        </span>
      ))}
    </span>
  )
}
