import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { EditorView } from '@codemirror/view'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Cloud,
  FileText,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  Keyboard,
  Pencil,
  Tags,
  LoaderCircle,
  Maximize2,
  Minus,
  Moon,
  Mic,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  X,
  Paperclip,
  Link as LinkIcon,
  Save,
  Waypoints,
  X as Close,
} from 'lucide-react'
import {
  MarkdownEditor,
  type EditorStatus,
  type MarkdownEditorHandle,
} from './components/notebook/MarkdownEditor'
import { useNotebook } from './notebook/useNotebook'
import {
  closeNote,
  FONTS,
  newNote,
  openNote,
  PROVIDERS,
  relativeDate,
  titleFromContent,
  UNTITLED,
  wordCount,
} from './notebook/model'
import { ZenMenu } from './notebook/ZenMenu'
import {
  activeHeading,
  addWordsToday,
  LinkedFrom,
  NoteOutline,
  outlineOf,
  WritingStats,
  wordsToday,
} from './notebook/WritingAids'
import { backlinks } from './notebook/note-links'
import { HuggingFaceGuide } from './notebook/HuggingFaceGuide'
import { GitSyncStatus } from './notebook/GitSyncStatus'
import {
  CommandPalette,
  type PaletteAction,
  type PaletteHeading,
} from './notebook/CommandPalette'
import { tableTemplate } from './components/notebook/markdown-editing'
import { syncNow, useGitSync } from './notebook/useGitSync'
import { UpdateNotice, useAutoUpdates } from './notebook/UpdateNotice'
import {
  checkForUpdates,
  registerUpdateSaver,
  updatesAvailable,
} from './services/updater'
import {
  NoteTree,
  type DragPayload,
  type DropTarget,
} from './notebook/organize/NoteTree'
import { Menu, type MenuItem } from './notebook/organize/Menu'
import { TagStrip, type TagStripHandle } from './notebook/organize/TagStrip'
import { TagManager } from './notebook/organize/TagManager'
import {
  childFolders,
  counts as organizeCounts,
  createFolder,
  deleteFolder,
  deleteTag,
  ensureTag,
  folderAndDescendants,
  folderPath,
  moveFolder,
  moveNotes,
  renameFolder,
  renameTag,
  setFolderCollapsed,
  setFolderColor,
  setNoteTag,
  setTagColor,
} from './notebook/organize/organize'
import './notebook/organize/organize.css'
import {
  activeSpace,
  createSpace,
  deleteSpace,
  moveToSpace,
  setContextSpaces,
  spaceCounts,
  spaceGitFolder,
  spaceList,
  spaceOf,
  spaceView,
  switchSpace,
  updateSpace,
} from './notebook/spaces/spaces'
import {
  SpaceAvatar,
  WorkspaceSwitcher,
} from './notebook/spaces/WorkspaceSwitcher'
import { WorkspaceManager } from './notebook/spaces/WorkspaceManager'
import { useRevisions } from './notebook/revisions/useRevisions'
import { addRevision, deleteNoteRevisions } from './notebook/revisions/store'
import { AI_ACTIONS, aiEngine } from './services/text-actions'
import { installEmbeddingRuntime } from './services/embedding-runtime'
import { installSpeechRuntime } from './services/speech-runtime'
import { downloadBuiltinModel } from './services/builtin-engine'
import { downloadWhistleModel } from './services/whistle'
import { mediaKind, importMediaFile } from './services/media-sources'
import {
  focusSemanticStatus,
  prepareSemanticIndex,
} from './services/semantic-retrieval'
import type { ZenLevel } from './types/notebook'
import { Modal } from './notebook/Modal'
import { ContextPanel } from './notebook/ContextPanel'
import { ModelChooser } from './notebook/ModelChooser'
import {
  InlineDictation,
  type InlineDictationHandle,
} from './notebook/InlineDictation'
import { ContextLibrary } from './notebook/ContextLibrary'
import {
  addDemoWorkspace,
  DEMO_DOWNLOAD_PATH,
  DEMO_NOTE_ID,
  DEMO_STARTER,
  hasDemoNote,
} from './notebook/demo'
import {
  contextFolder,
  findLibrarySource,
  libraryReference,
  newContextPackage,
  pruneContextLibrary,
} from './notebook/context-library'
import {
  linkNoteSource,
  resolveNoteContext,
  stripLinkedText,
  resolvedContextBudget,
} from './notebook/note-context'
import type { PreferencePane } from './notebook/preferences/types'

// Opened rarely: load on first use so the writing space starts sooner.
const Preferences = lazy(() =>
  import('./notebook/Preferences').then(module => ({
    default: module.Preferences,
  }))
)
const NoteGraph = lazy(() =>
  import('./notebook/NoteGraph').then(module => ({ default: module.NoteGraph }))
)
const RevisionHistory = lazy(() =>
  import('./notebook/revisions/RevisionHistory').then(module => ({
    default: module.RevisionHistory,
  }))
)
import { applyPalette } from './notebook/palette'
import { isDesktop } from './services/native'
import {
  assertWorkspaceFits,
  openMarkdownFile,
  saveMarkdownFile,
  STORAGE_LIMITS,
} from './services/storage'
import { importContextFile, importWebsite } from './services/sources'
import type {
  ContextSource,
  Note,
  OrganizeColor,
  Workspace,
} from './types/notebook'
import './App.css'
import './app-shell.css'
import './notebook/ai-pulse.css'
import { AiPulse } from './notebook/AiPulse'
import { shortcutText } from './notebook/shortcuts'

const MAX_STORED_CONTEXT_CHARACTERS = 2_000_000
const BRAND_ICON_URL = `${import.meta.env.BASE_URL}Icon.png`
// macOS shows native traffic lights at the top left of a transparent title bar.
const MAC_DESKTOP =
  isDesktop() &&
  /Mac/iu.test(
    typeof navigator === 'undefined'
      ? ''
      : navigator.platform || navigator.userAgent
  )
const MAC_KEYS =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/iu.test(navigator.platform || navigator.userAgent)
const SUPPORTED_SOURCE =
  /\.(txt|text|md|markdown|mdown|pdf|docx|png|jpe?g|webp|gif|bmp|wav|mp3|m4a|aac|ogg|flac|mp4|m4v|webm|mov)$/i

export function displayTitle(note: Pick<Note, 'title'>) {
  return note.title.trim() || UNTITLED
}

/**
 * An untitled note takes its title from its first line. A title the writer
 * types ends this; clearing the title starts it again.
 */
function autoTitlePatch(note: Note, patch: Partial<Note>): Partial<Note> {
  if (patch.title !== undefined)
    return patch.title.trim()
      ? { autoTitle: undefined }
      : { autoTitle: true, title: titleFromContent(note.content) }
  if (note.autoTitle && patch.content !== undefined)
    return { title: titleFromContent(patch.content) || UNTITLED }
  return {}
}

function App() {
  const {
    workspace,
    setWorkspace,
    loading,
    loadError,
    saveNow,
    saveStatus,
    storageError,
    hasUnsavedChanges,
    getWorkspace,
    waitForPendingSave,
  } = useNotebook()
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [preferencePane, setPreferencePane] =
    useState<PreferencePane>('writing')
  const [sidebarVisible, setSidebarVisible] = useState(
    () => window.innerWidth >= 760
  )
  const [contextVisible, setContextVisible] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryPackageId, setLibraryPackageId] = useState<string | undefined>()
  const pendingSampleFocus = useRef<{ atEnd: boolean } | null>(null)
  const [websitePackageId, setWebsitePackageId] = useState<string | undefined>()
  const dictationRef = useRef<InlineDictationHandle>(null)
  const [dictationActive, setDictationActive] = useState(false)
  const [dictationRecovery, setDictationRecovery] = useState<string | null>(
    null
  )
  const [focusMode, setFocusMode] = useState(false)
  const [revealChrome, setRevealChrome] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  if (historyOpen && !historyLoaded) setHistoryLoaded(true)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [rootDrop, setRootDrop] = useState(false)
  const [menu, setMenu] = useState<{
    kind: 'note' | 'folder' | 'move'
    id: string
    anchor: HTMLElement
  } | null>(null)
  const tagStrip = useRef<TagStripHandle>(null)
  // Keep a lazy dialog mounted after its first use, so it can animate closed.
  const [preferencesLoaded, setPreferencesLoaded] = useState(false)
  const [graphLoaded, setGraphLoaded] = useState(false)
  if (preferencesOpen && !preferencesLoaded) setPreferencesLoaded(true)
  if (graphOpen && !graphLoaded) setGraphLoaded(true)
  const focusModeRef = useRef(focusMode)
  focusModeRef.current = focusMode
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEditorFocus = useRef(false)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<EditorStatus>({ state: 'idle' })
  const [darkAppearance, setDarkAppearance] = useState(false)
  const [notice, setNotice] = useState('')
  const [requestToken, setRequestToken] = useState(0)
  const [websiteOpen, setWebsiteOpen] = useState(false)
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const importController = useRef<AbortController | null>(null)
  const [externalOpen, setExternalOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState('')
  const [recoveryActionError, setRecoveryActionError] = useState('')
  const closeInProgress = useRef(false)
  const fileSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const fileAutosaveStarted = useRef<number | null>(null)
  const fileAutosaveRunning = useRef(false)
  const [fileSaveEpoch, setFileSaveEpoch] = useState(0)
  const nativeHandlers = useRef<Record<string, () => void>>({})
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const recentSearch = useRef<HTMLInputElement>(null)
  const storedNote = useMemo(
    () => workspace.notes.find(item => item.id === workspace.activeNoteId),
    [workspace.notes, workspace.activeNoteId]
  )
  const note = useMemo(
    () =>
      storedNote
        ? resolveNoteContext(
            storedNote,
            workspace.notes,
            workspace.contextLibrary,
            workspace.contextPackages,
            workspace.folders
          )
        : undefined,
    [
      storedNote,
      workspace.notes,
      workspace.folders,
      workspace.contextLibrary,
      workspace.contextPackages,
    ]
  )
  const settings = workspace.settings
  const demoInstalled = useMemo(() => hasDemoNote(workspace), [workspace])
  const font = FONTS.find(item => item.name === settings.fontFamily) ?? FONTS[0]
  const hasLocalModel =
    settings.localEngine === 'embedded' ||
    (settings.localEngine === 'server' &&
      Boolean(settings.profiles.local.model.trim()))
  const usingExternal =
    settings.provider !== 'local' && settings.externalAutoEnabled
  const suggestKeys = shortcutText(settings.shortcuts.suggest)
  const wordKeys = shortcutText(settings.shortcuts.acceptWord)
  // What the open workspace sees: its own items and those of shared ones.
  const view = useMemo(() => spaceView(workspace), [workspace])
  const spaces = useMemo(() => spaceList(workspace), [workspace])
  const multipleSpaces = spaces.length > 1
  const currentSpace = view.active
  const ownedByActive = useCallback(
    (item: { id: string }) =>
      !multipleSpaces || view.owner.get(item.id) === currentSpace.id,
    [multipleSpaces, view, currentSpace.id]
  )
  const folders = view.folders
  const tags = view.tags
  const activeNotes = useMemo(
    () => view.notes.filter(ownedByActive),
    [view.notes, ownedByActive]
  )
  const activeFolders = useMemo(
    () => folders.filter(ownedByActive),
    [folders, ownedByActive]
  )
  const sharedSections = useMemo(
    () =>
      spaces
        .filter(space => space.shared && space.id !== currentSpace.id)
        .map(space => ({
          space,
          notes: view.notes.filter(
            item => view.owner.get(item.id) === space.id
          ),
          folders: folders.filter(item => view.owner.get(item.id) === space.id),
        })),
    [spaces, currentSpace.id, view, folders]
  )
  const [collapsedShared, setCollapsedShared] = useState<Set<string>>(
    () => new Set()
  )
  const [managerOpen, setManagerOpen] = useState<string | null>(null)
  const [switching, setSwitching] = useState(0)
  useEffect(() => {
    if (!switching) return
    const timer = setTimeout(() => setSwitching(0), 320)
    return () => clearTimeout(timer)
  }, [switching])
  const latestNote = useMemo(
    () =>
      view.notes.reduce<Note | undefined>(
        (newest, item) =>
          !newest || item.updatedAt > newest.updatedAt ? item : newest,
        undefined
      ),
    [view.notes]
  )
  const counts = useMemo(() => spaceCounts(workspace), [workspace])
  const gitSpaces = useMemo(
    () =>
      new Set(
        spaces
          .filter(space => spaceGitFolder(workspace, space))
          .map(space => space.id)
      ),
    [spaces, workspace]
  )
  /** The workspace id a new item belongs to, stored only with workspaces. */
  const newItemSpace = useCallback(
    (folderId?: string) => {
      const current = getWorkspace()
      if (!current.spaces?.length) return undefined
      const folder = folderId
        ? current.folders?.find(item => item.id === folderId)
        : undefined
      return folder ? spaceOf(current, folder) : activeSpace(current).id
    },
    [getWorkspace]
  )
  const organization = useMemo(() => organizeCounts(workspace), [workspace])
  const activeFolderPath = useMemo(
    () => folderPath(folders, storedNote?.folderId),
    [folders, storedNote?.folderId]
  )
  // A filter for a deleted tag ends quietly.
  if (tagFilter && !tags.some(tag => tag.id === tagFilter)) setTagFilter(null)
  // Counting a long note on every key would compete with typing, so the
  // count follows a short pause. Switching notes counts at once.
  const [countedContent, setCountedContent] = useState(note?.content ?? '')
  const countedNote = useRef(note?.id)
  useEffect(() => {
    const content = note?.content ?? ''
    if (countedNote.current !== note?.id) {
      countedNote.current = note?.id
      setCountedContent(content)
      return
    }
    const timer = setTimeout(() => setCountedContent(content), 400)
    return () => clearTimeout(timer)
  }, [note?.content, note?.id])
  const activeWordCount = useMemo(
    () => wordCount(countedContent),
    [countedContent]
  )
  // Words written today: growth of each note's count while you write.
  const [todayWords, setTodayWords] = useState(wordsToday)
  const countedWords = useRef<{ id?: string; words: number }>({ words: 0 })
  useEffect(() => {
    const previous = countedWords.current
    countedWords.current = { id: note?.id, words: activeWordCount }
    if (
      previous.id &&
      previous.id === note?.id &&
      activeWordCount > previous.words
    )
      setTodayWords(addWordsToday(activeWordCount - previous.words))
  }, [activeWordCount, note?.id])
  // The outline and backlinks follow the same pause as the word count.
  const headings = useMemo(() => outlineOf(countedContent), [countedContent])
  const headingsRef = useRef(headings)
  headingsRef.current = headings
  const [activeHeadingIndex, setActiveHeadingIndex] = useState(-1)
  const [linkedFrom, setLinkedFrom] = useState<Note[]>([])
  useEffect(() => {
    const current = getWorkspace()
    const target = current.notes.find(item => item.id === note?.id)
    setLinkedFrom(target ? backlinks(target, current.notes) : [])
  }, [
    countedContent,
    note?.id,
    note?.title,
    workspace.notes.length,
    getWorkspace,
  ])
  const selectedForDeletion = workspace.notes.find(item => item.id === deleteId)
  const notesVisible = sidebarVisible && !focusMode
  const toggleNotes = useCallback(() => {
    setSidebarVisible(!notesVisible)
    if (window.innerWidth <= 760) setContextVisible(false)
    setFocusMode(false)
  }, [notesVisible])

  const toggleContext = useCallback(() => {
    setContextVisible(value => !value)
    if (window.innerWidth <= 760) setSidebarVisible(false)
    setFocusMode(false)
  }, [])

  const notify = useCallback((message: string) => setNotice(message), [])
  const focusSample = useCallback(() => {
    const pending = pendingSampleFocus.current
    if (!pending || getWorkspace().activeNoteId !== DEMO_NOTE_ID) return
    const content = document.querySelector('.document-page .cm-content')
    const view = content ? EditorView.findFromDOM(content as HTMLElement) : null
    if (!view) return
    pendingSampleFocus.current = null
    if (pending.atEnd)
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      })
    editorRef.current?.focus()
  }, [getWorkspace])
  useEffect(() => {
    if (
      pendingSampleFocus.current &&
      note?.id === DEMO_NOTE_ID &&
      !libraryOpen &&
      !document.querySelector('[role="dialog"]')
    )
      focusSample()
  }, [note?.id, libraryOpen, focusSample])
  useEffect(() => {
    const recovered = () =>
      notify(
        'Recovered your last valid save. The damaged original is preserved.'
      )
    window.addEventListener('typenext:workspace-recovered', recovered)
    return () =>
      window.removeEventListener('typenext:workspace-recovered', recovered)
  }, [notify])
  useEffect(() => () => importController.current?.abort(), [])
  const showPreferences = useCallback((pane: PreferencePane = 'writing') => {
    setPreferencePane(pane)
    setPreferencesOpen(true)
  }, [])
  const updateNote = useCallback(
    (id: string, patch: Partial<Note>) => {
      setWorkspace(value => ({
        ...value,
        notes: value.notes.map(item =>
          item.id === id
            ? {
                ...item,
                ...patch,
                ...autoTitlePatch(item, patch),
                ...(patch.sources
                  ? { sources: stripLinkedText(patch.sources) }
                  : {}),
                updatedAt: Math.max(
                  Date.now(),
                  item.updatedAt + 1,
                  (item.exportedAt ?? 0) + 1
                ),
              }
            : item
        ),
      }))
    },
    [setWorkspace]
  )
  const selectNote = useCallback(
    (item: Note) => {
      setWorkspace(value => openNote(value, item))
      setStatus({ state: 'idle' })
      if (window.innerWidth < 760) setSidebarVisible(false)
    },
    [setWorkspace]
  )

  /** Create a note at once. Title and intent can be set later. */
  const createNote = useCallback(
    (title = '', folderId?: string, spaceId?: string) => {
      try {
        const space = spaceId ?? newItemSpace(folderId)
        const created = {
          ...newNote(title),
          ...(folderId ? { folderId } : {}),
          ...(space ? { spaceId: space } : {}),
        }
        setWorkspace(value => {
          const next = openNote(value, created)
          assertWorkspaceFits(next)
          return next
        })
        setStatus({ state: 'idle' })
        pendingEditorFocus.current = true
        if (window.innerWidth < 760) setSidebarVisible(false)
        return created.id
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
        return null
      }
    },
    [notify, setWorkspace, newItemSpace]
  )
  /** Organising changes: folders and tags. A failed change explains itself. */
  const organize = useCallback(
    (change: (value: Workspace) => Workspace) => {
      try {
        setWorkspace(value => {
          const next = change(value)
          if (next !== value) assertWorkspaceFits(next)
          return next
        })
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
      }
    },
    [notify, setWorkspace]
  )
  const newFolder = useCallback(
    (parentId?: string) => {
      let created: string | null = null
      organize(value => {
        const result = createFolder(value, '', parentId, newItemSpace())
        created = result.folder.id
        return result.workspace
      })
      if (created) {
        setSearch('')
        setTagFilter(null)
        setSidebarVisible(true)
        setRenamingFolder(created)
      }
    },
    [organize, newItemSpace]
  )
  const onRenameFolder = useCallback(
    (id: string, name: string | null | undefined) => {
      if (name === undefined) {
        setRenamingFolder(id)
        return
      }
      setRenamingFolder(current => (current === id ? null : current))
      if (name !== null) organize(value => renameFolder(value, id, name))
    },
    [organize]
  )
  const onToggleFolder = useCallback(
    (id: string) =>
      organize(value =>
        setFolderCollapsed(
          value,
          id,
          !value.folders?.find(folder => folder.id === id)?.collapsed
        )
      ),
    [organize]
  )
  const onDropItem = useCallback(
    (target: DropTarget, payload: DragPayload) => {
      organize(value =>
        payload.kind === 'note'
          ? moveNotes(value, [payload.id], target.folderId)
          : moveFolder(value, payload.id, target.folderId)
      )
      // Show where the item went.
      if (target.folderId)
        organize(value => setFolderCollapsed(value, target.folderId!, false))
    },
    [organize]
  )
  const toggleNoteTag = useCallback(
    (noteId: string, tagId: string, on: boolean) =>
      organize(value => setNoteTag(value, noteId, tagId, on)),
    [organize]
  )
  const createTagFor = useCallback(
    (noteId: string | null, name: string) =>
      organize(value => {
        // Tags are found among the ones this workspace can see, and a new
        // tag joins the note's workspace.
        const note = noteId
          ? value.notes.find(item => item.id === noteId)
          : undefined
        const seen = spaceView(value)
        const result = ensureTag(value, name, undefined, {
          ...(value.spaces?.length
            ? {
                spaceId: note ? spaceOf(value, note) : activeSpace(value).id,
              }
            : {}),
          visible: tag => seen.tags.some(item => item.id === tag.id),
        })
        return noteId
          ? setNoteTag(result.workspace, noteId, result.tag.id, true)
          : result.workspace
      }),
    [organize]
  )
  const switchWorkspace = useCallback(
    (id: string) => {
      if (getWorkspace().activeSpaceId === id) return
      setWorkspace(value => switchSpace(value, id))
      setSearch('')
      setTagFilter(null)
      setStatus({ state: 'idle' })
      setSwitching(Date.now())
    },
    [getWorkspace, setWorkspace]
  )
  const newWorkspace = useCallback(
    (name: string, shared: boolean, open = true) => {
      let id: string | null = null
      organize(value => {
        const result = createSpace(value, name, { shared })
        id = result.space.id
        // Its first context list and its tabs start empty.
        return result.workspace
      })
      if (id && open && !shared) switchWorkspace(id)
      else if (id)
        notify(
          shared
            ? 'Shared workspace created. It appears in every workspace.'
            : 'Workspace created.'
        )
      return id
    },
    [organize, switchWorkspace, notify]
  )
  /** Move notes or folders to a workspace; tabs that leave it close. */
  const moveToWorkspace = useCallback(
    (items: { notes?: string[]; folders?: string[] }, spaceId: string) => {
      organize(value => {
        const moved = moveToSpace(value, items, spaceId)
        const visible = new Set(spaceView(moved).notes.map(note => note.id))
        return moved.openNoteIds.every(id => visible.has(id))
          ? moved
          : moved.openNoteIds
              .filter(id => !visible.has(id))
              .reduce((next, id) => closeNote(next, id), moved)
      })
      const target = spaceList(getWorkspace()).find(
        space => space.id === spaceId
      )
      if (target) notify(`Moved to ${target.name}.`)
    },
    [organize, getWorkspace, notify]
  )
  const openNoteMenu = useCallback(
    (id: string, anchor: HTMLElement) => setMenu({ kind: 'note', id, anchor }),
    []
  )
  const openFolderMenu = useCallback(
    (id: string, anchor: HTMLElement) =>
      setMenu({ kind: 'folder', id, anchor }),
    []
  )
  const openNoteById = useCallback(
    (id: string) => {
      const target = getWorkspace().notes.find(item => item.id === id)
      if (target) selectNote(target)
    },
    [getWorkspace, selectNote]
  )
  useEffect(() => {
    if (!pendingEditorFocus.current || !note) return
    pendingEditorFocus.current = false
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [note?.id, note])

  useGitSync(workspace, getWorkspace, setWorkspace, notify)
  useAutoUpdates(settings.updates)
  const noteById = useCallback(
    (id: string) => getWorkspace().notes.find(item => item.id === id),
    [getWorkspace]
  )
  const { saveRevision, safetyCopy } = useRevisions({
    note: storedNote,
    settings: settings.revisions,
    noteById,
    notify,
  })
  const saveVersion = useCallback(
    async (label?: string) => {
      if (!getWorkspace().settings.revisions.enabled) {
        notify('Turn on revisions in Preferences → History to save versions.')
        return null
      }
      const saved = await saveRevision(label)
      notify(saved ? 'Version saved.' : 'This version is already saved.')
      return saved
    },
    [getWorkspace, notify, saveRevision]
  )
  /** Restore a version or merge parts of it, keeping the text before. */
  const replaceFromHistory = useCallback(
    async (
      text: string,
      how: { kind: 'restore' | 'merge'; revision: { createdAt: number } }
    ) => {
      const active = storedNote
      if (!active) return
      const at = new Date(how.revision.createdAt).toLocaleTimeString(
        undefined,
        { hour: 'numeric', minute: '2-digit' }
      )
      await safetyCopy(
        active.id,
        how.kind === 'restore'
          ? `Before restoring ${at}`
          : `Before bringing back parts of ${at}`
      )
      if (!editorRef.current?.replaceDocument(text))
        updateNote(active.id, { content: text })
      const current = getWorkspace().settings.revisions
      await addRevision({
        noteId: active.id,
        title: active.title,
        text,
        kind: how.kind,
        reason:
          how.kind === 'restore'
            ? `Restored the version from ${at}`
            : `Brought back parts of ${at}`,
        keep: current.keep,
      }).catch(() => null)
    },
    [storedNote, safetyCopy, updateNote, getWorkspace]
  )
  // Installing an update ends this process, so every edit must be on disk.
  const saveForUpdate = useCallback(async () => {
    await saveNow()
    await waitForPendingSave()
    await saveNow()
  }, [saveNow, waitForPendingSave])
  useEffect(() => {
    registerUpdateSaver(saveForUpdate)
    return () => registerUpdateSaver(null)
  }, [saveForUpdate])

  const zenLevel: ZenLevel = settings.zenLevel ?? 'chrome'
  const enterZen = useCallback(
    (level?: ZenLevel) => {
      if (level && level !== getWorkspace().settings.zenLevel)
        setWorkspace(value => ({
          ...value,
          settings: { ...value.settings, zenLevel: level },
        }))
      setFocusMode(true)
      setRevealChrome(false)
    },
    [getWorkspace, setWorkspace]
  )
  // Full screen follows the full zen level on desktop and in browsers.
  useEffect(() => {
    const full = focusMode && zenLevel === 'full'
    if (isDesktop()) {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(full))
        .catch(() => undefined)
    } else if (full && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined)
    } else if (!full && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined)
    }
  }, [focusMode, zenLevel])
  useEffect(() => {
    if (!focusMode || isDesktop()) return
    // Leaving browser full screen with the browser's own key leaves zen too.
    const left = () => {
      if (!document.fullscreenElement && zenLevel === 'full')
        setFocusMode(false)
    }
    document.addEventListener('fullscreenchange', left)
    return () => document.removeEventListener('fullscreenchange', left)
  }, [focusMode, zenLevel])
  useEffect(() => {
    if (!focusMode) return
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"], [role="menu"]')
      )
        setFocusMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode])
  const trackEdges = (event: React.MouseEvent) => {
    if (!focusMode || zenLevel === 'sidebars') return
    const nearEdge =
      event.clientY < 18 || event.clientY > window.innerHeight - 18
    const inChrome = (event.target as HTMLElement).closest(
      '.app-toolbar, .note-tabs, .suggestion-bar, .editor-footer, .zen-exit'
    )
    if (nearEdge || inChrome) {
      if (revealTimer.current) clearTimeout(revealTimer.current)
      revealTimer.current = null
      if (!revealChrome) setRevealChrome(true)
    } else if (revealChrome && !revealTimer.current) {
      revealTimer.current = setTimeout(() => {
        revealTimer.current = null
        setRevealChrome(false)
      }, 700)
    }
  }
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current)
    },
    []
  )

  useEffect(() => {
    focusSemanticStatus(note?.id ?? null)
  }, [note?.id])
  useEffect(() => {
    if (!note || !settings.semantic.enabled) return
    // Index after typing pauses; unchanged passages are never embedded again.
    const timer = setTimeout(() => {
      void prepareSemanticIndex(note, getWorkspace().settings)
    }, settings.timing.indexDelay)
    return () => clearTimeout(timer)
  }, [note, settings.semantic, settings.timing.indexDelay, getWorkspace])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
      applyPalette(document.documentElement, settings, dark)
      setDarkAppearance(dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings])
  useEffect(() => {
    if (
      status.kind === 'document' &&
      status.state === 'error' &&
      status.message
    )
      notify(status.message)
  }, [status.kind, status.state, status.message, notify])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(timer)
  }, [notice])
  const activeTitle = note ? displayTitle(note) : undefined
  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} · TypeNext` : 'TypeNext'
  }, [activeTitle])

  const openFile = useCallback(async () => {
    try {
      const file = await openMarkdownFile()
      if (!file) return
      const existing = file.path
        ? getWorkspace().notes.find(item => item.filePath === file.path)
        : undefined
      if (existing) {
        selectNote(existing)
        return
      }
      const created = newNote(
        file.name.replace(/\.(md|markdown|txt)$/i, ''),
        '',
        file.content,
        file.path
      )
      setWorkspace(value => {
        const next = openNote(value, created)
        assertWorkspaceFits(next)
        return next
      })
      setStatus({ state: 'idle' })
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }, [notify, selectNote, setWorkspace, getWorkspace])

  const writeNoteFile = useCallback((snapshot: Note, saveAs = false) => {
    const task = fileSaveQueue.current
      .catch(() => undefined)
      .then(() => saveMarkdownFile(snapshot, saveAs))
    fileSaveQueue.current = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }, [])

  const exportNote = useCallback(
    async (saveAs = false) => {
      try {
        await saveNow()
        const current = getWorkspace()
        const active = current.notes.find(
          item => item.id === current.activeNoteId
        )
        if (!active) return
        const result = await writeNoteFile(active, saveAs)
        if (!result) return
        setWorkspace(value => ({
          ...value,
          notes: value.notes.map(item =>
            item.id === active.id
              ? {
                  ...item,
                  ...(result.path ? { filePath: result.path } : {}),
                  exportedAt:
                    item.content === active.content
                      ? item.updatedAt
                      : Math.min(active.updatedAt, item.updatedAt - 1),
                }
              : item
          ),
        }))
        notify(
          result.path
            ? 'Markdown file saved.'
            : 'Markdown downloaded. Your notebook is saved locally.'
        )
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error))
      }
    },
    [notify, saveNow, setWorkspace, writeNoteFile, getWorkspace]
  )

  useEffect(() => {
    if (!settings.autoSave || !isDesktop() || loading || loadError) {
      fileAutosaveStarted.current = null
      return
    }
    const dirtyFiles = workspace.notes.filter(
      item => item.filePath && item.updatedAt > (item.exportedAt ?? 0)
    )
    if (!dirtyFiles.length) {
      fileAutosaveStarted.current = null
      return
    }
    fileAutosaveStarted.current ??= Date.now()
    if (fileAutosaveRunning.current || closeInProgress.current) return
    const delay = Math.max(
      0,
      Math.min(1000, 2000 - (Date.now() - fileAutosaveStarted.current))
    )
    const timer = setTimeout(() => {
      fileAutosaveStarted.current = null
      fileAutosaveRunning.current = true
      void (async () => {
        let failed = false
        try {
          // Keep one active batch; queued edits are read when the next save begins.
          const ids = getWorkspace()
            .notes.filter(
              item => item.filePath && item.updatedAt > (item.exportedAt ?? 0)
            )
            .map(item => item.id)
          for (const id of ids) {
            if (closeInProgress.current) break
            const item = getWorkspace().notes.find(current => current.id === id)
            if (!item?.filePath || item.updatedAt <= (item.exportedAt ?? 0))
              continue
            try {
              const result = await writeNoteFile(item)
              if (result)
                setWorkspace(value => {
                  const current = value.notes.find(note => note.id === id)
                  if (
                    !current ||
                    current.content !== item.content ||
                    current.filePath !== item.filePath ||
                    current.exportedAt === current.updatedAt
                  )
                    return value
                  return {
                    ...value,
                    notes: value.notes.map(note =>
                      note.id === id
                        ? { ...note, exportedAt: note.updatedAt }
                        : note
                    ),
                  }
                })
            } catch (error) {
              failed = true
              notify(
                `Could not autosave the Markdown file: ${error instanceof Error ? error.message : String(error)}`
              )
              break
            }
          }
        } finally {
          fileAutosaveRunning.current = false
          // Retry newer edits after a completed batch. A failed file waits for
          // another edit or manual save rather than polling a broken disk.
          if (!failed && !closeInProgress.current)
            setFileSaveEpoch(value => value + 1)
        }
      })()
    }, delay)
    return () => clearTimeout(timer)
  }, [
    workspace.notes,
    settings.autoSave,
    loading,
    loadError,
    notify,
    setWorkspace,
    writeNoteFile,
    getWorkspace,
    fileSaveEpoch,
  ])

  const finishClose = useCallback(
    async (save: boolean) => {
      if (closeInProgress.current) return
      closeInProgress.current = true
      setClosing(true)
      setCloseError('')
      setCloseOpen(true)
      try {
        importController.current?.abort()
        await fileSaveQueue.current
        await waitForPendingSave().catch(() => undefined)
        if (save && !loadError && !loading) {
          const dirty = getWorkspace().notes.filter(
            item => item.filePath && item.updatedAt > (item.exportedAt ?? 0)
          )
          for (const item of dirty) await writeNoteFile(item)
          await saveNow()
        }
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('exit_app')
      } catch (error) {
        setCloseError(error instanceof Error ? error.message : String(error))
        setClosing(false)
        closeInProgress.current = false
      }
    },
    [
      loadError,
      loading,
      saveNow,
      writeNoteFile,
      getWorkspace,
      waitForPendingSave,
    ]
  )

  const requestClose = useCallback(() => {
    if (
      !loadError &&
      !loading &&
      !getWorkspace().settings.autoSave &&
      hasUnsavedChanges()
    ) {
      setCloseOpen(true)
      return
    }
    void finishClose(!loadError && !loading)
  }, [finishClose, loadError, loading, hasUnsavedChanges, getWorkspace])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        !event.shiftKey &&
        !document.querySelector('[role="dialog"]')
      ) {
        // Option changes the character on macOS, so read the key's position.
        if (event.code === 'KeyS') {
          event.preventDefault()
          void paletteRefs.current.saveVersion()
          return
        }
        if (event.code === 'KeyH') {
          event.preventDefault()
          if (getWorkspace().settings.revisions.enabled) setHistoryOpen(true)
          else showPreferences('history')
          return
        }
        if (event.code === 'KeyF') {
          event.preventDefault()
          editorRef.current?.openFind('replace')
          return
        }
        // ⌘ ⌥ 1–9 opens a workspace, in the switcher's order.
        const digit = /^Digit([1-9])$/u.exec(event.code)?.[1]
        if (digit) {
          const all = spaceList(getWorkspace())
          const ordered = [
            ...all.filter(space => !space.shared),
            ...all.filter(space => space.shared),
          ]
          const target = ordered[Number(digit) - 1]
          if (target) {
            event.preventDefault()
            paletteRefs.current.switchWorkspace(target.id)
          }
          return
        }
      }
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey
      )
        return
      const key = event.key.toLowerCase()
      if (document.querySelector('[role="dialog"]')) {
        if (
          ['n', 'o', 's', ',', 'b', 'p'].includes(key) ||
          (['f', 'g'].includes(key) && event.shiftKey)
        )
          event.preventDefault()
        return
      }
      if (key === 'n') {
        event.preventDefault()
        createNote()
      } else if (key === 'o') {
        event.preventDefault()
        void openFile()
      } else if (key === 's') {
        event.preventDefault()
        void exportNote(event.shiftKey)
      } else if (key === ',') {
        event.preventDefault()
        showPreferences()
      } else if (key === 'b') {
        event.preventDefault()
        toggleNotes()
      } else if (key === 'f' && !event.shiftKey) {
        event.preventDefault()
        editorRef.current?.openFind('find')
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        if (focusModeRef.current) setFocusMode(false)
        else enterZen()
      } else if (key === 'g' && event.shiftKey) {
        event.preventDefault()
        setGraphOpen(true)
      } else if (key === 'p') {
        event.preventDefault()
        setPaletteOpen(value => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    openFile,
    exportNote,
    showPreferences,
    toggleNotes,
    createNote,
    enterZen,
    getWorkspace,
  ])

  nativeHandlers.current = {
    'menu-new-note': () => {
      createNote()
    },
    'menu-open': () => {
      void openFile()
    },
    'menu-save': () => {
      void exportNote()
    },
    'menu-preferences': () => showPreferences(),
    'menu-toggle-left-sidebar': toggleNotes,
    'menu-toggle-right-sidebar': () => {
      toggleContext()
      setFocusMode(false)
    },
    'native-close-requested': requestClose,
  }

  useEffect(() => {
    if (!isDesktop()) return
    const cleanup: (() => void)[] = []
    let disposed = false
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        for (const name of Object.keys(nativeHandlers.current)) {
          const stop = await listen(name, () =>
            nativeHandlers.current[name]?.()
          )
          if (disposed) stop()
          else cleanup.push(stop)
        }
      })
      .catch(error => notify(String(error)))
    return () => {
      disposed = true
      cleanup.forEach(stop => stop())
    }
  }, [notify])

  const windowAction = async (action: 'minimize' | 'maximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const current = getCurrentWindow()
      if (action === 'minimize') await current.minimize()
      else if (action === 'maximize') await current.toggleMaximize()
      else requestClose()
    } catch (error) {
      notify(String(error))
    }
  }

  const checkContextBudgets = (value: Workspace, previous: Workspace) => {
    const beforeById = new Map(previous.notes.map(item => [item.id, item]))
    for (const item of value.notes) {
      const before = beforeById.get(item.id)
      if (
        (item.contextPackageIds?.length ?? 0) > 64 &&
        (item.contextPackageIds?.length ?? 0) >
          (before?.contextPackageIds?.length ?? 0)
      )
        throw new Error(
          'A note can attach up to 64 contexts. Detach one before adding another.'
        )
      const budget = resolvedContextBudget(
        item,
        value.notes,
        value.contextLibrary,
        value.contextPackages,
        value.folders
      )
      // A live note can grow after attachment. Always allow removal or an
      // unchanged budget so a writer can reduce an already large context.
      const priorBudget = before
        ? resolvedContextBudget(
            before,
            previous.notes,
            previous.contextLibrary,
            previous.contextPackages,
            previous.folders
          )
        : { sources: 0, characters: 0 }
      if (
        (budget.sources > STORAGE_LIMITS.sourcesPerNote &&
          budget.sources > priorBudget.sources) ||
        (budget.characters > MAX_STORED_CONTEXT_CHARACTERS &&
          budget.characters > priorBudget.characters)
      )
        throw new Error(
          `“${item.title}” would have too much context. Detach a package or use smaller excerpts.`
        )
    }
    assertWorkspaceFits(value)
  }
  const changePackage = (operation: (value: Workspace) => Workspace) => {
    try {
      setWorkspace(value => {
        const next = operation(value)
        checkContextBudgets(next, value)
        return next
      })
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }
  const openSample = () => {
    if (importing) return
    try {
      const fresh = !hasDemoNote(getWorkspace())
      setWorkspace(value => {
        const next = addDemoWorkspace(value)
        checkContextBudgets(next, value)
        return next
      })
      pendingSampleFocus.current = { atEnd: fresh }
      setStatus({ state: 'idle' })
      if (window.innerWidth < 760) {
        setSidebarVisible(false)
        setContextVisible(false)
      }
      setLibraryOpen(false)
      notify('Sample opened.')
      if (!libraryOpen && getWorkspace().activeNoteId === note?.id)
        focusSample()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }
  const createPackage = (name: string) => {
    const current = getWorkspace()
    if ((current.contextPackages?.length ?? 0) >= 256) {
      notify('You can keep up to 256 context packages.')
      return null
    }
    const created = {
      ...newContextPackage(name),
      // A new context starts in the workspace it was made in.
      ...(current.spaces?.length
        ? { spaceIds: [activeSpace(current).id] }
        : {}),
    }
    try {
      setWorkspace(value => {
        const next = {
          ...value,
          contextPackages: [...(value.contextPackages ?? []), created],
        }
        assertWorkspaceFits(next)
        return next
      })
      return created.id
    } catch (error) {
      notify(String(error))
      return null
    }
  }
  const renamePackage = (id: string, name: string) =>
    changePackage(value => ({
      ...value,
      contextPackages: value.contextPackages?.map(item =>
        item.id === id ? { ...item, name, updatedAt: Date.now() } : item
      ),
    }))
  const removePackage = (id: string) =>
    changePackage(value => {
      const packages =
        value.contextPackages?.filter(item => item.id !== id) ?? []
      const notes = value.notes.map(item =>
        item.contextPackageIds?.includes(id)
          ? {
              ...item,
              contextPackageIds: item.contextPackageIds.filter(
                key => key !== id
              ),
              updatedAt: Date.now(),
            }
          : item
      )
      return {
        ...value,
        notes,
        contextPackages: packages,
        contextLibrary: pruneContextLibrary(
          value.contextLibrary ?? [],
          notes,
          packages
        ),
      }
    })
  const attachPackage = (id: string) =>
    changePackage(value => ({
      ...value,
      notes: value.notes.map(item =>
        item.id === value.activeNoteId && !item.contextPackageIds?.includes(id)
          ? {
              ...item,
              contextPackageIds: [...(item.contextPackageIds ?? []), id],
              updatedAt: Date.now(),
            }
          : item
      ),
    }))
  const detachPackage = (id: string) =>
    changePackage(value => ({
      ...value,
      notes: value.notes.map(item =>
        item.id === value.activeNoteId
          ? {
              ...item,
              contextPackageIds: item.contextPackageIds?.filter(
                key => key !== id
              ),
              updatedAt: Date.now(),
            }
          : item
      ),
    }))
  const removePackageSource = (packageId: string, sourceId: string) =>
    changePackage(value => {
      const packages =
        value.contextPackages?.map(item =>
          item.id === packageId
            ? {
                ...item,
                sourceIds: item.sourceIds.filter(id => id !== sourceId),
                updatedAt: Date.now(),
              }
            : item
        ) ?? []
      return {
        ...value,
        contextPackages: packages,
        contextLibrary: pruneContextLibrary(
          value.contextLibrary ?? [],
          value.notes,
          packages
        ),
      }
    })
  const appendContext = (
    activeId: string | null,
    source: ContextSource,
    packageId?: string
  ) => {
    let added = false
    setWorkspace(value => {
      const library = value.contextLibrary ?? []
      const existing = findLibrarySource(library, source)
      const canonical = existing ?? {
        ...source,
        libraryId: undefined,
        enabled: true,
      }
      if (!existing && library.length >= 2048)
        throw new Error(
          'Your library has 2,048 references. Remove unused references before adding more.'
        )
      if (packageId) {
        const target = value.contextPackages?.find(
          item => item.id === packageId
        )
        if (!target)
          throw new Error(
            'This context was removed. Choose another context and import again.'
          )
        const ids = target.sourceIds.includes(canonical.id)
          ? target.sourceIds
          : [...target.sourceIds, canonical.id]
        if (ids.length > 256)
          throw new Error(
            'A context can contain up to 256 references. Create another context for these files.'
          )
        const next = {
          ...value,
          contextLibrary: existing ? library : [...library, canonical],
          contextPackages: value.contextPackages!.map(item =>
            item.id === packageId
              ? { ...item, sourceIds: ids, updatedAt: Date.now() }
              : item
          ),
        }
        checkContextBudgets(next, value)
        added = true
        return next
      }
      const active = value.notes.find(item => item.id === activeId)
      const attach =
        active &&
        !(canonical.kind === 'note' && canonical.linkedNoteId === active.id) &&
        !active.sources.some(
          item =>
            item.libraryId === canonical.id ||
            (canonical.kind === 'note' &&
              item.linkedNoteId === canonical.linkedNoteId)
        )
      const reenable = active?.sources.some(
        item => item.libraryId === canonical.id && !item.enabled
      )
      const sources = attach
        ? [...active.sources, libraryReference(canonical)]
        : reenable
          ? active?.sources.map(item =>
              item.libraryId === canonical.id
                ? { ...item, enabled: true }
                : item
            )
          : active?.sources
      const nextLibrary = existing ? library : [...library, canonical]
      if (sources && sources.length > STORAGE_LIMITS.sourcesPerNote)
        throw new Error(
          'This note has too many references. Remove one before attaching another.'
        )
      if (
        active &&
        sources &&
        resolveNoteContext(
          { ...active, sources },
          value.notes,
          nextLibrary
        ).sources.reduce(
          (total, item) =>
            total + (item.kind === 'note' ? 0 : item.text.length),
          0
        ) > MAX_STORED_CONTEXT_CHARACTERS
      )
        throw new Error(
          'These references are too large for one note. Choose smaller excerpts or detach a reference.'
        )
      const next = {
        ...value,
        contextLibrary: nextLibrary,
        notes:
          attach || reenable
            ? value.notes.map(item =>
                item.id === activeId
                  ? {
                      ...item,
                      sources: sources!,
                      updatedAt: Math.max(
                        Date.now(),
                        item.updatedAt + 1,
                        (item.exportedAt ?? 0) + 1
                      ),
                    }
                  : item
              )
            : value.notes,
      }
      checkContextBudgets(next, value)
      added = true
      return next
    })
    return added
  }
  const addSources = async (files: FileList | null, packageId?: string) => {
    const activeId = getWorkspace().activeNoteId
    if (!files?.length) return
    const selectedFiles = Array.from(files).filter(
      file => !file.webkitRelativePath || SUPPORTED_SOURCE.test(file.name)
    )
    if (!selectedFiles.length) {
      notify(
        'This folder has no supported text, Markdown, PDF, Word, image, audio or video files.'
      )
      return
    }
    if (selectedFiles.length > 256) {
      notify(
        'Choose up to 256 files at a time. Split a large folder into smaller selections.'
      )
      return
    }
    if (importController.current) {
      notify('A reference is still being read. Try again when it finishes.')
      return
    }
    const controller = new AbortController()
    importController.current = controller
    setImporting(true)
    try {
      for (const file of selectedFiles) {
        if (controller.signal.aborted) break
        try {
          const imported = mediaKind(file)
            ? await importMediaFile(file, getWorkspace().settings.semantic, {
                signal: controller.signal,
              })
            : await importContextFile(file, controller.signal)
          const source = { ...imported, folder: contextFolder(file) }
          if (
            !controller.signal.aborted &&
            !appendContext(activeId, source, packageId)
          )
            controller.abort()
        } catch (error) {
          if (controller.signal.aborted) break
          notify(
            `${file.name}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    } finally {
      if (importController.current === controller)
        importController.current = null
      setImporting(false)
    }
  }

  const addWebsite = async () => {
    const activeId = getWorkspace().activeNoteId
    if (importController.current) return
    const controller = new AbortController()
    importController.current = controller
    setImporting(true)
    try {
      const source = await importWebsite(
        websiteUrl,
        settings,
        controller.signal
      )
      if (controller.signal.aborted) return
      appendContext(activeId, source, websitePackageId)
      setWebsiteOpen(false)
      if (websitePackageId) {
        setLibraryPackageId(websitePackageId)
        setLibraryOpen(true)
      }
      setWebsiteUrl('')
    } catch (error) {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : String(error))
    } finally {
      if (importController.current === controller)
        importController.current = null
      setImporting(false)
    }
  }

  const useNoteAsContext = (id: string, packageId?: string) => {
    const current = getWorkspace()
    const target = current.notes.find(item => item.id === id)
    if (!target) return
    try {
      appendContext(current.activeNoteId, linkNoteSource(target), packageId)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }

  const paletteRefs = useRef({
    openFile,
    exportNote,
    toggleNotes,
    toggleContext,
    showPreferences,
    createNote,
    enterZen,
    openSample,
    newFolder,
    saveVersion,
    switchWorkspace,
  })
  paletteRefs.current = {
    openFile,
    exportNote,
    toggleNotes,
    toggleContext,
    showPreferences,
    createNote,
    enterZen,
    openSample,
    newFolder,
    saveVersion,
    switchWorkspace,
  }
  const gitEnabled = settings.git.enabled
  const webFactsOn = settings.webFacts.enabled
  const revisionsOn = settings.revisions.enabled
  const aiOn = aiEngine(settings) !== null
  const suggestBinding = settings.shortcuts.suggest
  const aiBinding = settings.shortcuts.aiActions
  const spaceSignature = spaces
    .map(space => `${space.id}\u0000${space.name}\u0000${space.shared ? 1 : 0}`)
    .join('\u0001')
  const currentSpaceId = currentSpace.id
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const run = paletteRefs
    const mac = MAC_KEYS
    const key = (value: string) => (mac ? `⌘ ${value}` : `Ctrl ${value}`)
    const pane = (
      id: PreferencePane,
      title: string,
      keywords: string[] = []
    ): PaletteAction => ({
      id: `prefs-${id}`,
      title: `Preferences: ${title}`,
      section: 'Preferences',
      keywords: ['settings', ...keywords],
      run: () => run.current.showPreferences(id),
    })
    const actions: PaletteAction[] = [
      {
        id: 'new-note',
        title: 'New note',
        section: 'Actions',
        shortcut: key('N'),
        keywords: ['create', 'add'],
        run: () => run.current.createNote(),
      },
      {
        id: 'suggest',
        title: 'Suggest at the cursor',
        section: 'Actions',
        shortcut: shortcutText(suggestBinding),
        keywords: ['ai', 'complete', 'continue'],
        run: () => editorRef.current?.requestSuggestion(),
      },
      ...AI_ACTIONS.map((action, index): PaletteAction => ({
        id: `ai-${action.id}`,
        title: `AI: ${action.label} the selection`,
        section: 'Actions',
        shortcut: index === 0 ? shortcutText(aiBinding) : undefined,
        keywords: ['ai', 'edit', action.hint.toLocaleLowerCase()],
        disabled: !aiOn,
        run: () => {
          editorRef.current?.focus()
          editorRef.current?.openAiActions(action.id)
        },
      })),
      {
        id: 'history',
        title: 'Open history',
        section: 'Actions',
        shortcut: key('Alt H'),
        keywords: ['revisions', 'versions', 'diff', 'restore', 'undo'],
        disabled: !revisionsOn,
        run: () => setHistoryOpen(true),
      },
      {
        id: 'save-version',
        title: 'Save this version',
        section: 'Actions',
        shortcut: key('Alt S'),
        keywords: ['revision', 'snapshot', 'checkpoint', 'history'],
        disabled: !revisionsOn,
        run: () => void run.current.saveVersion(),
      },
      ...spaceSignature
        .split('\u0001')
        .filter(Boolean)
        .map((entry): PaletteAction => {
          const [id, name] = entry.split('\u0000')
          return {
            id: `space-${id}`,
            title: `Workspace: ${name}`,
            section: 'Go to',
            keywords: ['workspace', 'switch', 'profile', 'space'],
            disabled: id === currentSpaceId,
            run: () => run.current.switchWorkspace(id!),
          }
        }),
      {
        id: 'new-workspace',
        title: 'New workspace',
        section: 'Actions',
        keywords: ['workspace', 'profile', 'space', 'create'],
        run: () => setManagerOpen('new'),
      },
      {
        id: 'manage-workspaces',
        title: 'Manage workspaces',
        section: 'Actions',
        keywords: ['workspace', 'shared', 'git', 'repository'],
        run: () => setManagerOpen(''),
      },
      {
        id: 'new-folder',
        title: 'New folder',
        section: 'Actions',
        keywords: ['organise', 'organize', 'group', 'directory'],
        run: () => run.current.newFolder(),
      },
      {
        id: 'add-tag',
        title: 'Tag this note',
        section: 'Actions',
        keywords: ['label', 'organise', 'organize', 'category'],
        run: () => tagStrip.current?.openPicker(),
      },
      {
        id: 'manage-tags',
        title: 'Manage tags',
        section: 'Actions',
        keywords: ['labels', 'rename', 'colour', 'color'],
        run: () => setTagManagerOpen(true),
      },
      {
        id: 'graph',
        title: 'Open the note graph',
        section: 'Actions',
        shortcut: key('Shift G'),
        keywords: ['map', 'links', 'network'],
        run: () => setGraphOpen(true),
      },
      {
        id: 'zen-sidebars',
        title: 'Zen mode: hide side panels',
        section: 'Actions',
        keywords: ['focus', 'distraction'],
        run: () => run.current.enterZen('sidebars'),
      },
      {
        id: 'zen-chrome',
        title: 'Zen mode: hide toolbars',
        section: 'Actions',
        shortcut: key('Shift F'),
        keywords: ['focus', 'distraction'],
        run: () => run.current.enterZen('chrome'),
      },
      {
        id: 'zen-full',
        title: 'Zen mode: full screen',
        section: 'Actions',
        keywords: ['focus', 'fullscreen'],
        run: () => run.current.enterZen('full'),
      },
      {
        id: 'context',
        title: 'Show or hide the context panel',
        section: 'Actions',
        keywords: ['references', 'intent', 'objective'],
        run: () => run.current.toggleContext(),
      },
      {
        id: 'contexts',
        title: 'Open contexts',
        section: 'Actions',
        keywords: ['library', 'references', 'files'],
        run: () => setLibraryOpen(true),
      },
      {
        id: 'dictate',
        title: 'Start or stop dictation',
        section: 'Actions',
        shortcut: key('Shift D'),
        keywords: ['voice', 'speech', 'microphone'],
        run: () => dictationRef.current?.toggle(),
      },
      {
        id: 'web-facts',
        title: 'Search the web for facts',
        section: 'Actions',
        shortcut: key('Shift K'),
        keywords: ['research', 'cite', 'source'],
        disabled: !webFactsOn,
        run: () => editorRef.current?.requestWebFacts(),
      },
      {
        id: 'sidebar',
        title: 'Show or hide notes',
        section: 'Actions',
        shortcut: key('B'),
        keywords: ['sidebar'],
        run: () => run.current.toggleNotes(),
      },
      {
        id: 'theme',
        title: 'Switch light or dark appearance',
        section: 'Actions',
        keywords: ['theme', 'dark mode', 'light mode'],
        run: () =>
          setWorkspace(value => ({
            ...value,
            settings: {
              ...value.settings,
              theme:
                document.documentElement.dataset.theme === 'dark'
                  ? 'light'
                  : 'dark',
            },
          })),
      },
      {
        id: 'suggestions',
        title: 'Pause or resume suggestions',
        section: 'Actions',
        keywords: ['ghost', 'autocomplete', 'off'],
        run: () =>
          setWorkspace(value => ({
            ...value,
            settings: {
              ...value.settings,
              suggestionsEnabled: !value.settings.suggestionsEnabled,
            },
          })),
      },
      {
        id: 'open',
        title: 'Open a Markdown file',
        section: 'Actions',
        shortcut: key('O'),
        keywords: ['import', 'file'],
        run: () => void run.current.openFile(),
      },
      {
        id: 'save',
        title: 'Save as Markdown',
        section: 'Actions',
        shortcut: key('S'),
        keywords: ['export', 'file'],
        run: () => void run.current.exportNote(),
      },
      {
        id: 'sync',
        title: 'Sync with Git now',
        section: 'Actions',
        keywords: ['git', 'push', 'pull', 'commit'],
        disabled: !gitEnabled,
        run: () => void syncNow(),
      },
      {
        id: 'updates',
        title: 'Check for updates',
        section: 'Actions',
        keywords: ['update', 'upgrade', 'version', 'release', 'new'],
        disabled: !updatesAvailable(),
        run: () => {
          run.current.showPreferences('updates')
          void checkForUpdates({
            manual: true,
            download: getWorkspace().settings.updates.autoDownload,
          })
        },
      },
      {
        id: 'sample',
        title: 'Open the sample note',
        section: 'Actions',
        keywords: ['demo', 'try', 'example'],
        run: () => run.current.openSample(),
      },
      {
        id: 'insert-table',
        title: 'Insert a table',
        section: 'Insert',
        keywords: ['grid', 'columns'],
        run: () => {
          editorRef.current?.focus()
          editorRef.current?.insert(`\n${tableTemplate(3, 2)}\n`)
        },
      },
      {
        id: 'insert-date',
        title: 'Insert today’s date',
        section: 'Insert',
        keywords: ['today', 'day'],
        run: () => {
          editorRef.current?.focus()
          editorRef.current?.insert(
            new Date().toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          )
        },
      },
      pane('writing', 'Writing', ['font', 'typeface', 'palette', 'colour']),
      pane('editor', 'Editor', [
        'slash',
        'typewriter',
        'focus',
        'goal',
        'typography',
      ]),
      pane('suggestions', 'Suggestions', [
        'delay',
        'timing',
        'length',
        'creativity',
      ]),
      pane('models', 'Models', [
        'openai',
        'anthropic',
        'cloudflare',
        'openrouter',
        'local',
        'api key',
      ]),
      pane('knowledge', 'Knowledge', ['semantic', 'embedding', 'rag']),
      pane('web', 'Web facts', ['search', 'openai']),
      pane('dictation', 'Dictation', ['voice', 'whistle', 'fluid']),
      pane('history', 'History', ['revisions', 'versions']),
      pane('sync', 'Sync', ['git']),
      pane('shortcuts', 'Shortcuts', ['keys', 'keyboard', 'shortcut']),
    ]
    return actions
  }, [
    gitEnabled,
    webFactsOn,
    revisionsOn,
    aiOn,
    suggestBinding,
    aiBinding,
    spaceSignature,
    currentSpaceId,
    setWorkspace,
    getWorkspace,
  ])
  /** Folders as a flat list, indented, for "Move to…". */
  const moveItems = (
    move: (folderId: string | undefined) => void,
    current: string | undefined,
    exclude = new Set<string>()
  ): MenuItem[] => {
    const items: MenuItem[] = [
      {
        label: 'Top level',
        icon: <FileText size={14} />,
        checked: current === undefined,
        disabled: current === undefined,
        onSelect: () => move(undefined),
      },
    ]
    const walk = (parentId: string | undefined, depth: number) => {
      for (const folder of childFolders(folders, parentId)) {
        if (exclude.has(folder.id)) continue
        items.push({
          label: `${'\u2003'.repeat(depth)}${folder.name}`,
          icon: (
            <span className={`org-${folder.color ?? 'slate'}`}>
              <FolderOpen size={14} className="org-folder-icon" />
            </span>
          ),
          checked: folder.id === current,
          disabled: folder.id === current,
          onSelect: () => move(folder.id),
        })
        walk(folder.id, depth + 1)
      }
    }
    walk(undefined, 0)
    return items
  }
  const spaceItems = (
    current: string,
    move: (spaceId: string) => void
  ): MenuItem[] =>
    spaces.map(space => ({
      label: space.shared ? `${space.name} (shared)` : space.name,
      icon: <SpaceAvatar space={space} size="small" />,
      checked: space.id === current,
      disabled: space.id === current,
      onSelect: () => move(space.id),
    }))
  const menuItems = (): MenuItem[] => {
    if (!menu) return []
    if (menu.kind === 'folder') {
      const folder = folders.find(item => item.id === menu.id)
      if (!folder) return []
      return [
        {
          label: 'New note here',
          icon: <Plus size={14} />,
          onSelect: () => createNote('', folder.id),
        },
        {
          label: 'New folder inside',
          icon: <FolderPlus size={14} />,
          onSelect: () => newFolder(folder.id),
        },
        {
          label: 'Rename',
          icon: <Pencil size={14} />,
          onSelect: () => setRenamingFolder(folder.id),
        },
        {
          label: 'Move to…',
          icon: <FolderInput size={14} />,
          items: moveItems(
            parentId =>
              organize(value => moveFolder(value, folder.id, parentId)),
            folder.parentId,
            folderAndDescendants(folders, folder.id)
          ),
        },
        ...(multipleSpaces
          ? [
              {
                label: 'Move to workspace…',
                icon: <SpaceAvatar space={currentSpace} size="small" />,
                items: spaceItems(spaceOf(workspace, folder), spaceId =>
                  moveToWorkspace({ folders: [folder.id] }, spaceId)
                ),
              } satisfies MenuItem,
            ]
          : []),
        {
          kind: 'colors',
          label: 'Folder colour',
          value: folder.color,
          onSelect: (color: OrganizeColor) =>
            organize(value => setFolderColor(value, folder.id, color)),
        },
        { kind: 'separator' },
        {
          label: 'Remove folder',
          hint: 'Notes stay',
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => {
            organize(value => deleteFolder(value, folder.id))
            notify(
              `Removed “${folder.name}”. Its notes moved ${folder.parentId ? 'up a level' : 'to the top level'}.`
            )
          },
        },
      ]
    }
    const target = workspace.notes.find(item => item.id === menu.id)
    if (!target) return []
    const move = (folderId: string | undefined) =>
      organize(value => moveNotes(value, [target.id], folderId))
    if (menu.kind === 'move') return moveItems(move, target.folderId)
    return [
      {
        label: 'Open',
        icon: <FileText size={14} />,
        onSelect: () => selectNote(target),
      },
      {
        label: 'Move to…',
        icon: <FolderInput size={14} />,
        items: moveItems(move, target.folderId),
      },
      ...(multipleSpaces
        ? [
            {
              label: 'Move to workspace…',
              icon: <SpaceAvatar space={currentSpace} size="small" />,
              items: spaceItems(spaceOf(workspace, target), spaceId =>
                moveToWorkspace({ notes: [target.id] }, spaceId)
              ),
            } satisfies MenuItem,
          ]
        : []),
      {
        label: 'Tags…',
        icon: <Tags size={14} />,
        onSelect: () => {
          selectNote(target)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => tagStrip.current?.openPicker())
          )
        },
      },
      { kind: 'separator' },
      {
        label: 'Delete note',
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setDeleteId(target.id),
      },
    ]
  }

  const paletteHeadings = useMemo<PaletteHeading[]>(
    () => headings.map(({ level, text, from }) => ({ level, text, from })),
    [headings]
  )

  if (loading)
    return (
      <div className="loading-workspace">
        <LoaderCircle size={22} className="spin" />
        <span>Opening your notebook…</span>
      </div>
    )
  if (loadError)
    return (
      <main className="recovery-view">
        <ShieldCheck size={26} />
        <h1>Your saved notebook needs attention.</h1>
        <p>{storageError}</p>
        <p>
          TypeNext has kept your existing data and paused saving. Restore the
          notebook or its recovery copy, then try opening it again.
        </p>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          Try opening again
        </button>
        {isDesktop() && (
          <button
            className="button secondary"
            onClick={() => {
              setRecoveryActionError('')
              void import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke('open_workspace_folder'))
                .catch(error => setRecoveryActionError(String(error)))
            }}
          >
            Open saved files
          </button>
        )}
        {recoveryActionError && <p role="alert">{recoveryActionError}</p>}
        {isDesktop() && (
          <button
            className="button subtle"
            onClick={() => {
              void windowAction('close')
            }}
          >
            Close TypeNext
          </button>
        )}
      </main>
    )

  return (
    <div
      className={`app-shell ${!sidebarVisible || focusMode ? 'sidebar-hidden' : ''} ${focusMode ? `focus-mode zen zen-${zenLevel}` : ''} ${revealChrome ? 'zen-reveal' : ''} ${MAC_DESKTOP ? 'platform-mac' : ''} ${switching ? 'is-switching-space' : ''}`}
      onMouseMove={focusMode ? trackEdges : undefined}
    >
      <aside className="note-sidebar" aria-label="Notebook">
        <div className="sidebar-brand" data-tauri-drag-region>
          <img
            className="brand-mark"
            src={BRAND_ICON_URL}
            alt=""
            width={22}
            height={22}
            draggable={false}
            data-tauri-drag-region
          />
          <span className="brand-text">
            <span className="brand-name">TypeNext</span>
            <span className="brand-detail">a place for your words</span>
          </span>
        </div>
        <div className="sidebar-actions">
          <button
            className="button new-note-button"
            onClick={() => {
              createNote()
            }}
          >
            <Plus size={17} /> New note <kbd>⌘ / Ctrl N</kbd>
          </button>
          <button
            className="sidebar-open"
            onClick={() => {
              void openFile()
            }}
          >
            <FolderOpen size={16} />
            Open a Markdown file
            <ArrowUpRight size={14} />
          </button>
          <button className="sidebar-open" onClick={() => setLibraryOpen(true)}>
            <Paperclip size={16} /> Contexts <span>{view.packages.length}</span>
          </button>
        </div>
        <label className="note-search">
          <Search size={15} />
          <input
            ref={recentSearch}
            aria-label="Search notes"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Find a note"
          />
          <kbd>⌘ / Ctrl P</kbd>
        </label>
        {tags.length > 0 && !tagFilter && (
          <div
            className={`org-filters${filtersOpen ? ' is-open' : ''}`}
            aria-label="Filter by tag"
          >
            {[...tags]
              .sort(
                (left, right) =>
                  (organization.tags.get(right.id) ?? 0) -
                    (organization.tags.get(left.id) ?? 0) ||
                  left.name.localeCompare(right.name)
              )
              .slice(0, filtersOpen ? undefined : 8)
              .map(tag => (
                <button
                  key={tag.id}
                  type="button"
                  className={`org-filter org-${tag.color}`}
                  aria-pressed={false}
                  onClick={() => setTagFilter(tag.id)}
                >
                  <span className="org-dot" aria-hidden="true" />
                  {tag.name}
                  <small>{organization.tags.get(tag.id) ?? 0}</small>
                </button>
              ))}
            <span className="org-filter-tools">
              {tags.length > 8 && (
                <button
                  type="button"
                  className="org-filter-more"
                  onClick={() => setFiltersOpen(value => !value)}
                >
                  {filtersOpen ? 'Fewer' : `+${tags.length - 8}`}
                </button>
              )}
              <button
                type="button"
                className="org-filter-more"
                aria-label="Manage tags"
                title="Manage tags"
                onClick={() => setTagManagerOpen(true)}
              >
                <Tags size={13} />
              </button>
            </span>
          </div>
        )}
        {tagFilter && (
          <div
            className={`org-filtering org-${tags.find(tag => tag.id === tagFilter)?.color ?? 'slate'}`}
          >
            <span className="org-dot" aria-hidden="true" />
            <span>
              Tagged{' '}
              <strong>{tags.find(tag => tag.id === tagFilter)?.name}</strong>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Show all notes"
              onClick={() => setTagFilter(null)}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <div
          className={`notes-section-heading${rootDrop ? ' is-drop-target' : ''}`}
          onDragOver={event => {
            event.preventDefault()
            setRootDrop(true)
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={event => {
            event.preventDefault()
            setRootDrop(false)
            try {
              const payload = JSON.parse(
                event.dataTransfer.getData('application/x-typenext-item')
              ) as DragPayload
              if (payload?.id) onDropItem({}, payload)
            } catch {
              // Not a note or folder.
            }
          }}
        >
          <span>{tagFilter || search ? 'Matching notes' : 'Your notes'}</span>
          <span className="org-heading-tools">
            <span>{activeNotes.length}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="New folder"
              title="New folder"
              onClick={() => newFolder()}
            >
              <FolderPlus size={14} />
            </button>
          </span>
        </div>
        <div className="sidebar-lists">
          <NoteTree
            notes={activeNotes}
            folders={activeFolders}
            tags={tags}
            counts={organization}
            activeId={note?.id ?? null}
            query={search}
            tagFilter={tagFilter}
            renamingFolder={renamingFolder}
            empty={
              search || tagFilter
                ? 'No notes match.'
                : 'Your notes will feel at home here.'
            }
            onSelect={selectNote}
            onDelete={setDeleteId}
            onNoteMenu={openNoteMenu}
            onFolderMenu={openFolderMenu}
            onToggleFolder={onToggleFolder}
            onNewNoteIn={folderId => {
              createNote('', folderId)
            }}
            onRenameFolder={onRenameFolder}
            onDrop={onDropItem}
          />
          {sharedSections.map(
            ({ space, notes: spaceNotes, folders: spaceFolders }) => {
              const open = !collapsedShared.has(space.id)
              return (
                <div className="space-section" key={space.id}>
                  <div className="space-section-row">
                    <button
                      type="button"
                      className={`space-section-heading org-${space.color}`}
                      aria-expanded={open}
                      onClick={() =>
                        setCollapsedShared(value => {
                          const next = new Set(value)
                          if (next.has(space.id)) next.delete(space.id)
                          else next.add(space.id)
                          return next
                        })
                      }
                      onDragOver={event => {
                        event.preventDefault()
                        event.currentTarget.classList.add('is-drop-target')
                      }}
                      onDragLeave={event =>
                        event.currentTarget.classList.remove('is-drop-target')
                      }
                      onDrop={event => {
                        event.preventDefault()
                        event.currentTarget.classList.remove('is-drop-target')
                        try {
                          const payload = JSON.parse(
                            event.dataTransfer.getData(
                              'application/x-typenext-item'
                            )
                          ) as DragPayload
                          if (payload?.id)
                            moveToWorkspace(
                              payload.kind === 'note'
                                ? { notes: [payload.id] }
                                : { folders: [payload.id] },
                              space.id
                            )
                        } catch {
                          // Not a note or folder.
                        }
                      }}
                    >
                      <ChevronRight
                        size={13}
                        className="org-chevron"
                        aria-hidden="true"
                      />
                      <SpaceAvatar space={space} size="small" />
                      <strong>{space.name}</strong>
                      <span>{spaceNotes.length}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button space-section-add"
                      aria-label={`New note in ${space.name}`}
                      title={`New note in ${space.name}`}
                      onClick={() => {
                        setCollapsedShared(value => {
                          const next = new Set(value)
                          next.delete(space.id)
                          return next
                        })
                        createNote('', undefined, space.id)
                      }}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {open && (
                    <NoteTree
                      notes={spaceNotes}
                      folders={spaceFolders}
                      tags={tags}
                      counts={organization}
                      activeId={note?.id ?? null}
                      query={search}
                      tagFilter={tagFilter}
                      renamingFolder={renamingFolder}
                      empty={
                        search || tagFilter
                          ? 'No shared notes match.'
                          : `Notes in ${space.name} appear in every workspace.`
                      }
                      onSelect={selectNote}
                      onDelete={setDeleteId}
                      onNoteMenu={openNoteMenu}
                      onFolderMenu={openFolderMenu}
                      onToggleFolder={onToggleFolder}
                      onNewNoteIn={folderId => {
                        createNote('', folderId)
                      }}
                      onRenameFolder={onRenameFolder}
                      onDrop={onDropItem}
                    />
                  )}
                </div>
              )
            }
          )}
        </div>
        <div className="sidebar-bottom">
          <GitSyncStatus onOpenSettings={() => showPreferences('sync')} />
          <WorkspaceSwitcher
            spaces={spaces}
            activeId={currentSpace.id}
            counts={counts}
            gitFolders={gitSpaces}
            privacy={{
              external: usingExternal,
              label: usingExternal
                ? `${PROVIDERS[settings.provider]} active`
                : 'Local by default',
              detail: usingExternal
                ? `${PROVIDERS[settings.provider]} writes suggestions. Nearby writing and attached context are shared with it.`
                : 'Local by default. Your writing stays with you.',
            }}
            onSwitch={switchWorkspace}
            onCreate={(name, shared) => {
              newWorkspace(name, shared)
            }}
            onManage={id => setManagerOpen(id ?? '')}
          />
          <div className="sidebar-utilities">
            <button
              className="utility-button"
              onClick={() => showPreferences()}
            >
              <Settings2 size={16} />
              Preferences
            </button>
            <button
              className="icon-button"
              aria-label="Toggle light and dark mode"
              title="Toggle light and dark mode"
              onClick={() =>
                setWorkspace(value => ({
                  ...value,
                  settings: {
                    ...value.settings,
                    theme: darkAppearance ? 'light' : 'dark',
                  },
                }))
              }
            >
              {darkAppearance ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </div>
      </aside>
      <main className="writing-space">
        <header className="app-toolbar">
          <div className="toolbar-leading">
            <button
              className="icon-button"
              aria-label={
                notesVisible ? 'Hide note sidebar' : 'Show note sidebar'
              }
              title="Toggle notes (Ctrl / ⌘ B)"
              onClick={toggleNotes}
            >
              <PanelLeft size={18} />
            </button>
            <div className="breadcrumb" data-tauri-drag-region>
              <img
                className="brand-mark toolbar-brand-mark"
                src={BRAND_ICON_URL}
                alt="TypeNext"
                width={18}
                height={18}
                draggable={false}
                data-tauri-drag-region
              />
              <span className="breadcrumb-section">
                {multipleSpaces
                  ? (spaces.find(
                      space =>
                        space.id ===
                        (storedNote
                          ? spaceOf(workspace, storedNote)
                          : currentSpace.id)
                    )?.name ?? currentSpace.name)
                  : 'Notebook'}
              </span>
              {note &&
                activeFolderPath.map(folder => (
                  <span key={folder.id} className="breadcrumb-folder">
                    <ChevronRight size={13} />
                    <span>{folder.name}</span>
                  </span>
                ))}
              <ChevronRight size={13} />
              <span>{note ? displayTitle(note) : 'A fresh start'}</span>
            </div>
          </div>
          <div className="toolbar-actions">
            {note && (
              <>
                <button
                  className={`toolbar-button ${contextVisible ? 'selected' : ''}`}
                  aria-label="Context"
                  title="Note context"
                  aria-pressed={contextVisible}
                  onClick={() => {
                    toggleContext()
                    setFocusMode(false)
                  }}
                >
                  <Paperclip size={15} />
                  <span>Context</span>
                  {note.sources.length > 0 && (
                    <span className="source-count">{note.sources.length}</span>
                  )}
                </button>
                <button
                  className="icon-button"
                  aria-label="Dictate on this device"
                  title="Dictate on this device (Ctrl / ⌘ Shift D)"
                  aria-pressed={dictationActive}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => dictationRef.current?.toggle()}
                >
                  <Mic size={17} />
                </button>
                <button
                  className="icon-button graph-button"
                  aria-label="Open note graph"
                  title="Note graph (Ctrl / ⌘ Shift G)"
                  onClick={() => setGraphOpen(true)}
                >
                  <Waypoints size={17} />
                </button>
                {settings.revisions.enabled && (
                  <button
                    className="icon-button"
                    aria-label="History"
                    title="History: versions of this note (Ctrl / ⌘ Alt H)"
                    onClick={() => setHistoryOpen(true)}
                  >
                    <History size={17} />
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label="Save Markdown"
                  title="Save Markdown (Ctrl / ⌘ S)"
                  onClick={() => {
                    void exportNote()
                  }}
                >
                  <Save size={17} />
                </button>
                <ZenMenu
                  active={focusMode}
                  level={zenLevel}
                  onToggle={() =>
                    focusMode ? setFocusMode(false) : enterZen()
                  }
                  onChoose={enterZen}
                />
              </>
            )}
            {isDesktop() && !MAC_DESKTOP && (
              <div className="window-controls">
                <button
                  aria-label="Minimize window"
                  onClick={() => {
                    void windowAction('minimize')
                  }}
                >
                  <Minus size={14} />
                </button>
                <button
                  aria-label="Maximize window"
                  onClick={() => {
                    void windowAction('maximize')
                  }}
                >
                  <Maximize2 size={12} />
                </button>
                <button
                  className="window-close"
                  aria-label="Close window"
                  onClick={() => {
                    void windowAction('close')
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
        </header>
        {workspace.openNoteIds.length > 0 && (
          <nav className="note-tabs" aria-label="Open notes">
            {workspace.openNoteIds.map(id => {
              const item = workspace.notes.find(
                candidate => candidate.id === id
              )
              return item ? (
                <div
                  key={id}
                  className={`note-tab ${note?.id === id ? 'active' : ''}`}
                >
                  <button
                    onClick={() => selectNote(item)}
                    aria-current={note?.id === id ? 'page' : undefined}
                  >
                    <FileText size={13} />
                    <span>{displayTitle(item)}</span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close ${displayTitle(item)} tab`}
                    onClick={() => {
                      setWorkspace(value => closeNote(value, id))
                      setStatus({ state: 'idle' })
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : null
            })}
            <button
              className="icon-button add-tab"
              aria-label="Create another note"
              onClick={() => {
                createNote()
              }}
            >
              <Plus size={16} />
            </button>
          </nav>
        )}
        <div className="workspace-body">
          {note ? (
            <>
              <section
                className="editor-column"
                aria-label="Writing area"
                style={
                  {
                    '--writing-font': font.family,
                    '--writing-size': `${settings.fontSize}px`,
                  } as React.CSSProperties
                }
              >
                {!contextVisible && (
                  <NoteOutline
                    headings={headings}
                    active={activeHeadingIndex}
                    onJump={heading => editorRef.current?.jumpTo(heading.from)}
                  />
                )}
                <div className="document-scroll">
                  <div className="document-page">
                    <div className="document-meta">
                      <button
                        className="document-font"
                        onClick={() => showPreferences('writing')}
                      >
                        {settings.fontFamily}
                        <ChevronRight size={12} />
                      </button>
                      <span>{relativeDate(note.createdAt)}</span>
                    </div>
                    <input
                      className="note-title"
                      aria-label="Note title"
                      // A title taken from the first line is shown, but the
                      // stand-in "Untitled" is only a placeholder, and
                      // focusing a derived title selects it so typing
                      // replaces it.
                      value={
                        note.autoTitle && note.title === UNTITLED
                          ? ''
                          : note.title
                      }
                      maxLength={160}
                      placeholder={UNTITLED}
                      onFocus={event => {
                        if (!note.autoTitle) return
                        const field = event.currentTarget
                        field.select()
                        // A click would put the caret back on mouse-up.
                        field.addEventListener(
                          'mouseup',
                          up => up.preventDefault(),
                          { once: true }
                        )
                      }}
                      onChange={event =>
                        updateNote(note.id, { title: event.target.value })
                      }
                    />
                    <TagStrip
                      key={`tags:${note.id}`}
                      ref={tagStrip}
                      tags={tags}
                      chosen={storedNote?.tags ?? []}
                      counts={organization.tags}
                      folderPath={activeFolderPath}
                      onToggle={(id, on) => toggleNoteTag(note.id, id, on)}
                      onCreate={name => createTagFor(note.id, name)}
                      onManage={() => setTagManagerOpen(true)}
                      onFolder={anchor =>
                        setMenu({ kind: 'move', id: note.id, anchor })
                      }
                    />
                    {note.objective && (
                      <div className="objective-line">
                        <span>Objective</span>
                        <p>{note.objective}</p>
                      </div>
                    )}
                    <MarkdownEditor
                      key={note.id}
                      ref={editorRef}
                      note={note}
                      notes={view.notes}
                      settings={settings}
                      onChange={content => updateNote(note.id, { content })}
                      onStatus={setStatus}
                      requestToken={requestToken}
                      onOpenNote={openNoteById}
                      onCreateNote={title => {
                        createNote(title)
                      }}
                      onAction={action => {
                        if (action === 'dictate') dictationRef.current?.toggle()
                        else if (action === 'graph') setGraphOpen(true)
                      }}
                      zenFull={focusMode && zenLevel === 'full'}
                      onBeforeAiReplace={label => {
                        void safetyCopy(note.id, label)
                      }}
                      onCursorChange={context => {
                        const index = activeHeading(
                          headingsRef.current,
                          context.cursor
                        )
                        setActiveHeadingIndex(value =>
                          value === index ? value : index
                        )
                      }}
                    />
                    <LinkedFrom notes={linkedFrom} onOpen={openNoteById} />
                    {!note.content && (
                      <div className="blank-page-hint">
                        <Keyboard size={14} />
                        {settings.suggestionsEnabled ? (
                          <span>
                            {settings.autoSuggest
                              ? 'Write a thought. Pause for a suggestion, or press '
                              : 'Write a thought. Press '}
                            <kbd>{suggestKeys}</kbd> to explore a few ways
                            forward.
                          </span>
                        ) : (
                          <span>
                            Your page is ready. Write at your own pace.
                          </span>
                        )}
                      </div>
                    )}
                    {note.id === DEMO_NOTE_ID &&
                      note.content.trimEnd().endsWith(DEMO_STARTER) && (
                        <p
                          className="sample-note-hint"
                          role="note"
                          aria-label="Sample writing tip"
                        >
                          <Keyboard size={14} />
                          <span>
                            Fictional sample. Try <kbd>{suggestKeys}</kbd> for a
                            suggestion, then <kbd>Tab</kbd> to accept.
                          </span>
                        </p>
                      )}
                  </div>
                </div>
                <InlineDictation
                  key={note.id}
                  ref={dictationRef}
                  settings={settings.dictation}
                  onOpenSettings={() => showPreferences('dictation')}
                  recoveryText={dictationRecovery}
                  onRecoveryTextChange={setDictationRecovery}
                  onActiveChange={setDictationActive}
                  onCapture={() => {
                    if (!editorRef.current)
                      throw new Error('Open a note before dictating.')
                    return editorRef.current.captureDictation()
                  }}
                  onRecoverInsert={text => {
                    if (!editorRef.current)
                      throw new Error('Open a note before inserting.')
                    const capture = editorRef.current.captureDictation()
                    try {
                      capture.commit(text)
                    } finally {
                      capture.cancel()
                    }
                  }}
                />
                <div className="suggestion-bar">
                  <button
                    className={`local-suggestion-button ${!settings.suggestionsEnabled ? 'paused' : ''}`}
                    onClick={() =>
                      setWorkspace(value => ({
                        ...value,
                        settings: {
                          ...value.settings,
                          suggestionsEnabled:
                            !value.settings.suggestionsEnabled,
                        },
                      }))
                    }
                    aria-pressed={settings.suggestionsEnabled}
                    title="Pause or resume suggestions"
                  >
                    {usingExternal ? (
                      <Cloud size={14} />
                    ) : (
                      <ShieldCheck size={14} />
                    )}
                    <span>
                      {settings.suggestionsEnabled
                        ? usingExternal
                          ? PROVIDERS[settings.provider]
                          : hasLocalModel
                            ? 'Local model'
                            : 'Local suggestions'
                        : 'Suggestions paused'}
                    </span>
                  </button>
                  <div
                    className="suggestion-message"
                    role="status"
                    aria-live="polite"
                  >
                    {status.state === 'loading' ? (
                      <>
                        {settings.ai.indicator === 'off' ? (
                          <LoaderCircle size={13} className="spin" />
                        ) : (
                          <AiPulse style={settings.ai.indicator} />
                        )}
                        <span>
                          {status.message ?? 'Finding a continuation…'}
                        </span>
                      </>
                    ) : status.state === 'suggestion' ? (
                      <span
                        className={`acceptance-help${status.menuOpen ? ' choices-open' : ''}`}
                      >
                        {status.mode === 'starter' && 'Writing starter · '}
                        {status.menuOpen && (
                          <>
                            <kbd>↑ ↓</kbd> choose ·{' '}
                          </>
                        )}
                        <kbd>Tab</kbd> accept
                        {!status.menuOpen && (
                          <span className="word-accept-help">
                            {' '}
                            · <kbd>{wordKeys}</kbd> a word
                          </span>
                        )}{' '}
                        · <kbd>Esc</kbd> dismiss
                      </span>
                    ) : status.state === 'error' &&
                      status.kind === 'document' ? (
                      <span title={status.message}>{status.message}</span>
                    ) : status.state === 'error' ? (
                      <button
                        onClick={() =>
                          showPreferences(usingExternal ? 'external' : 'local')
                        }
                        title={status.message}
                      >
                        {status.message || 'Check your local model connection'}
                      </button>
                    ) : status.message ? (
                      <button
                        onClick={() =>
                          showPreferences(usingExternal ? 'external' : 'local')
                        }
                        title={status.message}
                      >
                        {status.message}
                      </button>
                    ) : (
                      <button
                        onClick={() => setRequestToken(value => value + 1)}
                      >
                        Suggest at the cursor <kbd>{suggestKeys}</kbd>
                      </button>
                    )}
                  </div>
                  <button
                    className="external-suggestion-button"
                    onClick={() => setExternalOpen(true)}
                    aria-label="Choose suggestion engine"
                    title="Choose suggestion engine"
                  >
                    <Cloud size={14} />
                    <span>
                      {usingExternal
                        ? settings.profiles[settings.provider].model
                        : 'Choose model'}
                    </span>
                    <ArrowUpRight size={12} />
                  </button>
                </div>
                <footer className="editor-footer">
                  <WritingStats
                    words={activeWordCount}
                    today={todayWords}
                    goal={settings.editor.dailyGoal}
                  />
                  <button
                    className={`save-indicator ${saveStatus === 'error' ? 'error' : ''}`}
                    title={storageError || 'Click to save the notebook locally'}
                    onClick={() => {
                      void saveNow().catch(() => undefined)
                    }}
                  >
                    {saveStatus === 'saving' ? (
                      <LoaderCircle className="spin" size={12} />
                    ) : saveStatus === 'saved' ? (
                      <Check size={13} />
                    ) : null}
                    {saveStatus === 'saved'
                      ? 'Saved locally'
                      : saveStatus === 'saving'
                        ? 'Saving…'
                        : saveStatus === 'error'
                          ? 'Save failed · retry'
                          : 'Unsaved · save now'}
                  </button>
                </footer>
              </section>
              {contextVisible && !focusMode && (
                <ContextPanel
                  key={note.id}
                  note={storedNote!}
                  notes={view.notes}
                  folders={folders}
                  onAttachFolder={folderId =>
                    changePackage(value => ({
                      ...value,
                      notes: value.notes.map(item =>
                        item.id === value.activeNoteId &&
                        !item.contextFolderIds?.includes(folderId)
                          ? {
                              ...item,
                              contextFolderIds: [
                                ...(item.contextFolderIds ?? []),
                                folderId,
                              ],
                              updatedAt: Date.now(),
                            }
                          : item
                      ),
                    }))
                  }
                  onDetachFolder={folderId =>
                    changePackage(value => ({
                      ...value,
                      notes: value.notes.map(item => {
                        if (item.id !== value.activeNoteId) return item
                        const kept = (item.contextFolderIds ?? []).filter(
                          id => id !== folderId
                        )
                        const { contextFolderIds: _old, ...rest } = item
                        void _old
                        return {
                          ...rest,
                          ...(kept.length ? { contextFolderIds: kept } : {}),
                          updatedAt: Date.now(),
                        }
                      }),
                    }))
                  }
                  packages={view.packages}
                  onDetachPackage={detachPackage}
                  onAttachPackage={attachPackage}
                  onCreatePackage={createPackage}
                  settings={settings}
                  onOpenKnowledgeSettings={() => showPreferences('knowledge')}
                  library={workspace.contextLibrary}
                  onLibrary={packageId => {
                    setLibraryPackageId(packageId)
                    setLibraryOpen(true)
                  }}
                  onUseNote={useNoteAsContext}
                  importing={importing}
                  onClose={() => setContextVisible(false)}
                  onUpdate={patch => updateNote(note.id, patch)}
                  onFiles={addSources}
                  onWebsite={() => {
                    setWebsitePackageId(undefined)
                    setWebsiteOpen(true)
                  }}
                />
              )}
            </>
          ) : (
            <section className="welcome-view">
              <div className="welcome-mark">
                <img
                  className="brand-mark"
                  src={BRAND_ICON_URL}
                  alt=""
                  width={40}
                  height={40}
                  draggable={false}
                />
              </div>
              <h1>A little room to think.</h1>
              <p>
                Your words, at your pace.
                <br />A suggestion when you need one.
              </p>
              <div className="welcome-actions">
                <button
                  className="button primary"
                  onClick={() => {
                    createNote()
                  }}
                >
                  <Plus size={16} />
                  Start a note
                </button>
                <button className="button secondary" onClick={openSample}>
                  {demoInstalled ? 'Open sample' : 'Try a sample'}
                </button>
                <button
                  className="button subtle"
                  onClick={() => {
                    void openFile()
                  }}
                >
                  <FolderOpen size={16} />
                  Open Markdown
                </button>
              </div>
              <div className="welcome-footnote">
                <ShieldCheck size={15} />
                <span>Local by default. Always your voice.</span>
              </div>
              {view.notes.length > 0 && (
                <button
                  className="return-to-note"
                  onClick={() => {
                    const latest = latestNote ?? workspace.notes[0]
                    if (latest) selectNote(latest)
                  }}
                >
                  Return to your latest note
                  <ChevronRight size={14} />
                </button>
              )}
            </section>
          )}
        </div>
      </main>
      <ContextLibrary
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        library={workspace.contextLibrary ?? []}
        notes={view.notes}
        activeNote={storedNote ?? null}
        packages={view.packages}
        initialPackageId={libraryPackageId}
        importing={importing}
        demoInstalled={demoInstalled}
        onDemo={openSample}
        demoDownloadHref={
          isDesktop()
            ? undefined
            : `${import.meta.env.BASE_URL}${DEMO_DOWNLOAD_PATH}`
        }
        onCloseAutoFocus={event => {
          if (pendingSampleFocus.current) {
            event.preventDefault()
            focusSample()
          }
        }}
        onCreatePackage={createPackage}
        onRenamePackage={renamePackage}
        onRemovePackage={removePackage}
        onAttachPackage={attachPackage}
        onDetachPackage={detachPackage}
        onRemoveSource={removePackageSource}
        onFiles={addSources}
        onWebsite={packageId => {
          setWebsitePackageId(packageId)
          setLibraryOpen(false)
          setWebsiteOpen(true)
        }}
        onUseNote={useNoteAsContext}
        settings={settings}
        onOpenKnowledgeSettings={() => showPreferences('knowledge')}
        spaces={spaces}
        onShareSpaces={(id, spaceIds) =>
          organize(value => setContextSpaces(value, id, spaceIds))
        }
      />
      <Menu
        anchor={menu?.anchor ?? null}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
        items={menuItems()}
        label={
          menu?.kind === 'folder'
            ? 'Folder actions'
            : menu?.kind === 'move'
              ? 'Move to a folder'
              : 'Note actions'
        }
      />
      <WorkspaceManager
        open={managerOpen !== null}
        onOpenChange={open => {
          if (!open) setManagerOpen(null)
        }}
        spaces={spaces}
        activeId={currentSpace.id}
        initialId={
          managerOpen && managerOpen !== 'new' ? managerOpen : undefined
        }
        counts={counts}
        homeGitFolder={settings.git.folder}
        gitEnabled={settings.git.enabled}
        onUpdate={(id, patch) =>
          organize(value => updateSpace(value, id, patch))
        }
        onCreate={shared => newWorkspace('', shared, false)}
        onDelete={(id, moveTo) => {
          const removed = spaces.find(space => space.id === id)
          organize(value => deleteSpace(value, id, moveTo))
          setSwitching(Date.now())
          if (removed) notify(`Removed the workspace “${removed.name}”.`)
        }}
        onSwitch={switchWorkspace}
        onOpenSync={() => {
          setManagerOpen(null)
          showPreferences('sync')
        }}
      />
      <TagManager
        open={tagManagerOpen}
        onOpenChange={setTagManagerOpen}
        tags={tags}
        counts={organization.tags}
        onCreate={name => createTagFor(null, name)}
        onRename={(id, name) => organize(value => renameTag(value, id, name))}
        onColor={(id, color) =>
          organize(value => setTagColor(value, id, color))
        }
        onDelete={id => organize(value => deleteTag(value, id))}
        onFilter={id => {
          setSearch('')
          setTagFilter(id)
          setSidebarVisible(true)
        }}
      />
      {historyLoaded && (
        <Suspense fallback={null}>
          <RevisionHistory
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            note={storedNote}
            enabled={settings.revisions.enabled}
            onSaveRevision={label => saveRevision(label)}
            onReplace={replaceFromHistory}
            onOpenSettings={() => {
              setHistoryOpen(false)
              showPreferences('history')
            }}
          />
        </Suspense>
      )}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        notes={view.notes}
        activeNoteId={workspace.activeNoteId}
        headings={paletteHeadings}
        actions={paletteActions}
        onOpenNote={openNoteById}
        onCreateNote={title => {
          createNote(title)
        }}
        onJumpToHeading={heading => editorRef.current?.jumpTo(heading.from)}
      />
      <UpdateNotice
        hidden={
          focusMode ||
          preferencesOpen ||
          libraryOpen ||
          graphOpen ||
          historyOpen
        }
        onOpenSettings={() => showPreferences('updates')}
      />
      <HuggingFaceGuide
        onRetry={source => {
          const { semantic } = getWorkspace().settings
          const retry =
            source === 'embedding'
              ? installEmbeddingRuntime(semantic.quantization, semantic.media)
              : source === 'speech'
                ? installSpeechRuntime()
                : source === 'builtin'
                  ? downloadBuiltinModel()
                  : source === 'whistle'
                    ? downloadWhistleModel()
                    : null
          // The download panels show progress and any further error.
          void retry?.catch(() => undefined)
        }}
      />
      {graphLoaded && (
        <Suspense fallback={null}>
          <NoteGraph
            open={graphOpen}
            onOpenChange={setGraphOpen}
            notes={view.notes}
            library={workspace.contextLibrary}
            packages={view.packages}
            activeNoteId={workspace.activeNoteId}
            onOpenNote={openNoteById}
            onCreateNote={title => {
              createNote(title)
            }}
          />
        </Suspense>
      )}
      {preferencesLoaded && (
        <Suspense fallback={null}>
          <Preferences
            open={preferencesOpen}
            onOpenChange={setPreferencesOpen}
            pane={preferencePane}
            onPaneChange={setPreferencePane}
            settings={settings}
            onChange={next =>
              setWorkspace(value => ({
                ...value,
                settings: next,
              }))
            }
          />
        </Suspense>
      )}
      <Modal
        open={websiteOpen}
        onOpenChange={open => {
          if (!importing) setWebsiteOpen(open)
        }}
        title="Bring a website into context"
        description={
          settings.websiteImporter === 'firecrawl'
            ? 'Firecrawl will receive this website URL and return its content. Your note is not sent.'
            : 'TypeNext will contact this website, extract its readable text, and keep a local copy. Your note is not sent.'
        }
      >
        <form
          onSubmit={event => {
            event.preventDefault()
            void addWebsite()
          }}
        >
          <label className="field-label" htmlFor="website-url">
            Website URL
          </label>
          <input
            id="website-url"
            type="url"
            value={websiteUrl}
            onChange={event => setWebsiteUrl(event.target.value)}
            required
            placeholder="https://example.com/article"
          />
          <p className="field-help">
            Text is extracted once and cached. Scanned PDFs and pages that block
            access may need a different source.
          </p>
          <div className="dialog-footer">
            <button
              className="button subtle"
              type="button"
              disabled={importing}
              onClick={() => setWebsiteOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={importing || !websiteUrl.trim()}
            >
              {importing ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <LinkIcon size={15} />
              )}
              {importing
                ? 'Reading website…'
                : settings.websiteImporter === 'firecrawl'
                  ? 'Import through Firecrawl'
                  : 'Import website'}
            </button>
          </div>
        </form>
      </Modal>
      <ModelChooser
        open={externalOpen}
        onOpenChange={setExternalOpen}
        settings={settings}
        onChange={next => setWorkspace(value => ({ ...value, settings: next }))}
        onConfigure={() => showPreferences('external')}
        onConfigureLocal={() => showPreferences('local')}
        onActivated={() => editorRef.current?.focus()}
      />
      <Modal
        open={closeOpen}
        onOpenChange={open => {
          if (!closing) setCloseOpen(open)
        }}
        title={closing ? 'Saving your notebook…' : 'Save before closing?'}
        description="Keep your latest writing in the notebook and any connected Markdown files."
      >
        {closeError && (
          <p className="field-error" role="alert">
            {closeError}
          </p>
        )}
        <div className="dialog-footer">
          <button
            className="button subtle"
            disabled={closing}
            onClick={() => setCloseOpen(false)}
          >
            Keep writing
          </button>
          <button
            className="button subtle"
            disabled={closing}
            onClick={() => {
              void finishClose(false)
            }}
          >
            Quit without saving
          </button>
          <button
            className="button primary"
            disabled={closing}
            onClick={() => {
              void finishClose(true)
            }}
          >
            {closing ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Save size={15} />
            )}
            Save and quit
          </button>
        </div>
      </Modal>
      <Modal
        open={Boolean(deleteId)}
        onOpenChange={open => {
          if (!open) setDeleteId(null)
        }}
        title="Delete this note?"
        description={`“${selectedForDeletion?.title ?? 'This note'}” will be removed from your local notebook. Any exported Markdown file stays on disk.`}
      >
        <div className="dialog-footer">
          <button className="button subtle" onClick={() => setDeleteId(null)}>
            Keep note
          </button>
          <button
            className="button destructive"
            onClick={() => {
              if (deleteId)
                void deleteNoteRevisions(deleteId).catch(() => undefined)
              setWorkspace(value => {
                const closed = closeNote(value, deleteId ?? '')
                return {
                  ...closed,
                  notes: closed.notes.filter(item => item.id !== deleteId),
                }
              })
              setDeleteId(null)
              setStatus({ state: 'idle' })
            }}
          >
            Delete note
          </button>
        </div>
      </Modal>
      {focusMode && zenLevel !== 'sidebars' && (
        <button
          className="zen-exit"
          onClick={() => setFocusMode(false)}
          aria-label="Leave zen mode"
        >
          <Close size={12} /> Leave zen <kbd>Esc</kbd>
        </button>
      )}
      {(notice || storageError) && (
        <div className="notice" role="status">
          <span>{notice || storageError}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

export default App
