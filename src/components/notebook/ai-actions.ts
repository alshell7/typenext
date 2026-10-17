import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  keymap,
  showTooltip,
  ViewPlugin,
  WidgetType,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'
import type { AiActionId, AiIndicatorStyle } from '../../types/notebook'
import {
  AI_ACTIONS,
  MAX_ACTION_CHARACTERS,
  type ActionRequest,
  type AiEngine,
} from '../../services/text-actions'
import { wordDiff } from '../../notebook/revisions/diff'
import { pulseElement } from './ai-pulse'

/**
 * Two things a writer sees while a model works: a small animation at the
 * cursor while a suggestion is on its way, and the AI panel for selected
 * text (polish, fix grammar, rewrite …). The panel only proposes. Nothing
 * changes until the writer chooses Replace.
 */

export interface AiHost {
  engine(): AiEngine | null
  indicator(): AiIndicatorStyle
  run(request: ActionRequest, signal: AbortSignal): Promise<string>
  /** Called before a replacement, so the text before it can be kept. */
  beforeReplace?(label: string): void
  shortcut?(): string
}

// ------------------------------------------------------------- Pending pulse

/** Show the animation at a position, or clear it with null. */
export const setAiPending = StateEffect.define<number | null>()

export const aiPendingField = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null
    for (const effect of transaction.effects)
      if (effect.is(setAiPending)) value = effect.value
    return value !== null && value <= transaction.state.doc.length
      ? value
      : null
  },
})

class PulseWidget extends WidgetType {
  constructor(readonly style: AiIndicatorStyle) {
    super()
  }
  override eq(other: PulseWidget) {
    return other.style === this.style
  }
  toDOM() {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-ai-pulse-widget'
    wrapper.setAttribute('aria-hidden', 'true')
    wrapper.append(pulseElement(this.style))
    return wrapper
  }
  override ignoreEvent() {
    return true
  }
}

function pendingDecorations(host: AiHost) {
  return EditorView.decorations.compute([aiPendingField, 'doc'], state => {
    const at = state.field(aiPendingField)
    const style = host.indicator()
    if (at === null || style === 'off') return Decoration.none
    return Decoration.set([
      Decoration.widget({ widget: new PulseWidget(style), side: 1 }).range(at),
    ])
  })
}

// ------------------------------------------------------------- AI panel

type Phase = 'menu' | 'running' | 'result' | 'error'

export interface AiSession {
  id: number
  from: number
  to: number
  phase: Phase
  action?: ActionRequest['action']
  result?: string
  error?: string
}

let nextSession = 1
export const setAiSession = StateEffect.define<AiSession | null>()

export const aiSessionField = StateField.define<AiSession | null>({
  create: () => null,
  update(session, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setAiSession)) return effect.value
    // A proposal is for the text as it was. Any edit or a move elsewhere
    // ends the session; the controller aborts a running request.
    if (session && (transaction.docChanged || transaction.selection))
      return null
    return session
  },
})

const setApplied = StateEffect.define<{ from: number; to: number } | null>()
const appliedField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(range, transaction) {
    if (range && transaction.docChanged)
      range = {
        from: transaction.changes.mapPos(range.from, 1),
        to: transaction.changes.mapPos(range.to, -1),
      }
    for (const effect of transaction.effects)
      if (effect.is(setApplied)) range = effect.value
    return range && range.from < range.to ? range : null
  },
  provide: field =>
    EditorView.decorations.from(field, range =>
      range
        ? Decoration.set([
            Decoration.mark({ class: 'cm-ai-applied' }).range(
              range.from,
              range.to
            ),
          ])
        : Decoration.none
    ),
})

const workingDecorations = EditorView.decorations.compute(
  [aiSessionField],
  state => {
    const session = state.field(aiSessionField)
    if (!session || session.from >= session.to) return Decoration.none
    return Decoration.set([
      Decoration.mark({
        class: session.phase === 'running' ? 'cm-ai-working' : 'cm-ai-selected',
      }).range(session.from, session.to),
    ])
  }
)

const controllers = new WeakMap<EditorView, AbortController>()

function abortRunning(view: EditorView) {
  controllers.get(view)?.abort()
  controllers.delete(view)
}

/** The selection to edit: as selected, or the paragraph at the cursor. */
function editRange(state: EditorState): { from: number; to: number } | null {
  const range = state.selection.main
  if (!range.empty) return { from: range.from, to: range.to }
  const doc = state.doc
  const line = doc.lineAt(range.head)
  if (!line.text.trim()) return null
  let first = line.number
  let last = line.number
  while (first > 1 && doc.line(first - 1).text.trim()) first--
  while (last < doc.lines && doc.line(last + 1).text.trim()) last++
  return { from: doc.line(first).from, to: doc.line(last).to }
}

export function openAiActions(
  view: EditorView,
  host: AiHost,
  action?: AiActionId
): boolean {
  if (!host.engine()) return false
  const range = editRange(view.state)
  if (!range) return false
  abortRunning(view)
  const session: AiSession = {
    id: nextSession++,
    ...range,
    phase: 'menu',
  }
  view.dispatch({
    selection: EditorSelection.range(range.from, range.to),
    effects: setAiSession.of(session),
  })
  if (action) runAction(view, host, action)
  return true
}

export function closeAiActions(view: EditorView, focus = true): boolean {
  const session = view.state.field(aiSessionField, false)
  if (!session) return false
  abortRunning(view)
  view.dispatch({ effects: setAiSession.of(null) })
  if (focus) view.focus()
  return true
}

function runAction(
  view: EditorView,
  host: AiHost,
  action: ActionRequest['action']
) {
  const session = view.state.field(aiSessionField, false)
  if (!session) return
  abortRunning(view)
  const { from, to } = session
  const text = view.state.sliceDoc(from, to)
  if (text.length > MAX_ACTION_CHARACTERS) {
    view.dispatch({
      effects: setAiSession.of({
        ...session,
        phase: 'error',
        action,
        error: `Select up to ${MAX_ACTION_CHARACTERS.toLocaleString('en')} characters at a time.`,
      }),
    })
    return
  }
  const controller = new AbortController()
  controllers.set(view, controller)
  const running: AiSession = { ...session, phase: 'running', action }
  view.dispatch({ effects: setAiSession.of(running) })
  const before = view.state.sliceDoc(Math.max(0, from - 600), from)
  const after = view.state.sliceDoc(
    to,
    Math.min(view.state.doc.length, to + 300)
  )
  const title =
    view.dom
      .closest('.document-page')
      ?.querySelector<HTMLInputElement>('.note-title')?.value ?? ''
  const current = () =>
    !controller.signal.aborted &&
    view.dom.isConnected &&
    view.state.field(aiSessionField, false)?.id === running.id
  void host
    .run({ action, text, before, after, noteTitle: title }, controller.signal)
    .then(result => {
      if (!current()) return
      view.dispatch({
        effects: setAiSession.of({ ...running, phase: 'result', result }),
      })
    })
    .catch(error => {
      if (!current()) return
      view.dispatch({
        effects: setAiSession.of({
          ...running,
          phase: 'error',
          error:
            error instanceof Error && error.message
              ? error.message
              : 'The model could not edit this text.',
        }),
      })
    })
    .finally(() => {
      if (controllers.get(view) === controller) controllers.delete(view)
    })
}

function actionLabel(action: ActionRequest['action'] | undefined) {
  if (!action) return 'Ask AI'
  if (typeof action !== 'string') return 'Your request'
  return AI_ACTIONS.find(item => item.id === action)?.label ?? 'Ask AI'
}

function workingLabel(action: ActionRequest['action'] | undefined) {
  if (!action || typeof action !== 'string') return 'Working on it'
  return AI_ACTIONS.find(item => item.id === action)?.working ?? 'Working on it'
}

function applyResult(view: EditorView, host: AiHost) {
  const session = view.state.field(aiSessionField, false)
  if (!session?.result) return
  host.beforeReplace?.(
    `Before ${actionLabel(session.action).toLocaleLowerCase()}`
  )
  const insert = session.result
  view.dispatch({
    changes: { from: session.from, to: session.to, insert },
    selection: EditorSelection.cursor(session.from + insert.length),
    effects: [
      setAiSession.of(null),
      setApplied.of({ from: session.from, to: session.from + insert.length }),
      EditorView.announce.of('Replaced the selection with the AI edit.'),
    ],
    annotations: [
      Transaction.userEvent.of('input.ai'),
      isolateHistory.of('full'),
    ],
    scrollIntoView: true,
  })
  view.focus()
}

// ------------------------------------------------------------- Panel DOM

const ICONS: Record<AiActionId | 'spark' | 'send', string[]> = {
  spark: [
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
    'M20 3v4',
    'M22 5h-4',
  ],
  polish: [
    'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
  ],
  grammar: ['m6 16 6-12 6 12', 'M8 12h8', 'm16 20 2 2 4-4'],
  rewrite: [
    'M12 20h9',
    'M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z',
  ],
  paraphrase: [
    'm2 9 3-3 3 3',
    'M13 18H7a2 2 0 0 1-2-2V6',
    'm22 15-3 3-3-3',
    'M11 6h6a2 2 0 0 1 2 2v10',
  ],
  shorter: ['m14 10 7-7', 'M20 10h-6V4', 'm3 21 7-7', 'M4 14h6v6'],
  longer: ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6'],
  send: ['m5 12 7-7 7 7', 'M12 19V5'],
}

function icon(name: keyof typeof ICONS, size = 15) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(
  label: string,
  onClick: () => void,
  className = 'cm-ai-button'
) {
  const node = element('button', className, label)
  node.type = 'button'
  node.addEventListener('mousedown', event => event.preventDefault())
  node.addEventListener('click', event => {
    event.preventDefault()
    onClick()
  })
  return node
}

function kbd(text: string) {
  return element('kbd', 'cm-ai-kbd', text)
}

class AiPanel implements TooltipView {
  dom = element('div', 'cm-ai-panel')
  private rendered: AiSession | null = null
  private highlighted = 0
  private draft = ''

  constructor(
    readonly view: EditorView,
    readonly host: AiHost
  ) {
    this.dom.setAttribute('role', 'dialog')
    this.dom.setAttribute('aria-label', 'AI actions for the selection')
    this.dom.tabIndex = -1
    this.dom.addEventListener('keydown', event => this.onKey(event))
    this.render()
  }

  mount() {
    this.focusFor(this.view.state.field(aiSessionField))
  }

  update(update: ViewUpdate) {
    if (update.state.field(aiSessionField) !== this.rendered) this.render()
  }

  /**
   * Move focus into the panel at once, not on the next frame: a key pressed
   * right after opening must never type over the selected text.
   */
  private focusFor(session: AiSession | null) {
    const focus = () => {
      if (!this.dom.isConnected || !session) return false
      const target =
        session.phase === 'menu'
          ? this.dom.querySelector<HTMLElement>('.cm-ai-input')
          : session.phase === 'result'
            ? (this.dom.querySelector<HTMLElement>(
                '.cm-ai-button.primary:not(:disabled)'
              ) ?? this.dom.querySelector<HTMLElement>('.cm-ai-button'))
            : this.dom
      target?.focus({ preventScroll: true })
      return true
    }
    if (!focus()) requestAnimationFrame(focus)
  }

  private onKey(event: KeyboardEvent) {
    const session = this.view.state.field(aiSessionField, false)
    if (!session) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeAiActions(this.view)
      return
    }
    if (session.phase === 'menu') {
      const items = [
        ...this.dom.querySelectorAll<HTMLButtonElement>('.cm-ai-action'),
      ]
      const typing =
        event.target instanceof HTMLInputElement && event.target.value !== ''
      // The actions sit in two columns: up and down move by a row, left and
      // right by one, unless the writer is typing a request.
      const step =
        event.key === 'ArrowDown'
          ? 2
          : event.key === 'ArrowUp'
            ? -2
            : event.key === 'ArrowRight' && !typing
              ? 1
              : event.key === 'ArrowLeft' && !typing
                ? -1
                : 0
      if (step) {
        event.preventDefault()
        this.highlighted =
          (this.highlighted + step + items.length) % items.length
        items.forEach((item, index) =>
          item.setAttribute('aria-selected', String(index === this.highlighted))
        )
        items[this.highlighted]?.scrollIntoView({ block: 'nearest' })
      } else if (
        event.key === 'Enter' &&
        event.target instanceof HTMLInputElement
      ) {
        event.preventDefault()
        const instruction = event.target.value.trim()
        if (instruction) runAction(this.view, this.host, { instruction })
        else {
          const id = AI_ACTIONS[this.highlighted]?.id
          if (id) runAction(this.view, this.host, id)
        }
      }
    } else if (session.phase === 'result') {
      if (
        event.key === 'Enter' &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault()
        applyResult(this.view, this.host)
      } else if (
        (event.key === 'r' || event.key === 'R') &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault()
        if (session.action) runAction(this.view, this.host, session.action)
      }
    }
  }

  private render() {
    const session = this.view.state.field(aiSessionField, false) ?? null
    const previous = this.rendered
    this.rendered = session
    if (!session) return
    const input = this.dom.querySelector<HTMLInputElement>('.cm-ai-input')
    if (input) this.draft = input.value
    this.dom.dataset.phase = session.phase
    this.dom.replaceChildren(this.header(session))
    if (session.phase === 'menu') this.renderMenu()
    else if (session.phase === 'running') this.renderRunning(session)
    else if (session.phase === 'result') this.renderResult(session)
    else this.renderError(session)
    if (previous && previous.phase !== session.phase) this.focusFor(session)
  }

  private header(session: AiSession) {
    const head = element('div', 'cm-ai-head')
    const title = element('span', 'cm-ai-title')
    title.append(
      icon('spark', 14),
      document.createTextNode(actionLabel(session.action))
    )
    head.append(title)
    const engine = this.host.engine()
    if (engine) {
      const meta = element('span', 'cm-ai-engine', engine.label)
      meta.title = `Edits are written by ${engine.label}`
      head.append(meta)
    }
    return head
  }

  private renderMenu() {
    const list = element('div', 'cm-ai-actions')
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'AI actions')
    AI_ACTIONS.forEach((action, index) => {
      const item = button(
        '',
        () => runAction(this.view, this.host, action.id),
        'cm-ai-action'
      )
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(index === this.highlighted))
      item.tabIndex = -1
      item.dataset.action = action.id
      const glyph = element('span', 'cm-ai-action-icon')
      glyph.append(icon(action.id))
      const words = element('span', 'cm-ai-action-text')
      words.append(
        element('strong', '', action.label),
        element('small', '', action.hint)
      )
      item.append(glyph, words)
      item.addEventListener('mouseenter', () => {
        this.highlighted = index
        list
          .querySelectorAll('.cm-ai-action')
          .forEach((other, position) =>
            other.setAttribute('aria-selected', String(position === index))
          )
      })
      list.append(item)
    })
    const ask = element('label', 'cm-ai-ask')
    const field = element('input', 'cm-ai-input')
    field.type = 'text'
    field.placeholder = 'Or describe a change…'
    field.setAttribute('aria-label', 'Describe a change for the AI')
    field.maxLength = 400
    field.value = this.draft
    field.autocomplete = 'off'
    field.spellcheck = true
    const send = button(
      '',
      () => {
        const instruction = field.value.trim()
        if (instruction) runAction(this.view, this.host, { instruction })
      },
      'cm-ai-send'
    )
    send.setAttribute('aria-label', 'Send request')
    send.append(icon('send', 13))
    ask.append(field, send)
    const foot = element('div', 'cm-ai-foot')
    foot.append(
      kbd('↑↓'),
      document.createTextNode(' choose · '),
      kbd('↵'),
      document.createTextNode(' run · '),
      kbd('Esc'),
      document.createTextNode(' close')
    )
    this.dom.append(list, ask, foot)
  }

  private renderRunning(session: AiSession) {
    const row = element('div', 'cm-ai-running')
    row.setAttribute('role', 'status')
    const style = this.host.indicator()
    if (style !== 'off') row.append(pulseElement(style))
    row.append(element('span', '', `${workingLabel(session.action)}…`))
    const cancel = button(
      'Cancel',
      () => closeAiActions(this.view),
      'cm-ai-button subtle'
    )
    cancel.append(kbd('Esc'))
    row.append(cancel)
    this.dom.append(row)
  }

  private renderResult(session: AiSession) {
    const original = this.view.state.sliceDoc(session.from, session.to)
    const result = session.result ?? ''
    const preview = element('div', 'cm-ai-preview')
    preview.setAttribute('aria-label', 'Proposed text with changes marked')
    const segments = wordDiff(original, result)
    let added = 0
    let removed = 0
    for (const segment of segments) {
      const tag =
        segment.op === 'insert'
          ? 'ins'
          : segment.op === 'delete'
            ? 'del'
            : 'span'
      preview.append(element(tag, `cm-ai-diff-${segment.op}`, segment.text))
      const words = segment.text.match(/\S+/gu)?.length ?? 0
      if (segment.op === 'insert') added += words
      else if (segment.op === 'delete') removed += words
    }
    const unchanged = result === original
    const stats = element(
      'div',
      'cm-ai-stats',
      unchanged
        ? 'No changes needed.'
        : `${added} ${added === 1 ? 'word' : 'words'} added · ${removed} removed`
    )
    const actions = element('div', 'cm-ai-buttons')
    const replace = button(
      'Replace',
      () => applyResult(this.view, this.host),
      'cm-ai-button primary'
    )
    replace.append(kbd('↵'))
    replace.disabled = unchanged
    const again = button('Try again', () => {
      if (session.action) runAction(this.view, this.host, session.action)
    })
    again.append(kbd('R'))
    const copy = button('Copy', () => {
      void navigator.clipboard?.writeText(result).then(() => {
        copy.textContent = 'Copied'
      })
    })
    const discard = button(
      'Discard',
      () => closeAiActions(this.view),
      'cm-ai-button subtle'
    )
    discard.append(kbd('Esc'))
    actions.append(replace, again, copy, discard)
    this.dom.append(preview, stats, actions)
  }

  private renderError(session: AiSession) {
    const message = element('p', 'cm-ai-error', session.error ?? '')
    message.setAttribute('role', 'alert')
    const actions = element('div', 'cm-ai-buttons')
    if (session.action) {
      const again = button(
        'Try again',
        () => runAction(this.view, this.host, session.action!),
        'cm-ai-button primary'
      )
      actions.append(again)
    }
    actions.append(
      button('Close', () => closeAiActions(this.view), 'cm-ai-button subtle')
    )
    this.dom.append(message, actions)
  }

  destroy() {
    // The panel closes when the session ends; a running request stops too.
    if (!this.view.state.field(aiSessionField, false)) abortRunning(this.view)
  }
}

function panelTooltip(host: AiHost) {
  return StateField.define<Tooltip | null>({
    create: () => null,
    update(tooltip, transaction) {
      const session = transaction.state.field(aiSessionField)
      if (!session) return null
      // Below the selection, so the text being edited stays in view: under
      // its start for one line, under its end for several.
      const doc = transaction.state.doc
      const pos =
        doc.lineAt(session.from).number === doc.lineAt(session.to).number
          ? session.from
          : session.to
      if (tooltip && tooltip.pos === pos) return tooltip
      return {
        pos,
        above: false,
        strictSide: false,
        arrow: false,
        create: view => new AiPanel(view, host),
      }
    },
    provide: field => showTooltip.from(field),
  })
}

const appliedTimeout = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (
        update.transactions.some(transaction =>
          transaction.effects.some(
            effect => effect.is(setApplied) && effect.value
          )
        )
      ) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          if (this.view.dom.isConnected)
            this.view.dispatch({ effects: setApplied.of(null) })
        }, 1600)
      }
    }
    destroy() {
      clearTimeout(this.timer)
    }
  }
)

/** Abort a running request when its session ends for any reason. */
const sessionWatcher = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      const before = update.startState.field(aiSessionField)
      const after = update.state.field(aiSessionField)
      if (before?.phase === 'running' && after?.id !== before.id)
        abortRunning(this.view)
    }
    destroy() {
      abortRunning(this.view)
    }
  }
)

export function aiTools(host: AiHost): Extension {
  return [
    aiPendingField,
    pendingDecorations(host),
    aiSessionField,
    appliedField,
    appliedTimeout,
    workingDecorations,
    panelTooltip(host),
    sessionWatcher,
    Prec.high(
      keymap.of([
        {
          key: 'Escape',
          run: view => closeAiActions(view),
        },
      ])
    ),
  ]
}

/** The keymap entry for the writer's AI shortcut. */
export function aiShortcut(host: AiHost, binding: string) {
  return {
    key: binding,
    preventDefault: true,
    run: (view: EditorView) => openAiActions(view, host),
  }
}
