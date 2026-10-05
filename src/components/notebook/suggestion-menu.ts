import { StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  EditorView,
  showTooltip,
  tooltips,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view'
import type {
  SuggestionCandidate,
  SuggestionResult,
} from '../../types/notebook'
import {
  acceptInlineSuggestion,
  setInlineSuggestion,
} from './editor-extensions'

export interface SuggestionMenu {
  at: number
  choices: SuggestionCandidate[]
  selected: number
  id: string
  tooltip: Tooltip
}

let nextMenuId = 0
export const setSuggestionMenu = StateEffect.define<SuggestionMenu | null>()

/** Keep one bounded, distinct list for both the inline preview and the menu. */
export function suggestionChoices(result: SuggestionResult) {
  const seen = new Set<string>()
  return [result, ...(result.alternatives ?? []).slice(0, 2)]
    .filter(candidate => {
      const text = candidate.text.trim()
      if (!text || seen.has(text)) return false
      seen.add(text)
      return true
    })
    .map(({ text, sources, mode }) => ({ text, sources, mode }))
}

export function suggestionOrigin(candidate: SuggestionCandidate) {
  if (candidate.mode === 'starter') return 'Writing starter'
  if (candidate.mode === 'model') return 'Local model'
  const source = candidate.sources[0]
  if (!source || /^(this|current) note$/i.test(source)) return 'From this note'
  return `From ${source}`
}

export function createSuggestionMenu(
  at: number,
  choices: SuggestionCandidate[]
): SuggestionMenu {
  return {
    at,
    choices,
    selected: 0,
    id: `cm-suggestions-${++nextMenuId}`,
    // Retain this object while navigating so the panel does not remount or
    // replay its entrance animation for each selected option.
    tooltip: { pos: at, create: createMenuTooltip, above: false },
  }
}

function activeOptionId(menu: SuggestionMenu) {
  return `${menu.id}-option-${menu.selected}`
}

export const suggestionMenuField = StateField.define<SuggestionMenu | null>({
  create: () => null,
  update(menu, transaction) {
    if (transaction.docChanged || transaction.selection) menu = null
    for (const effect of transaction.effects) {
      if (effect.is(setInlineSuggestion) && !effect.value) menu = null
      if (effect.is(setSuggestionMenu)) menu = effect.value
    }
    if (
      menu &&
      (menu.at !== transaction.newSelection.main.head ||
        !transaction.newSelection.main.empty ||
        transaction.newSelection.ranges.length !== 1)
    )
      return null
    return menu
  },
  provide: field => [
    showTooltip.from(field, menu => menu?.tooltip ?? null),
    EditorView.contentAttributes.from(field, menu => ({
      'aria-autocomplete': 'both',
      'aria-haspopup': 'listbox',
      ...(menu
        ? {
            'aria-controls': menu.id,
            'aria-activedescendant': activeOptionId(menu),
          }
        : {}),
    })),
  ],
})

function canUseMenu(view: EditorView, menu: SuggestionMenu | null) {
  return !!(
    menu &&
    view.hasFocus &&
    !view.composing &&
    !view.compositionStarted &&
    view.state.selection.main.empty &&
    view.state.selection.ranges.length === 1 &&
    view.state.selection.main.head === menu.at
  )
}

function selectChoice(view: EditorView, index: number) {
  const menu = view.state.field(suggestionMenuField)
  if (!canUseMenu(view, menu) || !menu) return false
  const selected = (index + menu.choices.length) % menu.choices.length
  const choice = menu.choices[selected]
  if (!choice) return false
  if (selected !== menu.selected)
    view.dispatch({
      effects: [
        setSuggestionMenu.of({ ...menu, selected }),
        setInlineSuggestion.of({ at: menu.at, ...choice }),
      ],
    })
  return true
}

export function moveSuggestionSelection(view: EditorView, direction: -1 | 1) {
  const menu = view.state.field(suggestionMenuField)
  return !!menu && selectChoice(view, menu.selected + direction)
}

export function acceptMenuSuggestion(view: EditorView) {
  const menu = view.state.field(suggestionMenuField)
  return canUseMenu(view, menu) && acceptInlineSuggestion(view)
}

function createMenuTooltip(view: EditorView): TooltipView {
  const menu = view.state.field(suggestionMenuField)
  if (!menu) throw new Error('A suggestion menu requires a current choice.')
  const ownerDocument = view.dom.ownerDocument
  const dom = ownerDocument.createElement('div')
  dom.className = 'cm-suggestion-tooltip'
  const panel = dom.appendChild(ownerDocument.createElement('div'))
  panel.className = 'cm-suggestion-menu'
  const list = panel.appendChild(ownerDocument.createElement('div'))
  list.className = 'cm-suggestion-options'
  list.id = menu.id
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Suggestions')
  const options = menu.choices.map((choice, index) => {
    const option = list.appendChild(ownerDocument.createElement('div'))
    option.className = 'cm-suggestion-option'
    option.id = `${menu.id}-option-${index}`
    option.setAttribute('role', 'option')
    const text = option.appendChild(ownerDocument.createElement('span'))
    text.className = 'cm-suggestion-option-text'
    text.textContent = choice.text.trim()
    const origin = option.appendChild(ownerDocument.createElement('span'))
    origin.className = 'cm-suggestion-option-origin'
    origin.textContent = suggestionOrigin(choice)
    option.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      if (view.state.field(suggestionMenuField)?.id !== menu.id) return
      if (selectChoice(view, index)) acceptMenuSuggestion(view)
    })
    return option
  })
  // Both mouse and touch keep DOM focus in the editor. A click explicitly
  // accepts; moving a pointer over the menu does not change the writing.
  dom.addEventListener('pointerdown', event => {
    event.preventDefault()
    event.stopPropagation()
  })
  dom.addEventListener('mousedown', event => event.preventDefault())
  const hint = panel.appendChild(ownerDocument.createElement('div'))
  hint.className = 'cm-suggestion-menu-hint'
  hint.setAttribute('aria-hidden', 'true')
  hint.textContent = '↑ ↓ choose · Tab / Enter accept · Esc dismiss'
  function updateSelection() {
    const current = view.state.field(suggestionMenuField)
    if (!current || current.id !== menu!.id) return
    options.forEach((option, index) => {
      option.setAttribute('aria-selected', String(index === current.selected))
    })
    options[current.selected]?.scrollIntoView?.({ block: 'nearest' })
  }
  updateSelection()
  return { dom, update: updateSelection }
}

export const suggestionMenuExtensions: Extension = [
  suggestionMenuField,
  tooltips({
    tooltipSpace(view) {
      const documentElement = view.dom.ownerDocument.documentElement
      const window = view.dom.ownerDocument.defaultView
      const width = documentElement.clientWidth || window?.innerWidth || 1024
      const height = documentElement.clientHeight || window?.innerHeight || 768
      return { left: 8, top: 8, right: width - 8, bottom: height - 8 }
    },
  }),
]
