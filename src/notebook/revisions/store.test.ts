import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../model'
import { largeDeletion, shouldCapture } from './policy'
import {
  addRevision,
  deleteRevision,
  latestRevision,
  listRevisions,
  resetRevisionStoreForTests,
  revisionSummary,
  revisionText,
  revisionsToPrune,
  updateRevision,
  type RevisionMeta,
} from './store'

const HOUR = 3_600_000
const DAY = 24 * HOUR

beforeEach(() => resetRevisionStoreForTests())

function add(
  text: string,
  extra: Partial<Parameters<typeof addRevision>[0]> = {}
) {
  return addRevision({
    noteId: 'note',
    title: 'Plan',
    text,
    kind: 'auto',
    keep: 100,
    ...extra,
  })
}

describe('revision store', () => {
  it('stores compressed text, newest first, with word changes and a summary', async () => {
    await add('# Plan\n\nFirst idea.', { now: 1_000 })
    await add('# Plan\n\nFirst idea, sharper.\n\n## Risks', { now: 2_000 })
    const list = await listRevisions('note')
    expect(list.map(item => item.summary)).toEqual([
      'Added “Risks”',
      'First version',
    ])
    expect(list[0]).toMatchObject({ added: 3, removed: 1, words: 5 })
    expect(await revisionText(list[1]!.id)).toBe('# Plan\n\nFirst idea.')
    expect((await latestRevision('note'))?.text).toContain('Risks')
  })

  it('skips an unchanged text but names it when the writer saves by hand', async () => {
    await add('Same text.', { now: 1 })
    expect(await add('Same text.', { now: 2 })).toBeNull()
    const named = await add('Same text.', {
      kind: 'manual',
      label: 'Draft for Sam',
      now: 3,
    })
    expect(named?.label).toBe('Draft for Sam')
    expect(await listRevisions('note')).toHaveLength(1)
  })

  it('names, pins and deletes revisions', async () => {
    const first = await add('One.')
    await add('Two.')
    await updateRevision(first!.id, { label: ' Outline ', pinned: true })
    let list = await listRevisions('note')
    expect(list[1]).toMatchObject({ label: 'Outline', pinned: true })
    await updateRevision(first!.id, { label: '', pinned: false })
    list = await listRevisions('note')
    expect(list[1]?.label).toBeUndefined()
    expect(list[1]?.pinned).toBeUndefined()
    await deleteRevision(first!.id)
    expect(await listRevisions('note')).toHaveLength(1)
  })

  it('keeps the limit by removing the oldest automatic revisions', async () => {
    for (let index = 0; index < 8; index++)
      await add(`Version ${index}`, { keep: 5, now: 1_000 + index })
    const list = await listRevisions('note')
    expect(list).toHaveLength(5)
    expect(await revisionText(list.at(-1)!.id)).toBe('Version 3')
  })
})

describe('thinning', () => {
  function revision(
    id: string,
    createdAt: number,
    extra: Partial<RevisionMeta> = {}
  ): RevisionMeta {
    return {
      id,
      noteId: 'note',
      createdAt,
      title: '',
      words: 0,
      characters: 0,
      kind: 'auto',
      summary: '',
      added: 0,
      removed: 0,
      hash: id,
      ...extra,
    }
  }

  it('keeps one an hour after a day and one a day after a week', () => {
    const now = 30 * DAY
    const records = [
      revision('new', now - 1000),
      revision('recent-a', now - 2 * HOUR),
      revision('recent-b', now - 2 * HOUR - 60_000),
      revision('hour-a', now - 2 * DAY),
      revision('hour-b', now - 2 * DAY + 60_000),
      revision('day-a', now - 10 * DAY),
      revision('day-b', now - 10 * DAY + HOUR),
      revision('named', now - 10 * DAY - 2 * HOUR, { label: 'Keep me' }),
    ]
    // The newer revision in each hour or day stays.
    expect(revisionsToPrune(records, 100, now).sort()).toEqual([
      'day-a',
      'hour-a',
    ])
  })

  it('never removes named, pinned or the newest revision', () => {
    const records = [
      revision('a', 5),
      revision('b', 4, { pinned: true }),
      revision('c', 3, { label: 'x' }),
      revision('d', 2),
    ]
    expect(revisionsToPrune(records, 1, 10)).toEqual(['d'])
  })
})

describe('policy', () => {
  const settings = { ...defaultSettings().revisions, enabled: true }

  it('captures after enough change and time', () => {
    const previous = { createdAt: 0, text: 'a'.repeat(100) }
    expect(
      shouldCapture({
        settings,
        previous,
        current: 'a'.repeat(100) + 'b'.repeat(300),
        now: 11 * 60_000,
      })
    ).toBe(true)
    expect(
      shouldCapture({
        settings,
        previous,
        current: 'a'.repeat(100) + 'b'.repeat(300),
        now: 5 * 60_000,
      })
    ).toBe(false)
    expect(
      shouldCapture({
        settings,
        previous,
        current: 'a'.repeat(100) + 'b',
        now: 60 * 60_000,
      })
    ).toBe(false)
    expect(
      shouldCapture({
        settings: { ...settings, mode: 'manual' },
        previous,
        current: 'x'.repeat(900),
        now: 60 * 60_000,
      })
    ).toBe(false)
  })

  it('takes a first revision once a note has enough text', () => {
    expect(
      shouldCapture({ settings, previous: null, current: 'short', now: 0 })
    ).toBe(false)
    expect(
      shouldCapture({
        settings,
        previous: null,
        current: 'x'.repeat(240),
        now: 0,
      })
    ).toBe(true)
  })

  it('notices a large deletion', () => {
    const before = 'A long paragraph. '.repeat(40)
    expect(largeDeletion(before, before.slice(0, 100), settings)).toBe(true)
    expect(largeDeletion(before, before.slice(0, -5), settings)).toBe(false)
    expect(largeDeletion(before, '', { ...settings, safetyNet: false })).toBe(
      false
    )
  })
})

describe('revisionSummary', () => {
  it('describes the change in a few words', () => {
    expect(revisionSummary(null, 'Hello')).toBe('First version')
    expect(revisionSummary('a\nb', 'a\nb\nThe **new** line')).toBe(
      'Added “The new line”'
    )
    expect(revisionSummary('a\nold line', 'a')).toBe('Removed “old line”')
    expect(revisionSummary('a\nb', 'b\na')).toBe('Rearranged lines')
  })
})
