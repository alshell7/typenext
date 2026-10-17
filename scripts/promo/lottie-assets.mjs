// Lottie animations for the film, written as plain Lottie JSON (bodymovin
// 5.x shape layers). film.js plays them with lottie-web, one frame at a time.
// All are 60 fps; colours are 0–1 RGB.

const FPS = 60
const INK = [0.957, 0.953, 0.937, 1]
const MINT = [0.651, 0.89, 0.722, 1]

// ------------------------------------------------------------- primitives

const still = k => ({ a: 0, k })
/** Keyframes: [[frame, value, ease?], ...]. ease is [ox, oy, ix, iy]. */
function keys(list) {
  return {
    a: 1,
    k: list.map(([t, value, ease = [0.33, 0, 0.2, 1]], index) => {
      const s = Array.isArray(value) ? value : [value]
      const key = { t, s }
      if (index < list.length - 1) {
        key.o = { x: s.map(() => ease[0]), y: s.map(() => ease[1]) }
        key.i = { x: s.map(() => ease[2]), y: s.map(() => ease[3]) }
      }
      return key
    }),
  }
}
const transform = ({ p = [0, 0], a = [0, 0], s = [100, 100], r = 0, o = 100 } = {}) => ({
  ty: 'tr',
  p: p.a !== undefined ? p : still(p),
  a: still(a),
  s: s.a !== undefined ? s : still(s),
  r: typeof r === 'object' ? r : still(r),
  o: typeof o === 'object' ? o : still(o),
  sk: still(0),
  sa: still(0),
})
const group = (name, items, tr) => ({ ty: 'gr', nm: name, it: [...items, transform(tr)] })
const stroke = (color = INK, width = 6, opacity = 100) => ({
  ty: 'st',
  c: still(color),
  o: typeof opacity === 'object' ? opacity : still(opacity),
  w: typeof width === 'object' ? width : still(width),
  lc: 2,
  lj: 2,
  ml: 4,
})
const fill = (color = INK, opacity = 100) => ({
  ty: 'fl',
  c: still(color),
  o: typeof opacity === 'object' ? opacity : still(opacity),
  r: 1,
})
const ellipse = (size, p = [0, 0]) => ({ ty: 'el', p: still(p), s: size.a !== undefined ? size : still(size), d: 1 })
const rect = (size, radius, p = [0, 0]) => ({ ty: 'rc', p: still(p), s: still(size), r: still(radius), d: 1 })
/** A polyline or closed shape from points (no curves). */
function path(points, closed = false) {
  return {
    ty: 'sh',
    ks: still({
      i: points.map(() => [0, 0]),
      o: points.map(() => [0, 0]),
      v: points,
      c: closed,
    }),
  }
}
/** Arc from angle a0 to a1 (degrees, 0 = up, clockwise) as cubic segments. */
function arc(cx, cy, r, a0, a1) {
  const segments = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90))
  const v = [], i = [], o = []
  const step = (a1 - a0) / segments
  const k = (4 / 3) * Math.tan((step * Math.PI) / 720) * r
  for (let n = 0; n <= segments; n++) {
    const angle = ((a0 + step * n - 90) * Math.PI) / 180
    const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle)
    const tx = -Math.sin(angle) * k, ty = Math.cos(angle) * k
    v.push([x, y])
    i.push(n === 0 ? [0, 0] : [-tx, -ty])
    o.push(n === segments ? [0, 0] : [tx, ty])
  }
  return { ty: 'sh', ks: still({ i, o, v, c: false }) }
}
const trim = (end, start = still(0)) => ({ ty: 'tm', s: start, e: end, o: still(0), m: 1 })

function layer(name, shapes, { ip = 0, op, ks = {} } = {}) {
  return {
    ddd: 0,
    ind: 1,
    ty: 4,
    nm: name,
    sr: 1,
    ks: {
      o: ks.o ?? still(100),
      r: ks.r ?? still(0),
      p: ks.p ?? still([0, 0, 0]),
      a: still([0, 0, 0]),
      s: ks.s ?? still([100, 100, 100]),
    },
    ao: 0,
    shapes,
    ip,
    op,
    st: 0,
    bm: 0,
  }
}
function animation(name, size, seconds, layers) {
  const op = Math.round(seconds * FPS)
  return {
    v: '5.7.4',
    fr: FPS,
    ip: 0,
    op,
    w: size,
    h: size,
    nm: name,
    ddd: 0,
    assets: [],
    layers: layers.map((item, index) => ({ ...item, ind: index + 1, op: item.op ?? op })),
  }
}
const back = [0.34, 0, 0.2, 1.4] // overshoot
const out = [0.16, 1, 0.3, 1]

// ------------------------------------------------------------- animations

/** Eight rays and a four-point star: the moment Tab keeps a suggestion. */
export function sparkle() {
  const size = 240, c = size / 2
  const rays = Array.from({ length: 8 }, (_, n) => {
    const angle = (n * 45 * Math.PI) / 180
    const inner = 34, outer = n % 2 ? 78 : 104
    const p0 = [c + Math.cos(angle) * inner, c + Math.sin(angle) * inner]
    const p1 = [c + Math.cos(angle) * outer, c + Math.sin(angle) * outer]
    return group(`ray ${n}`, [
      path([p0, p1]),
      trim(keys([[0, 0, out], [16, 100]]), keys([[6, 0, out], [26, 100]])),
      stroke(n % 2 ? MINT : INK, n % 2 ? 5 : 7),
    ])
  })
  const star = (() => {
    const r = 30, w = 7
    const points = [
      [c, c - r], [c + w, c - w], [c + r, c], [c + w, c + w],
      [c, c + r], [c - w, c + w], [c - r, c], [c - w, c - w],
    ]
    return group('star', [path(points, true), fill(MINT)], {
      a: [c, c],
      p: [c, c],
      s: keys([[0, [0, 0], back], [14, [118, 118], out], [22, [100, 100], out], [40, [0, 0]]]),
      r: keys([[0, -30, out], [40, 25]]),
    })
  })()
  return animation('sparkle', size, 0.75, [layer('sparkle', [star, ...rays])])
}

/** A circle and a tick that draw themselves in. */
export function check() {
  const size = 120, c = size / 2
  return animation('check', size, 0.7, [
    layer('check', [
      group('ring', [arc(c, c, 44, 0, 360), trim(keys([[0, 0, out], [24, 100]])), stroke(MINT, 6)]),
      group('fill', [ellipse([88, 88], [c, c]), fill(MINT, keys([[14, 0, out], [30, 16]]))]),
      group('tick', [
        path([[c - 19, c + 1], [c - 5, c + 15], [c + 21, c - 13]]),
        trim(keys([[12, 0, out], [32, 100]])),
        stroke(MINT, 8),
      ]),
    ]),
  ])
}

/** A microphone with rings that pulse outward, looping every 1.2 s. */
export function microphone() {
  const size = 320, c = size / 2
  const rings = [0, 24, 48].map(delay =>
    group(`ring ${delay}`, [
      ellipse(keys([[delay, [130, 130], out], [delay + 72, [310, 310]]]), [c, c - 6]),
      stroke(MINT, keys([[delay, 5], [delay + 72, 1]]), keys([[delay, 70], [delay + 72, 0]])),
    ])
  )
  const body = group('body', [
    rect([46, 78], 23, [c, c - 26]),
    stroke(INK, 7),
    arc(c, c - 6, 40, 90, 270),
    stroke(INK, 7),
    path([[c, c + 34], [c, c + 56]]),
    path([[c - 22, c + 56], [c + 22, c + 56]]),
    stroke(INK, 7),
  ], { a: [c, c], p: [c, c], s: keys([[0, [92, 92], out], [10, [100, 100]], [60, [100, 100], out], [72, [96, 96]]]) })
  return animation('microphone', size, 1.2, [layer('rings', rings), layer('mic', [body])])
}

/** A padlock whose shackle drops shut, inside a shield that draws in. */
export function lock() {
  const size = 360, c = size / 2
  const shield = [
    [c, 30], [c + 118, 74], [c + 112, 196], [c + 70, 268], [c, 318],
    [c - 70, 268], [c - 112, 196], [c - 118, 74],
  ]
  const shackle = group('shackle', [
    arc(c, c - 6, 30, 270, 450),
    path([[c - 30, c - 6], [c - 30, c + 16]]),
    path([[c + 30, c - 6], [c + 30, c + 16]]),
    stroke(INK, 10),
  ], { p: keys([[18, [0, -26], back], [34, [0, 0]]]) })
  return animation('lock', size, 1.2, [
    layer('shield', [
      group('outline', [path(shield, true), trim(keys([[0, 0, out], [30, 100]])), stroke(MINT, 7)]),
      group('glow', [path(shield, true), fill(MINT, keys([[20, 0, out], [44, 10]]))]),
    ]),
    layer('lock', [
      shackle,
      group('body', [rect([96, 74], 16, [c, c + 46]), fill(INK)], {
        a: [c, c + 46],
        p: [c, c + 46],
        s: keys([[8, [60, 60], back], [22, [100, 100]], [34, [100, 100], out], [38, [104, 96], out], [44, [100, 100]]]),
        o: keys([[8, 0], [14, 100]]),
      }),
      group('keyhole', [ellipse([14, 14], [c, c + 40]), path([[c, c + 44], [c, c + 58]]), stroke([0.02, 0.03, 0.03, 1], 7)], {
        o: keys([[30, 0], [38, 100]]),
      }),
    ]),
  ])
}

export const LOTTIE = { sparkle, check, microphone, lock }
