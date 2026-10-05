import { MapMode, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

export interface DictationAnchor {
  id: number
  at: number | null
  phase: 'listening' | 'transcribing'
}
export const setDictationAnchor = StateEffect.define<DictationAnchor | null>()
export const dictationAnchorField = StateField.define<DictationAnchor | null>({
  create: () => null,
  update(value, transaction) {
    if (value && transaction.docChanged)
      value = {
        ...value,
        at:
          value.at === null
            ? null
            : transaction.changes.mapPos(value.at, 1, MapMode.TrackDel),
      }
    for (const effect of transaction.effects)
      if (effect.is(setDictationAnchor)) value = effect.value
    return value
  },
})
class DictationMarker extends WidgetType {
  constructor(readonly phase: DictationAnchor['phase']) {
    super()
  }
  override eq(other: DictationMarker) {
    return this.phase === other.phase
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-dictation-anchor'
    span.setAttribute('aria-hidden', 'true')
    span.textContent =
      this.phase === 'listening' ? 'Listening…' : 'Transcribing…'
    return span
  }
  override ignoreEvent() {
    return true
  }
}
export const dictationAnchorDecoration = EditorView.decorations.compute(
  [dictationAnchorField],
  state => {
    const anchor = state.field(dictationAnchorField)
    return anchor?.at != null
      ? Decoration.set([
          Decoration.widget({
            widget: new DictationMarker(anchor.phase),
            side: 1,
          }).range(anchor.at),
        ])
      : Decoration.none
  }
)
export interface DictationCapture {
  commit(text: string): void
  cancel(): void
  transcribing(): void
}
export function spaceDictation(
  text: string,
  before: string,
  after: string
): string {
  const words = text.trim()
  if (!words) return ''
  const leading =
    before && !/\s$/u.test(before) && !/^[,.;:!?)}\]]/u.test(words) ? ' ' : ''
  const trailing = after && !/^\s|^[,.;:!?)}\]]/u.test(after) ? ' ' : ''
  return leading + words + trailing
}
