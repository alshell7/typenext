import type { ShortcutSettings } from '../types/notebook'

/**
 * Writer-chosen keys use CodeMirror's notation: modifiers, then a key, joined
 * by "-", with Mod meaning ⌘ on macOS and Ctrl elsewhere.
 */

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent)
  )
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: 'Enter',
  Backspace: '⌫',
  Delete: 'Del',
  Escape: 'Esc',
  Tab: 'Tab',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
}

/** Keycaps for display, for example ["⌘", "Space"]. */
export function shortcutKeys(binding: string, mac = isMacPlatform()): string[] {
  const parts = binding.split('-')
  // "Mod--" names the minus key: an empty part before a final "-".
  if (binding.endsWith('--')) parts.splice(-2, 2, '-')
  const key = parts.pop() ?? ''
  const modifiers = parts.map(part => {
    if (part === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (part === 'Meta') return mac ? '⌘' : 'Win'
    if (part === 'Ctrl') return mac ? '⌃' : 'Ctrl'
    if (part === 'Alt') return mac ? '⌥' : 'Alt'
    if (part === 'Shift') return mac ? '⇧' : 'Shift'
    return part
  })
  const label = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...modifiers, label]
}

export function shortcutText(binding: string, mac = isMacPlatform()): string {
  return shortcutKeys(binding, mac).join(' ')
}

/** Words for screen readers, for example "Command plus Space". */
export function shortcutSpeech(binding: string, mac = isMacPlatform()): string {
  return shortcutKeys(binding, mac)
    .map(
      key =>
        ({
          '⌘': 'Command',
          '⌃': 'Control',
          '⌥': 'Option',
          '⇧': 'Shift',
          '→': 'Right Arrow',
          '←': 'Left Arrow',
          '↑': 'Up Arrow',
          '↓': 'Down Arrow',
          '⌫': 'Backspace',
        })[key] ?? key
    )
    .join(' plus ')
}

const EVENT_KEYS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Del: 'Delete',
}

/**
 * The binding a key press would make, or null while only modifiers are held.
 * Letters use their unshifted form ("Mod-Shift-k"), as CodeMirror expects.
 */
export function bindingFromEvent(
  event: Pick<
    KeyboardEvent,
    'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
  mac = isMacPlatform()
): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph'].includes(event.key))
    return null
  let key = EVENT_KEYS[event.key] ?? event.key
  // Option and Shift change the produced character; use the physical key.
  if (/^Key[A-Z]$/u.test(event.code)) key = event.code.slice(3).toLowerCase()
  else if (/^Digit\d$/u.test(event.code)) key = event.code.slice(5)
  else if (key.length === 1) key = key.toLowerCase()
  const parts: string[] = []
  const primary = mac ? event.metaKey : event.ctrlKey
  if (primary) parts.push('Mod')
  if (mac && event.ctrlKey) parts.push('Ctrl')
  if (!mac && event.metaKey) parts.push('Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return [...parts, key].join('-')
}

/** Keys the app or the editor already uses for something else. */
export const RESERVED_SHORTCUTS: Record<string, string> = {
  'Mod-n': 'New note',
  'Mod-o': 'Open a file',
  'Mod-s': 'Save',
  'Mod-Shift-s': 'Save as',
  'Mod-p': 'Command palette',
  'Mod-b': 'Show or hide notes',
  'Mod-,': 'Preferences',
  'Mod-Shift-f': 'Zen mode',
  'Mod-Shift-g': 'Note graph',
  'Mod-Shift-d': 'Dictation',
  'Mod-Shift-k': 'Web facts',
  'Mod-k': 'Insert a link',
  'Mod-i': 'Italic',
  'Mod-Enter': 'Check a task',
  'Mod-z': 'Undo',
  'Mod-Shift-z': 'Redo',
  'Mod-y': 'Redo',
  'Mod-a': 'Select all',
  'Mod-c': 'Copy',
  'Mod-v': 'Paste',
  'Mod-x': 'Cut',
  'Mod-q': 'Quit',
  'Mod-w': 'Close the window',
  'Mod-h': 'Hide the app',
  'Mod-m': 'Minimise',
  'Mod-f': 'Find in the note',
  'Mod-Alt-f': 'Find and replace',
  'Mod-Alt-s': 'Save a revision',
  'Mod-Alt-h': 'Revision history',
  'Alt-Enter': 'Open the link at the cursor',
  'Mod-ArrowLeft': 'Line start',
  'Mod-ArrowUp': 'Note start',
  'Mod-ArrowDown': 'Note end',
  'Mod-Home': 'Note start',
  'Mod-End': 'Note end',
}

export const SHORTCUT_LABELS: Record<keyof ShortcutSettings, string> = {
  suggest: 'Suggest at the cursor',
  acceptWord: 'Accept one word',
  aiActions: 'AI actions for the selection',
}

/** Why a binding cannot be used here, or null when it is free. */
export function shortcutProblem(
  binding: string,
  name: keyof ShortcutSettings,
  current: ShortcutSettings
): string | null {
  const parts = binding.split('-')
  const key = parts.at(-1) ?? ''
  const modifiers = parts.slice(0, -1)
  const functionKey = /^F\d{1,2}$/u.test(key)
  if (!modifiers.length && !functionKey)
    return 'Add ⌘, Ctrl or Alt so typing still works.'
  if (modifiers.length === 1 && modifiers[0] === 'Shift' && !functionKey)
    return 'Shift alone changes letters. Add ⌘, Ctrl or Alt.'
  if (
    ['Tab', 'Enter', 'Escape', 'Backspace'].includes(key) &&
    !modifiers.includes('Mod')
  )
    return 'Writing needs this key. Add ⌘ or Ctrl.'
  const reserved = RESERVED_SHORTCUTS[binding]
  if (reserved) return `Already used for ${reserved}.`
  for (const other of Object.keys(current) as (keyof ShortcutSettings)[])
    if (other !== name && current[other] === binding)
      return `Already used for ${SHORTCUT_LABELS[other]}.`
  return null
}
