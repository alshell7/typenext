import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Cloud,
  FileText,
  FolderOpen,
  Keyboard,
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
  SquarePen,
  Sun,
  Trash2,
  X,
  Paperclip,
  Link as LinkIcon,
  Focus,
  Save,
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
  wordCount,
} from './notebook/model'
import { Modal } from './notebook/Modal'
import { ContextPanel } from './notebook/ContextPanel'
import { ModelChooser } from './notebook/ModelChooser'
import { DictationDialog } from './notebook/DictationDialog'
import { ContextLibrary } from './notebook/ContextLibrary'
import {
  contextFolder,
  findLibrarySource,
  libraryReference,
} from './notebook/context-library'
import {
  linkNoteSource,
  resolveNoteContext,
  stripLinkedText,
} from './notebook/note-context'
import { Preferences, type PreferencePane } from './notebook/Preferences'
import { applyPalette } from './notebook/palette'
import { isDesktop } from './services/native'
import {
  assertWorkspaceFits,
  openMarkdownFile,
  saveMarkdownFile,
  STORAGE_LIMITS,
} from './services/storage'
import { importContextFile, importWebsite } from './services/sources'
import type { ContextSource, Note } from './types/notebook'
import './App.css'

const MAX_STORED_CONTEXT_CHARACTERS = 2_000_000

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
  const [newNoteOpen, setNewNoteOpen] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContext, setDraftContext] = useState('')
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [preferencePane, setPreferencePane] =
    useState<PreferencePane>('writing')
  const [sidebarVisible, setSidebarVisible] = useState(
    () => window.innerWidth >= 760
  )
  const [contextVisible, setContextVisible] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [dictationOpen, setDictationOpen] = useState(false)
  const dictationNoteId = useRef<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
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
  const note = useMemo(() => {
    const active = workspace.notes.find(
      item => item.id === workspace.activeNoteId
    )
    return active
      ? resolveNoteContext(active, workspace.notes, workspace.contextLibrary)
      : undefined
  }, [workspace.notes, workspace.activeNoteId, workspace.contextLibrary])
  const settings = workspace.settings
  const font = FONTS.find(item => item.name === settings.fontFamily) ?? FONTS[0]
  const hasLocalModel =
    settings.localEngine === 'embedded' ||
    (settings.localEngine === 'server' &&
      Boolean(settings.profiles.local.model.trim()))
  const usingExternal =
    settings.provider !== 'local' && settings.externalAutoEnabled
  const visibleNotes = useMemo(() => {
    const recent = [...workspace.notes].sort(
      (a, b) => b.updatedAt - a.updatedAt
    )
    const query = search.toLocaleLowerCase()
    if (!query) return recent
    return recent.filter(
      item =>
        item.title.toLocaleLowerCase().includes(query) ||
        item.content.toLocaleLowerCase().includes(query)
    )
  }, [workspace.notes, search])
  const activeWordCount = useMemo(
    () => wordCount(note?.content ?? ''),
    [note?.content]
  )
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
    const timer = setTimeout(() => setNotice(''), 6500)
    return () => clearTimeout(timer)
  }, [notice])
  const activeTitle = note?.title
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
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey
      )
        return
      const key = event.key.toLowerCase()
      if (document.querySelector('[role="dialog"]')) {
        if (
          ['n', 'o', 's', ',', 'b', 'p'].includes(key) ||
          (key === 'f' && event.shiftKey)
        )
          event.preventDefault()
        return
      }
      if (key === 'n') {
        event.preventDefault()
        setNewNoteOpen(true)
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
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault()
        setFocusMode(value => !value)
      } else if (key === 'p') {
        event.preventDefault()
        setSidebarVisible(true)
        setFocusMode(false)
        setTimeout(() => recentSearch.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFile, exportNote, showPreferences, toggleNotes])

  nativeHandlers.current = {
    'menu-new-note': () => setNewNoteOpen(true),
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

  const appendContext = (activeId: string | null, source: ContextSource) => {
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
      assertWorkspaceFits(next)
      added = true
      return next
    })
    return added
  }
  const attachLibrary = (id: string) => {
    const current = getWorkspace()
    const source = current.contextLibrary?.find(item => item.id === id)
    if (!source) return
    try {
      appendContext(current.activeNoteId, source)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }
  const detachLibrary = (id: string) => {
    const current = getWorkspace()
    const active = current.notes.find(item => item.id === current.activeNoteId)
    if (active)
      updateNote(active.id, {
        sources: active.sources.filter(source => source.libraryId !== id),
      })
  }
  const removeLibrary = (id: string) =>
    setWorkspace(value => ({
      ...value,
      contextLibrary: value.contextLibrary?.filter(source => source.id !== id),
      notes: value.notes.map(item =>
        item.sources.some(source => source.libraryId === id)
          ? {
              ...item,
              sources: item.sources.filter(source => source.libraryId !== id),
              updatedAt: Math.max(
                Date.now(),
                item.updatedAt + 1,
                (item.exportedAt ?? 0) + 1
              ),
            }
          : item
      ),
    }))

  const addSources = async (files: FileList | null) => {
    const activeId = getWorkspace().activeNoteId
    if (!files?.length) return
    const selectedFiles = Array.from(files).filter(
      file =>
        !file.webkitRelativePath ||
        /\.(txt|text|md|markdown|mdown|pdf|docx)$/i.test(file.name)
    )
    if (!selectedFiles.length) {
      notify('This folder has no supported text, Markdown, PDF or Word files.')
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
          const source = {
            ...(await importContextFile(file, controller.signal)),
            folder: contextFolder(file),
          }
          if (!controller.signal.aborted && !appendContext(activeId, source))
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
      appendContext(activeId, source)
      setWebsiteOpen(false)
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

  const useNoteAsContext = (id: string) => {
    const current = getWorkspace()
    const target = current.notes.find(item => item.id === id)
    if (!target) return
    try {
      appendContext(current.activeNoteId, linkNoteSource(target))
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    }
  }

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
      className={`app-shell ${!sidebarVisible || focusMode ? 'sidebar-hidden' : ''} ${focusMode ? 'focus-mode' : ''}`}
    >
      <aside className="note-sidebar" aria-label="Notebook">
        <div className="sidebar-brand" data-tauri-drag-region>
          <SquarePen size={21} strokeWidth={1.6} />
          <span>TypeNext</span>
          <span className="brand-detail">a place for your words</span>
        </div>
        <div className="sidebar-actions">
          <button
            className="button new-note-button"
            onClick={() => setNewNoteOpen(true)}
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
            <Paperclip size={16} /> Context library{' '}
            <span>{workspace.contextLibrary?.length ?? 0}</span>
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
        <div className="notes-section-heading">
          <span>Your notes</span>
          <span>{workspace.notes.length}</span>
        </div>
        <div className="note-list">
          {visibleNotes.map(item => (
            <div
              key={item.id}
              className={`note-list-item ${note?.id === item.id ? 'active' : ''}`}
            >
              <button
                className="note-select"
                onClick={() => selectNote(item)}
                aria-current={note?.id === item.id ? 'page' : undefined}
              >
                <FileText size={16} />
                <span>
                  <strong>{item.title}</strong>
                  <small>
                    {relativeDate(item.updatedAt)}
                    {item.sources.length > 0
                      ? ` · ${item.sources.length} source${item.sources.length > 1 ? 's' : ''}`
                      : ''}
                  </small>
                </span>
              </button>
              <button
                className="icon-button note-delete"
                aria-label={`Delete ${item.title}`}
                onClick={() => setDeleteId(item.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!visibleNotes.length && (
            <p className="sidebar-empty">
              {search
                ? 'No notes match your search.'
                : 'Your notes will feel at home here.'}
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-promise">
            {usingExternal ? <Cloud size={16} /> : <ShieldCheck size={16} />}
            <span>
              {usingExternal
                ? `${PROVIDERS[settings.provider]} active`
                : 'Local by default'}
              <small>
                {usingExternal
                  ? 'Context is shared for suggestions.'
                  : 'Your writing stays with you.'}
              </small>
            </span>
          </div>
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
              <span>Notebook</span>
              <ChevronRight size={13} />
              <span>{note?.title ?? 'A fresh start'}</span>
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
                  title="Dictate on this device"
                  onClick={() => {
                    dictationNoteId.current = note.id
                    setDictationOpen(true)
                  }}
                >
                  <Mic size={17} />
                </button>
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
                <button
                  className="icon-button"
                  aria-label={
                    focusMode ? 'Leave focus mode' : 'Enter focus mode'
                  }
                  title="Focus mode (Ctrl / ⌘ Shift F)"
                  onClick={() => setFocusMode(value => !value)}
                >
                  <Focus size={17} />
                </button>
              </>
            )}
            {isDesktop() && (
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
                    <span>{item.title}</span>
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close ${item.title} tab`}
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
              onClick={() => setNewNoteOpen(true)}
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
                      value={note.title}
                      maxLength={160}
                      placeholder="Untitled"
                      onChange={event =>
                        updateNote(note.id, { title: event.target.value })
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
                      settings={settings}
                      onChange={content => updateNote(note.id, { content })}
                      onStatus={setStatus}
                      requestToken={requestToken}
                    />
                    {!note.content && (
                      <div className="blank-page-hint">
                        <Keyboard size={14} />
                        {settings.suggestionsEnabled ? (
                          <span>
                            {settings.autoSuggest
                              ? 'Write a thought. Pause for a suggestion, or press '
                              : 'Write a thought. Press '}
                            <kbd>Ctrl / ⌘ Space</kbd> to explore a few ways
                            forward.
                          </span>
                        ) : (
                          <span>
                            Your page is ready. Write at your own pace.
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
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
                        <LoaderCircle size={13} className="spin" />
                        <span>Finding a continuation…</span>
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
                            · <kbd>Ctrl / ⌘ →</kbd> a word
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
                        Suggest at the cursor <kbd>Ctrl / ⌘ Space</kbd>
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
                  <span>
                    {activeWordCount.toLocaleString()} word
                    {activeWordCount !== 1 ? 's' : ''}
                    <span className="footer-divider">·</span>Markdown
                  </span>
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
                  note={note}
                  notes={workspace.notes}
                  library={workspace.contextLibrary}
                  onLibrary={() => setLibraryOpen(true)}
                  onUseNote={useNoteAsContext}
                  importing={importing}
                  onClose={() => setContextVisible(false)}
                  onUpdate={patch => updateNote(note.id, patch)}
                  onFiles={addSources}
                  onWebsite={() => setWebsiteOpen(true)}
                />
              )}
            </>
          ) : (
            <section className="welcome-view">
              <div className="welcome-mark">
                <SquarePen size={32} strokeWidth={1.25} />
              </div>
              <h1>A little room to think.</h1>
              <p>
                Your words, at your pace.
                <br />A suggestion when you need one.
              </p>
              <div className="welcome-actions">
                <button
                  className="button primary"
                  onClick={() => setNewNoteOpen(true)}
                >
                  <Plus size={16} />
                  Start a note
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
              {workspace.notes.length > 0 && (
                <button
                  className="return-to-note"
                  onClick={() => {
                    const latest = visibleNotes[0] ?? workspace.notes[0]
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
      <Modal
        open={newNoteOpen}
        onOpenChange={setNewNoteOpen}
        title="Where would you like to begin?"
        description="Give this note a name and a little direction. You can change both anytime."
      >
        <form
          onSubmit={event => {
            event.preventDefault()
            if (!draftTitle.trim()) return
            try {
              const created = newNote(draftTitle, draftContext)
              setWorkspace(value => {
                const next = openNote(value, created)
                assertWorkspaceFits(next)
                return next
              })
              setNewNoteOpen(false)
              setDraftTitle('')
              setDraftContext('')
              setStatus({ state: 'idle' })
            } catch (error) {
              notify(error instanceof Error ? error.message : String(error))
            }
          }}
        >
          <label className="field-label" htmlFor="new-note-title">
            Title
          </label>
          <input
            id="new-note-title"
            value={draftTitle}
            onChange={event => setDraftTitle(event.target.value)}
            placeholder="A thought worth following"
            required
            maxLength={160}
          />
          <label className="field-label" htmlFor="new-note-context">
            Context for suggestions{' '}
            <span className="optional-label">optional</span>
          </label>
          <textarea
            id="new-note-context"
            rows={4}
            value={draftContext}
            onChange={event => setDraftContext(event.target.value)}
            placeholder="What are you writing? Who is it for? A tone, a point of view, or a few details…"
          />
          <p className="field-help">
            Keep the first line for your objective if that helps. Context stays
            local unless you enable an external model.
          </p>
          <div className="dialog-footer">
            <button
              type="button"
              className="button subtle"
              onClick={() => setNewNoteOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={!draftTitle.trim()}
            >
              Create note
              <ChevronRight size={15} />
            </button>
          </div>
        </form>
      </Modal>
      <DictationDialog
        open={dictationOpen}
        onOpenChange={setDictationOpen}
        onInsert={text => {
          if (
            getWorkspace().activeNoteId !== dictationNoteId.current ||
            !editorRef.current
          )
            throw new Error(
              'Return to the note where you started dictation before inserting this transcript.'
            )
          editorRef.current.insert(text)
        }}
      />
      <ContextLibrary
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        library={workspace.contextLibrary ?? []}
        notes={workspace.notes}
        activeNote={note ?? null}
        importing={importing}
        onAttach={attachLibrary}
        onDetach={detachLibrary}
        onRemove={removeLibrary}
        onFiles={addSources}
        onWebsite={() => {
          setLibraryOpen(false)
          setWebsiteOpen(true)
        }}
        onUseNote={useNoteAsContext}
      />
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
