import { ArrowRight } from 'lucide-react'
import type { NotebookSettings } from '../../types/notebook'
import { Group, Row, Section, SwitchRow } from './controls'
import { engineSummary } from './engine'
import type { PaneProps } from './types'

function seconds(value: number) {
  return value < 1000
    ? `${value} ms`
    : `${(value / 1000).toFixed(value % 1000 ? 2 : 0)} s`
}

function TimingRange({
  id,
  min,
  max,
  step,
  value,
  onChange,
  labels,
}: {
  id: string
  min: number
  max: number
  step: number
  value: number
  onChange(value: number): void
  labels: [string, string]
}) {
  return (
    <>
      <span className="pref-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={seconds(value)}
          onChange={event => onChange(Number(event.target.value))}
        />
        <output htmlFor={id}>{seconds(value)}</output>
      </span>
      <span className="pref-range-labels" aria-hidden="true">
        <span>{labels[0]}</span>
        <span>{labels[1]}</span>
      </span>
    </>
  )
}

export function SuggestionsPane({
  settings,
  update,
  latest,
  onPaneChange,
}: PaneProps) {
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
        title="Timing"
        description="How long TypeNext waits before it offers a suggestion, and other small delays."
      >
        <Group>
          <Row
            label="Pause before suggesting"
            htmlFor="suggestion-pause"
            stacked
          >
            <TimingRange
              id="suggestion-pause"
              min={200}
              max={3000}
              step={50}
              value={settings.suggestionDelay}
              onChange={suggestionDelay => update({ suggestionDelay })}
              labels={['Quick', 'Unhurried']}
            />
          </Row>
          <SwitchRow
            label="Adapt to my rhythm"
            description="Wait longer while you type quickly. Offer sooner at a sentence end or after you accept a suggestion."
            checked={settings.timing.adaptiveDelay}
            onChange={adaptiveDelay =>
              update({ timing: { ...latest().timing, adaptiveDelay } })
            }
          />
          <Row
            label="Characters before suggesting"
            htmlFor="suggestion-min-characters"
          >
            <input
              id="suggestion-min-characters"
              type="number"
              min={0}
              max={200}
              value={settings.timing.minCharacters}
              onChange={event =>
                update({
                  timing: {
                    ...latest().timing,
                    minCharacters: Math.min(
                      200,
                      Math.max(0, Math.round(Number(event.target.value) || 0))
                    ),
                  },
                })
              }
            />
          </Row>
          <Row label="Link preview delay" htmlFor="hover-delay" stacked>
            <TimingRange
              id="hover-delay"
              min={0}
              max={1500}
              step={50}
              value={settings.timing.hoverDelay}
              onChange={hoverDelay =>
                update({ timing: { ...latest().timing, hoverDelay } })
              }
              labels={['At once', 'Slow']}
            />
          </Row>
          <Row label="Meaning index delay" htmlFor="index-delay" stacked>
            <TimingRange
              id="index-delay"
              min={200}
              max={10000}
              step={100}
              value={settings.timing.indexDelay}
              onChange={indexDelay =>
                update({ timing: { ...latest().timing, indexDelay } })
              }
              labels={['Soon after edits', 'When writing pauses']}
            />
          </Row>
        </Group>
        <p className="pref-help">
          New link preview delays apply to notes you open next.
        </p>
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
