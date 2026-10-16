import { useEffect, useState } from 'react'
import { Globe, KeyRound } from 'lucide-react'
import { getSecret } from '../../services/native'
import type { WebFactSettings } from '../../types/notebook'
import { Callout, Group, Pill, Section, SwitchRow } from './controls'
import type { PaneProps } from './types'

export const WEB_FACT_MODELS = [
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.5',
  'gpt-4.1-mini',
] as const

export function WebFactsPane({
  settings,
  update,
  latest,
  onPaneChange,
}: PaneProps) {
  const facts = settings.webFacts
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void getSecret('provider:openai')
      .then(secret => Boolean(secret.trim()))
      .catch(() => false)
      .then(present => {
        if (alive) setHasKey(present)
      })
    return () => {
      alive = false
    }
  }, [])
  const patch = (next: Partial<WebFactSettings>) =>
    update({ webFacts: { ...latest().webFacts, ...next } })
  return (
    <>
      <div className="pref-hero">
        <span className="pref-hero-icon" aria-hidden="true">
          <Globe size={18} />
        </span>
        <p>
          Select a phrase, press <kbd>Ctrl / ⌘ Shift K</kbd> or choose{' '}
          <em>Search the web for facts</em> in the{' '}
          {settings.editor.slashTrigger} menu, then pick a cited fact to insert.
          Nothing is searched until you ask.
        </p>
      </div>
      <Section title="Web facts">
        <Group>
          <SwitchRow
            label="Web facts"
            description="Search the web with OpenAI and insert a fact with its source."
            checked={facts.enabled}
            onChange={enabled => patch({ enabled })}
          />
          <SwitchRow
            label="Also ground Ctrl / ⌘ Space choices with web facts"
            description="Manual choices can include up to two cited facts. Each request runs a web search."
            checked={facts.withSuggestions}
            disabled={!facts.enabled}
            onChange={withSuggestions => patch({ withSuggestions })}
          />
        </Group>
      </Section>
      <Section title="Model">
        <label className="pref-field-label" htmlFor="web-facts-model">
          Search model
        </label>
        <input
          id="web-facts-model"
          value={facts.model}
          maxLength={128}
          spellCheck={false}
          autoComplete="off"
          placeholder="gpt-5.4-mini"
          onChange={event => patch({ model: event.target.value })}
          onBlur={event => {
            if (!event.target.value.trim()) patch({ model: 'gpt-5.4-mini' })
          }}
        />
        <div
          className="pref-suggested"
          role="group"
          aria-label="Suggested models"
        >
          {WEB_FACT_MODELS.map(model => (
            <button
              key={model}
              type="button"
              className="pref-chip"
              aria-pressed={facts.model === model}
              onClick={() => patch({ model })}
            >
              {model}
            </button>
          ))}
        </div>
        <p className="pref-help">
          Smaller models answer faster and cost less. Any OpenAI model with web
          search works.
        </p>
      </Section>
      <Section title="OpenAI key">
        {hasKey === null ? (
          <Pill tone="busy">Checking for a key</Pill>
        ) : hasKey ? (
          <Callout icon={<KeyRound size={16} />}>
            Web facts use the key saved for the OpenAI provider.{' '}
            <Pill tone="ok">Key ready</Pill>
          </Callout>
        ) : (
          <Callout
            icon={<KeyRound size={16} />}
            action={
              <button
                type="button"
                className="button secondary is-compact"
                onClick={() => {
                  update({ externalProvider: 'openai' })
                  onPaneChange('external')
                }}
              >
                Add OpenAI key
              </button>
            }
          >
            Web facts use the key saved for the OpenAI provider. No key is saved
            yet.
          </Callout>
        )}
        <p className="pref-disclosure-text">
          When you search, the selected text, nearby writing, the note title and
          its objective are sent to OpenAI. OpenAI charges for each web search
          in addition to tokens.
        </p>
      </Section>
    </>
  )
}
