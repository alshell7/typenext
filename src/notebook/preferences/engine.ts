import type { NotebookSettings, ProviderId } from '../../types/notebook'
import { PROVIDERS } from '../model'
import type { ExternalProvider } from './types'

export const LOCAL_ENGINES = {
  recall: {
    title: 'Writing starters & recall',
    short: 'Starters & recall',
  },
  embedded: { title: 'Built-in SmolLM2', short: 'Built-in model' },
  server: { title: 'Local server', short: 'Local server' },
} as const satisfies Record<
  NotebookSettings['localEngine'],
  { title: string; short: string }
>

export const KEY_LINKS: Partial<Record<ExternalProvider, string>> = {
  openrouter: 'https://openrouter.ai/keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  cloudflare: 'https://dash.cloudflare.com/profile/api-tokens',
}

export function usingExternal(settings: NotebookSettings): boolean {
  return settings.provider !== 'local' && settings.externalAutoEnabled
}

function remember(models: (string | undefined)[]): string[] {
  return [...new Set(models.map(model => model?.trim() ?? ''))]
    .filter(Boolean)
    .slice(0, 32)
}

/** Keep an external provider active for automatic and manual suggestions. */
export function activateExternal(
  settings: NotebookSettings,
  provider: ExternalProvider,
  model?: string
): NotebookSettings {
  const current = settings.profiles[provider]
  const chosen = (model ?? current.model).trim()
  return {
    ...settings,
    provider,
    externalAutoEnabled: true,
    externalProvider: provider,
    profiles: {
      ...settings.profiles,
      [provider]: {
        ...current,
        model: chosen,
        savedModels: remember([chosen, ...(current.savedModels ?? [])]),
      },
    },
  }
}

/** Return every suggestion to this device, optionally with a new engine. */
export function activateLocal(
  settings: NotebookSettings,
  engine: NotebookSettings['localEngine'] = settings.localEngine
): NotebookSettings {
  const local = settings.profiles.local
  return {
    ...settings,
    provider: 'local',
    externalAutoEnabled: false,
    localEngine: engine,
    profiles: {
      ...settings.profiles,
      local: {
        ...local,
        savedModels: remember([local.model, ...(local.savedModels ?? [])]),
      },
    },
  }
}

export function canActivate(
  settings: NotebookSettings,
  provider: ProviderId
): boolean {
  const profile = settings.profiles[provider]
  return Boolean(profile.model.trim() && profile.endpoint.trim())
}

/** What produces suggestions right now, in plain words. */
export function engineSummary(settings: NotebookSettings): {
  external: boolean
  title: string
  detail: string
} {
  if (usingExternal(settings)) {
    const model = settings.profiles[settings.provider].model.trim()
    return {
      external: true,
      title: PROVIDERS[settings.provider],
      detail: model || 'No model chosen',
    }
  }
  const model = settings.profiles.local.model.trim()
  if (settings.localEngine === 'server')
    return model
      ? { external: false, title: model, detail: 'Local server' }
      : {
          external: false,
          title: LOCAL_ENGINES.recall.title,
          detail: 'Local server has no model yet',
        }
  if (settings.localEngine === 'embedded')
    return {
      external: false,
      title: LOCAL_ENGINES.embedded.title,
      detail: 'Runs inside TypeNext',
    }
  return {
    external: false,
    title: LOCAL_ENGINES.recall.title,
    detail: 'No setup needed',
  }
}
