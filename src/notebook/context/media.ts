import { useSyncExternalStore } from 'react'
import type { NotebookSettings } from '../../types/notebook'
import {
  MEDIA_ACCEPT,
  MEDIA_LIMITS,
  mediaKind,
} from '../../services/media-sources'
import {
  getSemanticIndexStatus,
  subscribeSemanticIndex,
  type SemanticIndexStatus,
} from '../../services/semantic-retrieval'

export const TEXT_ACCEPT = '.txt,.md,.markdown,.pdf,.docx'
export const SOURCE_ACCEPT = `${TEXT_ACCEPT},${MEDIA_ACCEPT}`
export const SOURCE_FORMATS_HELP = `Text, Markdown, PDF and Word. Images up to ${MEDIA_LIMITS.image.label}, audio up to ${MEDIA_LIMITS.audio.label}, video up to ${MEDIA_LIMITS.video.label}.`
export const SOURCE_FORMATS_SHORT =
  'Text, Markdown, PDF, Word, images, audio or video'

export function hasMediaFiles(files: FileList | File[] | null | undefined) {
  if (!files) return false
  for (const file of Array.from(files)) if (mediaKind(file)) return true
  return false
}

/** Media sources need embeddings; without them a dropped image has no text. */
export function mediaNeedsSetup(settings: NotebookSettings | undefined) {
  return !!settings && !(settings.semantic?.enabled && settings.semantic?.media)
}

export function semanticOn(settings: NotebookSettings | undefined) {
  return settings?.semantic?.enabled === true
}

const OFF: SemanticIndexStatus = { state: 'off', indexed: 0, total: 0 }
const subscribeNothing = () => () => undefined
const getOff = () => OFF

export function useSemanticStatus(enabled: boolean): SemanticIndexStatus {
  return useSyncExternalStore(
    enabled ? subscribeSemanticIndex : subscribeNothing,
    enabled ? getSemanticIndexStatus : getOff,
    getOff
  )
}

export function semanticStatusLabel(status: SemanticIndexStatus) {
  if (status.state === 'indexing')
    return `Indexing ${status.indexed.toLocaleString()} of ${status.total.toLocaleString()} passages`
  if (status.state === 'ready')
    return status.total
      ? `Meaning search ready · ${status.total.toLocaleString()} ${status.total === 1 ? 'passage' : 'passages'}`
      : 'Meaning search ready'
  if (status.state === 'error' || status.state === 'unavailable')
    return 'Meaning search is unavailable. Matching words only.'
  return ''
}
