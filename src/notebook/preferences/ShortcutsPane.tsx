import type { ShortcutSettings } from '../../types/notebook'
import { shortcutText } from '../shortcuts'
import { Group, Section } from './controls'
import { ShortcutField } from './ShortcutField'
import type { PaneProps } from './types'

function groups(trigger: string, keys: ShortcutSettings) {
  return [
    {
      title: 'Notes',
      items: [
        ['New note', 'Ctrl / ⌘ N'],
        ['Open a file', 'Ctrl / ⌘ O'],
        ['Save', 'Ctrl / ⌘ S'],
        ['Save as', 'Ctrl / ⌘ Shift S'],
        ['Command palette', 'Ctrl / ⌘ P'],
        ['Show or hide notes', 'Ctrl / ⌘ B'],
        ['Preferences', 'Ctrl / ⌘ ,'],
      ],
    },
    {
      title: 'Writing',
      items: [
        ['Zen mode', 'Ctrl / ⌘ Shift F'],
        ['Dictate on this device', 'Ctrl / ⌘ Shift D'],
        ['Insert menu', trigger],
        ['Search the web for facts', 'Ctrl / ⌘ Shift K'],
        ['AI actions for the selection', shortcutText(keys.aiActions)],
        ['Save a version (History)', 'Ctrl / ⌘ Alt S'],
        ['Open History', 'Ctrl / ⌘ Alt H'],
        ['Note graph', 'Ctrl / ⌘ Shift G'],
        ['Find in the note', 'Ctrl / ⌘ F'],
        ['Find and replace', 'Ctrl / ⌘ Alt F'],
        ['Insert a link', 'Ctrl / ⌘ K'],
        ['Italic', 'Ctrl / ⌘ I'],
        ['Check or uncheck a task', 'Ctrl / ⌘ Enter'],
        ['Open the link at the cursor', 'Alt Enter or Ctrl / ⌘ click'],
        ['Next or previous table cell, indent a list item', 'Tab / Shift Tab'],
      ],
    },
    {
      title: 'Suggestions',
      items: [
        ['Suggest at the cursor', shortcutText(keys.suggest)],
        ['Accept', 'Tab'],
        ['Accept one word', shortcutText(keys.acceptWord)],
        ['Choose another', '↑ ↓'],
        ['Dismiss', 'Esc'],
      ],
    },
  ] as const
}

function isMac() {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent)
}

export function ShortcutsPane({ settings, update, latest }: PaneProps) {
  const modifier = isMac() ? '⌘' : 'Ctrl'
  const keys = settings.shortcuts
  return (
    <>
      <Section
        title="Your keys"
        description="Choose the keys for suggestions and AI. Click a key, then press the new combination."
      >
        <Group>
          {(['suggest', 'acceptWord', 'aiActions'] as const).map(name => (
            <ShortcutField
              key={name}
              name={name}
              shortcuts={keys}
              onChange={binding =>
                update({
                  shortcuts: { ...latest().shortcuts, [name]: binding },
                })
              }
            />
          ))}
        </Group>
      </Section>
      {groups(settings.editor.slashTrigger, keys).map(group => (
        <Section key={group.title} title={group.title}>
          <dl className="pref-shortcuts">
            {group.items.map(([label, keys]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {keys
                    .replace('Ctrl / ⌘', modifier)
                    .split(' ')
                    .map((key, index) => (
                      <kbd key={index}>{key}</kbd>
                    ))}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ))}
    </>
  )
}
