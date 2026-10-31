import { useRef, type KeyboardEvent } from 'react'
import {
  BookOpen,
  Cpu,
  Globe,
  Keyboard,
  PenLine,
  Sparkles,
  TextCursorInput,
  type LucideIcon,
  GitBranch,
  Mic,
  ArrowUpCircle,
  History,
  Cloud,
} from 'lucide-react'
import type { Note, NoteSpace, NotebookSettings } from '../types/notebook'
import { Modal } from './Modal'
import { EditorPane } from './preferences/EditorPane'
import { KnowledgePane } from './preferences/KnowledgePane'
import { ModelsPane } from './preferences/ModelsPane'
import { ShortcutsPane } from './preferences/ShortcutsPane'
import { SuggestionsPane } from './preferences/SuggestionsPane'
import {
  mainPane,
  type MainPane,
  type PaneProps,
  type PreferencePane,
} from './preferences/types'
import { WebFactsPane } from './preferences/WebFactsPane'
import { SyncPane } from './preferences/SyncPane'
import { CloudPane } from './preferences/CloudPane'
import { DictationPane } from './preferences/DictationPane'
import { UpdatesPane } from './preferences/UpdatesPane'
import { HistoryPane } from './preferences/HistoryPane'
import { WritingPane } from './preferences/WritingPane'
import './preferences.css'

export type { PreferencePane } from './preferences/types'

export const PREFERENCE_PANES: {
  id: MainPane
  label: string
  description: string
  icon: LucideIcon
}[] = [
  {
    id: 'writing',
    label: 'Writing',
    description: 'Type, colour and the quiet around the page.',
    icon: PenLine,
  },
  {
    id: 'editor',
    label: 'Editor',
    description: 'The insert menu, your snippets and live preview.',
    icon: TextCursorInput,
  },
  {
    id: 'suggestions',
    label: 'Suggestions',
    description: 'When and how continuations appear.',
    icon: Sparkles,
  },
  {
    id: 'models',
    label: 'Models',
    description: 'Choose what writes your suggestions.',
    icon: Cpu,
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    description: 'How TypeNext finds the right passages in your references.',
    icon: BookOpen,
  },
  {
    id: 'web',
    label: 'Web facts',
    description: 'Cited facts from the web, only when you ask.',
    icon: Globe,
  },
  {
    id: 'dictation',
    label: 'Dictation',
    description: 'Speech engine, microphone and voice commands.',
    icon: Mic,
  },
  {
    id: 'history',
    label: 'History',
    description: 'Versions of every note, with or without Git.',
    icon: History,
  },
  {
    id: 'cloud',
    label: 'Cloud sync',
    description: 'Your notebook on every device, end-to-end encrypted.',
    icon: Cloud,
  },
  {
    id: 'sync',
    label: 'Git sync',
    description: 'Keep notes in a Git repository.',
    icon: GitBranch,
  },
  {
    id: 'updates',
    label: 'Updates',
    description: 'New versions, checked and installed with your say.',
    icon: ArrowUpCircle,
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Keys for everyday writing.',
    icon: Keyboard,
  },
]

export function Preferences({
  open,
  onOpenChange,
  pane,
  onPaneChange,
  settings,
  onChange,
  cloud,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  pane: PreferencePane
  onPaneChange(pane: PreferencePane): void
  settings: NotebookSettings
  onChange(settings: NotebookSettings): void
  /** What Cloud sync shows beside its settings. */
  cloud?: {
    notes: Note[]
    spaces: NoteSpace[]
    onLinkFiles(paths: Record<string, string>): void
  }
}) {
  const tabs = useRef<Partial<Record<MainPane, HTMLButtonElement | null>>>({})
  const latest = useRef(settings)
  latest.current = settings
  const active = mainPane(pane)
  const current =
    PREFERENCE_PANES.find(item => item.id === active) ?? PREFERENCE_PANES[0]!
  const props: PaneProps = {
    settings,
    update: patch => {
      // Successive updates in one event build on each other.
      const next = { ...latest.current, ...patch }
      latest.current = next
      onChange(next)
    },
    latest: () => latest.current,
    onPaneChange,
  }
  const onRailKey = (event: KeyboardEvent<HTMLButtonElement>, id: MainPane) => {
    const order = PREFERENCE_PANES.map(item => item.id)
    const index = order.indexOf(id)
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? order[(index + 1) % order.length]
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? order[(index + order.length - 1) % order.length]
          : event.key === 'Home'
            ? order[0]
            : event.key === 'End'
              ? order[order.length - 1]
              : undefined
    if (!next) return
    event.preventDefault()
    onPaneChange(next)
    tabs.current[next]?.focus()
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Make yourself at home"
      description="A few preferences for your writing space."
      className="preferences-dialog"
      onEscapeKeyDown={event => {
        // Radix sees Escape before the input's own key handler. Let an invalid
        // colour draft restore its last saved value, or a snippet draft close,
        // before closing Preferences.
        const target = event.target
        if (
          target instanceof HTMLElement &&
          (target.dataset.invalidPaletteDraft === 'true' ||
            target.closest('[data-escape-local="true"]'))
        )
          event.preventDefault()
      }}
    >
      <nav className="prefs-rail" aria-label="Preference sections">
        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label="Preferences"
          className="prefs-rail-list"
        >
          {PREFERENCE_PANES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              ref={element => {
                tabs.current[id] = element
              }}
              id={`tab-${id}`}
              type="button"
              role="tab"
              className="prefs-rail-item"
              tabIndex={active === id ? 0 : -1}
              aria-selected={active === id}
              aria-controls={`pane-${id}`}
              onClick={() => onPaneChange(id)}
              onKeyDown={event => onRailKey(event, id)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="prefs-main">
        <div
          className="preference-body"
          role="tabpanel"
          id={`pane-${active}`}
          aria-labelledby={`tab-${active}`}
          key={active}
          tabIndex={-1}
        >
          <header className="prefs-pane-header">
            <h2>{current.label}</h2>
            <p>{current.description}</p>
          </header>
          <div className="prefs-pane">
            {active === 'writing' && <WritingPane {...props} />}
            {active === 'editor' && <EditorPane {...props} />}
            {active === 'suggestions' && <SuggestionsPane {...props} />}
            {active === 'models' && (
              <ModelsPane
                {...props}
                focus={
                  pane === 'local' || pane === 'external' ? pane : undefined
                }
              />
            )}
            {active === 'knowledge' && <KnowledgePane {...props} />}
            {active === 'web' && <WebFactsPane {...props} />}
            {active === 'cloud' && (
              <CloudPane
                {...props}
                notes={cloud?.notes ?? []}
                spaces={cloud?.spaces ?? []}
                onLinkFiles={paths => cloud?.onLinkFiles(paths)}
              />
            )}
            {active === 'sync' && <SyncPane {...props} />}
            {active === 'history' && <HistoryPane {...props} />}
            {active === 'dictation' && <DictationPane {...props} />}
            {active === 'updates' && <UpdatesPane {...props} />}
            {active === 'shortcuts' && <ShortcutsPane {...props} />}
          </div>
        </div>
        <div className="dialog-footer prefs-footer">
          <span className="field-help">
            Preferences are saved with your notebook.
          </span>
          <button
            type="button"
            className="button primary"
            onClick={() => onOpenChange(false)}
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  )
}
