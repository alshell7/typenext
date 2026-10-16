import type { ProviderId } from '../types/notebook'

export interface CatalogModel {
  id: string
  name: string
  /** One short line: speed, cost or strength. */
  note: string
  recommended?: boolean
}

/**
 * Models shipped with TypeNext, checked on 2026-10-16 against each provider's
 * model list. "Load models" still shows everything an account can use.
 */
export const MODEL_CATALOG: Partial<Record<ProviderId, CatalogModel[]>> = {
  openai: [
    {
      id: 'gpt-5.4-mini',
      name: 'GPT-5.4 mini',
      note: 'Fast and low cost. Good default for suggestions',
      recommended: true,
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      note: 'Fast, natural continuations',
      recommended: true,
    },
    {
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      note: 'Newest fast model',
      recommended: true,
    },
    { id: 'gpt-5.5', name: 'GPT-5.5', note: 'Strong writing quality' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol', note: 'Most capable GPT-6 tier' },
    {
      id: 'gpt-6.1-sol',
      name: 'GPT-6.1 Sol',
      note: 'Newest flagship. Always reasons, so it is slower',
    },
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      note: 'Balanced quality and speed',
    },
    { id: 'gpt-5.4', name: 'GPT-5.4', note: 'Previous generation flagship' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', note: 'Lowest cost' },
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 mini',
      note: 'No reasoning. Very predictable',
    },
  ],
  anthropic: [
    {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      note: 'Fastest and lowest cost. Good default for suggestions',
      recommended: true,
    },
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      note: 'Best combination of speed and quality',
      recommended: true,
    },
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      note: 'Highest quality writing. Slower',
      recommended: true,
    },
    {
      id: 'claude-fable-5-1',
      name: 'Claude Fable 5.1',
      note: 'Most capable. Slow and costly for short suggestions',
    },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', note: 'Previous Sonnet' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', note: 'Previous Opus' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', note: 'Legacy' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', note: 'Legacy' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', note: 'Legacy' },
  ],
  cloudflare: [
    {
      id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      name: 'Llama 3.3 70B fast',
      note: 'Strong English prose, fast',
      recommended: true,
    },
    {
      id: '@cf/google/gemma-4-26b-a4b-it',
      name: 'Gemma 4 26B',
      note: 'Multilingual, efficient',
      recommended: true,
    },
    {
      id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
      name: 'Mistral Small 3.1 24B',
      note: 'Balanced, multilingual',
      recommended: true,
    },
    {
      id: '@cf/meta/llama-3.1-8b-instruct-fp8',
      name: 'Llama 3.1 8B',
      note: 'Smallest and fastest',
    },
    {
      id: '@cf/meta/llama-4-scout-17b-16e-instruct',
      name: 'Llama 4 Scout',
      note: 'Long context',
    },
    { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', note: 'Multilingual' },
    { id: '@cf/zai-org/glm-5.3-flash', name: 'GLM 5.3 Flash', note: 'Fast' },
    {
      id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
      name: 'DeepSeek V4 Flash',
      note: 'Fast reasoning',
    },
    { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', note: 'Large model' },
    {
      id: '@cf/openai/gpt-oss-20b',
      name: 'GPT-OSS 20B',
      note: 'Open-weight, reasons first',
    },
    {
      id: '@cf/openai/gpt-oss-120b',
      name: 'GPT-OSS 120B',
      note: 'Open-weight, reasons first',
    },
    {
      id: '@cf/nvidia/nemotron-3-120b-a12b',
      name: 'Nemotron 3 120B',
      note: 'Large model',
    },
    {
      id: '@cf/cloudflare/clef-flash',
      name: 'Clef Flash',
      note: 'Cloudflare model',
    },
  ],
  openrouter: [
    {
      id: 'openrouter/free',
      name: 'Free router',
      note: 'Free models, chosen per request. Quality varies',
      recommended: true,
    },
    {
      id: 'openai/gpt-5.4-mini',
      name: 'GPT-5.4 mini',
      note: 'Paid. Fast and consistent',
    },
    {
      id: 'anthropic/claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      note: 'Paid. Fast',
    },
  ],
}

export function catalogFor(provider: ProviderId): CatalogModel[] {
  return MODEL_CATALOG[provider] ?? []
}

/** The catalog entry for a model, if TypeNext knows it. */
export function catalogModel(provider: ProviderId, id: string) {
  return catalogFor(provider).find(model => model.id === id.trim())
}
