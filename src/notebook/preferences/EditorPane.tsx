import { useId, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { EditorSettings, SlashCommandSetting } from '../../types/notebook'
import { Group, Row, Section, Segmented, SwitchRow } from './controls'
import type { PaneProps } from './types'

const TOKENS = ['{cursor}', '{date}', '{time}'] as const
const MAX_COMMANDS = 64

/** One printable symbol: no letters, digits or spaces. */
export function validTrigger(value: string): boolean {
  return [...value].length === 1 && !/[\p{L}\p{N}\s]/u.test(value)
}

function commandId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function TemplatePreview({ template }: { template: string }) {
  const parts = template.split(/(\{cursor\}|\{date\}|\{time\})/u)
  return (
    <span className="pref-template-preview">
      {parts.map((part, index) =>
        (TOKENS as readonly string[]).includes(part) ? (
          <span className="pref-token" key={index}>
            {part.slice(1, -1)}
          </span>
        ) : (
          <span key={index}>{part.replace(/\n/gu, ' ↵ ')}</span>
        )
      )}
    </span>
  )
}

function CommandForm({
  initial,
  trigger,
  taken,
  onSave,
  onCancel,
}: {
  initial: SlashCommandSetting
  trigger: string
  taken: string[]
  onSave(command: SlashCommandSetting): void
  onCancel(): void
}) {
  const id = useId()
  const [name, setName] = useState(initial.name)
  const [template, setTemplate] = useState(initial.template)
  const [tried, setTried] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const trimmed = name.trim()
  const duplicate = taken.some(
    other => other.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
  )
  const error = !trimmed
    ? 'Give the command a name.'
    : duplicate
      ? 'Another custom command already has this name.'
      : !template.trim()
        ? 'Add the text to insert.'
        : ''
  const insertToken = (token: string) => {
    const element = area.current
    const start = element?.selectionStart ?? template.length
    const end = element?.selectionEnd ?? template.length
    const next = template.slice(0, start) + token + template.slice(end)
    setTemplate(next)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  return (
    <form
      className="pref-command-form"
      data-escape-local="true"
      aria-label={initial.name ? `Edit ${initial.name}` : 'New command'}
      onSubmit={event => {
        event.preventDefault()
        setTried(true)
        if (error) return
        onSave({ ...initial, name: trimmed, template })
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          // Preferences ignores this Escape; it only discards the draft.
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <label className="pref-field-label" htmlFor={`${id}-name`}>
        Command name
      </label>
      <input
        id={`${id}-name`}
        value={name}
        maxLength={48}
        autoFocus
        placeholder="Meeting notes"
        aria-invalid={tried && (!trimmed || duplicate)}
        onChange={event => setName(event.target.value)}
      />
      <label className="pref-field-label" htmlFor={`${id}-template`}>
        Text to insert
      </label>
      <textarea
        id={`${id}-template`}
        ref={area}
        rows={4}
        maxLength={4000}
        value={template}
        spellCheck={false}
        placeholder={'## Meeting · {date}\n\n- {cursor}'}
        aria-invalid={tried && !template.trim()}
        onChange={event => setTemplate(event.target.value)}
      />
      <div className="pref-token-bar">
        <span>Insert</span>
        {TOKENS.map(token => (
          <button
            key={token}
            type="button"
            className="pref-chip"
            onClick={() => insertToken(token)}
          >
            {token}
          </button>
        ))}
      </div>
      <p className="pref-help">
        Markdown is inserted as written. <code>{'{cursor}'}</code> places the
        caret, <code>{'{date}'}</code> and <code>{'{time}'}</code> become
        today’s date and the current time. Type <kbd>{trigger}</kbd> and the
        name to use it.
      </p>
      {tried && error && (
        <p className="pref-status tone-error" role="alert">
          {error}
        </p>
      )}
      <div className="pref-form-actions">
        <button
          type="button"
          className="button subtle is-compact"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="button primary is-compact">
          Save command
        </button>
      </div>
    </form>
  )
}

function CustomCommands({
  editor,
  onChange,
}: {
  editor: EditorSettings
  onChange(commands: SlashCommandSetting[]): void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<SlashCommandSetting | null>(null)
  const commands = editor.customCommands
  const addButton = useRef<HTMLButtonElement | null>(null)
  const close = () => {
    setEditing(null)
    setDraft(null)
    requestAnimationFrame(() => addButton.current?.focus())
  }
  return (
    <div className="pref-commands">
      {commands.length === 0 && !draft && (
        <p className="pref-empty">
          No custom commands yet. Add snippets you type often, like a meeting
          header or a sign-off.
        </p>
      )}
      {commands.length > 0 && (
        <ul className="pref-command-list" aria-label="Custom commands">
          {commands.map(command =>
            editing === command.id ? (
              <li key={command.id} className="is-editing">
                <CommandForm
                  initial={command}
                  trigger={editor.slashTrigger}
                  taken={commands
                    .filter(other => other.id !== command.id)
                    .map(other => other.name)}
                  onCancel={close}
                  onSave={next => {
                    onChange(
                      commands.map(item => (item.id === next.id ? next : item))
                    )
                    close()
                  }}
                />
              </li>
            ) : (
              <li key={command.id}>
                <span className="pref-command-text">
                  <span className="pref-command-name">
                    <kbd>{editor.slashTrigger}</kbd>
                    {command.name}
                  </span>
                  <TemplatePreview template={command.template} />
                </span>
                <span className="pref-command-actions">
                  <button
                    type="button"
                    className="pref-icon-button"
                    aria-label={`Edit ${command.name}`}
                    onClick={() => {
                      setDraft(null)
                      setEditing(command.id)
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="pref-icon-button is-danger"
                    aria-label={`Delete ${command.name}`}
                    onClick={() => {
                      onChange(commands.filter(item => item.id !== command.id))
                      requestAnimationFrame(() => addButton.current?.focus())
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </li>
            )
          )}
        </ul>
      )}
      {draft && (
        <CommandForm
          initial={draft}
          trigger={editor.slashTrigger}
          taken={commands.map(command => command.name)}
          onCancel={close}
          onSave={next => {
            onChange([...commands, next])
            close()
          }}
        />
      )}
      {!draft && (
        <button
          ref={addButton}
          type="button"
          className="button secondary is-compact pref-add"
          disabled={commands.length >= MAX_COMMANDS}
          onClick={() => {
            setEditing(null)
            setDraft({ id: commandId(), name: '', template: '' })
          }}
        >
          <Plus size={14} /> Add command
        </button>
      )}
    </div>
  )
}

export function EditorPane({ settings, update, latest }: PaneProps) {
  const editor = settings.editor
  const [trigger, setTrigger] = useState(editor.slashTrigger)
  const triggerValid = validTrigger(trigger)
  const patch = (next: Partial<EditorSettings>) =>
    update({ editor: { ...latest().editor, ...next } })
  return (
    <>
      <Section
        title="Insert menu"
        description="Headings, lists, tables and your own snippets, a keystroke away."
      >
        <Group>
          <SwitchRow
            label="Insert menu"
            description={`Type ${editor.slashTrigger} at the start of a word to open it.`}
            checked={editor.slashMenu}
            onChange={slashMenu => patch({ slashMenu })}
          />
          <Row
            label="Trigger character"
            htmlFor="slash-trigger"
            description={
              triggerValid
                ? 'One symbol, such as / or ;'
                : 'Use one symbol. Letters, numbers and spaces would open the menu while you write.'
            }
          >
            <input
              id="slash-trigger"
              className="pref-trigger-input"
              value={trigger}
              maxLength={2}
              disabled={!editor.slashMenu}
              aria-invalid={!triggerValid}
              spellCheck={false}
              autoComplete="off"
              onChange={event => {
                const value = [...event.target.value].slice(-1).join('')
                setTrigger(value)
                if (validTrigger(value)) patch({ slashTrigger: value })
              }}
              onBlur={() => {
                if (!validTrigger(trigger))
                  setTrigger(latest().editor.slashTrigger)
              }}
            />
          </Row>
        </Group>
        <h4 className="pref-subheading">Custom commands</h4>
        <p className="pref-help is-lead">
          A custom command with the same name as a built-in one (for example
          “Table”) replaces it.
        </p>
        <CustomCommands
          editor={editor}
          onChange={customCommands => patch({ customCommands })}
        />
      </Section>
      <Section title="Reading while writing">
        <Group>
          <SwitchRow
            label="Live preview"
            description="Render bullets, task boxes, rules and tables when the cursor is elsewhere."
            checked={editor.livePreview}
            onChange={livePreview => patch({ livePreview })}
          />
          <Row
            label="Link previews"
            description={
              editor.linkPreviews === 'off'
                ? 'Links stay plain text on hover.'
                : editor.linkPreviews === 'notes'
                  ? 'Hovering a link to another note shows its opening lines.'
                  : 'Notes, plus website titles on hover. Fetching a title contacts that website.'
            }
          >
            <Segmented
              label="Link previews"
              value={editor.linkPreviews}
              onChange={linkPreviews => patch({ linkPreviews })}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'notes', label: 'Notes' },
                { value: 'all', label: 'Notes & web' },
              ]}
            />
          </Row>
        </Group>
      </Section>
    </>
  )
}
