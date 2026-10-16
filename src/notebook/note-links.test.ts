import { describe, expect, it } from 'vitest'
import type { ContextPackage, ContextSource, Note } from '../types/notebook'
import {
  backlinks,
  buildNoteGraph,
  neighborhood,
  noteKey,
  noteLinks,
  parseWikiLinks,
  resolveNoteLink,
  wikiLinkText,
  type NoteGraph,
} from './note-links'

let sequence = 0
function note(title: string, content = '', extra: Partial<Note> = {}): Note {
  sequence += 1
  return {
    id: extra.id ?? `n${sequence}`,
    title,
    objective: '',
    context: '',
    content,
    sources: [],
    createdAt: 1,
    updatedAt: extra.updatedAt ?? sequence,
    ...extra,
  }
}

function noteSource(
  id: string,
  linkedNoteId: string,
  extra: Partial<ContextSource> = {}
): ContextSource {
  return {
    id,
    name: 'Linked note',
    kind: 'note',
    text: '',
    linkedNoteId,
    enabled: true,
    addedAt: 1,
    ...extra,
  }
}

function contextPackage(id: string, sourceIds: string[]): ContextPackage {
  return { id, name: id, sourceIds, createdAt: 1, updatedAt: 1 }
}

const edgeKey = (graph: NoteGraph) =>
  graph.edges.map(edge => `${edge.source}-${edge.target}:${edge.kind}`).sort()

describe('parseWikiLinks', () => {
  it('reads targets, labels and headings with their offsets', () => {
    const text =
      'See [[Garden]] and [[Field notes|the notes]] or [[Atlas#Maps]].'
    const links = parseWikiLinks(text)
    expect(links).toEqual([
      { from: 4, to: 14, target: 'Garden' },
      { from: 19, to: 44, target: 'Field notes', label: 'the notes' },
      { from: 48, to: 62, target: 'Atlas', heading: 'Maps' },
    ])
    expect(text.slice(links[1]!.from, links[1]!.to)).toBe(
      '[[Field notes|the notes]]'
    )
  })

  it('combines a heading with a label and trims whitespace', () => {
    expect(parseWikiLinks('[[  Atlas # Maps | atlas maps ]]')).toEqual([
      {
        from: 0,
        to: 32,
        target: 'Atlas',
        heading: 'Maps',
        label: 'atlas maps',
      },
    ])
  })

  it('finds several links on one line and across lines', () => {
    const links = parseWikiLinks('[[A]] [[B]][[C]]\nnext [[D]]')
    expect(links.map(link => link.target)).toEqual(['A', 'B', 'C', 'D'])
    expect(links[3]!.from).toBe(22)
  })

  it('ignores empty targets, heading-only links and nested brackets', () => {
    expect(parseWikiLinks('[[]] [[ ]] [[#Only heading]] [[a[b]]')).toEqual([])
  })

  it('ignores links inside fenced code blocks', () => {
    const text = [
      'before [[A]]',
      '```md',
      '[[Inside backticks]]',
      '```',
      '~~~~',
      '[[Inside tildes]]',
      '~~~',
      'still code [[Short close]]',
      '~~~~',
      'after [[B]]',
    ].join('\n')
    expect(parseWikiLinks(text).map(link => link.target)).toEqual(['A', 'B'])
  })

  it('does not close a fence with an info string or the other fence character', () => {
    const text = ['```', '~~~', '```js', '[[Hidden]]', '```', '[[Shown]]'].join(
      '\n'
    )
    expect(parseWikiLinks(text).map(link => link.target)).toEqual(['Shown'])
  })

  it('ignores links in inline code spans of any backtick length', () => {
    const text =
      'a `[[One]]` b ``code ` [[Two]]`` c [[Three]] `unclosed [[Four]]'
    expect(parseWikiLinks(text).map(link => link.target)).toEqual([
      'Three',
      'Four',
    ])
  })

  it('caches parsed links until the note changes', () => {
    const item = note('Cache', '[[A]]')
    const first = noteLinks(item)
    expect(noteLinks({ ...item })).toBe(first)
    expect(
      noteLinks({ ...item, content: '[[B]]' }).map(link => link.target)
    ).toEqual(['B'])
  })

  it('escapes characters that would split a link', () => {
    expect(wikiLinkText('A [b] | c # d\ne')).toBe('[[A b c d e]]')
  })
})

describe('resolveNoteLink', () => {
  it('matches titles regardless of case, width and spacing', () => {
    const garden = note('Garden  Notes')
    const notes = [garden, note('Other')]
    expect(noteKey('  GARDEN   notes ')).toBe('garden notes')
    expect(resolveNoteLink('garden notes', notes)).toBe(garden)
    expect(resolveNoteLink(' Garden\tNotes ', notes)).toBe(garden)
    expect(resolveNoteLink('Ｇarden Notes', notes)).toBe(garden)
    expect(resolveNoteLink('Missing', notes)).toBeUndefined()
  })

  it('prefers the most recently edited note when titles repeat', () => {
    const older = note('Draft', '', { updatedAt: 10 })
    const newer = note('draft', '', { updatedAt: 20 })
    expect(resolveNoteLink('Draft', [older, newer])).toBe(newer)
    expect(resolveNoteLink('Draft', [newer, older])).toBe(newer)
  })

  it('lists backlinks from other notes only', () => {
    const target = note('Target', '[[Target]]')
    const linking = note('Linking', 'see [[target]]')
    const unrelated = note('Unrelated', '[[Elsewhere]]')
    expect(backlinks(target, [target, linking, unrelated])).toEqual([linking])
  })
})

describe('buildNoteGraph', () => {
  it('creates one undirected weighted edge per pair', () => {
    const a = note('A', '[[B]] and [[b]] again', { id: 'a' })
    const b = note('B', 'back to [[A]]', { id: 'b' })
    const c = note('C', '[[C]] is itself', { id: 'c' })
    const graph = buildNoteGraph([a, b, c])
    expect(graph.edges).toEqual([
      { source: 'a', target: 'b', kind: 'link', weight: 3 },
    ])
    const degree = Object.fromEntries(
      graph.nodes.map(node => [node.id, node.degree])
    )
    expect(degree).toEqual({ a: 1, b: 1, c: 0 })
  })

  it('reports word counts and update times for sizing', () => {
    const graph = buildNoteGraph([
      note('Words', 'one two  three\nfour', { id: 'w', updatedAt: 42 }),
    ])
    expect(graph.nodes[0]).toMatchObject({ words: 4, updatedAt: 42 })
  })

  it('adds ghost nodes for unresolved links unless disabled', () => {
    const a = note('A', '[[Someday]] [[someday]] [[Later]]', { id: 'a' })
    const b = note('B', '[[SOMEDAY]]', { id: 'b' })
    const graph = buildNoteGraph([a, b])
    const ghosts = graph.nodes.filter(node => node.ghost)
    expect(ghosts.map(node => [node.id, node.title, node.degree])).toEqual([
      ['ghost:someday', 'Someday', 2],
      ['ghost:later', 'Later', 1],
    ])
    expect(edgeKey(graph)).toEqual([
      'a-ghost:later:link',
      'a-ghost:someday:link',
      'b-ghost:someday:link',
    ])
    expect(
      graph.edges.find(
        edge => edge.target === 'ghost:someday' && edge.source === 'a'
      )?.weight
    ).toBe(2)
    const plain = buildNoteGraph([a, b], [], [], { ghosts: false })
    expect(plain.nodes.some(node => node.ghost)).toBe(false)
    expect(plain.edges).toEqual([])
  })

  it('makes context edges for direct note sources', () => {
    const a = note('A', '', { id: 'a' })
    const b = note('B', '', {
      id: 'b',
      sources: [noteSource('s1', 'a'), noteSource('self', 'b')],
    })
    expect(buildNoteGraph([a, b]).edges).toEqual([
      { source: 'a', target: 'b', kind: 'context', weight: 1 },
    ])
  })

  it('follows library references and context packages', () => {
    const library = [
      noteSource('lib-a', 'a'),
      noteSource('lib-c', 'c'),
      noteSource('lib-missing', 'gone'),
      { ...noteSource('lib-file', 'a'), kind: 'text' as const },
    ]
    const packages = [
      contextPackage('p1', ['lib-c', 'lib-missing', 'lib-file']),
    ]
    const a = note('A', '', { id: 'a' })
    const b = note('B', '', {
      id: 'b',
      sources: [
        {
          ...noteSource('ref', ''),
          libraryId: 'lib-a',
          linkedNoteId: undefined,
        },
      ],
      contextPackageIds: ['p1', 'unknown'],
    })
    const c = note('C', '', { id: 'c' })
    const graph = buildNoteGraph([a, b, c], library, packages)
    expect(edgeKey(graph)).toEqual(['a-b:context', 'b-c:context'])
  })

  it('counts a pair linked both ways once, as a link', () => {
    const a = note('A', '', { id: 'a' })
    const b = note('B', 'mentions [[A]]', {
      id: 'b',
      sources: [noteSource('s', 'a')],
    })
    expect(buildNoteGraph([a, b]).edges).toEqual([
      { source: 'a', target: 'b', kind: 'link', weight: 2 },
    ])
    const contextFirst = buildNoteGraph([
      note('A', '', { id: 'a', sources: [noteSource('s', 'b')] }),
      note('B', '[[A]]', { id: 'b' }),
    ])
    expect(contextFirst.edges[0]).toMatchObject({ kind: 'link', weight: 2 })
  })
})

describe('neighborhood', () => {
  const chain = (): NoteGraph => {
    const notes = [
      note('One', '[[Two]]', { id: '1' }),
      note('Two', '[[Three]]', { id: '2' }),
      note('Three', '[[Four]]', { id: '3' }),
      note('Four', '', { id: '4' }),
      note('Alone', '', { id: '5' }),
    ]
    return buildNoteGraph(notes)
  }

  it('walks the requested number of steps from the center', () => {
    const graph = chain()
    expect([...neighborhood(graph, '1', 0)]).toEqual(['1'])
    expect([...neighborhood(graph, '1')].sort()).toEqual(['1', '2'])
    expect([...neighborhood(graph, '1', 2)].sort()).toEqual(['1', '2', '3'])
    expect([...neighborhood(graph, '2', 1)].sort()).toEqual(['1', '2', '3'])
    expect([...neighborhood(graph, '1', 9)].sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
  })

  it('returns only the center for an isolated or unknown note', () => {
    const graph = chain()
    expect([...neighborhood(graph, '5', 2)]).toEqual(['5'])
    expect([...neighborhood(graph, 'nope', 2)]).toEqual(['nope'])
  })

  it('handles a large hub without quadratic adjacency', () => {
    const edges = Array.from({ length: 20_000 }, (_, index) => ({
      source: 'hub',
      target: `n${index}`,
      kind: 'link' as const,
      weight: 1,
    }))
    const started = performance.now()
    const around = neighborhood({ nodes: [], edges }, 'hub', 1)
    expect(around.size).toBe(20_001)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
