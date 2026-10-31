import { beforeEach, describe, expect, it } from 'vitest'
import type { Note, Workspace } from '../../types/notebook'
import { emptyWorkspace, newNote } from '../../notebook/model'
import { createVault, type Keyring } from './crypto'
import { TargetSync } from './engine'
import { MemoryTransport } from './memory-transport'
import type { SyncScope } from './records'
import { resetCloudStateForTests } from './state'

const ALL: SyncScope = {
  include: { notes: true, organize: true, contexts: true, settings: true },
  spaceIds: [],
}

let keyring: Keyring

class Device {
  workspace: Workspace
  engines = new Map<MemoryTransport, TargetSync>()
  scope: SyncScope = ALL
  constructor(
    readonly id: string,
    readonly name: string,
    workspace = emptyWorkspace()
  ) {
    this.workspace = workspace
  }
  engine(database: MemoryTransport) {
    let engine = this.engines.get(database)
    if (!engine) {
      engine = new TargetSync({
        targetId: `${this.id}-${this.engines.size}`,
        transport: database,
        keyring,
        device: { id: this.id, name: this.name },
        getWorkspace: () => this.workspace,
        updateWorkspace: apply => {
          this.workspace = apply(this.workspace)
        },
        scope: () => this.scope,
        deviceName: id => (id === 'mac' ? 'Mac' : id === 'pc' ? 'PC' : 'Phone'),
      })
      this.engines.set(database, engine)
    }
    return engine
  }
  sync(database: MemoryTransport) {
    return this.engine(database).sync()
  }
  note(title: string) {
    return this.workspace.notes.find(note => note.title === title)
  }
  edit(id: string, patch: Partial<Note>) {
    this.workspace = {
      ...this.workspace,
      notes: this.workspace.notes.map(note =>
        note.id === id
          ? { ...note, ...patch, updatedAt: note.updatedAt + 1 }
          : note
      ),
    }
  }
  add(title: string, content: string) {
    const note = { ...newNote(title), content }
    this.workspace = {
      ...this.workspace,
      notes: [...this.workspace.notes, note],
    }
    return note
  }
}

const STORY = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'

beforeEach(async () => {
  resetCloudStateForTests()
  keyring = (
    await createVault('correct horse battery', { iterations: 100_000 })
  ).keyring
})

describe('cloud sync engine', () => {
  it('brings a new device everything: notes, folders, tags, workspaces, contexts and preferences', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    const note = mac.add('Plan', STORY)
    mac.workspace = {
      ...mac.workspace,
      folders: [{ id: 'f1', name: 'Projects', createdAt: 1, collapsed: true }],
      tags: [{ id: 't1', name: 'urgent', color: 'rose', createdAt: 1 }],
      spaces: [
        { id: 'personal', name: 'Personal', color: 'sage', createdAt: 0 },
        {
          id: 'work',
          name: 'Work',
          color: 'sky',
          icon: 'briefcase',
          createdAt: 2,
          gitFolder: '/Users/me/repo',
        },
      ],
      contextLibrary: [
        {
          id: 's1',
          name: 'Guide',
          kind: 'text',
          text: 'Be brief.',
          enabled: true,
          addedAt: 1,
        },
      ],
      contextPackages: [
        {
          id: 'p1',
          name: 'Style',
          sourceIds: ['s1'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      settings: { ...mac.workspace.settings, theme: 'dark', fontSize: 19 },
    }
    mac.edit(note.id, {
      folderId: 'f1',
      tags: ['t1'],
      filePath: '/Users/me/plan.md',
    })
    const first = await mac.sync(db)
    expect(first.pushed).toBeGreaterThan(30)

    const pc = new Device('pc', 'PC')
    const report = await pc.sync(db)
    expect(report.conflicts).toEqual([])
    const copied = pc.note('Plan')!
    expect(copied.content).toBe(STORY)
    expect(copied.folderId).toBe('f1')
    expect(copied.tags).toEqual(['t1'])
    // Paths stay on the device that has them.
    expect(copied.filePath).toBeUndefined()
    expect(pc.workspace.folders?.[0]).toMatchObject({ name: 'Projects' })
    expect(pc.workspace.folders?.[0]?.collapsed).toBeUndefined()
    expect(pc.workspace.spaces?.map(space => space.name)).toEqual([
      'Personal',
      'Work',
    ])
    expect(pc.workspace.spaces?.[1]?.gitFolder).toBeUndefined()
    expect(pc.workspace.contextPackages?.[0]?.sourceIds).toEqual(['s1'])
    expect(pc.workspace.settings.theme).toBe('dark')
    expect(pc.workspace.settings.fontSize).toBe(19)

    // Nothing changed: a second sync sends nothing back.
    expect((await pc.sync(db)).pushed).toBe(0)
    expect(await pc.engine(db).pending()).toBe(0)
    expect((await mac.sync(db)).pushed).toBe(0)

    // The Mac's file paths are offered for mapping, not applied.
    const links = await pc.engine(db).peerLinks()
    expect(links).toHaveLength(1)
    expect(links[0]!.links.notes[note.id]).toBe('/Users/me/plan.md')
    expect(links[0]!.links.spaces.work).toBe('/Users/me/repo')
  })

  it('merges edits two devices made to different parts of one note', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    const note = mac.add('Story', STORY)
    await mac.sync(db)
    const pc = new Device('pc', 'PC')
    await pc.sync(db)

    mac.edit(note.id, {
      content: STORY.replace('First paragraph.', 'First paragraph, revised.'),
    })
    pc.edit(note.id, {
      content: STORY.replace('Third paragraph.', 'Third paragraph, extended.'),
    })
    await mac.sync(db)
    const report = await pc.sync(db)
    expect(report.conflicts).toEqual([])
    await mac.sync(db)

    const expected =
      'First paragraph, revised.\n\nSecond paragraph.\n\nThird paragraph, extended.'
    expect(mac.note('Story')!.content).toBe(expected)
    expect(pc.note('Story')!.content).toBe(expected)
    expect(pc.workspace.notes).toHaveLength(1)
  })

  it('keeps both versions when two devices change the same words', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    const note = mac.add('Story', STORY)
    await mac.sync(db)
    const pc = new Device('pc', 'PC')
    await pc.sync(db)

    mac.edit(note.id, { content: STORY.replace('Second', 'Mac’s second') })
    pc.edit(note.id, { content: STORY.replace('Second', 'PC’s second') })
    await mac.sync(db)
    const report = await pc.sync(db)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]!.device).toBe('mac')
    await mac.sync(db)

    for (const device of [mac, pc]) {
      expect(device.note('Story')!.content).toContain('PC’s second')
      expect(device.note('Story (Mac)')!.content).toContain('Mac’s second')
    }
  })

  it('sends deletions, and an edit wins over a deletion', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    const keep = mac.add('Keep', 'kept')
    const gone = mac.add('Gone', 'bye')
    await mac.sync(db)
    const pc = new Device('pc', 'PC')
    await pc.sync(db)

    mac.workspace = {
      ...mac.workspace,
      notes: mac.workspace.notes.filter(note => note.id !== gone.id),
    }
    await mac.sync(db)
    await pc.sync(db)
    expect(pc.note('Gone')).toBeUndefined()

    pc.workspace = {
      ...pc.workspace,
      notes: pc.workspace.notes.filter(note => note.id !== keep.id),
    }
    mac.edit(keep.id, { content: 'kept and edited' })
    await mac.sync(db)
    await pc.sync(db)
    await mac.sync(db)
    expect(pc.note('Keep')?.content).toBe('kept and edited')
    expect(mac.note('Keep')?.content).toBe('kept and edited')
  })

  it('retries a refused write after merging the newer version', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    const note = mac.add('List', 'a\nb\nc')
    await mac.sync(db)
    const pc = new Device('pc', 'PC')
    await pc.sync(db)
    // The PC writes, then the Mac sends without reading first.
    pc.edit(note.id, { content: 'a\nb\nc\nd' })
    await pc.sync(db)
    mac.edit(note.id, { content: 'z\na\nb\nc' })
    const engine = mac.engine(db) as unknown as {
      push(state: unknown, scope: SyncScope, report: object): Promise<string[]>
      load(): Promise<unknown>
    }
    const refused = await engine.push(await engine.load(), ALL, {
      pulled: 0,
      pushed: 0,
      conflicts: [],
      skipped: 0,
      tooLarge: [],
    })
    expect(refused).toHaveLength(1)
    await mac.sync(db)
    await pc.sync(db)
    expect(mac.note('List')!.content).toBe('z\na\nb\nc\nd')
    expect(pc.note('List')!.content).toBe('z\na\nb\nc\nd')
  })

  it('relays between two databases through a device that uses both', async () => {
    const neon = new MemoryTransport()
    const d1 = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    const pc = new Device('pc', 'PC')
    const phone = new Device('phone', 'Phone')
    mac.add('From the Mac', 'hello')
    await mac.sync(neon)
    await pc.sync(neon)
    await pc.sync(d1)
    await phone.sync(d1)
    expect(phone.note('From the Mac')?.content).toBe('hello')
    // And back.
    phone.edit(phone.note('From the Mac')!.id, {
      content: 'hello from the phone',
    })
    await phone.sync(d1)
    await pc.sync(d1)
    await pc.sync(neon)
    await mac.sync(neon)
    expect(mac.note('From the Mac')?.content).toBe('hello from the phone')
  })

  it('follows the selection: preferences and other workspaces can stay local', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    mac.workspace = {
      ...mac.workspace,
      spaces: [
        { id: 'personal', name: 'Personal', color: 'sage', createdAt: 0 },
        { id: 'work', name: 'Work', color: 'sky', createdAt: 1 },
      ],
      settings: { ...mac.workspace.settings, theme: 'dark' },
    }
    mac.add('Diary', 'private')
    const work = mac.add('Roadmap', 'q3')
    mac.edit(work.id, { spaceId: 'work' })
    await mac.sync(db)

    const pc = new Device('pc', 'PC')
    pc.scope = {
      include: { notes: true, organize: true, contexts: true, settings: false },
      spaceIds: ['work'],
    }
    await pc.sync(db)
    expect(pc.note('Roadmap')).toBeDefined()
    expect(pc.note('Diary')).toBeUndefined()
    expect(pc.workspace.settings.theme).toBe('system')
    // Widening the selection reads what was skipped.
    pc.scope = ALL
    await pc.sync(db)
    expect(pc.note('Diary')?.content).toBe('private')
    expect(pc.workspace.settings.theme).toBe('dark')
  })

  it('skips records it cannot read without stopping', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    mac.add('Fine', 'ok')
    await mac.sync(db)
    await db.push(keyring.vaultId, 'evil', [
      { id: 'garbage', base: 0, deleted: false, body: 'AAAA' },
    ])
    const pc = new Device('pc', 'PC')
    const report = await pc.sync(db)
    expect(report.skipped).toBe(1)
    expect(pc.note('Fine')?.content).toBe('ok')
  })

  it('stores nothing readable in the database', async () => {
    const db = new MemoryTransport()
    const mac = new Device('mac', 'Mac')
    mac.add('Bank details', 'account 1234 5678')
    await mac.sync(db)
    const dump = JSON.stringify([...db.rows.values()])
    expect(dump).not.toMatch(/Bank|1234|note:/u)
  })
})

describe('file links from other devices', () => {
  it('are offered only when well formed', async () => {
    const { parseIncoming } = await import('./records')
    const settings = emptyWorkspace().settings
    expect(
      parseIncoming(
        'links',
        'mac',
        { name: 'Mac', notes: { a: '/x.md' }, spaces: {} },
        settings
      )
    ).toEqual({
      name: 'Mac',
      notes: { a: '/x.md' },
      spaces: {},
    })
    expect(
      parseIncoming(
        'links',
        'mac',
        { name: 'Mac', notes: 'nope', spaces: {} },
        settings
      )
    ).toBeNull()
    expect(
      parseIncoming(
        'links',
        'mac',
        { name: 'Mac', notes: { a: 7 }, spaces: {} },
        settings
      )
    ).toBeNull()
  })
})
