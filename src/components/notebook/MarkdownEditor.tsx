import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  EditorSelection,
  EditorState,
  StateEffect,
  Transaction,
  type Extension,
  type Text,
} from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  isolateHistory,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { suggest } from '../../services/completion'
import {
  getBuiltinState,
  subscribeBuiltinState,
} from '../../services/builtin-engine'
import { STORAGE_LIMITS } from '../../services/storage'
import type {
  CursorContext,
  Note,
  NotebookSettings,
  ProviderId,
  SuggestionCandidate,
  SuggestionResult,
} from '../../types/notebook'
import {
  acceptedSuggestionHighlight,
  acceptInlineSuggestion,
  acceptedRangeField,
  boundSerializedHistory,
  documentByteSize,
  externalDocumentUpdate,
  HISTORY_TRIM_THRESHOLD,
  HISTORY_TRIM_MIN_WORK,
  inlineSuggestionField,
  markdownPresentation,
  proposedDocumentByteSize,
  retainedHistoryWeight,
  setAcceptedRange,
  setInlineSuggestion,
  writingSurface,
} from './editor-extensions'
import {
  acceptMenuSuggestion,
  createSuggestionMenu,
  moveSuggestionSelection,
  setSuggestionMenu,
  suggestionChoices,
  suggestionMenuExtensions,
  suggestionMenuField,
} from './suggestion-menu'

import {
  dictationAnchorField,
  dictationAnchorDecoration,
  setDictationAnchor,
  spaceDictation,
  type DictationCapture,
} from './dictation-anchor'

let nextDictationId = 0

export interface EditorStatus {
  state: 'idle' | 'loading' | 'suggestion' | 'error'
  kind?: 'document'
  message?: string
  sources?: string[]
  mode?: SuggestionCandidate['mode']
  menuOpen?: boolean
  choices?: number
}

export interface MarkdownEditorHandle {
  focus(): void
  insert(text: string): void
  captureDictation(): DictationCapture
  requestSuggestion(): void
  /** Request this provider once without changing the activated suggestion mode. */
  requestExternalSuggestion(provider: ProviderId): void
}

interface MarkdownEditorProps {
  note: Note
  settings: NotebookSettings
  onChange(text: string): void
  onStatus(status: EditorStatus): void
  requestToken: number
  onCursorChange?(context: CursorContext): void
}

interface EditorControls {
  invalidate(): void
  request(provider?: ProviderId): void
}

// Restore cursor, scrolling, and undo when moving between open note tabs.
const savedEditors = new Map<
  string,
  {
    state: EditorState | null
    selection: EditorSelection
    scrollTop: number
    scrollLeft: number
    weight: number
  }
>()
const MAX_SAVED_EDITORS = 16
const MAX_SAVED_EDITOR_WEIGHT = 2_500_000
const MAX_TOTAL_EDITOR_WEIGHT = 6_000_000
let savedEditorWeight = 0
const passiveEditorExtensions: Extension[] = [
  history(),
  retainedHistoryWeight,
  documentByteSize,
]
const documentStrings = new WeakMap<Text, string>()
const identityKeys = new WeakMap<object, number>()
let nextIdentityKey = 0
const completionCache = new Map<string, SuggestionResult>()
const MAX_CACHED_SUGGESTIONS = 16
const MAX_CACHE_CHARACTERS = 500_000
let cacheCharacters = 0

// Even if a transport takes time to settle after abort, only one inference
// request can be active. Queued work is bounded to the latest request.
type CompletionJob = { signal: AbortSignal; run(): Promise<void> }
let runningCompletion = false
let queuedCompletion: CompletionJob | null = null

function enqueueCompletion(job: CompletionJob) {
  queuedCompletion = job
  if (runningCompletion) return
  void drainCompletions()
}

function cancelQueuedCompletion(signal: AbortSignal) {
  if (queuedCompletion?.signal === signal) queuedCompletion = null
}

function documentText(doc: Text) {
  let text = documentStrings.get(doc)
  if (text === undefined) {
    text = doc.toString()
    documentStrings.set(doc, text)
  }
  return text
}

/** CodeMirror uses LF internally; cached text must use the same cursor offsets. */
function normalizedDocument(text: string) {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

function identityKey(value: object) {
  let key = identityKeys.get(value)
  if (key === undefined) {
    key = ++nextIdentityKey
    identityKeys.set(value, key)
  }
  return key
}

function removeSavedEditor(id: string) {
  const saved = savedEditors.get(id)
  if (saved) savedEditorWeight -= saved.weight
  savedEditors.delete(id)
  return saved
}

function saveEditor(id: string, view: EditorView) {
  removeSavedEditor(id)
  const weight =
    view.state.doc.length +
    view.state.field(retainedHistoryWeight).characters +
    4_096
  const state =
    weight <= MAX_SAVED_EDITOR_WEIGHT
      ? view.state.update({
          effects: StateEffect.reconfigure.of(passiveEditorExtensions),
        }).state
      : null
  savedEditors.set(id, {
    state,
    selection: view.state.selection,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
    weight: state ? weight : 0,
  })
  savedEditorWeight += state ? weight : 0
  for (const saved of savedEditors.values()) {
    if (savedEditorWeight <= MAX_TOTAL_EDITOR_WEIGHT) break
    savedEditorWeight -= saved.weight
    saved.state = null
    saved.weight = 0
  }
  while (savedEditors.size > MAX_SAVED_EDITORS) {
    const oldest = savedEditors.keys().next().value as string | undefined
    if (oldest === undefined) break
    removeSavedEditor(oldest)
  }
}

async function drainCompletions() {
  runningCompletion = true
  try {
    while (queuedCompletion) {
      const job = queuedCompletion
      queuedCompletion = null
      if (!job.signal.aborted) await job.run()
    }
  } finally {
    runningCompletion = false
  }
}

function getCachedSuggestion(key: string) {
  const result = completionCache.get(key)
  if (result) {
    completionCache.delete(key)
    completionCache.set(key, result)
  }
  return result
}

function cacheSuggestion(key: string, result: SuggestionResult) {
  const resultSize = (value: SuggestionResult) =>
    [value, ...(value.alternatives ?? [])].reduce(
      (size, candidate) =>
        size +
        candidate.text.length +
        candidate.sources.reduce((size, source) => size + source.length, 0),
      0
    )
  const size = key.length + resultSize(result)
  if (size > MAX_CACHE_CHARACTERS / 2) return
  const previous = completionCache.get(key)
  if (previous) cacheCharacters -= key.length + resultSize(previous)
  completionCache.delete(key)
  completionCache.set(key, result)
  cacheCharacters += size
  while (
    completionCache.size > MAX_CACHED_SUGGESTIONS ||
    cacheCharacters > MAX_CACHE_CHARACTERS
  ) {
    const oldest = completionCache.entries().next().value as
      [string, SuggestionResult] | undefined
    if (!oldest) break
    cacheCharacters -= oldest[0].length + resultSize(oldest[1])
    completionCache.delete(oldest[0])
  }
}

function cursorContext(view: EditorView): CursorContext {
  const selection = view.state.selection
  let node = syntaxTree(view.state).resolveInner(selection.main.head, -1)
  let inCode = false
  for (;;) {
    if (/^(InlineCode|FencedCode|CodeBlock|CodeText)$/.test(node.name)) {
      inCode = true
      break
    }
    if (!node.parent) break
    node = node.parent
  }
  return {
    text: documentText(view.state.doc),
    cursor: selection.main.head,
    selectionEmpty: selection.ranges.length === 1 && selection.main.empty,
    ...(inCode ? { inCode: true } : {}),
  }
}

function requestSettings(settings: NotebookSettings, override?: ProviderId) {
  // Legacy workspaces may remember a cloud profile without deliberate automatic
  // activation. One-off requests are explicit; routine inference uses this guard.
  const provider =
    override ??
    (settings.provider === 'local' || settings.externalAutoEnabled
      ? settings.provider
      : 'local')
  return { ...settings, provider }
}

type CompletionConfiguration = readonly (string | number | boolean)[]

/** Compare source values without serializing entire reference files on every render. */
function configurationSnapshot(
  note: Note,
  settings: NotebookSettings
): CompletionConfiguration {
  const sources = note.sources.filter(source => source.enabled)
  return [
    note.title,
    note.objective,
    note.context,
    settings.provider,
    settings.externalAutoEnabled,
    settings.localEngine,
    settings.suggestionInstructions,
    settings.temperature,
    settings.maxTokens,
    settings.suggestionLength,
    settings.suggestionsEnabled,
    settings.autoSuggest,
    settings.suggestionDelay,
    ...Object.values(settings.profiles).flatMap(profile => [
      profile.endpoint,
      profile.model,
      profile.protocol,
    ]),
    sources.length,
    ...sources.flatMap(source => [
      source.id,
      source.name,
      source.kind,
      source.text,
    ]),
  ]
}

function completionKey(
  noteId: string,
  doc: Text,
  context: CursorContext,
  configuration: CompletionConfiguration,
  provider: ProviderId,
  engineIdentity: string
) {
  return JSON.stringify([
    noteId,
    identityKey(doc),
    identityKey(configuration),
    context.cursor,
    context.selectionEmpty,
    !!context.inCode,
    provider,
    engineIdentity,
  ])
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const controlsRef = useRef<EditorControls | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const noteId = props.note.id
  const lastRequestToken = useRef(props.requestToken)

  const nextConfiguration = configurationSnapshot(props.note, props.settings)
  const configurationRef = useRef(nextConfiguration)
  if (
    nextConfiguration.length !== configurationRef.current.length ||
    nextConfiguration.some(
      (value, index) => value !== configurationRef.current[index]
    )
  )
    configurationRef.current = nextConfiguration
  const completionConfiguration = configurationRef.current

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      insert(text) {
        const view = viewRef.current
        if (!text) return
        if (!view)
          throw new Error(
            'The note editor is no longer open. Reopen the note and try inserting again.'
          )
        const insertion = view.state.update({
          ...view.state.replaceSelection(text),
          annotations: [
            Transaction.userEvent.of('input.paste'),
            isolateHistory.of('full'),
          ],
          scrollIntoView: true,
        })
        if (!insertion.docChanged)
          throw new Error(
            'This note can hold up to 8 MiB. Insert the transcript into another note; your existing writing is unchanged.'
          )
        view.focus()
        view.dispatch(insertion)
      },
      captureDictation() {
        const view = viewRef.current
        if (!view) throw new Error('Open a note before dictating.')
        if (!view.state.selection.main.empty)
          throw new Error('Place the cursor where you want to dictate.')
        controlsRef.current?.invalidate()
        const id = ++nextDictationId
        view.focus()
        view.dispatch({
          effects: setDictationAnchor.of({
            id,
            at: view.state.selection.main.head,
            phase: 'listening',
          }),
        })
        const anchor = (requirePosition = true) => {
          const value =
            viewRef.current === view
              ? view.state.field(dictationAnchorField)
              : null
          if (
            !value ||
            value.id !== id ||
            (requirePosition && value.at === null)
          )
            throw new Error(
              'The dictation position changed. Place the cursor and insert your transcript below.'
            )
          return value
        }
        return {
          cancel() {
            if (
              viewRef.current === view &&
              view.state.field(dictationAnchorField)?.id === id
            )
              view.dispatch({ effects: setDictationAnchor.of(null) })
          },
          transcribing() {
            // Finish recognition even if typing removed the insertion point.
            // A later commit failure keeps the transcript available for recovery.
            const value = anchor(false)
            view.dispatch({
              effects: setDictationAnchor.of({
                ...value,
                phase: 'transcribing',
              }),
            })
          },
          commit(text) {
            const value = anchor()
            const at = value.at!
            const inserted = spaceDictation(
              text,
              view.state.sliceDoc(Math.max(0, at - 1), at),
              view.state.sliceDoc(at, at + 1)
            )
            if (!inserted)
              throw new Error('No words were heard. Try recording again.')
            const transaction = view.state.update({
              changes: { from: at, insert: inserted },
              selection: EditorSelection.cursor(at + inserted.length),
              effects: setDictationAnchor.of(null),
              annotations: [
                Transaction.userEvent.of('input.dictation'),
                isolateHistory.of('full'),
              ],
              scrollIntoView: true,
            })
            if (!transaction.docChanged)
              throw new Error(
                'This note is full. Keep your transcript below and insert it into a shorter note.'
              )
            view.focus()
            view.dispatch(transaction)
          },
        }
      },
      requestSuggestion: () => controlsRef.current?.request(),
      requestExternalSuggestion: provider =>
        controlsRef.current?.request(provider),
    }),
    []
  )

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false
    let revision = 0
    let composing = false
    let compositionEdited = false
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let trimmingHistory = false
    let offeredBlankStarter = false
    let lastStatus: EditorStatus = { state: 'idle' }

    function emitStatus(status: EditorStatus) {
      if (disposed || propsRef.current.note.id !== noteId) return
      if (JSON.stringify(lastStatus) === JSON.stringify(status)) return
      lastStatus = status
      propsRef.current.onStatus(status)
    }

    function invalidate(clearGhost = true) {
      revision += 1
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (controller) {
        cancelQueuedCompletion(controller.signal)
        controller.abort()
      }
      controller = null
      if (clearGhost) {
        const oldSuggestion = view.state.field(inlineSuggestionField)
        const oldMenu = view.state.field(suggestionMenuField)
        // CodeMirror disallows dispatch from inside its update listener. Only
        // clear this particular ghost; a fresh cache result may arrive first.
        if (oldSuggestion || oldMenu) {
          queueMicrotask(() => {
            if (
              !disposed &&
              view.state.field(inlineSuggestionField) === oldSuggestion &&
              view.state.field(suggestionMenuField) === oldMenu
            ) {
              view.dispatch({
                effects: [
                  setInlineSuggestion.of(null),
                  setSuggestionMenu.of(null),
                ],
              })
            }
          })
        }
      }
      emitStatus({ state: 'idle' })
    }

    function showSuggestion(
      result: SuggestionResult,
      showMenu: boolean,
      manual: boolean,
      provider: ProviderId,
      requestedChoices = false
    ) {
      const choices = suggestionChoices(result)
      const first = choices[0]
      if (!first) {
        emitStatus({
          state: 'idle',
          ...(manual
            ? {
                message:
                  provider === 'local'
                    ? 'Try a new line for a writing starter, or connect a local model in Preferences.'
                    : 'The model returned no continuation. Try another cursor position or adjust your instructions.',
              }
            : {}),
        })
        return
      }
      const at = view.state.selection.main.head
      const menu = showMenu ? createSuggestionMenu(at, choices, provider) : null
      view.dispatch({
        effects: [
          setInlineSuggestion.of({ at, ...first }),
          setSuggestionMenu.of(menu),
          EditorView.announce.of(
            `Suggested continuation: ${first.text.trim()}\n${menu ? `${choices.length} ${choices.length === 1 ? 'choice' : 'choices'}. Press Up or Down Arrow to choose. Press Enter to accept. ` : ''}Press Tab to accept. Press Control or Command plus Right Arrow for one word. Press Escape to dismiss.`
          ),
        ],
      })
      emitSuggestionStatus(
        requestedChoices && choices.length < 2
          ? 'The model returned one distinct choice. Press Ctrl or Command + Space to try again.'
          : undefined
      )
    }

    function emitSuggestionStatus(message?: string) {
      const ghost = view.state.field(inlineSuggestionField)
      const menu = view.state.field(suggestionMenuField)
      emitStatus(
        ghost
          ? {
              state: 'suggestion',
              sources: ghost.sources,
              mode: ghost.mode,
              menuOpen: !!menu,
              choices: menu?.choices.length ?? 1,
              ...(message ? { message } : {}),
            }
          : { state: 'idle' }
      )
    }

    function request(override?: ProviderId, manual = true) {
      if (view.state.field(dictationAnchorField)) return
      if (manual) view.focus()
      // Focusing an empty page may schedule its initial automatic starter.
      // A manual request owns this interaction and cancels that focus timer.
      invalidate()
      const current = propsRef.current
      const settings = requestSettings(current.settings, override)
      const provider = settings.provider
      const showMenu = manual && override === undefined
      const freshChoices =
        showMenu &&
        provider !== 'local' &&
        settings.profiles[provider].protocol !== 'fim'
      const context = cursorContext(view)
      if (
        disposed ||
        current.note.id !== noteId ||
        !view.hasFocus ||
        view.dom.ownerDocument.visibilityState === 'hidden' ||
        view.composing ||
        view.compositionStarted ||
        composing
      ) {
        return
      }
      if (!settings.suggestionsEnabled) {
        if (manual)
          emitStatus({
            state: 'idle',
            message: 'Suggestions are paused. Turn on suggestions to continue.',
          })
        return
      }
      if (!context.selectionEmpty) {
        if (manual) {
          emitStatus({
            state: 'idle',
            message: 'Place your cursor where you would like a suggestion.',
          })
        }
        return
      }
      // Local mode may use private offline context recall without a model.
      if (provider !== 'local' && !settings.profiles[provider].model.trim()) {
        emitStatus({
          state: 'error',
          message: 'Choose a model in settings first.',
        })
        return
      }

      const requestConfiguration = configurationRef.current
      const engineIdentity =
        provider === 'local' && settings.localEngine === 'embedded'
          ? getBuiltinState().identity
          : ''
      const key = completionKey(
        noteId,
        view.state.doc,
        context,
        requestConfiguration,
        provider,
        engineIdentity
      )
      const requestRevision = revision
      const requestedDoc = view.state.doc
      const requestedSelection = view.state.selection
      const abort = new AbortController()
      controller = abort
      function isCurrent() {
        const latest = propsRef.current
        return (
          !disposed &&
          !abort.signal.aborted &&
          controller === abort &&
          revision === requestRevision &&
          latest.note.id === noteId &&
          latest.settings.suggestionsEnabled &&
          view.hasFocus &&
          view.dom.ownerDocument.visibilityState !== 'hidden' &&
          !composing &&
          !view.composing &&
          !view.compositionStarted &&
          view.state.doc === requestedDoc &&
          view.state.selection.eq(requestedSelection) &&
          (!engineIdentity || getBuiltinState().identity === engineIdentity) &&
          configurationRef.current === requestConfiguration
        )
      }

      const cached = freshChoices ? undefined : getCachedSuggestion(key)
      if (cached) {
        if (isCurrent()) showSuggestion(cached, showMenu, manual, provider)
        controller = null
        return
      }

      emitStatus({ state: 'loading' })
      enqueueCompletion({
        signal: abort.signal,
        async run() {
          try {
            if (!isCurrent()) return
            const note = { ...current.note, content: context.text }
            const result = await (freshChoices
              ? suggest(note, context, settings, abort.signal, {
                  purpose: 'alternatives',
                })
              : suggest(note, context, settings, abort.signal))
            if (!isCurrent()) return
            if (!freshChoices) cacheSuggestion(key, result)
            showSuggestion(result, showMenu, manual, provider, freshChoices)
          } catch (error) {
            if (!isCurrent()) return
            emitStatus({
              state: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : 'The suggestion could not be completed.',
            })
          } finally {
            if (controller === abort) controller = null
          }
        },
      })
    }

    function scheduleAutomatic() {
      if (view.state.field(dictationAnchorField)) return
      const { settings } = propsRef.current
      if (
        disposed ||
        !settings.suggestionsEnabled ||
        !settings.autoSuggest ||
        !view.hasFocus ||
        view.dom.ownerDocument.visibilityState === 'hidden' ||
        composing ||
        view.composing ||
        view.compositionStarted
      ) {
        return
      }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(
        () => {
          timer = null
          request(undefined, false)
        },
        Math.max(300, settings.suggestionDelay)
      )
    }

    function boundHistory() {
      if (trimmingHistory) return
      trimmingHistory = true
      queueMicrotask(() => {
        trimmingHistory = false
        if (
          disposed ||
          composing ||
          view.composing ||
          !historyNeedsTrimming(view.state)
        )
          return
        const snapshot = view.state.toJSON({ history: historyField }) as {
          doc: string
          selection: unknown
          history: unknown
        }
        const bounded = boundSerializedHistory(snapshot.history)
        snapshot.history = bounded.history
        const ghost = view.state.field(inlineSuggestionField)
        const accepted = view.state.field(acceptedRangeField)
        const scrollTop = view.scrollDOM.scrollTop
        const scrollLeft = view.scrollDOM.scrollLeft
        const hadTimer = timer !== null
        invalidate(false)
        let state = EditorState.fromJSON(
          snapshot,
          {
            extensions: [
              ...extensions,
              retainedHistoryWeight.init(() => ({
                characters: bounded.weight,
                changes: 0,
              })),
            ],
          },
          { history: historyField }
        )
        documentStrings.set(state.doc, snapshot.doc)
        state = state.update({
          effects: [
            setInlineSuggestion.of(ghost),
            setSuggestionMenu.of(null),
            setAcceptedRange.of(accepted),
          ],
        }).state
        view.setState(state)
        view.scrollDOM.scrollTop = scrollTop
        view.scrollDOM.scrollLeft = scrollLeft
        if (ghost) emitSuggestionStatus()
        if (hadTimer) scheduleAutomatic()
      })
    }

    function historyNeedsTrimming(state: EditorState) {
      const weight = state.field(retainedHistoryWeight)
      return (
        weight.characters > HISTORY_TRIM_THRESHOLD &&
        weight.changes > HISTORY_TRIM_MIN_WORK
      )
    }

    const extensions: Extension[] = [
      dictationAnchorField,
      dictationAnchorDecoration,
      history(),
      retainedHistoryWeight,
      documentByteSize,
      EditorState.transactionFilter.of(transaction => {
        if (
          !transaction.docChanged ||
          proposedDocumentByteSize(transaction) <= STORAGE_LIMITS.noteBytes
        )
          return transaction
        queueMicrotask(() => {
          if (disposed) return
          invalidate()
          emitStatus({
            state: 'error',
            kind: 'document',
            message:
              'This note can hold up to 8 MiB. Put this text in another note; your existing writing is unchanged.',
          })
        })
        return []
      }),
      markdown(),
      markdownPresentation,
      writingSurface,
      EditorView.lineWrapping,
      highlightSpecialChars(),
      drawSelection(),
      inlineSuggestionField,
      suggestionMenuExtensions,
      acceptedSuggestionHighlight,
      placeholder('Start with your own words…'),
      EditorView.contentAttributes.of({
        'aria-label': 'Note content',
        'aria-multiline': 'true',
        'aria-description':
          'Write in Markdown. Control or Command plus Space opens suggestion choices. Up and Down choose; Tab or Enter accepts; Escape dismisses.',
        spellcheck: 'true',
        autocapitalize: 'sentences',
      }),
      keymap.of([
        { key: 'ArrowDown', run: editor => moveSuggestionSelection(editor, 1) },
        { key: 'ArrowUp', run: editor => moveSuggestionSelection(editor, -1) },
        { key: 'Enter', run: acceptMenuSuggestion },
        { key: 'Tab', run: acceptInlineSuggestion },
        {
          key: 'Mod-ArrowRight',
          run: editor => acceptInlineSuggestion(editor, 'word'),
        },
        {
          key: 'Escape',
          run: (): boolean => {
            const active: boolean = !!(
              controller ||
              timer !== null ||
              view.state.field(inlineSuggestionField) ||
              view.state.field(suggestionMenuField)
            )
            if (active) invalidate()
            return active
          },
        },
        {
          key: 'Mod-Space',
          run: () => {
            request()
            return true
          },
          preventDefault: true,
          stopPropagation: true,
        },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({
        focus: () => {
          // A focused empty page can offer one quiet starter after the normal
          // pause. Revisiting existing writing never triggers an idle request.
          if (!offeredBlankStarter && view.state.doc.length === 0) {
            offeredBlankStarter = true
            scheduleAutomatic()
          }
          return false
        },
        blur: () => {
          invalidate()
          return false
        },
        compositionstart: () => {
          composing = true
          compositionEdited = false
          invalidate()
          return false
        },
        compositionend: () => {
          composing = false
          if (historyNeedsTrimming(view.state)) boundHistory()
          if (compositionEdited) scheduleAutomatic()
          compositionEdited = false
          return false
        },
      }),
      EditorView.updateListener.of(update => {
        const external = update.transactions.some(transaction =>
          transaction.annotation(externalDocumentUpdate)
        )
        if (update.docChanged || update.selectionSet) {
          invalidate(false)
          if (update.docChanged && composing) compositionEdited = true
          const context = cursorContext(update.view)
          if (update.docChanged && !external) {
            propsRef.current.onChange(context.text)
          }
          propsRef.current.onCursorChange?.(context)
          const accepted = update.transactions.some(transaction =>
            transaction.isUserEvent('input.complete')
          )
          if (
            update.docChanged &&
            !external &&
            (!accepted || !update.state.field(inlineSuggestionField))
          )
            scheduleAutomatic()
          if (update.docChanged && historyNeedsTrimming(update.state))
            boundHistory()
        }
        const previous = update.startState.field(inlineSuggestionField)
        const next = update.state.field(inlineSuggestionField)
        const previousMenu = update.startState.field(suggestionMenuField)
        const nextMenu = update.state.field(suggestionMenuField)
        if (previous !== next || previousMenu !== nextMenu)
          emitSuggestionStatus()
      }),
    ]

    const cachedEditor = removeSavedEditor(noteId)
    const content = normalizedDocument(propsRef.current.note.content)
    const state: EditorState =
      cachedEditor?.state && documentText(cachedEditor.state.doc) === content
        ? cachedEditor.state.update({
            effects: [
              StateEffect.reconfigure.of(extensions),
              setInlineSuggestion.of(null),
              setSuggestionMenu.of(null),
              setAcceptedRange.of(null),
            ],
          }).state
        : EditorState.create({
            doc: content,
            selection: EditorSelection.cursor(
              Math.min(cachedEditor?.selection.main.head ?? 0, content.length)
            ),
            extensions,
          })
    const view: EditorView = new EditorView({
      state,
      parent: containerRef.current,
    })
    viewRef.current = view
    documentStrings.set(view.state.doc, content)
    controlsRef.current = { invalidate, request }
    const document = view.dom.ownerDocument
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') invalidate()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    let builtinIdentity = getBuiltinState().identity
    const unsubscribeBuiltin = subscribeBuiltinState(() => {
      const identity = getBuiltinState().identity
      if (identity === builtinIdentity) return
      builtinIdentity = identity
      const settings = propsRef.current.settings
      if (
        requestSettings(settings).provider === 'local' &&
        settings.localEngine === 'embedded'
      )
        invalidate()
    })
    if (cachedEditor) {
      view.scrollDOM.scrollTop = cachedEditor.scrollTop
      view.scrollDOM.scrollLeft = cachedEditor.scrollLeft
    }
    propsRef.current.onCursorChange?.(cursorContext(view))
    propsRef.current.onStatus({ state: 'idle' })

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibilityChanged)
      unsubscribeBuiltin()
      revision += 1
      if (controller) {
        cancelQueuedCompletion(controller.signal)
        controller.abort()
      }
      if (timer !== null) clearTimeout(timer)
      saveEditor(noteId, view)
      controlsRef.current = null
      viewRef.current = null
      view.destroy()
    }
  }, [noteId])

  useEffect(() => {
    controlsRef.current?.invalidate()
  }, [completionConfiguration, noteId])

  useEffect(() => {
    const view = viewRef.current
    if (!view || documentText(view.state.doc) === props.note.content) return
    const content = normalizedDocument(props.note.content)
    if (documentText(view.state.doc) === content) return
    const cursor = Math.min(view.state.selection.main.head, content.length)
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      selection: EditorSelection.cursor(cursor),
      annotations: [
        externalDocumentUpdate.of(true),
        Transaction.addToHistory.of(false),
      ],
    })
    documentStrings.set(view.state.doc, content)
  }, [props.note.content, noteId])

  useEffect(() => {
    if (lastRequestToken.current !== props.requestToken) {
      lastRequestToken.current = props.requestToken
      controlsRef.current?.request()
    }
  }, [props.requestToken, noteId])

  return <div className="markdown-editor" ref={containerRef} />
})
