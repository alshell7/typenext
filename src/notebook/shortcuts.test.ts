import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUTS } from './model'
import {
  bindingFromEvent,
  shortcutKeys,
  shortcutProblem,
  shortcutSpeech,
  shortcutText,
} from './shortcuts'

function press(
  key: string,
  code: string,
  modifiers: Partial<
    Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>
  > = {}
) {
  return {
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe('shortcuts', () => {
  it('formats bindings for each platform', () => {
    expect(shortcutKeys('Mod-Space', true)).toEqual(['⌘', 'Space'])
    expect(shortcutKeys('Mod-Space', false)).toEqual(['Ctrl', 'Space'])
    expect(shortcutText('Mod-Shift-j', true)).toBe('⌘ ⇧ J')
    expect(shortcutText('Alt-ArrowRight', false)).toBe('Alt →')
    expect(shortcutSpeech('Mod-ArrowRight', true)).toBe(
      'Command plus Right Arrow'
    )
  })

  it('records a press as a CodeMirror binding', () => {
    expect(bindingFromEvent(press(' ', 'Space', { metaKey: true }), true)).toBe(
      'Mod-Space'
    )
    expect(
      bindingFromEvent(
        press('Dead', 'KeyJ', { altKey: true, ctrlKey: true }),
        false
      )
    ).toBe('Mod-Alt-j')
    expect(
      bindingFromEvent(
        press('K', 'KeyK', { metaKey: true, shiftKey: true }),
        true
      )
    ).toBe('Mod-Shift-k')
    expect(
      bindingFromEvent(press('Meta', 'MetaLeft', { metaKey: true }), true)
    ).toBeNull()
    expect(
      bindingFromEvent(press('.', 'Period', { ctrlKey: true }), false)
    ).toBe('Mod-.')
  })

  it('rejects keys that typing, the app or another action needs', () => {
    const current = { ...DEFAULT_SHORTCUTS }
    expect(shortcutProblem('j', 'suggest', current)).toMatch(/Add/u)
    expect(shortcutProblem('Shift-j', 'suggest', current)).toMatch(/Shift/u)
    expect(shortcutProblem('Mod-s', 'suggest', current)).toMatch(/Save/u)
    expect(shortcutProblem('Mod-j', 'suggest', current)).toMatch(/AI actions/u)
    expect(shortcutProblem('Alt-Space', 'suggest', current)).toBeNull()
    expect(shortcutProblem('F8', 'suggest', current)).toBeNull()
    expect(shortcutProblem('Mod-Space', 'suggest', current)).toBeNull()
  })
})
