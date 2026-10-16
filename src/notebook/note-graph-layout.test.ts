import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  fitCamera,
  hitTestNode,
  interpolateCamera,
  manyBodyForces,
  nearestInDirection,
  nodeRadius,
  placeLabels,
  screenToWorld,
  seededRandom,
  worldToScreen,
  zoomAt,
  type LayoutInputEdge,
  type LayoutInputNode,
  type PositionCache,
} from './note-graph-layout'

function nodes(count: number, prefix = 'n'): LayoutInputNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    radius: 4,
  }))
}

function edge(source: string, target: string, weight = 1): LayoutInputEdge {
  return { source, target, weight }
}

/** Two dense clusters joined by one bridge, plus isolated notes. */
function clusteredGraph() {
  const list = nodes(24)
  const edges: LayoutInputEdge[] = []
  for (let i = 0; i < 10; i++)
    for (let j = i + 1; j < 10; j++)
      if ((i + j) % 3 !== 0) edges.push(edge(`n${i}`, `n${j}`))
  for (let i = 10; i < 20; i++)
    for (let j = i + 1; j < 20; j++)
      if ((i * j) % 4 !== 1) edges.push(edge(`n${i}`, `n${j}`))
  edges.push(edge('n0', 'n10'))
  return { list, edges }
}

const distance = (
  sim: ReturnType<typeof createSimulation>,
  a: number,
  b: number
) => Math.hypot(sim.x[a]! - sim.x[b]!, sim.y[a]! - sim.y[b]!)

describe('seeded placement', () => {
  it('repeats exactly for the same seed and graph', () => {
    const { list, edges } = clusteredGraph()
    const a = createSimulation(list, edges, { seed: 7, cache: null })
    const b = createSimulation(list, edges, { seed: 7, cache: null })
    a.tick(120)
    b.tick(120)
    expect([...a.x]).toEqual([...b.x])
    expect([...a.y]).toEqual([...b.y])
    const c = createSimulation(list, edges, { seed: 8, cache: null })
    expect([...c.x]).not.toEqual([
      ...createSimulation(list, edges, { seed: 7, cache: null }).x,
    ])
  })

  it('produces a well-distributed PRNG', () => {
    const random = seededRandom(42)
    const values = Array.from({ length: 2_000 }, random)
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...values)).toBeLessThan(1)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    expect(mean).toBeGreaterThan(0.45)
    expect(mean).toBeLessThan(0.55)
  })
})

describe('force simulation', () => {
  it('cools to rest with decreasing energy', () => {
    const { list, edges } = clusteredGraph()
    const sim = createSimulation(list, edges, { cache: null })
    sim.tick(10)
    const early = sim.kineticEnergy()
    sim.tick(100)
    const middle = sim.kineticEnergy()
    sim.tick(400)
    const late = sim.kineticEnergy()
    expect(middle).toBeLessThan(early)
    expect(late).toBeLessThan(middle)
    expect(sim.settled).toBe(true)
    expect(sim.step(5)).toBe(false)
    for (let i = 0; i < list.length; i++) {
      expect(Number.isFinite(sim.x[i]!)).toBe(true)
      expect(Number.isFinite(sim.y[i]!)).toBe(true)
    }
  })

  it('draws linked notes closer than unlinked ones', () => {
    const { list, edges } = clusteredGraph()
    const sim = createSimulation(list, edges, { cache: null })
    sim.tick(500)
    const linked = new Set(edges.map(item => `${item.source}|${item.target}`))
    let linkedSum = 0
    let linkedCount = 0
    let otherSum = 0
    let otherCount = 0
    for (let i = 0; i < 20; i++)
      for (let j = i + 1; j < 20; j++) {
        const d = distance(sim, i, j)
        if (linked.has(`n${i}|n${j}`)) {
          linkedSum += d
          linkedCount++
        } else {
          otherSum += d
          otherCount++
        }
      }
    expect(linkedSum / linkedCount).toBeLessThan(otherSum / otherCount)
    // Cluster members sit closer to each other than to the other cluster.
    expect(distance(sim, 1, 2)).toBeLessThan(distance(sim, 1, 15))
  })

  it('keeps disconnected components and isolated notes near the centre', () => {
    const { list, edges } = clusteredGraph()
    const sim = createSimulation(
      list,
      edges.filter(item => item.source !== 'n0' || item.target !== 'n10'),
      {
        cache: null,
      }
    )
    sim.tick(500)
    const bounds = sim.bounds()!
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    expect(span).toBeLessThan(700)
    for (let i = 0; i < list.length; i++)
      expect(Math.hypot(sim.x[i]!, sim.y[i]!)).toBeLessThan(400)
  })

  it('handles empty, single and paired graphs', () => {
    const empty = createSimulation([], [], { cache: null })
    expect(empty.settled).toBe(true)
    expect(empty.bounds()).toBeNull()
    empty.tick(3)

    const single = createSimulation(nodes(1), [], { cache: null })
    single.tick(300)
    expect(Math.hypot(single.x[0]!, single.y[0]!)).toBeLessThan(5)

    const pair = createSimulation(nodes(2), [edge('n0', 'n1')], { cache: null })
    pair.tick(300)
    const d = distance(pair, 0, 1)
    expect(d).toBeGreaterThan(8)
    expect(d).toBeLessThan(120)
  })

  it('separates coincident nodes and ignores unknown or self edges', () => {
    const cache: PositionCache = new Map([
      ['n0', { x: 0, y: 0 }],
      ['n1', { x: 0, y: 0 }],
    ])
    const sim = createSimulation(
      nodes(2),
      [edge('n0', 'n0'), edge('n0', 'zz')],
      { cache }
    )
    expect(sim.links).toHaveLength(0)
    sim.tick(200)
    expect(distance(sim, 0, 1)).toBeGreaterThan(7)
  })

  it('holds a pinned node in place and releases it afterwards', () => {
    const { list, edges } = clusteredGraph()
    const sim = createSimulation(list, edges, { cache: null })
    sim.pin(3, 500, -200)
    sim.alphaTarget = 0.3
    sim.tick(50)
    expect(sim.x[3]).toBe(500)
    expect(sim.y[3]).toBe(-200)
    expect(sim.isPinned(3)).toBe(true)
    expect(sim.settled).toBe(false)
    sim.unpin(3)
    sim.alphaTarget = 0
    sim.tick(300)
    expect(sim.isPinned(3)).toBe(false)
    expect(Math.hypot(sim.x[3]! - 500, sim.y[3]! + 200)).toBeGreaterThan(50)
  })

  it('warm starts from cached positions by id', () => {
    const cache: PositionCache = new Map()
    const { list, edges } = clusteredGraph()
    const first = createSimulation(list, edges, { cache })
    first.tick(300)
    first.save()
    expect(cache.size).toBe(list.length)

    const grown = [...list, { id: 'fresh', radius: 4 }]
    const second = createSimulation(grown, [...edges, edge('n5', 'fresh')], {
      cache,
    })
    for (let i = 0; i < list.length; i++) {
      expect(second.x[i]).toBe(first.x[i])
      expect(second.y[i]).toBe(first.y[i])
    }
    expect(second.warm).toBeGreaterThan(0.9)
    expect(second.alpha).toBeLessThan(0.5)
    // A new note starts beside its linked neighbour rather than far away.
    const fresh = second.index.get('fresh')!
    expect(distance(second, fresh, 5)).toBeLessThan(60)
  })
})

describe('many-body forces', () => {
  it('approximates exact forces with Barnes–Hut', () => {
    const random = seededRandom(3)
    const n = 600
    const x = new Float64Array(n)
    const y = new Float64Array(n)
    const charge = new Float64Array(n).fill(-30)
    for (let i = 0; i < n; i++) {
      // Clustered points stress the tree more than a uniform cloud.
      const cluster = i % 4
      x[i] = cluster * 300 + (random() - 0.5) * 200
      y[i] = (cluster % 2) * 300 + (random() - 0.5) * 200
    }
    // Coincident points must not break the tree.
    x[1] = x[0]!
    y[1] = y[0]!
    const exactX = new Float64Array(n)
    const exactY = new Float64Array(n)
    const treeX = new Float64Array(n)
    const treeY = new Float64Array(n)
    manyBodyForces(x, y, charge, exactX, exactY, { theta: 0 })
    manyBodyForces(x, y, charge, treeX, treeY, { theta: 0.7 })
    let error = 0
    let magnitude = 0
    for (let i = 0; i < n; i++) {
      error += Math.hypot(treeX[i]! - exactX[i]!, treeY[i]! - exactY[i]!)
      magnitude += Math.hypot(exactX[i]!, exactY[i]!)
    }
    expect(error / magnitude).toBeLessThan(0.05)
    // A tight theta is nearly exact.
    manyBodyForces(x, y, charge, treeX, treeY, { theta: 0.2 })
    let tight = 0
    for (let i = 0; i < n; i++)
      tight += Math.hypot(treeX[i]! - exactX[i]!, treeY[i]! - exactY[i]!)
    expect(tight / magnitude).toBeLessThan(0.01)
  })

  it('repels two charges along the line between them', () => {
    const x = new Float64Array([0, 10])
    const y = new Float64Array([0, 0])
    const fx = new Float64Array(2)
    const fy = new Float64Array(2)
    manyBodyForces(x, y, new Float64Array([-10, -10]), fx, fy, { theta: 0 })
    expect(fx[0]).toBeLessThan(0)
    expect(fx[1]).toBeGreaterThan(0)
    expect(fx[0]).toBeCloseTo(-fx[1]!)
    expect(fy[0]).toBe(0)
  })
})

describe('large graphs', () => {
  it('ticks 3,000 notes at interactive speed', () => {
    const random = seededRandom(11)
    const list = nodes(3_000)
    const edges: LayoutInputEdge[] = []
    for (let i = 1; i < 3_000; i++) {
      edges.push(edge(`n${i}`, `n${Math.floor(random() * i)}`))
      if (i % 3 === 0)
        edges.push(edge(`n${i}`, `n${Math.floor(random() * 3_000)}`))
    }
    const sim = createSimulation(list, edges, { cache: null })
    sim.tick(2) // warm the JIT
    const started = performance.now()
    sim.tick(10)
    const perTick = (performance.now() - started) / 10
    expect(perTick).toBeLessThan(60)
    expect(Number.isFinite(sim.kineticEnergy())).toBe(true)
  })

  it('stops a step once the time budget is spent', () => {
    const sim = createSimulation(nodes(50), [], { cache: null })
    let clock = 0
    const now = () => (clock += 4)
    const before = sim.alpha
    expect(sim.step(10, now)).toBe(true)
    // Ticks ran until the fake clock passed the budget: two or three ticks.
    expect(sim.alpha).toBeLessThan(before)
    expect(sim.alpha).toBeGreaterThan(before * 0.9)
  })
})

describe('camera', () => {
  it('maps between screen and world', () => {
    const camera = { x: 10, y: -5, k: 2 }
    const screen = worldToScreen(camera, 800, 600, 20, 5)
    expect(screen).toEqual({ x: 420, y: 320 })
    expect(screenToWorld(camera, 800, 600, screen.x, screen.y)).toEqual({
      x: 20,
      y: 5,
    })
  })

  it('zooms around the pointer and clamps the scale', () => {
    const camera = { x: 0, y: 0, k: 1 }
    const zoomed = zoomAt(camera, 800, 600, 600, 100, 2)
    const before = screenToWorld(camera, 800, 600, 600, 100)
    const after = screenToWorld(zoomed, 800, 600, 600, 100)
    expect(zoomed.k).toBe(2)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(zoomAt(camera, 800, 600, 0, 0, 1_000).k).toBe(6)
    expect(zoomAt(camera, 800, 600, 0, 0, 0.0001).k).toBe(0.05)
  })

  it('fits bounds with padding and a zoom ceiling', () => {
    const fit = fitCamera(
      { minX: -100, minY: -50, maxX: 300, maxY: 50 },
      1000,
      600,
      {
        padding: 100,
        maxZoom: 4,
      }
    )
    expect(fit.x).toBe(100)
    expect(fit.y).toBe(0)
    expect(fit.k).toBeCloseTo(2) // limited by width: 800 / 400
    expect(fitCamera({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 1000, 600).k).toBe(
      1.6
    )
    expect(fitCamera(null, 1000, 600)).toEqual({ x: 0, y: 0, k: 1 })
  })

  it('interpolates with an ease-out curve', () => {
    const from = { x: 0, y: 0, k: 1 }
    const to = { x: 100, y: 50, k: 4 }
    expect(interpolateCamera(from, to, 0)).toEqual(from)
    const end = interpolateCamera(from, to, 1)
    expect(end.x).toBeCloseTo(100)
    expect(end.k).toBeCloseTo(4)
    expect(interpolateCamera(from, to, 0.5).x).toBeGreaterThan(50)
    expect(interpolateCamera(from, to, 0.5).k).toBeCloseTo(4 ** 0.875)
  })
})

describe('picking and navigation', () => {
  const x = [0, 50, 0, -50, 40]
  const y = [0, 0, 50, 0, -60]
  const r = [5, 5, 5, 5, 5]

  it('hits the nearest disc within its radius and slop', () => {
    expect(hitTestNode(x, y, r, 1, 1)).toBe(0)
    expect(hitTestNode(x, y, r, 48, 2)).toBe(1)
    expect(hitTestNode(x, y, r, 25, 0)).toBe(-1)
    expect(hitTestNode(x, y, r, 8, 0, 4)).toBe(0)
    expect(hitTestNode(x, y, r, 1, 1, 0, i => i !== 0)).toBe(-1)
  })

  it('moves the selection in the arrow direction', () => {
    expect(nearestInDirection(x, y, 0, 1, 0)).toBe(1)
    expect(nearestInDirection(x, y, 0, -1, 0)).toBe(3)
    expect(nearestInDirection(x, y, 0, 0, 1)).toBe(2)
    expect(nearestInDirection(x, y, 0, 0, -1)).toBe(4)
    expect(nearestInDirection(x, y, 2, 0, 1)).toBe(-1)
    expect(nearestInDirection(x, y, 0, 1, 0, i => i !== 1)).toBe(-1)
  })
})

describe('labels and sizing', () => {
  it('keeps higher-priority labels and drops overlapping ones', () => {
    const placed = placeLabels([
      { index: 0, x: 0, y: 0, width: 80, height: 14 },
      { index: 1, x: 40, y: 4, width: 80, height: 14 },
      { index: 2, x: 200, y: 0, width: 80, height: 14 },
      { index: 3, x: 10, y: 2, width: 30, height: 14, force: true },
      { index: 4, x: 0, y: 40, width: 80, height: 14 },
    ])
    expect(placed.map(label => label.index)).toEqual([0, 2, 3, 4])
    expect(
      placeLabels(
        [
          { index: 0, x: 0, y: 0, width: 10, height: 10 },
          { index: 1, x: 100, y: 0, width: 10, height: 10 },
        ],
        { limit: 1 }
      ).map(label => label.index)
    ).toEqual([0])
  })

  it('grows node radius gently with degree and length', () => {
    expect(nodeRadius(0, 0)).toBeCloseTo(2.8)
    expect(nodeRadius(4, 0)).toBeGreaterThan(nodeRadius(1, 0))
    expect(nodeRadius(1, 3_000)).toBeGreaterThan(nodeRadius(1, 0))
    expect(nodeRadius(10_000, 10_000_000)).toBe(12)
    expect(nodeRadius(9, 900, true)).toBeLessThan(nodeRadius(0, 0))
  })
})
