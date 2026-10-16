/**
 * Pure geometry for the note graph: a force-directed layout, camera maths,
 * hit testing, directional navigation and label culling. Nothing here touches
 * the DOM, so every piece is deterministic and unit-testable.
 */

export interface LayoutInputNode {
  id: string
  /** Collision radius in world units. */
  radius: number
}

export interface LayoutInputEdge {
  source: string
  target: string
  weight: number
}

export interface LayoutOptions {
  seed?: number
  /** Positions by id from an earlier layout. Defaults to a module cache. */
  cache?: PositionCache | null
  /** Many-body strength per node (negative repels). */
  charge?: number
  /** Rest length added to both radii for each link. */
  linkDistance?: number
  /** Weak pull toward the origin that keeps components gathered. */
  gravity?: number
  /** Extra space kept between node discs. */
  collisionPadding?: number
  /** Barnes–Hut accuracy. 0 forces exact pairwise forces. */
  theta?: number
  /** Use the quadtree above this many nodes. */
  barnesHutThreshold?: number
  /** Repulsion beyond this distance is ignored. */
  distanceMax?: number
}

export interface Simulation {
  readonly ids: string[]
  readonly index: Map<string, number>
  readonly x: Float64Array
  readonly y: Float64Array
  readonly vx: Float64Array
  readonly vy: Float64Array
  readonly radius: Float64Array
  readonly links: { source: number; target: number; weight: number }[]
  /** Share of nodes whose position came from the cache. */
  readonly warm: number
  alpha: number
  alphaTarget: number
  readonly alphaMin: number
  /** True when cooled and nothing holds the simulation awake. */
  readonly settled: boolean
  tick(iterations?: number): void
  /** Run ticks until the budget is spent or the layout rests. Returns `!settled`. */
  step(budgetMs: number, now?: () => number): boolean
  reheat(alpha?: number): void
  pin(index: number, x: number, y: number): void
  unpin(index: number): void
  isPinned(index: number): boolean
  kineticEnergy(): number
  bounds(ids?: Iterable<number>): Bounds | null
  /** Store current positions for a later warm start. */
  save(): void
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type PositionCache = Map<string, { x: number; y: number }>

const MAX_CACHED_POSITIONS = 20_000
/** Positions survive closing and reopening the graph within a session. */
export const positionCache: PositionCache = new Map()

/** A small, fast, seeded PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// Many-body forces

/**
 * A flat quadtree over point charges. Cells are created parent-first, so a
 * reverse sweep aggregates mass bottom-up without recursion.
 */
class QuadTree {
  private capacity = 0
  count = 0
  x0 = new Float64Array(0)
  y0 = new Float64Array(0)
  size = new Float64Array(0)
  mass = new Float64Array(0)
  cx = new Float64Array(0)
  cy = new Float64Array(0)
  /** Four child slots per cell; -1 when empty. */
  child = new Int32Array(0)
  /** First body in a leaf (-1 for internal or empty cells). */
  body = new Int32Array(0)
  /** Bodies sharing a leaf (coincident points), as a linked list. */
  next = new Int32Array(0)

  private grow(cells: number) {
    if (cells <= this.capacity) return
    const capacity = Math.max(cells, this.capacity * 2, 64)
    const resize = <T extends Float64Array | Int32Array>(
      array: T,
      fill?: number
    ): T => {
      const created = new (array.constructor as { new (n: number): T })(
        capacity * (array === this.child ? 4 : 1)
      )
      created.set(array)
      if (fill !== undefined) created.fill(fill, array.length)
      return created
    }
    this.x0 = resize(this.x0)
    this.y0 = resize(this.y0)
    this.size = resize(this.size)
    this.mass = resize(this.mass)
    this.cx = resize(this.cx)
    this.cy = resize(this.cy)
    this.child = resize(this.child, -1)
    this.body = resize(this.body, -1)
    this.capacity = capacity
  }

  private cell(x0: number, y0: number, size: number): number {
    this.grow(this.count + 1)
    const id = this.count++
    this.x0[id] = x0
    this.y0[id] = y0
    this.size[id] = size
    this.mass[id] = 0
    this.cx[id] = 0
    this.cy[id] = 0
    this.body[id] = -1
    this.child.fill(-1, id * 4, id * 4 + 4)
    return id
  }

  build(x: Float64Array, y: Float64Array, charge: Float64Array) {
    const n = x.length
    this.count = 0
    if (this.next.length < n) this.next = new Int32Array(n)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      if (x[i]! < minX) minX = x[i]!
      if (x[i]! > maxX) maxX = x[i]!
      if (y[i]! < minY) minY = y[i]!
      if (y[i]! > maxY) maxY = y[i]!
    }
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.0001
    this.cell(minX, minY, size)
    for (let i = 0; i < n; i++) this.insert(i, x, y)
    // Aggregate charge and charge-weighted centers from the leaves up.
    for (let id = this.count - 1; id >= 0; id--) {
      let mass = 0
      let sx = 0
      let sy = 0
      if (this.body[id]! >= 0) {
        for (let b = this.body[id]!; b >= 0; b = this.next[b]!) {
          const q = charge[b]!
          mass += q
          sx += x[b]! * q
          sy += y[b]! * q
        }
      } else {
        for (let q = 0; q < 4; q++) {
          const c = this.child[id * 4 + q]!
          if (c < 0) continue
          mass += this.mass[c]!
          sx += this.cx[c]! * this.mass[c]!
          sy += this.cy[c]! * this.mass[c]!
        }
      }
      this.mass[id] = mass
      this.cx[id] = mass !== 0 ? sx / mass : 0
      this.cy[id] = mass !== 0 ? sy / mass : 0
    }
  }

  private insert(i: number, x: Float64Array, y: Float64Array) {
    this.next[i] = -1
    let id = 0
    for (let depth = 0; ; depth++) {
      const hasChildren = this.body[id]! < 0 && this.isInternal(id)
      if (!hasChildren) {
        const resident = this.body[id]!
        if (resident < 0) {
          this.body[id] = i
          return
        }
        const same =
          Math.abs(x[resident]! - x[i]!) < 1e-9 &&
          Math.abs(y[resident]! - y[i]!) < 1e-9
        if (same || depth > 40) {
          this.next[i] = this.body[id]!
          this.body[id] = i
          return
        }
        // Split the leaf and push its resident bodies one level down.
        this.body[id] = -1
        const chain = resident
        const half = this.size[id]! / 2
        for (let b = chain; b >= 0;) {
          const following = this.next[b]!
          const q = this.quadrant(id, x[b]!, y[b]!)
          let c = this.child[id * 4 + q]!
          if (c < 0) {
            c = this.cell(
              this.x0[id]! + (q & 1 ? half : 0),
              this.y0[id]! + (q & 2 ? half : 0),
              half
            )
            this.child[id * 4 + q] = c
          }
          this.next[b] = this.body[c]!
          this.body[c] = b
          b = following
        }
      }
      const q = this.quadrant(id, x[i]!, y[i]!)
      const c = this.child[id * 4 + q]!
      if (c < 0) {
        const half = this.size[id]! / 2
        const created = this.cell(
          this.x0[id]! + (q & 1 ? half : 0),
          this.y0[id]! + (q & 2 ? half : 0),
          half
        )
        this.child[id * 4 + q] = created
        this.body[created] = i
        return
      }
      id = c
    }
  }

  private isInternal(id: number): boolean {
    const base = id * 4
    return (
      this.child[base]! >= 0 ||
      this.child[base + 1]! >= 0 ||
      this.child[base + 2]! >= 0 ||
      this.child[base + 3]! >= 0
    )
  }

  private quadrant(id: number, px: number, py: number): number {
    const half = this.size[id]! / 2
    return (
      (px >= this.x0[id]! + half ? 1 : 0) | (py >= this.y0[id]! + half ? 2 : 0)
    )
  }
}

const sharedTree = new QuadTree()
const traversal: number[] = []

/**
 * Accumulate the many-body force on every node into `fx`/`fy` (not scaled by
 * alpha). With `theta > 0` distant cells are approximated by their centre of
 * charge (Barnes–Hut); `theta = 0` computes exact pairwise forces.
 */
export function manyBodyForces(
  x: Float64Array,
  y: Float64Array,
  charge: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  { theta = 0.9, distanceMin = 1, distanceMax = Infinity } = {}
): void {
  const n = x.length
  fx.fill(0, 0, n)
  fy.fill(0, 0, n)
  const min2 = distanceMin * distanceMin
  const max2 = distanceMax * distanceMax
  if (theta <= 0) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[j]! - x[i]!
        const dy = y[j]! - y[i]!
        let d2 = dx * dx + dy * dy
        if (d2 >= max2) continue
        if (d2 < min2) d2 = Math.sqrt(min2 * d2)
        if (d2 === 0) continue
        // Charge on i from j pulls along +d for positive strength.
        fx[i] = fx[i]! + (dx * charge[j]!) / d2
        fy[i] = fy[i]! + (dy * charge[j]!) / d2
        fx[j] = fx[j]! - (dx * charge[i]!) / d2
        fy[j] = fy[j]! - (dy * charge[i]!) / d2
      }
    }
    return
  }
  const tree = sharedTree
  tree.build(x, y, charge)
  const theta2 = theta * theta
  for (let i = 0; i < n; i++) {
    const xi = x[i]!
    const yi = y[i]!
    let sx = 0
    let sy = 0
    traversal.length = 0
    traversal.push(0)
    while (traversal.length) {
      const id = traversal.pop()!
      const mass = tree.mass[id]!
      if (mass === 0) continue
      const dx = tree.cx[id]! - xi
      const dy = tree.cy[id]! - yi
      const w = tree.size[id]!
      let d2 = dx * dx + dy * dy
      const leaf = tree.body[id]! >= 0
      if (!leaf && (w * w) / theta2 < d2) {
        if (d2 < max2) {
          if (d2 < min2) d2 = Math.sqrt(min2 * d2)
          sx += (dx * mass) / d2
          sy += (dy * mass) / d2
        }
        continue
      }
      if (leaf) {
        for (let b = tree.body[id]!; b >= 0; b = tree.next[b]!) {
          if (b === i) continue
          const bx = x[b]! - xi
          const by = y[b]! - yi
          let e2 = bx * bx + by * by
          if (e2 >= max2 || e2 === 0) continue
          if (e2 < min2) e2 = Math.sqrt(min2 * e2)
          sx += (bx * charge[b]!) / e2
          sy += (by * charge[b]!) / e2
        }
        continue
      }
      for (let q = 0; q < 4; q++) {
        const c = tree.child[id * 4 + q]!
        if (c >= 0) traversal.push(c)
      }
    }
    fx[i] = sx
    fy[i] = sy
  }
}

// ---------------------------------------------------------------------------
// Simulation

/** Golden-angle spiral with seeded jitter: even, deterministic, compact. */
function initialPosition(index: number, spacing: number, random: () => number) {
  const radius = spacing * Math.sqrt(0.5 + index)
  const angle = index * Math.PI * (3 - Math.sqrt(5))
  return {
    x: radius * Math.cos(angle) + (random() - 0.5) * spacing * 0.5,
    y: radius * Math.sin(angle) + (random() - 0.5) * spacing * 0.5,
  }
}

export function createSimulation(
  nodes: LayoutInputNode[],
  edges: LayoutInputEdge[],
  options: LayoutOptions = {}
): Simulation {
  const {
    seed = 1,
    cache = positionCache,
    charge: strength = -42,
    linkDistance = 34,
    gravity = 0.045,
    collisionPadding = 3,
    theta = 0.9,
    barnesHutThreshold = 200,
    distanceMax = 1_600,
  } = options
  const n = nodes.length
  const ids = nodes.map(node => node.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const vx = new Float64Array(n)
  const vy = new Float64Array(n)
  const fx = new Float64Array(n)
  const fy = new Float64Array(n)
  const radius = new Float64Array(nodes.map(node => Math.max(0.5, node.radius)))
  const pinX = new Float64Array(n).fill(NaN)
  const pinY = new Float64Array(n).fill(NaN)
  const charge = new Float64Array(n)
  const random = seededRandom(seed ^ hashString(ids.join('\u0000')))

  const links: { source: number; target: number; weight: number }[] = []
  const linkCount = new Float64Array(n)
  for (const edge of edges) {
    const source = index.get(edge.source)
    const target = index.get(edge.target)
    if (source === undefined || target === undefined || source === target)
      continue
    links.push({ source, target, weight: Math.max(0.05, edge.weight) })
    linkCount[source] = linkCount[source]! + 1
    linkCount[target] = linkCount[target]! + 1
  }
  // Hubs push a little harder so their neighbourhoods get room.
  for (let i = 0; i < n; i++)
    charge[i] = strength * (1 + Math.min(2, Math.sqrt(linkCount[i]!) * 0.15))
  const linkStrength = links.map(
    link =>
      Math.min(1, 0.55 + 0.25 * Math.log2(1 + link.weight)) /
      Math.min(linkCount[link.source]!, linkCount[link.target]!)
  )
  const linkLength = links.map(
    link =>
      (linkDistance + radius[link.source]! + radius[link.target]!) /
      (1 + 0.12 * Math.log2(Math.max(1, link.weight)))
  )
  const linkBias = links.map(
    link =>
      linkCount[link.source]! /
      (linkCount[link.source]! + linkCount[link.target]!)
  )

  // Warm start: reuse cached positions; place new nodes beside a known
  // neighbour when possible, otherwise on the spiral.
  let known = 0
  const placed = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const cached = cache?.get(ids[i]!)
    if (cached && Number.isFinite(cached.x) && Number.isFinite(cached.y)) {
      x[i] = cached.x
      y[i] = cached.y
      placed[i] = 1
      known++
    }
  }
  const spacing = linkDistance * 0.9
  if (known < n) {
    const neighbours: number[][] = Array.from({ length: n }, () => [])
    for (const link of links) {
      neighbours[link.source]!.push(link.target)
      neighbours[link.target]!.push(link.source)
    }
    let spiral = 0
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        if (placed[i]) continue
        const anchor = neighbours[i]!.find(j => placed[j])
        if (anchor !== undefined) {
          const angle = random() * Math.PI * 2
          const distance = spacing * (0.6 + random() * 0.6)
          x[i] = x[anchor]! + Math.cos(angle) * distance
          y[i] = y[anchor]! + Math.sin(angle) * distance
          placed[i] = 1
        } else if (pass === 1 || known === 0) {
          const position = initialPosition(spiral++, spacing, random)
          x[i] = position.x
          y[i] = position.y
          placed[i] = 1
        }
      }
    }
  }
  const warm = n ? known / n : 1

  const alphaMin = 0.001
  const alphaDecay = 1 - Math.pow(alphaMin, 1 / 300)
  const velocityDecay = 0.6
  const useTree = n > barnesHutThreshold && theta > 0

  // Collision uses a uniform grid sized to the largest disc.
  let maxRadius = 0
  for (let i = 0; i < n; i++) maxRadius = Math.max(maxRadius, radius[i]!)
  const cellSize = Math.max(1, (maxRadius + collisionPadding) * 2)
  const grid = new Map<number, number[]>()
  const cellKey = (cx: number, cy: number) => (cx * 73856093) ^ (cy * 19349663)

  const collide = () => {
    grid.clear()
    for (let i = 0; i < n; i++) {
      const key = cellKey(
        Math.floor((x[i]! + vx[i]!) / cellSize),
        Math.floor((y[i]! + vy[i]!) / cellSize)
      )
      const bucket = grid.get(key)
      if (bucket) bucket.push(i)
      else grid.set(key, [i])
    }
    for (let i = 0; i < n; i++) {
      const xi = x[i]! + vx[i]!
      const yi = y[i]! + vy[i]!
      const ri = radius[i]! + collisionPadding
      const gx = Math.floor(xi / cellSize)
      const gy = Math.floor(yi / cellSize)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = grid.get(cellKey(gx + ox, gy + oy))
          if (!bucket) continue
          for (const j of bucket) {
            if (j <= i) continue
            const rj = radius[j]! + collisionPadding
            let dx = xi - (x[j]! + vx[j]!)
            let dy = yi - (y[j]! + vy[j]!)
            let d2 = dx * dx + dy * dy
            const reach = ri + rj
            if (d2 >= reach * reach) continue
            if (d2 === 0) {
              dx = (random() - 0.5) * 1e-3
              dy = (random() - 0.5) * 1e-3
              d2 = dx * dx + dy * dy
            }
            const d = Math.sqrt(d2)
            const push = ((reach - d) / d) * 0.7
            const share = (rj * rj) / (ri * ri + rj * rj)
            vx[i] = vx[i]! + dx * push * share
            vy[i] = vy[i]! + dy * push * share
            vx[j] = vx[j]! - dx * push * (1 - share)
            vy[j] = vy[j]! - dy * push * (1 - share)
          }
        }
      }
    }
  }

  const simulation: Simulation = {
    ids,
    index,
    x,
    y,
    vx,
    vy,
    radius,
    links,
    warm,
    alpha: n === 0 ? 0 : warm > 0.9 ? 0.25 : warm > 0.5 ? 0.5 : 1,
    alphaTarget: 0,
    alphaMin,
    get settled() {
      return simulation.alpha < alphaMin && simulation.alphaTarget < alphaMin
    },
    tick(iterations = 1) {
      for (let iteration = 0; iteration < iterations; iteration++) {
        const alpha = (simulation.alpha +=
          (simulation.alphaTarget - simulation.alpha) * alphaDecay)
        if (n === 0) continue
        // Springs.
        for (let l = 0; l < links.length; l++) {
          const link = links[l]!
          const s = link.source
          const t = link.target
          let dx = x[t]! + vx[t]! - x[s]! - vx[s]!
          let dy = y[t]! + vy[t]! - y[s]! - vy[s]!
          if (dx === 0 && dy === 0) {
            dx = (random() - 0.5) * 1e-3
            dy = (random() - 0.5) * 1e-3
          }
          const d = Math.sqrt(dx * dx + dy * dy)
          const k = ((d - linkLength[l]!) / d) * alpha * linkStrength[l]!
          dx *= k
          dy *= k
          const bias = linkBias[l]!
          vx[t] = vx[t]! - dx * bias
          vy[t] = vy[t]! - dy * bias
          vx[s] = vx[s]! + dx * (1 - bias)
          vy[s] = vy[s]! + dy * (1 - bias)
        }
        // Repulsion.
        if (n > 1) {
          manyBodyForces(x, y, charge, fx, fy, {
            theta: useTree ? theta : 0,
            distanceMax,
          })
          for (let i = 0; i < n; i++) {
            vx[i] = vx[i]! + fx[i]! * alpha
            vy[i] = vy[i]! + fy[i]! * alpha
          }
        }
        // Gravity keeps disconnected components gathered near the centre.
        for (let i = 0; i < n; i++) {
          vx[i] = vx[i]! - x[i]! * gravity * alpha
          vy[i] = vy[i]! - y[i]! * gravity * alpha
        }
        collide()
        for (let i = 0; i < n; i++) {
          if (!Number.isNaN(pinX[i]!)) {
            x[i] = pinX[i]!
            y[i] = pinY[i]!
            vx[i] = 0
            vy[i] = 0
            continue
          }
          vx[i] = vx[i]! * velocityDecay
          vy[i] = vy[i]! * velocityDecay
          x[i] = x[i]! + vx[i]!
          y[i] = y[i]! + vy[i]!
        }
      }
    },
    step(budgetMs, now = () => performance.now()) {
      if (simulation.settled) return false
      const started = now()
      do simulation.tick()
      while (!simulation.settled && now() - started < budgetMs)
      return !simulation.settled
    },
    reheat(alpha = 0.3) {
      simulation.alpha = Math.max(simulation.alpha, alpha)
    },
    pin(i, px, py) {
      if (i < 0 || i >= n) return
      pinX[i] = px
      pinY[i] = py
      x[i] = px
      y[i] = py
      vx[i] = 0
      vy[i] = 0
    },
    unpin(i) {
      if (i < 0 || i >= n) return
      pinX[i] = NaN
      pinY[i] = NaN
    },
    isPinned(i) {
      return i >= 0 && i < n && !Number.isNaN(pinX[i]!)
    },
    kineticEnergy() {
      let energy = 0
      for (let i = 0; i < n; i++) energy += vx[i]! * vx[i]! + vy[i]! * vy[i]!
      return energy
    },
    bounds(subset) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const visit = (i: number) => {
        const r = radius[i]!
        minX = Math.min(minX, x[i]! - r)
        minY = Math.min(minY, y[i]! - r)
        maxX = Math.max(maxX, x[i]! + r)
        maxY = Math.max(maxY, y[i]! + r)
      }
      if (subset) for (const i of subset) visit(i)
      else for (let i = 0; i < n; i++) visit(i)
      return minX === Infinity ? null : { minX, minY, maxX, maxY }
    },
    save() {
      if (!cache) return
      for (let i = 0; i < n; i++) {
        cache.delete(ids[i]!)
        cache.set(ids[i]!, { x: x[i]!, y: y[i]! })
      }
      while (cache.size > MAX_CACHED_POSITIONS) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
    },
  }
  return simulation
}

// ---------------------------------------------------------------------------
// Camera

/** The world point shown at the viewport centre, and the zoom factor. */
export interface Camera {
  x: number
  y: number
  k: number
}

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 6

export const clampZoom = (k: number, min = MIN_ZOOM, max = MAX_ZOOM) =>
  Math.min(max, Math.max(min, k))

export function worldToScreen(
  camera: Camera,
  width: number,
  height: number,
  wx: number,
  wy: number
) {
  return {
    x: (wx - camera.x) * camera.k + width / 2,
    y: (wy - camera.y) * camera.k + height / 2,
  }
}

export function screenToWorld(
  camera: Camera,
  width: number,
  height: number,
  sx: number,
  sy: number
) {
  return {
    x: camera.x + (sx - width / 2) / camera.k,
    y: camera.y + (sy - height / 2) / camera.k,
  }
}

/** Zoom by `factor`, keeping the world point under the screen point fixed. */
export function zoomAt(
  camera: Camera,
  width: number,
  height: number,
  sx: number,
  sy: number,
  factor: number,
  min = MIN_ZOOM,
  max = MAX_ZOOM
): Camera {
  const k = clampZoom(camera.k * factor, min, max)
  const anchor = screenToWorld(camera, width, height, sx, sy)
  return {
    x: anchor.x - (sx - width / 2) / k,
    y: anchor.y - (sy - height / 2) / k,
    k,
  }
}

/** Frame `bounds` inside the viewport with `padding` screen pixels around it. */
export function fitCamera(
  bounds: Bounds | null,
  width: number,
  height: number,
  { padding = 80, maxZoom = 1.6, minZoom = MIN_ZOOM } = {}
): Camera {
  if (!bounds || width <= 0 || height <= 0) return { x: 0, y: 0, k: 1 }
  const w = Math.max(bounds.maxX - bounds.minX, 1)
  const h = Math.max(bounds.maxY - bounds.minY, 1)
  const k = clampZoom(
    Math.min(
      Math.max(width - padding * 2, width * 0.3) / w,
      Math.max(height - padding * 2, height * 0.3) / h
    ),
    minZoom,
    maxZoom
  )
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    k,
  }
}

export const easeOutCubic = (t: number) =>
  1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)

/** Interpolate cameras, zooming in log space so the motion feels even. */
export function interpolateCamera(from: Camera, to: Camera, t: number): Camera {
  const e = easeOutCubic(t)
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    k: Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e),
  }
}

// ---------------------------------------------------------------------------
// Picking and navigation

/**
 * The node under a world point. `slop` adds forgiveness in world units so
 * small discs stay easy to hit; the nearest centre wins.
 */
export function hitTestNode(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  radius: ArrayLike<number>,
  wx: number,
  wy: number,
  slop = 0,
  include?: (index: number) => boolean
): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < x.length; i++) {
    if (include && !include(i)) continue
    const dx = x[i]! - wx
    const dy = y[i]! - wy
    const d2 = dx * dx + dy * dy
    const reach = radius[i]! + slop
    if (d2 <= reach * reach && d2 < bestDistance) {
      best = i
      bestDistance = d2
    }
  }
  return best
}

/**
 * The closest node roughly in a direction (within a 45° half-angle cone,
 * preferring alignment). Returns -1 when nothing lies that way.
 */
export function nearestInDirection(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  from: number,
  dx: number,
  dy: number,
  include?: (index: number) => boolean
): number {
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < x.length; i++) {
    if (i === from || (include && !include(i))) continue
    const ox = x[i]! - x[from]!
    const oy = y[i]! - y[from]!
    const distance = Math.hypot(ox, oy)
    if (distance === 0) continue
    const along = ox * ux + oy * uy
    if (along <= 0 || along < distance * Math.SQRT1_2) continue
    const across = Math.abs(ox * uy - oy * ux)
    const score = along + across * 2
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Labels

export interface LabelCandidate {
  index: number
  /** Screen-space rectangle the label would occupy. */
  x: number
  y: number
  width: number
  height: number
  /** Always placed, even when it overlaps (hovered, active, selected). */
  force?: boolean
}

/**
 * Place labels in priority order, dropping any that would overlap one already
 * placed. Candidates must arrive sorted from most to least important.
 */
export function placeLabels<T extends LabelCandidate>(
  candidates: T[],
  { cell = 64, gap = 3, limit = Infinity } = {}
): T[] {
  const placed: T[] = []
  const grid = new Map<string, LabelCandidate[]>()
  const cellsFor = (label: LabelCandidate) => {
    const keys: string[] = []
    const x0 = Math.floor((label.x - gap) / cell)
    const x1 = Math.floor((label.x + label.width + gap) / cell)
    const y0 = Math.floor((label.y - gap) / cell)
    const y1 = Math.floor((label.y + label.height + gap) / cell)
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) keys.push(`${gx},${gy}`)
    return keys
  }
  for (const label of candidates) {
    if (!label.force && placed.length >= limit) continue
    const keys = cellsFor(label)
    let blocked = false
    if (!label.force)
      outer: for (const key of keys)
        for (const other of grid.get(key) ?? [])
          if (
            label.x < other.x + other.width + gap &&
            label.x + label.width + gap > other.x &&
            label.y < other.y + other.height + gap &&
            label.y + label.height + gap > other.y
          ) {
            blocked = true
            break outer
          }
    if (blocked) continue
    placed.push(label)
    for (const key of keys) {
      const bucket = grid.get(key)
      if (bucket) bucket.push(label)
      else grid.set(key, [label])
    }
  }
  return placed
}

/** Node disc radius in world units, growing gently with links and length. */
export function nodeRadius(
  degree: number,
  words: number,
  ghost = false
): number {
  if (ghost) return 2.6
  return Math.min(
    12,
    2.8 + 1.25 * Math.sqrt(degree) + 0.5 * Math.sqrt(Math.max(0, words) / 300)
  )
}
