import { useSyncExternalStore } from 'react'
import {
  WHISTLE_LANGUAGES,
  type WhistleLanguage,
} from '../../services/whistle-model'

/**
 * The microphone and Whistle language are per device, not per notebook, so
 * they live in local storage. Preferences and the dictation chip share them.
 */
export const DICTATION_INPUT_KEY = 'typenext:dictation-input:v1'

export interface DictationInput {
  deviceId: string
  language: WhistleLanguage
}

const EMPTY: DictationInput = { deviceId: '', language: '' }
let current: DictationInput | null = null
const listeners = new Set<() => void>()

function read(): DictationInput {
  try {
    const value = JSON.parse(localStorage.getItem(DICTATION_INPUT_KEY) ?? '{}')
    return {
      deviceId:
        typeof value.deviceId === 'string' ? value.deviceId.slice(0, 512) : '',
      language: WHISTLE_LANGUAGES.some(item => item.id === value.language)
        ? value.language
        : '',
    }
  } catch {
    return EMPTY
  }
}

export function getDictationInput(): DictationInput {
  current ??= read()
  return current
}

export function setDictationInput(patch: Partial<DictationInput>) {
  current = { ...getDictationInput(), ...patch }
  try {
    localStorage.setItem(DICTATION_INPUT_KEY, JSON.stringify(current))
  } catch {
    // Optional device preference; writing persistence is independent.
  }
  listeners.forEach(listener => listener())
}

export function subscribeDictationInput(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDictationInput(): DictationInput {
  return useSyncExternalStore(
    subscribeDictationInput,
    getDictationInput,
    getDictationInput
  )
}

/** Test-only: forget the cached value so the next read uses storage. */
export function resetDictationInputForTests() {
  current = null
  listeners.clear()
}
