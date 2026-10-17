import { ArrowRight, Ban } from 'lucide-react'
import type { AiIndicatorStyle } from '../../types/notebook'
import {
  Group,
  Row,
  Section,
  Segmented,
  SwitchRow,
  TileGroup,
} from './controls'
import { AiPulse } from '../AiPulse'
import { PULSE_STYLES } from '../../components/notebook/ai-pulse'
import { aiEngine } from '../../services/text-actions'
import { shortcutKeys } from '../shortcuts'
import { useState } from 'react'
import { INSTRUCTION_TEMPLATES } from './instruction-templates'
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
          <Row
            label="Suggestion length"
            description={
              settings.suggestionWords > 0
                ? `Up to ${settings.suggestionWords} ${settings.suggestionWords === 1 ? 'word' : 'words'}, wherever you write. Table cells and headings stay short.`
                : settings.suggestionLength === 'short'
                  ? 'Just a few words: finish the phrase.'
                  : settings.suggestionLength === 'sentence'
                    ? 'Up to one sentence.'
                    : 'A word inside a sentence, a phrase mid-line, a sentence after a full stop.'
            }
            stacked={settings.suggestionWords > 0}
          >
            <Segmented
              label="Suggestion length"
              value={
                settings.suggestionWords > 0
                  ? 'custom'
                  : settings.suggestionLength
              }
              onChange={value =>
                value === 'custom'
                  ? update({
                      suggestionWords:
                        latest().suggestionWords > 0
                          ? latest().suggestionWords
                          : 12,
                    })
                  : update({ suggestionLength: value, suggestionWords: 0 })
              }
              options={[
                { value: 'adaptive', label: 'Adapt' },
                { value: 'short', label: 'Few words' },
                { value: 'sentence', label: 'Sentence' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
            {settings.suggestionWords > 0 && (
              <>
                <span className="pref-range">
                  <input
                    id="suggestion-words"
                    type="range"
                    min={1}
                    max={60}
                    step={1}
                    value={settings.suggestionWords}
                    aria-label="Most words in a suggestion"
                    aria-valuetext={`${settings.suggestionWords} words`}
                    onChange={event =>
                      update({ suggestionWords: Number(event.target.value) })
                    }
                  />
                  <output htmlFor="suggestion-words">
                    {settings.suggestionWords} words
                  </output>
                </span>
                <span className="pref-range-labels" aria-hidden="true">
                  <span>A word or two</span>
                  <span>A few sentences</span>
                </span>
              </>
            )}
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
      <AiSections
        settings={settings}
        update={update}
        latest={latest}
        onPaneChange={onPaneChange}
      />
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
        <InstructionTemplates
          value={settings.suggestionInstructions}
          onChoose={suggestionInstructions =>
            update({ suggestionInstructions })
          }
        />
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

function AiSections({ settings, update, latest, onPaneChange }: PaneProps) {
  const engine = aiEngine({
    ...settings,
    ai: { ...settings.ai, selectionActions: true },
  })
  const patch = (next: Partial<PaneProps['settings']['ai']>) =>
    update({ ai: { ...latest().ai, ...next } })
  return (
    <>
      <Section
        title="Edit with AI"
        description="Select text, then choose Polish, Fix grammar, Rewrite, Paraphrase, Shorter or Longer. You see every change before it enters the page."
      >
        <Group>
          <SwitchRow
            label="AI actions for selected text"
            description={
              engine
                ? `Written by ${engine.label}. The selection and a little text around it are sent.`
                : 'Activate a chat model in Models to use them. Local recall and the built-in model cannot edit text.'
            }
            checked={settings.ai.selectionActions}
            onChange={selectionActions => patch({ selectionActions })}
          />
          <Row
            label="Open them with"
            description="Or click ✦ AI on the format bar."
          >
            <button
              type="button"
              className="pref-keys-button"
              onClick={() => onPaneChange('shortcuts')}
              title="Change in Shortcuts"
            >
              {shortcutKeys(settings.shortcuts.aiActions).map((key, index) => (
                <kbd key={index}>{key}</kbd>
              ))}
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          </Row>
        </Group>
      </Section>
      <Section
        title="While AI works"
        description="A small animation at the cursor and in the status bar while a model thinks."
      >
        <TileGroup<AiIndicatorStyle>
          label="Animation while AI works"
          className="pref-pulse-tiles"
          value={settings.ai.indicator}
          onChange={indicator => patch({ indicator })}
          options={[
            ...PULSE_STYLES.map(style => ({
              value: style.id,
              title: style.name,
              description:
                style.id === 'orb'
                  ? `${style.description}. The default.`
                  : style.description,
              icon: <AiPulse style={style.id} instant />,
            })),
            {
              value: 'off' as const,
              title: 'Off',
              description: 'Only words in the status bar',
              icon: <Ban size={15} />,
            },
          ]}
        />
      </Section>
    </>
  )
}

/**
 * Starting points for the instructions. Choosing one fills the field; text
 * the writer had is one click away with Undo. A template edited later is no
 * longer marked as chosen.
 */
function InstructionTemplates({
  value,
  onChoose,
}: {
  value: string
  onChoose(text: string): void
}) {
  const [previous, setPrevious] = useState<{
    text: string
    name: string
  } | null>(null)
  const chosen = INSTRUCTION_TEMPLATES.find(
    template => template.text === value.trim()
  )
  return (
    <div className="pref-templates">
      <div className="pref-templates-head">
        <span className="pref-field-label">Start from a template</span>
        {previous && (
          <span className="pref-templates-undo" role="status">
            Using {previous.name}.
            <button
              type="button"
              className="pref-aside-link"
              onClick={() => {
                onChoose(previous.text)
                setPrevious(null)
              }}
            >
              Undo
            </button>
          </span>
        )}
      </div>
      <div
        className="pref-templates-list"
        role="group"
        aria-label="Instruction templates"
      >
        {INSTRUCTION_TEMPLATES.map(template => (
          <button
            key={template.id}
            type="button"
            className="pref-template"
            aria-pressed={chosen?.id === template.id}
            title={template.text}
            onClick={() => {
              if (chosen?.id === template.id) return
              // Offer Undo only when it would bring back the writer's own text.
              setPrevious(
                value.trim() &&
                  !INSTRUCTION_TEMPLATES.some(
                    item => item.text === value.trim()
                  )
                  ? { text: value, name: template.name }
                  : previous && { ...previous, name: template.name }
              )
              onChoose(template.text)
            }}
          >
            <strong>{template.name}</strong>
            <small>{template.hint}</small>
          </button>
        ))}
      </div>
    </div>
  )
}
