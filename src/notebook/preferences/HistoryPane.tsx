import { useEffect, useState } from 'react'
import { HardDrive, Trash2 } from 'lucide-react'
import type { RevisionSettings } from '../../types/notebook'
import {
  clearRevisions,
  revisionUsage,
  subscribeRevisions,
} from '../revisions/store'
import {
  Callout,
  formatBytes,
  Group,
  Row,
  Section,
  Segmented,
  SwitchRow,
} from './controls'
import type { PaneProps } from './types'

function minutes(value: number) {
  if (value === 0) return 'After every pause'
  if (value < 60) return `${value} min`
  return `${value / 60} h`
}

export function HistoryPane({ settings, update, latest }: PaneProps) {
  const revisions = settings.revisions
  const patch = (next: Partial<RevisionSettings>) =>
    update({ revisions: { ...latest().revisions, ...next } })
  const [usage, setUsage] = useState<{ count: number; bytes: number } | null>(
    null
  )
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    let live = true
    const load = () =>
      void revisionUsage()
        .then(value => {
          if (live) setUsage(value)
        })
        .catch(() => undefined)
    load()
    const stop = subscribeRevisions(load)
    return () => {
      live = false
      stop()
    }
  }, [])

  const off = !revisions.enabled
  const words = Math.max(1, Math.round(revisions.minChanges / 6))
  return (
    <>
      <Section
        title="Revisions"
        description="Versions of each note, kept on this device. Compare any two, bring back a paragraph or restore a whole version, without Git."
      >
        <Group>
          <SwitchRow
            label="Keep revisions of my notes"
            description="Off by default. Turning it off keeps saved versions; it only stops new ones."
            checked={revisions.enabled}
            onChange={enabled => patch({ enabled })}
          />
          <Row
            label="New versions"
            description={
              revisions.mode === 'automatic'
                ? 'When writing pauses after a meaningful change, and when you leave a note.'
                : 'Only when you choose Save this version, or press ⌘ / Ctrl Alt S.'
            }
          >
            <Segmented
              label="New versions"
              value={revisions.mode}
              onChange={mode => patch({ mode })}
              options={[
                { value: 'automatic', label: 'Automatic', disabled: off },
                { value: 'manual', label: 'Manual', disabled: off },
              ]}
            />
          </Row>
        </Group>
      </Section>
      <Section
        title="When a change becomes a version"
        description="Small edits join the next version, so the timeline shows the steps that matter."
      >
        <Group>
          <Row
            label="Changed text"
            htmlFor="revision-threshold"
            stacked
            description={`About ${words} ${words === 1 ? 'word' : 'words'} added or removed (${revisions.minChanges} characters).`}
          >
            <span className="pref-range">
              <input
                id="revision-threshold"
                type="range"
                min={20}
                max={3000}
                step={20}
                value={revisions.minChanges}
                disabled={off || revisions.mode === 'manual'}
                aria-valuetext={`${revisions.minChanges} characters`}
                onChange={event =>
                  patch({ minChanges: Number(event.target.value) })
                }
              />
              <output htmlFor="revision-threshold">
                {revisions.minChanges}
              </output>
            </span>
            <span className="pref-range-labels" aria-hidden="true">
              <span>A sentence</span>
              <span>A few paragraphs</span>
            </span>
          </Row>
          <Row
            label="Time between automatic versions"
            htmlFor="revision-interval"
            stacked
          >
            <span className="pref-range">
              <input
                id="revision-interval"
                type="range"
                min={0}
                max={120}
                step={5}
                value={revisions.minMinutes}
                disabled={off || revisions.mode === 'manual'}
                aria-valuetext={minutes(revisions.minMinutes)}
                onChange={event =>
                  patch({ minMinutes: Number(event.target.value) })
                }
              />
              <output htmlFor="revision-interval">
                {minutes(revisions.minMinutes)}
              </output>
            </span>
            <span className="pref-range-labels" aria-hidden="true">
              <span>Every pause</span>
              <span>Every two hours</span>
            </span>
          </Row>
          <Row
            label="Versions kept per note"
            htmlFor="revision-keep"
            description="Older automatic versions thin out to one an hour, then one a day. Named and pinned versions always stay."
          >
            <input
              id="revision-keep"
              type="number"
              min={5}
              max={1000}
              value={revisions.keep}
              disabled={off}
              onChange={event =>
                patch({
                  keep: Math.min(
                    1000,
                    Math.max(5, Math.round(Number(event.target.value) || 5))
                  ),
                })
              }
            />
          </Row>
          <SwitchRow
            label="Safety copies"
            description="Keep the text from just before an AI edit, a restore or a large deletion."
            checked={revisions.safetyNet}
            disabled={off}
            onChange={safetyNet => patch({ safetyNet })}
          />
        </Group>
      </Section>
      <Section title="Storage">
        <Callout
          icon={<HardDrive size={16} />}
          action={
            confirm ? (
              <span className="pref-inline-confirm">
                <button
                  type="button"
                  className="button destructive is-compact"
                  onClick={() => {
                    void clearRevisions().then(() => setConfirm(false))
                  }}
                >
                  Delete all
                </button>
                <button
                  type="button"
                  className="button subtle is-compact"
                  onClick={() => setConfirm(false)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="button secondary is-compact"
                disabled={!usage?.count}
                onClick={() => setConfirm(true)}
              >
                <Trash2 size={14} /> Delete all versions
              </button>
            )
          }
        >
          {usage
            ? usage.count
              ? `${usage.count.toLocaleString()} ${usage.count === 1 ? 'version' : 'versions'}, ${formatBytes(usage.bytes)} on this device.`
              : 'No versions saved yet.'
            : 'Measuring…'}{' '}
          Versions are not part of Git sync or exported Markdown. Notes are
          never changed by deleting versions.
        </Callout>
      </Section>
    </>
  )
}
