import type { NotebookSettings, ZenLevel } from '../../types/notebook'
import { FONTS } from '../model'
import { PalettePicker } from '../PalettePicker'
import { Group, Row, Section, Segmented, SwitchRow } from './controls'
import type { PaneProps } from './types'

const ZEN: Record<ZenLevel, { label: string; help: string }> = {
  sidebars: {
    label: 'Sidebars',
    help: 'Hides the side panels. Toolbars and tabs stay in view.',
  },
  chrome: {
    label: 'Chrome',
    help: 'Also hides toolbars, tabs and the status bar until you move to an edge.',
  },
  full: {
    label: 'Full',
    help: 'Only the page remains, full screen on desktop.',
  },
}

export function WritingPane({ settings, update }: PaneProps) {
  const family = FONTS.find(font => font.name === settings.fontFamily)?.family
  return (
    <>
      <Section title="Type" description="How your words look on the page.">
        <div className="pref-type-grid">
          <div>
            <label className="pref-field-label" htmlFor="writer-font">
              Typeface
            </label>
            <select
              id="writer-font"
              value={settings.fontFamily}
              onChange={event =>
                update({
                  fontFamily: event.target.value,
                  ...(event.target.value === 'Times New Roman'
                    ? { fontSize: 16 }
                    : {}),
                })
              }
            >
              {FONTS.map(font => (
                <option key={font.name}>{font.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="pref-field-label" htmlFor="writer-size">
              Size (px)
            </label>
            <input
              id="writer-size"
              type="number"
              min={12}
              max={32}
              value={settings.fontSize}
              onChange={event =>
                update({
                  fontSize: Math.min(
                    32,
                    Math.max(12, Number(event.target.value) || 17)
                  ),
                })
              }
            />
          </div>
        </div>
        <div
          className="pref-font-preview"
          style={{ fontFamily: family, fontSize: settings.fontSize }}
          aria-hidden="true"
        >
          A thought becomes a sentence.
          <br />A sentence becomes a beginning.
        </div>
      </Section>
      <Section
        title="Appearance"
        description="Light, dark, and the colours of each."
      >
        <Group>
          <Row label="Theme">
            <Segmented
              label="Appearance"
              value={settings.theme}
              onChange={theme => update({ theme })}
              options={
                [
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ] satisfies {
                  value: NotebookSettings['theme']
                  label: string
                }[]
              }
            />
          </Row>
        </Group>
        <PalettePicker settings={settings} onChange={next => update(next)} />
      </Section>
      <Section
        title="Zen mode"
        description={
          <>
            What steps aside when you press <kbd>Ctrl / ⌘ Shift F</kbd>.
          </>
        }
      >
        <Group>
          <Row label="Hide" description={ZEN[settings.zenLevel].help}>
            <Segmented
              label="Zen mode"
              value={settings.zenLevel}
              onChange={zenLevel => update({ zenLevel })}
              options={(Object.keys(ZEN) as ZenLevel[]).map(value => ({
                value,
                label: ZEN[value].label,
              }))}
            />
          </Row>
        </Group>
      </Section>
      <Section title="Saving">
        <Group>
          <SwitchRow
            label="Autosave"
            description="Keep a local copy as you write."
            checked={settings.autoSave}
            onChange={autoSave => update({ autoSave })}
          />
        </Group>
      </Section>
    </>
  )
}
