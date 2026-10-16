import * as Dialog from '@radix-ui/react-dialog'
import { List, Minus, Plus, Scan, Search, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type RefObject,
} from 'react'
import type { ContextPackage, ContextSource, Note } from '../types/notebook'
import {
  buildNoteGraph,
  neighborhood,
  noteKey,
  type NoteGraph as NoteGraphData,
  type NoteGraphNode,
} from './note-links'
import {
  clampZoom,
  createSimulation,
  fitCamera,
  hitTestNode,
  interpolateCamera,
  nearestInDirection,
  nodeRadius,
  placeLabels,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
  type LabelCandidate,
  type Simulation,
} from './note-graph-layout'
import './NoteGraph.css'

// ---------------------------------------------------------------------------
// Graph derivation

export interface GraphViewOptions {
  scope: 'all' | 'local'
  depth: 1 | 2
  contextLinks: boolean
  unlinked: boolean
  ghosts: boolean
}

export const defaultGraphOptions: GraphViewOptions = {
  scope: 'all',
  depth: 1,
  contextLinks: true,
  unlinked: true,
  ghosts: true,
}

/** View choices persist while the app runs, so reopening feels continuous. */
let rememberedOptions: GraphViewOptions = { ...defaultGraphOptions }
let rememberedList = false

/** Forget remembered view choices (used by tests and on sign-out paths). */
export function resetGraphView() {
  rememberedOptions = { ...defaultGraphOptions }
  rememberedList = false
}

export interface DerivedGraph extends NoteGraphData {
  /** Connections that exist anywhere, before view filters. */
  totalEdges: number
  local: boolean
}

/** Apply the view filters and recompute degrees for what remains. */
export function deriveGraph(
  notes: Note[],
  library: ContextSource[],
  packages: ContextPackage[],
  activeNoteId: string | null,
  options: GraphViewOptions
): DerivedGraph {
  const full = buildNoteGraph(notes, library, packages, {
    ghosts: options.ghosts,
  })
  let nodes = full.nodes
  let edges = options.contextLinks
    ? full.edges
    : full.edges.filter(edge => edge.kind === 'link')
  const center =
    activeNoteId && nodes.some(node => node.id === activeNoteId)
      ? activeNoteId
      : null
  const local = options.scope === 'local' && center !== null
  if (local) {
    const keep = neighborhood({ nodes, edges }, center, options.depth)
    nodes = nodes.filter(node => keep.has(node.id))
    edges = edges.filter(edge => keep.has(edge.source) && keep.has(edge.target))
  }
  const degree = new Map<string, number>()
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  nodes = nodes.map(node =>
    node.degree === (degree.get(node.id) ?? 0)
      ? node
      : { ...node, degree: degree.get(node.id) ?? 0 }
  )
  if (!options.unlinked)
    nodes = nodes.filter(node => node.degree > 0 || node.id === center)
  return { nodes, edges, totalEdges: full.edges.length, local }
}

/** Rank title matches: exact, prefix, word start, then anywhere. */
export function searchGraph(
  nodes: NoteGraphNode[],
  query: string
): { matches: Set<string>; best: string | null } {
  const needle = noteKey(query)
  const matches = new Set<string>()
  if (!needle) return { matches, best: null }
  let best: NoteGraphNode | null = null
  let bestScore = Infinity
  for (const node of nodes) {
    const key = noteKey(node.title)
    let score: number
    if (key === needle) score = 0
    else if (key.startsWith(needle)) score = 1
    else if (` ${key}`.includes(` ${needle}`)) score = 2
    else if (key.includes(needle)) score = 3
    else continue
    matches.add(node.id)
    // Written notes before placeholders, then the better connected note.
    score = score * 1e6 + (node.ghost ? 5e5 : 0) - Math.min(node.degree, 4e5)
    if (score < bestScore) {
      best = node
      bestScore = score
    }
  }
  return { matches, best: best?.id ?? null }
}

const displayTitle = (title: string) => title.trim() || 'Untitled'

function connectionSummary(node: NoteGraphNode) {
  if (node.ghost) return 'Not written yet'
  if (node.degree === 0) return 'No connections'
  return `${node.degree} ${node.degree === 1 ? 'connection' : 'connections'}`
}

// ---------------------------------------------------------------------------
// Canvas view

interface Palette {
  ink: string
  secondary: string
  muted: string
  line: string
  accent: string
  paper: string
  surface: string
  font: string
}

const FALLBACK_FONT = "'Source Sans Pro', 'Segoe UI', sans-serif"

function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback
  return {
    ink: read('--ink', '#292d29'),
    secondary: read('--secondary', '#60665e'),
    muted: read('--muted', '#697066'),
    line: read('--line', '#e5e8e1'),
    accent: read('--accent', '#42644d'),
    paper: read('--paper', '#ffffff'),
    surface: read('--surface', '#f8f9f6'),
    font: style.fontFamily.trim() || FALLBACK_FONT,
  }
}

let motionQuery: MediaQueryList | null | undefined
const prefersReducedMotion = () => {
  if (motionQuery === undefined)
    motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null
  return motionQuery?.matches ?? false
}

const DIM = 0.14
const LABEL_HEIGHT = 15
const MAX_LABEL_CHARS = 34
const CAMERA_MS = 300

export interface GraphViewCallbacks {
  onHover(id: string | null): void
  /** A click without dragging: a node id, or null for the background. */
  onActivate(id: string | null): void
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  node: number
  moved: boolean
}

/**
 * Owns the canvas, simulation, camera and pointer input. React passes data and
 * focus in; hot paths (frames, pointer moves) never re-render React.
 */
export class GraphView {
  private readonly ctx: CanvasRenderingContext2D | null
  private width = 0
  private height = 0
  private dpr = 1
  private nodes: NoteGraphNode[] = []
  private sim: Simulation | null = null
  private edgeSource = new Int32Array(0)
  private edgeTarget = new Int32Array(0)
  private edgeContext = new Uint8Array(0)
  private neighbours: number[][] = []
  private byDegree: number[] = []
  private displayRadius = new Float64Array(0)
  private emphasis = new Float32Array(0)
  private emphasisTarget = new Float32Array(0)
  private camera: Camera = { x: 0, y: 0, k: 1 }
  private cameraAnimation: {
    from: Camera
    to: Camera
    start: number
  } | null = null
  private autoFit = true
  private signature = ''
  private nodeSignature = ''
  private hover = -1
  private externalHover = -1
  private selected = -1
  private active = -1
  private best = -1
  private matches: Set<number> | null = null
  private drag: DragState | null = null
  private frameId = 0
  private lastFrame = 0
  private destroyed = false
  private palette: Palette
  private readonly labelWidths = new Map<string, number>()
  private readonly cleanups: (() => void)[] = []

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly tooltip: HTMLElement | null,
    private readonly callbacks: { current: GraphViewCallbacks }
  ) {
    let context: CanvasRenderingContext2D | null = null
    try {
      context = canvas.getContext('2d')
    } catch {
      context = null
    }
    this.ctx = context
    this.palette = readPalette()
    this.measure()
    this.listen(canvas, 'pointerdown', this.onPointerDown)
    this.listen(canvas, 'pointermove', this.onPointerMove)
    this.listen(canvas, 'pointerup', this.onPointerUp)
    this.listen(canvas, 'pointercancel', this.onPointerUp)
    this.listen(canvas, 'pointerleave', this.onPointerLeave)
    this.listen(canvas, 'dblclick', this.onDoubleClick)
    this.listen(canvas, 'wheel', this.onWheel, { passive: false })
    this.listen(document, 'visibilitychange', this.onVisibility)
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        this.measure()
        this.invalidate()
      })
      observer.observe(host)
      this.cleanups.push(() => observer.disconnect())
    } else {
      this.listen(window, 'resize', () => {
        this.measure()
        this.invalidate()
      })
    }
    if (typeof MutationObserver !== 'undefined') {
      // Palette changes write custom properties to the root's style.
      const observer = new MutationObserver(() => {
        const next = readPalette()
        if (next.font !== this.palette.font) this.labelWidths.clear()
        this.palette = next
        this.invalidate()
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'style', 'class'],
      })
      this.cleanups.push(() => observer.disconnect())
    }
  }

  private listen<K extends string>(
    target: EventTarget,
    type: K,
    handler: (event: never) => void,
    options?: AddEventListenerOptions
  ) {
    const listener = handler as unknown as EventListener
    target.addEventListener(type, listener, options)
    this.cleanups.push(() =>
      target.removeEventListener(type, listener, options)
    )
  }

  destroy() {
    this.destroyed = true
    if (this.frameId) cancelFrame(this.frameId)
    this.frameId = 0
    this.sim?.save()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  // -- Data -----------------------------------------------------------------

  setGraph(graph: NoteGraphData) {
    const nodes = graph.nodes
    const n = nodes.length
    const index = new Map(nodes.map((node, i) => [node.id, i]))
    const edges = graph.edges.filter(
      edge => index.has(edge.source) && index.has(edge.target)
    )
    const nodeSignature = nodes.map(node => node.id).join('\u0000')
    const signature = `${nodeSignature}\u0001${edges
      .map(
        edge =>
          `${edge.source}\u0000${edge.target}\u0000${edge.kind}\u0000${edge.weight}`
      )
      .join('\u0001')}`
    if (this.sim && signature === this.signature) {
      // Same shape (for example, a note was saved): keep layout and camera.
      this.nodes = nodes
      this.invalidate()
      return
    }
    const previous = this.sim
    previous?.save()
    const reshaped = nodeSignature !== this.nodeSignature
    this.signature = signature
    this.nodeSignature = nodeSignature
    const hoverId = this.idAt(this.hover)
    this.nodes = nodes
    this.edgeSource = new Int32Array(edges.map(edge => index.get(edge.source)!))
    this.edgeTarget = new Int32Array(edges.map(edge => index.get(edge.target)!))
    this.edgeContext = new Uint8Array(
      edges.map(edge => (edge.kind === 'context' ? 1 : 0))
    )
    this.neighbours = Array.from({ length: n }, () => [])
    for (let e = 0; e < edges.length; e++) {
      this.neighbours[this.edgeSource[e]!]!.push(this.edgeTarget[e]!)
      this.neighbours[this.edgeTarget[e]!]!.push(this.edgeSource[e]!)
    }
    this.displayRadius = new Float64Array(
      nodes.map(node => nodeRadius(node.degree, node.words, node.ghost))
    )
    this.byDegree = nodes
      .map((_, i) => i)
      .sort(
        (a, b) =>
          nodes[b]!.degree - nodes[a]!.degree ||
          nodes[b]!.words - nodes[a]!.words
      )
    this.sim = createSimulation(
      nodes.map((node, i) => ({
        id: node.id,
        radius: this.displayRadius[i]! + 1,
      })),
      edges.map(edge => ({
        source: edge.source,
        target: edge.target,
        // Context is a looser relationship than a written link.
        weight: edge.kind === 'context' ? edge.weight * 0.5 : edge.weight,
      }))
    )
    // Settle a little before the first paint so the graph opens composed.
    this.sim.step(prefersReducedMotion() ? 400 : this.sim.warm > 0.5 ? 12 : 60)
    this.emphasis = new Float32Array(n).fill(1)
    this.emphasisTarget = new Float32Array(n).fill(1)
    this.hover = hoverId ? (index.get(hoverId) ?? -1) : -1
    this.drag = null
    if (reshaped) this.autoFit = true
    if (!previous) this.camera = this.fitTarget()
    this.cameraAnimation = null
    this.refreshEmphasis(true)
    this.invalidate()
  }

  setFocus(focus: {
    active: string | null
    selected: string | null
    matches: Set<string> | null
    best: string | null
  }) {
    const index = this.sim?.index
    const find = (id: string | null) =>
      id && index ? (index.get(id) ?? -1) : -1
    this.active = find(focus.active)
    this.selected = find(focus.selected)
    this.best = find(focus.best)
    this.matches = focus.matches
      ? new Set([...focus.matches].map(find).filter(i => i >= 0))
      : null
    this.refreshEmphasis()
    this.invalidate()
  }

  setExternalHover(id: string | null) {
    this.externalHover = id && this.sim ? (this.sim.index.get(id) ?? -1) : -1
    this.refreshEmphasis()
    this.invalidate()
  }

  private idAt(i: number): string | null {
    return i >= 0 ? (this.nodes[i]?.id ?? null) : null
  }

  private focusIndex() {
    if (this.hover >= 0) return this.hover
    if (this.externalHover >= 0) return this.externalHover
    return this.selected
  }

  private refreshEmphasis(snap = false) {
    const n = this.nodes.length
    const target = this.emphasisTarget
    const focus = this.focusIndex()
    if (focus >= 0) {
      target.fill(DIM)
      target[focus] = 1
      for (const j of this.neighbours[focus] ?? []) target[j] = 1
    } else if (this.matches) {
      target.fill(DIM)
      for (const i of this.matches) target[i] = 1
    } else target.fill(1)
    if (snap || prefersReducedMotion())
      for (let i = 0; i < n; i++) this.emphasis[i] = target[i]!
  }

  // -- Camera -----------------------------------------------------------------

  private measure() {
    const rect = this.host.getBoundingClientRect()
    this.width = Math.max(0, rect.width || this.host.clientWidth)
    this.height = Math.max(0, rect.height || this.host.clientHeight)
    this.dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  }

  private fitTarget(indices?: Iterable<number>): Camera {
    // Leave room for the floating toolbar above and the legend below.
    return fitCamera(
      this.sim?.bounds(indices) ?? null,
      this.width,
      this.height,
      {
        padding: Math.min(
          96,
          Math.max(32, Math.min(this.width, this.height) * 0.12)
        ),
        maxZoom: 1.8,
      }
    )
  }

  private animateTo(target: Camera) {
    this.autoFit = false
    if (prefersReducedMotion()) {
      this.camera = target
      this.cameraAnimation = null
    } else
      this.cameraAnimation = {
        from: { ...this.camera },
        to: target,
        start: performance.now(),
      }
    this.invalidate()
  }

  fit() {
    this.animateTo(this.fitTarget())
    // Keep following the layout while it is still settling.
    this.autoFit = !(this.sim?.settled ?? true)
  }

  centerOn(id: string, minZoom = 0.9) {
    const i = this.sim?.index.get(id)
    if (i === undefined || !this.sim) return
    this.animateTo({
      x: this.sim.x[i]!,
      y: this.sim.y[i]!,
      k: clampZoom(Math.max(this.camera.k, minZoom)),
    })
  }

  /** Pan just enough to bring a node comfortably inside the viewport. */
  ensureVisible(id: string) {
    const i = this.sim?.index.get(id)
    if (i === undefined || !this.sim) return
    const margin = Math.min(120, Math.min(this.width, this.height) * 0.2)
    const s = worldToScreen(
      this.camera,
      this.width,
      this.height,
      this.sim.x[i]!,
      this.sim.y[i]!
    )
    if (
      s.x >= margin &&
      s.y >= margin &&
      s.x <= this.width - margin &&
      s.y <= this.height - margin
    )
      return
    this.animateTo({ ...this.camera, x: this.sim.x[i]!, y: this.sim.y[i]! })
  }

  zoomBy(factor: number) {
    this.animateTo(
      zoomAt(
        this.camera,
        this.width,
        this.height,
        this.width / 2,
        this.height / 2,
        factor
      )
    )
  }

  screenPosition(id: string): { x: number; y: number } | null {
    const i = this.sim?.index.get(id)
    if (i === undefined || !this.sim) return null
    return worldToScreen(
      this.camera,
      this.width,
      this.height,
      this.sim.x[i]!,
      this.sim.y[i]!
    )
  }

  /** The node to start keyboard navigation from. */
  startNode(preferred: string | null): string | null {
    if (!this.sim || !this.nodes.length) return null
    if (preferred && this.sim.index.has(preferred)) return preferred
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < this.nodes.length; i++) {
      const d = Math.hypot(
        this.sim.x[i]! - this.camera.x,
        this.sim.y[i]! - this.camera.y
      )
      if (d < bestDistance) {
        best = i
        bestDistance = d
      }
    }
    return this.nodes[best]!.id
  }

  neighbourInDirection(from: string, dx: number, dy: number): string | null {
    const i = this.sim?.index.get(from)
    if (i === undefined || !this.sim) return null
    return this.idAt(nearestInDirection(this.sim.x, this.sim.y, i, dx, dy))
  }

  // -- Input ------------------------------------------------------------------

  private local(event: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private pick(sx: number, sy: number): number {
    if (!this.sim) return -1
    const world = screenToWorld(this.camera, this.width, this.height, sx, sy)
    const k = this.camera.k
    // Discs never render smaller than 1.6px; keep a forgiving target.
    return hitTestNode(
      this.sim.x,
      this.sim.y,
      this.displayRadius,
      world.x,
      world.y,
      Math.max(1.6 / k, 0) + 5 / k
    )
  }

  private setHover(i: number) {
    if (i === this.hover) return
    this.hover = i
    this.canvas.style.cursor = i >= 0 ? 'pointer' : ''
    this.refreshEmphasis()
    this.invalidate()
    this.callbacks.current.onHover(this.idAt(i))
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const p = this.local(event)
    try {
      this.canvas.setPointerCapture(event.pointerId)
    } catch {
      // Capture is best effort (for example, synthetic events in tests).
    }
    this.cameraAnimation = null
    this.drag = {
      pointerId: event.pointerId,
      startX: p.x,
      startY: p.y,
      lastX: p.x,
      lastY: p.y,
      node: this.pick(p.x, p.y),
      moved: false,
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    const p = this.local(event)
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) {
      this.setHover(this.pick(p.x, p.y))
      return
    }
    if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 3) {
      drag.moved = true
      this.autoFit = false
      this.canvas.style.cursor = 'grabbing'
      if (drag.node >= 0 && this.sim) {
        this.sim.alphaTarget = 0.25
        this.sim.reheat(0.25)
      }
    }
    if (drag.moved) {
      if (drag.node >= 0 && this.sim) {
        const world = screenToWorld(
          this.camera,
          this.width,
          this.height,
          p.x,
          p.y
        )
        this.sim.pin(drag.node, world.x, world.y)
      } else {
        this.camera = {
          ...this.camera,
          x: this.camera.x - (p.x - drag.lastX) / this.camera.k,
          y: this.camera.y - (p.y - drag.lastY) / this.camera.k,
        }
      }
      this.invalidate()
    }
    drag.lastX = p.x
    drag.lastY = p.y
  }

  private onPointerUp = (event: PointerEvent) => {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    this.drag = null
    try {
      this.canvas.releasePointerCapture(event.pointerId)
    } catch {
      // Already released.
    }
    if (drag.node >= 0 && this.sim?.isPinned(drag.node)) {
      this.sim.unpin(drag.node)
      this.sim.alphaTarget = 0
      this.invalidate()
    }
    const p = this.local(event)
    this.canvas.style.cursor = this.pick(p.x, p.y) >= 0 ? 'pointer' : ''
    if (!drag.moved && event.type === 'pointerup')
      this.callbacks.current.onActivate(this.idAt(drag.node))
  }

  private onPointerLeave = () => {
    if (!this.drag) this.setHover(-1)
  }

  private onDoubleClick = (event: MouseEvent) => {
    const p = this.local(event)
    if (this.pick(p.x, p.y) < 0) this.fit()
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const p = this.local(event)
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
    // Pinch gestures arrive as ctrl + wheel with small deltas.
    const sensitivity = event.ctrlKey ? 0.01 : 0.0016
    const factor = Math.exp(-event.deltaY * scale * sensitivity)
    this.cameraAnimation = null
    this.autoFit = false
    this.camera = zoomAt(this.camera, this.width, this.height, p.x, p.y, factor)
    this.invalidate()
  }

  private onVisibility = () => {
    if (!document.hidden) {
      this.lastFrame = 0
      this.invalidate()
    }
  }

  // -- Frames -----------------------------------------------------------------

  invalidate() {
    if (this.frameId || this.destroyed) return
    this.frameId = requestFrame(this.frame)
  }

  private frame = (time: number) => {
    this.frameId = 0
    if (this.destroyed || document.hidden) return
    const dt = this.lastFrame
      ? Math.min(64, Math.max(1, time - this.lastFrame))
      : 16
    this.lastFrame = time
    let busy = false
    const sim = this.sim
    if (sim && !sim.settled) {
      busy = sim.step(this.drag ? 6 : 9)
      if (!busy) sim.save()
    }
    if (this.cameraAnimation) {
      const { from, to, start } = this.cameraAnimation
      const t = (performance.now() - start) / CAMERA_MS
      this.camera = interpolateCamera(from, to, t)
      if (t >= 1) this.cameraAnimation = null
      else busy = true
    } else if (this.autoFit && sim && !this.drag) {
      const target = this.fitTarget()
      const ease = prefersReducedMotion() ? 1 : 1 - Math.exp(-dt / 160)
      const next = {
        x: this.camera.x + (target.x - this.camera.x) * ease,
        y: this.camera.y + (target.y - this.camera.y) * ease,
        k: Math.exp(
          Math.log(this.camera.k) +
            (Math.log(target.k) - Math.log(this.camera.k)) * ease
        ),
      }
      const moving =
        Math.abs(next.x - target.x) * next.k > 0.3 ||
        Math.abs(next.y - target.y) * next.k > 0.3 ||
        Math.abs(next.k - target.k) / target.k > 0.002
      this.camera = moving ? next : target
      busy = busy || moving
    }
    busy = this.stepEmphasis(dt) || busy
    this.draw()
    this.lastFrame = busy ? time : 0
    if (busy) this.invalidate()
  }

  private stepEmphasis(dt: number): boolean {
    const blend = 1 - Math.exp(-dt / 90)
    let moving = false
    for (let i = 0; i < this.emphasis.length; i++) {
      const diff = this.emphasisTarget[i]! - this.emphasis[i]!
      if (Math.abs(diff) < 0.004) this.emphasis[i] = this.emphasisTarget[i]!
      else {
        this.emphasis[i] = this.emphasis[i]! + diff * blend
        moving = true
      }
    }
    return moving
  }

  private labelWidth(
    ctx: CanvasRenderingContext2D,
    text: string,
    font: string
  ) {
    const key = `${font}\u0000${text}`
    let width = this.labelWidths.get(key)
    if (width === undefined) {
      width = ctx.measureText(text).width
      if (this.labelWidths.size > 6_000) this.labelWidths.clear()
      this.labelWidths.set(key, width)
    }
    return width
  }

  private draw() {
    const ctx = this.ctx
    const sim = this.sim
    if (!ctx || !sim) {
      this.positionTooltip()
      return
    }
    // Moving between displays changes the ratio without a resize.
    this.dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const deviceWidth = Math.round(this.width * this.dpr)
    const deviceHeight = Math.round(this.height * this.dpr)
    if (
      this.canvas.width !== deviceWidth ||
      this.canvas.height !== deviceHeight
    ) {
      this.canvas.width = deviceWidth
      this.canvas.height = deviceHeight
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, deviceWidth, deviceHeight)
    const n = this.nodes.length
    if (!n) return
    const { x, y } = sim
    const { k } = this.camera
    const dpr = this.dpr
    const palette = this.palette
    const em = this.emphasis
    const focus = this.focusIndex()
    ctx.setTransform(
      dpr * k,
      0,
      0,
      dpr * k,
      dpr * (this.width / 2 - this.camera.x * k),
      dpr * (this.height / 2 - this.camera.y * k)
    )
    const pad = 40 / k
    const left = this.camera.x - this.width / 2 / k - pad
    const right = this.camera.x + this.width / 2 / k + pad
    const top = this.camera.y - this.height / 2 / k - pad
    const bottom = this.camera.y + this.height / 2 / k + pad
    const inView = (i: number) =>
      x[i]! >= left && x[i]! <= right && y[i]! >= top && y[i]! <= bottom

    // Edges: quiet hairlines that recede as the view zooms out.
    const zoomFade = Math.min(1, Math.max(0.28, (k - 0.08) / 0.55))
    const LEVELS = 6
    const buckets: number[][] = Array.from(
      { length: (LEVELS + 1) * 2 },
      () => []
    )
    const highlighted: number[] = []
    for (let e = 0; e < this.edgeSource.length; e++) {
      const s = this.edgeSource[e]!
      const t = this.edgeTarget[e]!
      if (
        (x[s]! < left && x[t]! < left) ||
        (x[s]! > right && x[t]! > right) ||
        (y[s]! < top && y[t]! < top) ||
        (y[s]! > bottom && y[t]! > bottom)
      )
        continue
      if (focus >= 0 && (s === focus || t === focus) && em[focus]! > 0.5) {
        highlighted.push(e)
        continue
      }
      const level = Math.round(Math.min(em[s]!, em[t]!) * LEVELS)
      buckets[level * 2 + this.edgeContext[e]!]!.push(e)
    }
    ctx.lineCap = 'round'
    ctx.strokeStyle = palette.muted
    ctx.lineWidth = 1 / k
    for (let b = 0; b < buckets.length; b++) {
      const list = buckets[b]!
      if (!list.length) continue
      const level = b >> 1
      const context = b & 1
      ctx.globalAlpha = (context ? 0.4 : 0.46) * zoomFade * (level / LEVELS)
      ctx.setLineDash(context ? [3 / k, 3 / k] : [])
      ctx.beginPath()
      for (const e of list) {
        ctx.moveTo(x[this.edgeSource[e]!]!, y[this.edgeSource[e]!]!)
        ctx.lineTo(x[this.edgeTarget[e]!]!, y[this.edgeTarget[e]!]!)
      }
      ctx.stroke()
    }
    if (highlighted.length) {
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1.25 / k
      for (const context of [0, 1]) {
        ctx.globalAlpha = 0.72 * em[focus]!
        ctx.setLineDash(context ? [3 / k, 3 / k] : [])
        ctx.beginPath()
        for (const e of highlighted) {
          if (this.edgeContext[e] !== context) continue
          ctx.moveTo(x[this.edgeSource[e]!]!, y[this.edgeSource[e]!]!)
          ctx.lineTo(x[this.edgeTarget[e]!]!, y[this.edgeTarget[e]!]!)
        }
        ctx.stroke()
      }
    }
    ctx.setLineDash([])

    // Nodes: batched by style and emphasis level.
    const minRadius = 1.6 / k
    const NODE_LEVELS = 8
    const fills: number[][] = Array.from(
      { length: (NODE_LEVELS + 1) * 3 },
      () => []
    )
    const special = new Set([
      this.active,
      this.hover,
      this.externalHover,
      this.selected,
      this.best,
    ])
    for (let i = 0; i < n; i++) {
      if (!inView(i) || special.has(i)) continue
      const node = this.nodes[i]!
      const style = node.ghost ? 2 : node.degree === 0 ? 1 : 0
      fills[Math.round(em[i]! * NODE_LEVELS) * 3 + style]!.push(i)
    }
    const radiusOf = (i: number) => Math.max(this.displayRadius[i]!, minRadius)
    for (let b = 0; b < fills.length; b++) {
      const list = fills[b]!
      if (!list.length) continue
      const level = Math.floor(b / 3) / NODE_LEVELS
      const style = b % 3
      ctx.beginPath()
      for (const i of list) {
        const r = radiusOf(i)
        ctx.moveTo(x[i]! + r, y[i]!)
        ctx.arc(x[i]!, y[i]!, r, 0, Math.PI * 2)
      }
      if (style === 2) {
        // Placeholders are hollow: paper inside, a fine muted ring.
        ctx.globalAlpha = level
        ctx.fillStyle = palette.paper
        ctx.fill()
        ctx.globalAlpha = 0.85 * level
        ctx.strokeStyle = palette.muted
        ctx.lineWidth = 1 / k
        ctx.stroke()
      } else {
        ctx.globalAlpha = (style === 1 ? 0.55 : 0.85) * level
        ctx.fillStyle = style === 1 ? palette.muted : palette.secondary
        ctx.fill()
      }
    }
    for (const i of special) {
      if (i < 0 || !inView(i)) continue
      const node = this.nodes[i]!
      const r = radiusOf(i)
      const lit = i === this.hover || i === this.externalHover
      const isActive = i === this.active
      const alpha = Math.max(em[i]!, isActive || lit ? 1 : 0)
      if (isActive) {
        ctx.globalAlpha = 0.16 * alpha
        ctx.fillStyle = palette.accent
        ctx.beginPath()
        ctx.arc(x[i]!, y[i]!, r + 5 / k, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(x[i]!, y[i]!, r, 0, Math.PI * 2)
      if (node.ghost) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = palette.paper
        ctx.fill()
        ctx.strokeStyle = lit ? palette.accent : palette.muted
        ctx.lineWidth = 1.25 / k
        ctx.stroke()
      } else {
        ctx.globalAlpha = alpha * (isActive || lit ? 1 : 0.9)
        ctx.fillStyle = isActive || lit ? palette.accent : palette.secondary
        ctx.fill()
      }
      if (i === this.selected || (i === this.best && this.selected < 0)) {
        ctx.globalAlpha = 0.9
        ctx.strokeStyle = palette.accent
        ctx.lineWidth = 1.5 / k
        ctx.beginPath()
        ctx.arc(x[i]!, y[i]!, r + 3.5 / k, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Labels in screen space so text stays crisp and a constant size.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const font = `11.5px ${palette.font}`
    const strongFont = `600 12px ${palette.font}`
    const candidates: (LabelCandidate & {
      text: string
      strong: boolean
      alpha: number
    })[] = []
    const seen = new Uint8Array(n)
    const addLabel = (i: number, force: boolean, alpha: number) => {
      if (i < 0 || seen[i] || !inView(i)) return
      seen[i] = 1
      const node = this.nodes[i]!
      const title = displayTitle(node.title)
      const text =
        title.length > MAX_LABEL_CHARS
          ? `${title.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
          : title
      const strong = i === this.active || i === this.selected
      ctx.font = strong ? strongFont : font
      const width = this.labelWidth(ctx, text, ctx.font)
      const s = worldToScreen(
        this.camera,
        this.width,
        this.height,
        x[i]!,
        y[i]!
      )
      const r = radiusOf(i) * k
      candidates.push({
        index: i,
        x: s.x - width / 2,
        y: s.y + r + 3,
        width,
        height: LABEL_HEIGHT,
        force,
        text,
        strong,
        alpha,
      })
    }
    addLabel(this.hover, true, 1)
    addLabel(this.externalHover, true, 1)
    addLabel(this.selected, true, 1)
    addLabel(this.active, true, 1)
    addLabel(this.best, true, 1)
    if (focus >= 0)
      for (const j of this.neighbours[focus] ?? []) addLabel(j, false, em[j]!)
    if (this.matches) for (const i of this.matches) addLabel(i, false, em[i]!)
    const showAll = k >= 1.35 || (n <= 40 && k >= 0.6)
    const budget = showAll
      ? n
      : Math.round(
          4 + 70 * Math.pow(Math.min(1, Math.max(0, (k - 0.3) / 1.05)), 2)
        )
    const quiet = focus >= 0 || this.matches !== null
    const fade = showAll ? 1 : Math.min(1, Math.max(0.6, (k - 0.25) / 0.6))
    let considered = 0
    for (const i of this.byDegree) {
      if (considered >= budget) break
      const node = this.nodes[i]!
      if (!showAll && node.degree < 2) break
      if (seen[i] || !inView(i)) continue
      considered++
      addLabel(i, false, quiet ? em[i]! * 0.9 : fade)
    }
    const placed = placeLabels(candidates, { limit: 320 })
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3
    for (const label of placed) {
      const i = label.index
      // The hovered node's name is shown by the tooltip instead.
      if (i === this.hover || i === this.externalHover) continue
      if (label.alpha < 0.05) continue
      const node = this.nodes[i]!
      ctx.font = label.strong ? strongFont : font
      const cx = label.x + label.width / 2
      ctx.globalAlpha = 0.85 * label.alpha
      ctx.strokeStyle = palette.paper
      ctx.strokeText(label.text, cx, label.y)
      ctx.globalAlpha = label.alpha
      ctx.fillStyle =
        i === this.active
          ? palette.accent
          : node.ghost
            ? palette.muted
            : label.force || (focus >= 0 && em[i]! > 0.5)
              ? palette.ink
              : palette.secondary
      ctx.fillText(label.text, cx, label.y)
    }
    ctx.globalAlpha = 1
    this.positionTooltip()
  }

  private positionTooltip() {
    const tooltip = this.tooltip
    if (!tooltip) return
    const i = this.hover >= 0 ? this.hover : this.externalHover
    if (i < 0 || !this.sim || this.drag?.moved) {
      tooltip.dataset.visible = 'false'
      return
    }
    const s = worldToScreen(
      this.camera,
      this.width,
      this.height,
      this.sim.x[i]!,
      this.sim.y[i]!
    )
    const r =
      Math.max(this.displayRadius[i]!, 1.6 / this.camera.k) * this.camera.k
    const half = (tooltip.offsetWidth || 0) / 2
    const left = Math.min(
      Math.max(s.x, half + 8),
      Math.max(half + 8, this.width - half - 8)
    )
    tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(s.y + r + 6)}px, 0) translateX(-50%)`
    tooltip.dataset.visible = 'true'
  }
}

const requestFrame = (callback: (time: number) => void): number =>
  typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(callback)
    : (setTimeout(() => callback(performance.now()), 16) as unknown as number)

const cancelFrame = (id: number) => {
  if (typeof window.cancelAnimationFrame === 'function')
    window.cancelAnimationFrame(id)
  else clearTimeout(id)
}

// ---------------------------------------------------------------------------
// React surface

export interface NoteGraphProps {
  open: boolean
  onOpenChange(open: boolean): void
  notes: Note[]
  library?: ContextSource[]
  packages?: ContextPackage[]
  activeNoteId: string | null
  onOpenNote(id: string): void
  onCreateNote?(title: string): void
}

export function NoteGraph(props: NoteGraphProps) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="note-graph-backdrop" />
        {props.open && <GraphSurface {...props} />}
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const EMPTY_LIBRARY: ContextSource[] = []
const EMPTY_PACKAGES: ContextPackage[] = []
const LIST_LIMIT = 400
const NEIGHBOUR_LIMIT = 30
const DIRECTIONS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

interface GhostOffer {
  id: string
  title: string
  x: number
  y: number
}

function GraphSurface({
  onOpenChange,
  notes,
  library = EMPTY_LIBRARY,
  packages = EMPTY_PACKAGES,
  activeNoteId,
  onOpenNote,
  onCreateNote,
}: NoteGraphProps) {
  const ids = useId()
  const keyHintId = `${ids}-keys`
  const listId = `${ids}-list`
  const [options, setOptions] = useState<GraphViewOptions>(rememberedOptions)
  const [listVisible, setListVisible] = useState(rememberedList)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [offer, setOffer] = useState<GhostOffer | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const viewRef = useRef<GraphView | null>(null)
  const hoverSink = useRef<(id: string | null) => void>(() => undefined)
  const highlight = useCallback(
    (id: string | null) => viewRef.current?.setExternalHover(id),
    []
  )
  const callbacks = useRef<GraphViewCallbacks>({
    onHover: () => undefined,
    onActivate: () => undefined,
  })

  useEffect(() => {
    rememberedOptions = options
  }, [options])
  useEffect(() => {
    rememberedList = listVisible
  }, [listVisible])

  const canLocal =
    !!activeNoteId && notes.some(note => note.id === activeNoteId)
  const graph = useMemo(
    () => deriveGraph(notes, library, packages, activeNoteId, options),
    [notes, library, packages, activeNoteId, options]
  )
  const nodeById = useMemo(
    () => new Map(graph.nodes.map(node => [node.id, node])),
    [graph.nodes]
  )
  const adjacency = useMemo(() => {
    const map: Adjacency = new Map()
    const add = (from: string, to: string, context: boolean) => {
      const list = map.get(from)
      if (list) list.push({ id: to, context })
      else map.set(from, [{ id: to, context }])
    }
    for (const edge of graph.edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue
      add(edge.source, edge.target, edge.kind === 'context')
      add(edge.target, edge.source, edge.kind === 'context')
    }
    return map
  }, [graph.edges, nodeById])
  const search = useMemo(
    () => searchGraph(graph.nodes, query),
    [graph.nodes, query]
  )
  const hasQuery = noteKey(query).length > 0
  const noteCount = useMemo(
    () => graph.nodes.reduce((count, node) => count + (node.ghost ? 0 : 1), 0),
    [graph.nodes]
  )

  const describe = useCallback(
    (id: string) => {
      const node = nodeById.get(id)
      if (!node) return ''
      const names = (adjacency.get(id) ?? [])
        .slice(0, 8)
        .map(item => displayTitle(nodeById.get(item.id)?.title ?? ''))
      return `${displayTitle(node.title)}. ${connectionSummary(node)}${
        names.length ? `: ${names.join(', ')}` : ''
      }.`
    },
    [adjacency, nodeById]
  )

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  const activate = useCallback(
    (id: string | null) => {
      if (!id) {
        setSelected(null)
        setOffer(null)
        return
      }
      const node = nodeById.get(id)
      if (!node) return
      if (node.ghost) {
        const position = viewRef.current?.screenPosition(id) ?? null
        const stage = stageRef.current
        setSelected(id)
        const width = stage?.clientWidth ?? 0
        const height = stage?.clientHeight ?? 0
        // Keep the card inside the window, below the point when possible.
        const clamp = (value: number, low: number, high: number) =>
          Math.min(Math.max(value, low), Math.max(low, high))
        setOffer({
          id,
          title: node.title,
          x: clamp(position?.x ?? width / 2, 156, width - 156),
          y: clamp(position?.y ?? height / 2, 60, height - 130),
        })
        return
      }
      onOpenNote(id)
      close()
    },
    [close, nodeById, onOpenNote]
  )

  const create = useCallback(
    (title: string) => {
      if (!onCreateNote) return
      onCreateNote(title)
      close()
    },
    [close, onCreateNote]
  )

  useEffect(() => {
    callbacks.current = {
      onHover: id => hoverSink.current(id),
      onActivate: activate,
    }
  }, [activate])

  // The view lives as long as the dialog is open.
  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const view = new GraphView(canvas, stage, tooltipRef.current, callbacks)
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    viewRef.current?.setGraph(graph)
  }, [graph])

  useEffect(() => {
    if (selected && !nodeById.has(selected)) setSelected(null)
    if (offer && !nodeById.has(offer.id)) setOffer(null)
  }, [nodeById, offer, selected])

  useEffect(() => {
    viewRef.current?.setFocus({
      active: activeNoteId,
      selected,
      matches: hasQuery ? search.matches : null,
      best: hasQuery ? search.best : null,
    })
  }, [activeNoteId, graph, hasQuery, search, selected])

  // Bring the best match into view once typing pauses.
  useEffect(() => {
    if (!hasQuery || !search.best) return
    const best = search.best
    const timer = setTimeout(() => viewRef.current?.centerOn(best), 140)
    return () => clearTimeout(timer)
  }, [hasQuery, search.best])

  useEffect(() => {
    if (!hasQuery) return
    const count = search.matches.size
    setAnnouncement(
      count === 0
        ? 'No notes match.'
        : `${count} ${count === 1 ? 'note matches' : 'notes match'}.`
    )
  }, [hasQuery, search.matches])

  const updateOptions = (patch: Partial<GraphViewOptions>) =>
    setOptions(value => ({ ...value, ...patch }))

  const onCanvasKey = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const view = viewRef.current
    if (!view || event.metaKey || event.ctrlKey || event.altKey) return
    const direction = DIRECTIONS[event.key]
    if (direction) {
      event.preventDefault()
      const from = selected && nodeById.has(selected) ? selected : null
      const next = from
        ? view.neighbourInDirection(from, direction[0], direction[1])
        : view.startNode(activeNoteId)
      if (!next) return
      setSelected(next)
      setOffer(null)
      view.ensureVisible(next)
      setAnnouncement(describe(next))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (selected) activate(selected)
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      view.zoomBy(1.3)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      view.zoomBy(1 / 1.3)
    }
  }

  const onSurfaceKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey
    if (
      mod &&
      event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'g'
    ) {
      event.preventDefault()
      close()
      return
    }
    if (event.defaultPrevented || mod || event.altKey) return
    const target = event.target as HTMLElement
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
    )
      return
    if (event.key === '/') {
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    } else if (event.key === 'f' || event.key === 'F') {
      event.preventDefault()
      viewRef.current?.fit()
    }
  }

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (search.best) activate(search.best)
    } else if (event.key === 'ArrowDown' && search.best) {
      event.preventDefault()
      setSelected(search.best)
      setAnnouncement(describe(search.best))
      canvasRef.current?.focus()
    }
  }

  const rows = useMemo(() => {
    const visible = hasQuery
      ? graph.nodes.filter(node => search.matches.has(node.id))
      : graph.nodes
    return [...visible].sort(
      (a, b) =>
        Number(!!a.ghost) - Number(!!b.ghost) ||
        displayTitle(a.title).localeCompare(displayTitle(b.title))
    )
  }, [graph.nodes, hasQuery, search.matches])

  const empty = graph.totalEdges === 0
  const quietLocal = !empty && graph.local && graph.edges.length === 0
  const linkCount = graph.edges.length

  return (
    <Dialog.Content
      className="note-graph"
      onOpenAutoFocus={event => {
        event.preventDefault()
        canvasRef.current?.focus({ preventScroll: true })
      }}
      onEscapeKeyDown={event => {
        if (offer) {
          event.preventDefault()
          setOffer(null)
          canvasRef.current?.focus({ preventScroll: true })
        } else if (document.activeElement === searchRef.current && query) {
          event.preventDefault()
          setQuery('')
        }
      }}
      onKeyDown={onSurfaceKey}
    >
      <div className="note-graph-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="note-graph-canvas"
          tabIndex={0}
          role="application"
          aria-roledescription="note graph"
          aria-label={`Note graph: ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}, ${linkCount} ${linkCount === 1 ? 'link' : 'links'}`}
          aria-describedby={keyHintId}
          onKeyDown={onCanvasKey}
          onBlur={() => setSelected(value => (offer ? value : null))}
        />
        <HoverTooltip
          tooltipRef={tooltipRef}
          sink={hoverSink}
          nodeById={nodeById}
          canCreate={!!onCreateNote}
        />
        <p className="note-graph-hint" id={keyHintId}>
          <span className="note-graph-hint-pointer">
            Scroll to zoom · Drag to move · Double-click to fit
          </span>
          <span className="note-graph-hint-keys">
            Arrow keys move between notes · Enter opens · F fits
          </span>
        </p>
      </div>

      <header className="note-graph-toolbar">
        <div className="note-graph-heading">
          <Dialog.Title className="note-graph-title">Graph</Dialog.Title>
          <span className="note-graph-count">
            {noteCount} {noteCount === 1 ? 'note' : 'notes'} · {linkCount}{' '}
            {linkCount === 1 ? 'link' : 'links'}
          </span>
        </div>
        <Dialog.Description className="visually-hidden">
          Your notes and how they connect. Solid lines are links written in a
          note, dashed lines are notes used as context, and hollow points are
          links to notes not yet written.
        </Dialog.Description>
        <div className="note-graph-controls">
          <label className="note-graph-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Find a note"
              aria-label="Find a note"
              aria-controls={listId}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
            />
            {!query && (
              <kbd className="note-graph-kbd" aria-hidden="true">
                /
              </kbd>
            )}
          </label>
          <div className="note-graph-group" role="group" aria-label="Show">
            <button
              type="button"
              className="note-graph-segment"
              aria-pressed={options.scope === 'all' || !canLocal}
              onClick={() => updateOptions({ scope: 'all' })}
            >
              All notes
            </button>
            <button
              type="button"
              className="note-graph-segment"
              aria-pressed={options.scope === 'local' && canLocal}
              disabled={!canLocal}
              title={
                canLocal ? undefined : 'Open a note to see what is around it'
              }
              onClick={() => updateOptions({ scope: 'local' })}
            >
              Around this note
            </button>
            {options.scope === 'local' && canLocal && (
              <div
                className="note-graph-stepper"
                role="group"
                aria-label="Steps from this note"
              >
                <button
                  type="button"
                  className="note-graph-step"
                  aria-label="Fewer steps"
                  disabled={options.depth === 1}
                  onClick={() => updateOptions({ depth: 1 })}
                >
                  <Minus size={12} />
                </button>
                <output aria-live="polite" aria-label="Steps">
                  {options.depth}
                </output>
                <button
                  type="button"
                  className="note-graph-step"
                  aria-label="More steps"
                  disabled={options.depth === 2}
                  onClick={() => updateOptions({ depth: 2 })}
                >
                  <Plus size={12} />
                </button>
              </div>
            )}
          </div>
          <div className="note-graph-group" role="group" aria-label="Include">
            <button
              type="button"
              className="note-graph-toggle"
              aria-pressed={options.contextLinks}
              onClick={() =>
                updateOptions({ contextLinks: !options.contextLinks })
              }
            >
              Context links
            </button>
            <button
              type="button"
              className="note-graph-toggle"
              aria-pressed={options.unlinked}
              onClick={() => updateOptions({ unlinked: !options.unlinked })}
            >
              Unlinked notes
            </button>
            <button
              type="button"
              className="note-graph-toggle"
              aria-pressed={options.ghosts}
              onClick={() => updateOptions({ ghosts: !options.ghosts })}
            >
              Unresolved links
            </button>
          </div>
          <div className="note-graph-group note-graph-actions">
            <button
              type="button"
              className="note-graph-icon"
              aria-label="List"
              title="Show as a list"
              aria-pressed={listVisible}
              aria-controls={listId}
              onClick={() => setListVisible(value => !value)}
            >
              <List size={15} />
            </button>
            <button
              type="button"
              className="note-graph-icon"
              aria-label="Fit to view"
              title="Fit to view (F)"
              onClick={() => viewRef.current?.fit()}
            >
              <Scan size={15} />
            </button>
            <Dialog.Close
              className="note-graph-icon"
              aria-label="Close graph"
              title="Close (Esc)"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
        </div>
      </header>

      <ul className="note-graph-legend" aria-label="Legend">
        <li>
          <svg width="18" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="17" y2="4" />
          </svg>
          Link
        </li>
        {options.contextLinks && (
          <li>
            <svg width="18" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="17" y2="4" strokeDasharray="2.5 2.5" />
            </svg>
            Used as context
          </li>
        )}
        {options.ghosts && (
          <li>
            <svg width="18" height="8" aria-hidden="true">
              <circle cx="9" cy="4" r="3" />
            </svg>
            Not yet written
          </li>
        )}
      </ul>

      {(empty || quietLocal) && (
        <div
          className="note-graph-empty"
          role="note"
          data-centered={graph.nodes.length === 0 ? 'true' : undefined}
        >
          <strong>
            {notes.length === 0
              ? 'Your graph is empty'
              : quietLocal
                ? 'Nothing connects to this note yet'
                : 'No connections yet'}
          </strong>
          <p>
            Type <span className="note-graph-code">[[Note title]]</span> in a
            note to link it to another. Notes used as context for each other are
            connected too.
          </p>
        </div>
      )}

      {offer && (
        <div
          className="note-graph-offer"
          role="group"
          aria-label={`${displayTitle(offer.title)} is not written yet`}
          style={{ left: offer.x, top: offer.y }}
        >
          <p>
            <strong>{displayTitle(offer.title)}</strong> isn&apos;t written yet.
          </p>
          <div className="note-graph-offer-actions">
            {onCreateNote && (
              <button
                type="button"
                className="button primary"
                autoFocus
                onClick={() => create(offer.title)}
              >
                Create note
              </button>
            )}
            <button
              type="button"
              className="button subtle"
              autoFocus={!onCreateNote}
              onClick={() => {
                setOffer(null)
                canvasRef.current?.focus({ preventScroll: true })
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      <GraphList
        id={listId}
        visible={listVisible}
        rows={rows}
        adjacency={adjacency}
        nodeById={nodeById}
        activeNoteId={activeNoteId}
        hasQuery={hasQuery}
        canCreate={!!onCreateNote}
        onOpen={activate}
        onCreate={create}
        onHighlight={highlight}
      />

      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </Dialog.Content>
  )
}

type Adjacency = Map<string, { id: string; context: boolean }[]>

/** Notes and their connections: a screen-reader outline, or a visible list. */
const GraphList = memo(function GraphList({
  id,
  visible,
  rows,
  adjacency,
  nodeById,
  activeNoteId,
  hasQuery,
  canCreate,
  onOpen,
  onCreate,
  onHighlight,
}: {
  id: string
  visible: boolean
  rows: NoteGraphNode[]
  adjacency: Adjacency
  nodeById: Map<string, NoteGraphNode>
  activeNoteId: string | null
  hasQuery: boolean
  canCreate: boolean
  onOpen(id: string): void
  onCreate(title: string): void
  onHighlight(id: string | null): void
}) {
  return (
    <section
      id={id}
      className={visible ? 'note-graph-list' : 'visually-hidden'}
      aria-label="Notes and their connections"
    >
      {rows.length === 0 ? (
        <p className="note-graph-list-empty">
          {hasQuery ? 'No notes match.' : 'No notes to show.'}
        </p>
      ) : (
        <ul>
          {rows.slice(0, visible ? LIST_LIMIT : rows.length).map(node => {
            const linked = adjacency.get(node.id) ?? []
            const title = displayTitle(node.title)
            if (!visible)
              return (
                <li key={node.id}>
                  {title}
                  {node.ghost ? ' (not written yet)' : ''}
                  {linked.length > 0 &&
                    `: connected to ${linked
                      .slice(0, NEIGHBOUR_LIMIT)
                      .map(item =>
                        displayTitle(nodeById.get(item.id)?.title ?? '')
                      )
                      .join(
                        ', '
                      )}${linked.length > NEIGHBOUR_LIMIT ? ` and ${linked.length - NEIGHBOUR_LIMIT} more` : ''}`}
                </li>
              )
            return (
              <li
                key={node.id}
                className="note-graph-row"
                onMouseEnter={() => onHighlight(node.id)}
                onMouseLeave={() => onHighlight(null)}
              >
                <div className="note-graph-row-main">
                  <button
                    type="button"
                    className="note-graph-row-title"
                    aria-current={node.id === activeNoteId ? 'page' : undefined}
                    data-ghost={node.ghost ? 'true' : undefined}
                    onFocus={() => onHighlight(node.id)}
                    onBlur={() => onHighlight(null)}
                    onClick={() =>
                      node.ghost ? onCreate(node.title) : onOpen(node.id)
                    }
                    disabled={node.ghost && !canCreate}
                    aria-label={
                      node.ghost ? `Create ${title}` : `Open ${title}`
                    }
                  >
                    <span>{title}</span>
                  </button>
                  <small>{connectionSummary(node)}</small>
                </div>
                {linked.length > 0 && (
                  <ul
                    className="note-graph-row-links"
                    aria-label={`Connected to ${title}`}
                  >
                    {linked.slice(0, NEIGHBOUR_LIMIT).map(item => {
                      const other = nodeById.get(item.id)
                      if (!other) return null
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            data-context={item.context ? 'true' : undefined}
                            data-ghost={other.ghost ? 'true' : undefined}
                            onClick={() =>
                              other.ghost
                                ? onCreate(other.title)
                                : onOpen(other.id)
                            }
                            disabled={other.ghost && !canCreate}
                            title={item.context ? 'Used as context' : 'Linked'}
                          >
                            {displayTitle(other.title)}
                          </button>
                        </li>
                      )
                    })}
                    {linked.length > NEIGHBOUR_LIMIT && (
                      <li className="note-graph-more">
                        and {linked.length - NEIGHBOUR_LIMIT} more
                      </li>
                    )}
                  </ul>
                )}
              </li>
            )
          })}
          {visible && rows.length > LIST_LIMIT && (
            <li className="note-graph-more">
              {rows.length - LIST_LIMIT} more. Refine the search to find them.
            </li>
          )}
        </ul>
      )}
    </section>
  )
})

/** The hover card owns its state, so hovering never re-renders the list. */
function HoverTooltip({
  tooltipRef,
  sink,
  nodeById,
  canCreate,
}: {
  tooltipRef: RefObject<HTMLDivElement>
  sink: MutableRefObject<(id: string | null) => void>
  nodeById: Map<string, NoteGraphNode>
  canCreate: boolean
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  useEffect(() => {
    sink.current = setHovered
    return () => {
      sink.current = () => undefined
    }
  }, [sink])
  const node = hovered ? nodeById.get(hovered) : undefined
  return (
    <div
      ref={tooltipRef}
      className="note-graph-tooltip"
      data-visible="false"
      aria-hidden="true"
    >
      {node && (
        <>
          <strong>{displayTitle(node.title)}</strong>
          <span>
            {node.ghost
              ? canCreate
                ? 'Not written yet · click to create'
                : 'Not written yet'
              : connectionSummary(node)}
          </span>
        </>
      )}
    </div>
  )
}
