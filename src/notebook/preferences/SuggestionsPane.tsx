import { ArrowRight } from 'lucide-react'
import type { NotebookSettings } from '../../types/notebook'
import { Group, Row, Section, SwitchRow } from './controls'
import { engineSummary } from './engine'
import type { PaneProps } from './types'

export function SuggestionsPane({ settings, update, onPaneChange }: PaneProps) {
  const engine = engineSummary(settings)
  return (
    <>
      <Section
        title="Inline suggestions"
        description="Short continuations at the cursor. You choose what enters the page."
        aside={
          <button
            type="button"
            className="pref-engine-link"
            onClick={() => onPaneChange('models')}
          >
            <span>
              <small>Written by</small>
              {engine.title}
            </span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        }
      >
        <Group>
          <SwitchRow
            label="Inline suggestions"
            description="Tab accepts, Escape dismisses."
            checked={settings.suggestionsEnabled}
            onChange={suggestionsEnabled => update({ suggestionsEnabled })}
          />
          <SwitchRow
            label="Suggest after a pause"
            description="Otherwise press Ctrl / ⌘ Space to choose a continuation."
            checked={settings.autoSuggest}
            disabled={!settings.suggestionsEnabled}
            onChange={autoSuggest => update({ autoSuggest })}
          />
          <Row label="Suggestion length" htmlFor="suggestion-length">
            <select
              id="suggestion-length"
              value={settings.suggestionLength}
              onChange={event =>
                update({
                  suggestionLength: event.target
                    .value as NotebookSettings['suggestionLength'],
                })
              }
            >
              <option value="adaptive">Adapt to the sentence</option>
              <option value="short">Just a few words</option>
              <option value="sentence">Up to one sentence</option>
            </select>
          </Row>
          <Row label="Pause before suggesting" htmlFor="suggestion-pause">
            <select
              id="suggestion-pause"
              value={settings.suggestionDelay}
              onChange={event =>
                update({ suggestionDelay: Number(event.target.value) })
              }
            >
              <option value={650}>Quick (0.65s)</option>
              <option value={1100}>Natural (1.1s)</option>
              <option value={1800}>Unhurried (1.8s)</option>
            </select>
          </Row>
          <Row label="Creativity" htmlFor="suggestion-temperature" stacked>
            <span className="pref-range">
              <input
                id="suggestion-temperature"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.temperature}
                aria-valuetext={settings.temperature.toFixed(2)}
                onChange={event =>
                  update({ temperature: Number(event.target.value) })
                }
              />
              <output htmlFor="suggestion-temperature">
                {settings.temperature.toFixed(2)}
              </output>
            </span>
            <span className="pref-range-labels" aria-hidden="true">
              <span>Stay close</span>
              <span>Explore a little</span>
            </span>
          </Row>
        </Group>
      </Section>
      <Section
        title="Instructions"
        description="Applied to every model with the chosen length. They never change your text by themselves."
      >
        <label className="pref-field-label" htmlFor="suggestion-instructions">
          Suggestion instructions
        </label>
        <textarea
          id="suggestion-instructions"
          rows={4}
          maxLength={2000}
          value={settings.suggestionInstructions}
          onChange={event =>
            update({ suggestionInstructions: event.target.value })
          }
          placeholder="Keep my voice. Prefer concrete language. For a few words, finish the phrase; for a line, add one concise sentence."
        />
        <p className="pref-help pref-counter">
          {settings.suggestionInstructions.length} / 2000
        </p>
      </Section>
    </>
  )
}
