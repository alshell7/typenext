import { Section } from './controls'
import type { PaneProps } from './types'

function groups(trigger: string) {
  return [
    {
      title: 'Notes',
      items: [
        ['New note', 'Ctrl / ⌘ N'],
        ['Open a file', 'Ctrl / ⌘ O'],
        ['Save', 'Ctrl / ⌘ S'],
        ['Save as', 'Ctrl / ⌘ Shift S'],
        ['Search notes', 'Ctrl / ⌘ P'],
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
        ['Note graph', 'Ctrl / ⌘ Shift G'],
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
        ['Suggest at the cursor', 'Ctrl / ⌘ Space'],
        ['Accept', 'Tab'],
        ['Accept one word', 'Ctrl / ⌘ →'],
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

export function ShortcutsPane({ settings }: PaneProps) {
  const modifier = isMac() ? '⌘' : 'Ctrl'
  return (
    <>
      {groups(settings.editor.slashTrigger).map(group => (
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
