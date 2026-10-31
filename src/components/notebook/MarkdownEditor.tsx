import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  currentMatch,
  findField,
  findNext,
  findTools,
  replaceAll as replaceAllMatches,
  replaceNext,
  revealFirst,
  setFindQuery,
} from './find'
import { FindBar, type FindControls, type FindInfo } from './FindBar'
import { createPortal, flushSync } from 'react-dom'
import {
  Compartment,
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
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { suggest } from '../../services/completion'
import {
  researchFocus,
  searchWebFacts,
  webFactsAvailable,
} from '../../services/web-facts'
import { isDesktop } from '../../services/native'
import {
  getBuiltinState,
  subscribeBuiltinState,
} from '../../services/builtin-engine'
import { STORAGE_LIMITS } from '../../services/storage'
import type {
  AiActionId,
  CursorContext,
  Note,
  NotebookSettings,
  ProviderId,
  SuggestionCandidate,
  SuggestionResult,
} from '../../types/notebook'
import {
  completionOpen,
  editorCompletions,
  type EditorAction,
  type EditorHost,
} from './editor-completions'
import { livePreview } from './live-preview'
import { refreshFlow, writingFlow, type FlowHost } from './writing-flow'
import { fetchLinkPreview } from '../../services/link-preview'
import {
  automaticAllowed,
  automaticDelay,
  newRhythm,
  noteAccepted,
  noteKeystroke,
} from './suggestion-timing'
import { linkTools, refreshLinks, type LinkHost } from './link-tools'
import {
  deleteMarkupBackward,
  insertLink,
  smartEnter,
  smartShiftTab,
  smartTab,
  toggleTask,
  wrapSelection,
} from './markdown-editing'
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
  MAX_MENU_CHOICES,
  moveSuggestionSelection,
  setSuggestionMenu,
  suggestionChoices,
  suggestionMenuExtensions,
  suggestionMenuField,
} from './suggestion-menu'

import {
  aiPendingField,
  aiShortcut,
  aiTools,
  closeAiActions,
  openAiActions,
  setAiPending,
  type AiHost,
} from './ai-actions'
import { aiEngine, runTextAction } from '../../services/text-actions'
import { shortcutSpeech } from '../../notebook/shortcuts'
import { DEFAULT_SHORTCUTS } from '../../notebook/model'
import {
  dictationAnchorField,
  dictationAnchorDecoration,
  dictationFinished,
  startDictationCapture,
  type DictationCapture,
} from './dictation-anchor'

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
  /** Research the selection (or the sentence before the cursor) on the web. */
  requestWebFacts(): void
  /** Move the cursor to a position and show it near the top of the window. */
  jumpTo(pos: number): void
  /** Open the AI actions for the selection, or run one directly. */
  openAiActions(action?: AiActionId): boolean
  /** Replace the whole note as one undoable step (restoring a version). */
  replaceDocument(text: string): boolean
  /** Open the find bar, or find and replace. */
  openFind(mode?: 'find' | 'replace'): void
}

interface MarkdownEditorProps {
  note: Note
  settings: NotebookSettings
  onChange(text: string): void
  onStatus(status: EditorStatus): void
  requestToken: number
  onCursorChange?(context: CursorContext): void
  /** All notes, for [[links]], hover previews and completion. */
  notes?: Note[]
  onOpenNote?(id: string): void
  onCreateNote?(title: string): void
  onAction?(action: EditorAction): void
  /** Full zen: typewriter scrolling and paragraph focus when allowed. */
  zenFull?: boolean
  /** Before an AI edit replaces text: a chance to keep the text as it was. */
  onBeforeAiReplace?(label: string): void
}

interface EditorControls {
  invalidate(): void
  request(provider?: ProviderId): void
  webFacts(): void
  ai: AiHost
}

const EMPTY_NOTES: Note[] = []
const livePreviewCompartment = new Compartment()
const shortcutCompartment = new Compartment()

function shortcutKeymap(
  shortcuts: NotebookSettings['shortcuts'] | undefined,
  request: () => void,
  ai: AiHost
): Extension {
  const keys = { ...DEFAULT_SHORTCUTS, ...shortcuts }
  return keymap.of([
    {
      key: keys.suggest,
      run: () => {
        request()
        return true
      },
      preventDefault: true,
      stopPropagation: true,
    },
    {
      key: keys.acceptWord,
      run: editor => acceptInlineSuggestion(editor, 'word'),
    },
    aiShortcut(ai, keys.aiActions),
  ])
}

export function openExternalUrl(url: string) {
  if (!/^(?:https?:|mailto:)/iu.test(url)) return
  if (isDesktop())
    void import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('plugin:opener|open_url', { url }).catch(() =>
        window.open(url, '_blank', 'noopener,noreferrer')
      )
    )
  else window.open(url, '_blank', 'noopener,noreferrer')
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
  const [find, setFind] = useState<{
    mode: 'find' | 'replace'
    initial: string
    token: number
  } | null>(null)
  const [findInfo, setFindInfo] = useState<FindInfo>({ index: -1, total: 0 })
  // The bar lives at the top of the scrolling page, above the writing.
  const [findHost, setFindHost] = useState<HTMLElement | null>(null)
  const findHostRef = useRef<HTMLElement | null>(null)
  const removeFindHost = () => {
    findHostRef.current?.remove()
    findHostRef.current = null
  }
  useEffect(() => removeFindHost, [])
  const findOpen = useRef(false)
  findOpen.current = find !== null
  /** Where the cursor was when the find bar opened: typing searches from here. */
  const findStart = useRef(0)
  const openFindRef = useRef<(mode: 'find' | 'replace') => void>(() => {})
  openFindRef.current = mode => {
    const view = viewRef.current
    if (!view) return
    const range = view.state.selection.main
    const selected = view.state.sliceDoc(range.from, range.to)
    const initial =
      selected && selected.length <= 200 && !selected.includes('\n')
        ? selected
        : ''
    if (!findOpen.current) findStart.current = range.from
    if (!findHostRef.current) {
      const scroller = containerRef.current?.closest('.document-scroll')
      const host = document.createElement('div')
      host.className = 'find-host'
      ;(scroller ?? containerRef.current?.parentElement)?.prepend(host)
      findHostRef.current = host
    }
    const host = findHostRef.current
    // Render now, so the field has focus before the next key arrives.
    flushSync(() => {
      setFindHost(host)
      setFind(previous => ({
        mode,
        initial,
        token: (previous?.token ?? 0) + 1,
      }))
    })
  }
  const reportFind = useRef<(view: EditorView) => void>(() => {})
  reportFind.current = view => {
    const state = view.state.field(findField)
    setFindInfo(previous => {
      const next: FindInfo = {
        index: currentMatch(view.state),
        total: state.matches.length,
        ...(state.truncated ? { truncated: true } : {}),
        ...(state.error ? { error: state.error } : {}),
      }
      return previous.index === next.index &&
        previous.total === next.total &&
        previous.error === next.error &&
        previous.truncated === next.truncated
        ? previous
        : next
    })
  }
  const findControls = useMemo<FindControls>(
    () => ({
      setQuery(query, reveal) {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ effects: setFindQuery.of(query) })
        if (query && reveal) revealFirst(view, findStart.current)
        reportFind.current(view)
      },
      next(direction) {
        const view = viewRef.current
        if (!view) return
        findNext(view, direction)
        findStart.current = view.state.selection.main.from
      },
      replace(text) {
        const view = viewRef.current
        if (view) replaceNext(view, text)
      },
      replaceAll(text) {
        const view = viewRef.current
        return view ? replaceAllMatches(view, text) : 0
      },
      close() {
        setFind(null)
        setFindHost(null)
        findHostRef.current?.remove()
        findHostRef.current = null
        const view = viewRef.current
        if (!view) return
        view.dispatch({ effects: setFindQuery.of(null) })
        view.focus()
      },
    }),
    []
  )

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
        return startDictationCapture(view, () => viewRef.current === view)
      },
      requestSuggestion: () => controlsRef.current?.request(),
      requestExternalSuggestion: provider =>
        controlsRef.current?.request(provider),
      requestWebFacts: () => controlsRef.current?.webFacts(),
      jumpTo(pos) {
        const view = viewRef.current
        if (!view) return
        const at = Math.max(0, Math.min(pos, view.state.doc.length))
        view.dispatch({
          selection: EditorSelection.cursor(at),
          effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 96 }),
        })
        view.focus()
      },
      openFind(mode = 'find') {
        openFindRef.current(mode)
      },
      replaceDocument(text) {
        const view = viewRef.current
        if (!view) return false
        const insert = normalizedDocument(text)
        const doc = view.state.doc.toString()
        if (doc === insert) return true
        // Change only the differing middle, so the cursor and scroll stay.
        let start = 0
        while (
          start < doc.length &&
          start < insert.length &&
          doc.charCodeAt(start) === insert.charCodeAt(start)
        )
          start++
        let end = 0
        while (
          end < doc.length - start &&
          end < insert.length - start &&
          doc.charCodeAt(doc.length - 1 - end) ===
            insert.charCodeAt(insert.length - 1 - end)
        )
          end++
        const update = view.state.update({
          changes: {
            from: start,
            to: doc.length - end,
            insert: insert.slice(start, insert.length - end),
          },
          annotations: [
            Transaction.userEvent.of('input.restore'),
            isolateHistory.of('full'),
          ],
          scrollIntoView: true,
        })
        if (!update.docChanged) return false
        view.dispatch(update)
        return true
      },
      openAiActions(action) {
        const view = viewRef.current
        const ai = controlsRef.current?.ai
        if (!view || !ai) return false
        view.focus()
        return openAiActions(view, ai, action)
      },
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
    let rhythm = newRhythm()

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
      if (view.state.field(aiPendingField) !== null) clearPending()
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
      // The insert menu and note completion own the keyboard while open.
      if (!manual && completionOpen(view)) return
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

      const withFacts =
        showMenu &&
        current.settings.webFacts?.withSuggestions === true &&
        webFactsAvailable(current.settings)
      const cached = freshChoices ? undefined : getCachedSuggestion(key)
      if (cached) {
        if (isCurrent()) {
          showSuggestion(cached, showMenu, manual, provider)
          if (withFacts) void appendWebFacts(context, isCurrent)
        }
        if (!withFacts) controller = null
        return
      }

      emitStatus({ state: 'loading' })
      showPending()
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
            if (showMenu && withFacts) void appendWebFacts(context, isCurrent)
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
            clearPending()
          }
        },
      })
    }

    /** The model-at-work animation at the cursor. */
    function showPending() {
      if (view.state.field(aiPendingField) !== null) return
      view.dispatch({
        effects: setAiPending.of(view.state.selection.main.head),
      })
    }

    function clearPending() {
      queueMicrotask(() => {
        if (!disposed && view.state.field(aiPendingField) !== null)
          view.dispatch({ effects: setAiPending.of(null) })
      })
    }

    /** Add cited web facts to an open choice menu when they arrive. */
    async function appendWebFacts(
      context: CursorContext,
      isCurrent: () => boolean
    ) {
      const current = propsRef.current
      try {
        const facts = await searchWebFacts(
          {
            selection: '',
            beforeCursor: context.text.slice(0, context.cursor),
            afterCursor: context.text.slice(context.cursor),
            noteTitle: current.note.title,
            objective: current.note.objective,
          },
          current.settings.webFacts,
          controller?.signal
        )
        const menu = view.state.field(suggestionMenuField)
        if (!facts.length || !isCurrent() || !menu) return
        const choices = [
          ...menu.choices.slice(
            0,
            MAX_MENU_CHOICES - Math.min(2, facts.length)
          ),
          ...facts,
        ].slice(0, MAX_MENU_CHOICES)
        const next = createSuggestionMenu(menu.at, choices, menu.provider)
        view.dispatch({
          effects: [
            setSuggestionMenu.of({ ...next, selected: menu.selected }),
            EditorView.announce.of(
              `${facts.length} web ${facts.length === 1 ? 'fact' : 'facts'} added to the choices.`
            ),
          ],
        })
      } catch {
        // Ordinary choices stay usable when web search fails.
      }
    }

    function webFacts() {
      if (view.state.field(dictationAnchorField)) return
      const current = propsRef.current
      view.focus()
      invalidate()
      if (!webFactsAvailable(current.settings)) {
        emitStatus({
          state: 'idle',
          message:
            'Turn on web facts in Preferences → Web facts to research a selection.',
        })
        return
      }
      const range = view.state.selection.main
      const selection = view.state.sliceDoc(range.from, range.to)
      // Facts are inserted after the selected text.
      if (!range.empty)
        view.dispatch({ selection: EditorSelection.cursor(range.to) })
      const context = cursorContext(view)
      if (
        !researchFocus({
          selection,
          beforeCursor: context.text.slice(0, context.cursor),
          afterCursor: '',
          noteTitle: '',
          objective: '',
        })
      ) {
        emitStatus({
          state: 'idle',
          message: 'Select text or write a sentence to research.',
        })
        return
      }
      const abort = new AbortController()
      controller = abort
      const requestRevision = revision
      const requestedDoc = view.state.doc
      const requestedSelection = view.state.selection
      const isCurrent = () =>
        !disposed &&
        !abort.signal.aborted &&
        controller === abort &&
        revision === requestRevision &&
        view.state.doc === requestedDoc &&
        view.state.selection.eq(requestedSelection)
      emitStatus({ state: 'loading', message: 'Searching the web…' })
      showPending()
      void searchWebFacts(
        {
          selection,
          beforeCursor: context.text.slice(0, context.cursor),
          afterCursor: context.text.slice(context.cursor),
          noteTitle: current.note.title,
          objective: current.note.objective,
        },
        current.settings.webFacts,
        abort.signal
      )
        .then(facts => {
          if (!isCurrent()) return
          if (!facts.length) {
            emitStatus({
              state: 'idle',
              message: 'The web search found no cited facts. Try other words.',
            })
            return
          }
          const [first, ...rest] = facts
          showSuggestion(
            { ...first!, alternatives: rest },
            true,
            true,
            'openai'
          )
        })
        .catch(error => {
          if (!isCurrent()) return
          emitStatus({
            state: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'The web search could not be completed.',
          })
        })
        .finally(() => {
          if (controller === abort) controller = null
          clearPending()
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
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      const lineBefore = view.state.sliceDoc(line.from, head)
      if (
        !automaticAllowed({
          lineBefore,
          minCharacters: settings.timing?.minCharacters ?? 0,
          documentEmpty: view.state.doc.length === 0,
        })
      )
        return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(
        () => {
          timer = null
          request(undefined, false)
        },
        automaticDelay({
          base: settings.suggestionDelay,
          adaptive: settings.timing?.adaptiveDelay === true,
          rhythm,
          now: Date.now(),
          lineBefore,
        })
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

    const editorHost: EditorHost = {
      settings: () => propsRef.current.settings.editor,
      webFacts: () => webFactsAvailable(propsRef.current.settings),
      notes: () => propsRef.current.notes ?? EMPTY_NOTES,
      noteId: () => noteId,
      runAction(action) {
        if (action === 'suggest') queueMicrotask(() => request())
        else if (action === 'web-facts') queueMicrotask(() => webFacts())
        else propsRef.current.onAction?.(action)
      },
    }
    const linkHost: LinkHost = {
      notes: () => propsRef.current.notes ?? EMPTY_NOTES,
      noteId: () => noteId,
      previews: () => propsRef.current.settings.editor?.linkPreviews ?? 'notes',
      hoverDelay: () => propsRef.current.settings.timing?.hoverDelay ?? 320,
      openNote: id => propsRef.current.onOpenNote?.(id),
      createNote: title => propsRef.current.onCreateNote?.(title),
      openUrl: openExternalUrl,
      foldLinks: () =>
        propsRef.current.settings.editor?.foldLinks !== false &&
        propsRef.current.settings.editor?.livePreview !== false,
    }

    const aiHost: AiHost = {
      engine: () => aiEngine(propsRef.current.settings),
      indicator: () => propsRef.current.settings.ai?.indicator ?? 'orb',
      run: (request, signal) =>
        runTextAction(request, propsRef.current.settings, signal),
      beforeReplace: label => propsRef.current.onBeforeAiReplace?.(label),
    }

    const editorSettings = () => propsRef.current.settings.editor
    const zenFocus = () =>
      propsRef.current.zenFull === true && editorSettings()?.zenFocus !== false
    const flowHost: FlowHost = {
      selectionToolbar: () => editorSettings()?.selectionToolbar !== false,
      typewriter: () => editorSettings()?.typewriter === true || zenFocus(),
      focus: () =>
        editorSettings()?.focus && editorSettings()!.focus !== 'off'
          ? editorSettings()!.focus
          : zenFocus()
            ? 'paragraph'
            : 'off',
      smartTypography: () => editorSettings()?.smartTypography === true,
      webFacts: () => webFactsAvailable(propsRef.current.settings),
      runWebFacts: () => queueMicrotask(() => webFacts()),
      aiAvailable: () => aiHost.engine() !== null,
      openAi: () =>
        queueMicrotask(() => {
          if (!disposed) openAiActions(view, aiHost)
        }),
      linkTitle: url =>
        editorSettings()?.linkPreviews === 'all'
          ? fetchLinkPreview(url).then(preview => preview.title ?? null)
          : Promise.resolve(null),
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
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        completeHTMLTags: false,
      }),
      markdownPresentation,
      livePreviewCompartment.of(
        propsRef.current.settings.editor?.livePreview === false
          ? []
          : livePreview()
      ),
      editorCompletions(editorHost),
      linkTools(linkHost),
      writingFlow(flowHost),
      findTools(),
      aiTools(aiHost),
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
        'aria-description': `Write in Markdown. ${shortcutSpeech(
          propsRef.current.settings.shortcuts?.suggest ??
            DEFAULT_SHORTCUTS.suggest
        )} opens suggestion choices. Up and Down choose; Tab or Enter accepts; Escape dismisses.`,
        spellcheck: 'true',
        autocapitalize: 'sentences',
      }),
      shortcutCompartment.of(
        shortcutKeymap(
          propsRef.current.settings.shortcuts,
          () => request(),
          aiHost
        )
      ),
      keymap.of([
        { key: 'ArrowDown', run: editor => moveSuggestionSelection(editor, 1) },
        { key: 'ArrowUp', run: editor => moveSuggestionSelection(editor, -1) },
        {
          key: 'Enter',
          run: editor => acceptMenuSuggestion(editor) || smartEnter(editor),
        },
        { key: 'Backspace', run: deleteMarkupBackward },
        {
          key: 'Tab',
          run: editor => acceptInlineSuggestion(editor) || smartTab(editor),
        },
        { key: 'Shift-Tab', run: smartShiftTab },
        { key: 'Mod-Enter', run: toggleTask },
        { key: 'Mod-k', run: insertLink, preventDefault: true },
        { key: 'Mod-i', run: editor => wrapSelection(editor, '*') },
        {
          key: 'Mod-Shift-k',
          run: () => {
            webFacts()
            return true
          },
          preventDefault: true,
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
          // After suggestions and menus have had their Escape.
          key: 'Escape',
          run: () => {
            if (!findOpen.current) return false
            findControls.close()
            return true
          },
        },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.domEventHandlers({
        // Find reads the physical key and refuses Shift: some layouts and
        // test drivers send a lowercase "f" with Shift held, and ⌘ ⇧ F is
        // zen mode, which must never open find.
        keydown: event => {
          const primary = /Mac|iPhone|iPad/u.test(navigator.platform)
            ? event.metaKey && !event.ctrlKey
            : event.ctrlKey && !event.metaKey
          if (!primary || event.shiftKey || event.code !== 'KeyF') return false
          event.preventDefault()
          openFindRef.current(event.altKey ? 'replace' : 'find')
          return true
        },
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
        if (
          findOpen.current &&
          (update.docChanged ||
            update.selectionSet ||
            update.startState.field(findField) !==
              update.state.field(findField))
        )
          reportFind.current(update.view)
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
          if (accepted) rhythm = noteAccepted(rhythm, Date.now())
          else if (
            update.docChanged &&
            update.transactions.some(
              transaction =>
                transaction.isUserEvent('input.type') ||
                transaction.isUserEvent('delete')
            )
          )
            rhythm = noteKeystroke(rhythm, Date.now())
          if (
            update.docChanged &&
            !external &&
            (!accepted || !update.state.field(inlineSuggestionField))
          )
            scheduleAutomatic()
          if (update.docChanged && historyNeedsTrimming(update.state))
            boundHistory()
        }
        // Phrases enter while the dictation position is held, which pauses
        // suggestions. When a dictation with words ends, suggest again.
        if (
          update.transactions.some(transaction =>
            transaction.annotation(dictationFinished)
          )
        )
          scheduleAutomatic()
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
    controlsRef.current = { invalidate, request, webFacts, ai: aiHost }
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
      closeAiActions(view, false)
      saveEditor(noteId, view)
      controlsRef.current = null
      viewRef.current = null
      view.destroy()
    }
  }, [noteId, findControls])

  useEffect(() => {
    controlsRef.current?.invalidate()
  }, [completionConfiguration, noteId])

  const livePreviewEnabled = props.settings.editor?.livePreview !== false
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: livePreviewCompartment.reconfigure(
        livePreviewEnabled ? livePreview() : []
      ),
    })
  }, [livePreviewEnabled, noteId])

  const shortcutSignature = JSON.stringify(props.settings.shortcuts ?? null)
  useEffect(() => {
    const view = viewRef.current
    const controls = controlsRef.current
    if (!view || !controls) return
    view.dispatch({
      effects: shortcutCompartment.reconfigure(
        shortcutKeymap(
          propsRef.current.settings.shortcuts,
          () => controls.request(),
          controls.ai
        )
      ),
    })
  }, [shortcutSignature, noteId])

  const flowKey = `${props.zenFull ? 1 : 0}:${props.settings.editor?.focus}:${props.settings.editor?.zenFocus}`
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshFlow.of(null) })
  }, [flowKey])

  // Restyle [[links]] when titles change; note bodies do not affect styles.
  const titles = (props.notes ?? EMPTY_NOTES).map(item => item.title).join('\n')
  const folding = `${props.settings.editor?.foldLinks !== false}:${livePreviewEnabled}`
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLinks.of(null) })
  }, [titles, folding])

  useEffect(() => {
    const view = viewRef.current
    if (!view || documentText(view.state.doc) === props.note.content) return
    const content = normalizedDocument(props.note.content)
    const current = documentText(view.state.doc)
    if (current === content) return
    // Replace only the changed span. Edits merged in from another device
    // then leave the cursor and selection where the writer is working.
    let start = 0
    const limit = Math.min(current.length, content.length)
    while (start < limit && current[start] === content[start]) start++
    let end = 0
    while (
      end < limit - start &&
      current[current.length - 1 - end] === content[content.length - 1 - end]
    )
      end++
    view.dispatch({
      changes: {
        from: start,
        to: current.length - end,
        insert: content.slice(start, content.length - end),
      },
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

  return (
    <>
      {find &&
        findHost &&
        createPortal(
          <FindBar
            mode={find.mode}
            initial={find.initial}
            focusToken={find.token}
            info={findInfo}
            controls={findControls}
          />,
          findHost
        )}
      <div className="markdown-editor" ref={containerRef} />
    </>
  )
})
