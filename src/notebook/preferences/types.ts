import type { NotebookSettings } from '../../types/notebook'

export type PreferencePane =
  | 'writing'
  | 'editor'
  | 'suggestions'
  | 'models'
  | 'knowledge'
  | 'web'
  | 'sync'
  | 'history'
  | 'dictation'
  | 'updates'
  | 'shortcuts'
  /** Legacy alias: Models, scrolled to On this device. */
  | 'local'
  /** Legacy alias: Models, scrolled to External providers. */
  | 'external'

export type MainPane = Exclude<PreferencePane, 'local' | 'external'>

export interface PaneProps {
  settings: NotebookSettings
  /** Merge a patch into the latest settings, even within one event. */
  update(patch: Partial<NotebookSettings>): void
  /** Settings as of the most recent update, for nested merges. */
  latest(): NotebookSettings
  onPaneChange(pane: PreferencePane): void
}

export const EXTERNAL_PROVIDERS = [
  'openrouter',
  'openai',
  'anthropic',
  'cloudflare',
  'custom',
] as const

export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number]

export function mainPane(pane: PreferencePane): MainPane {
  return pane === 'local' || pane === 'external' ? 'models' : pane
}
