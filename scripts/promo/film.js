// The TypeNext film: every frame is a pure function of time, so the
// renderer can step through it at a fixed rate. Open film.html?t=12.3 in a
// browser to look at one moment.
import { CLIP_MAPS, HOOK, MONTAGE, SCENES, STOMPS } from './timeline.mjs'

const CLIPS = '../../artifacts/promo/clips'

// ---------------------------------------------------------------- helpers

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value))
const lerp = (a, b, k) => a + (b - a) * k
const prog = (t, a, b) => clamp((t - a) / (b - a))
const ease = {
  outExpo: x => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
  inExpo: x => (x <= 0 ? 0 : 2 ** (10 * x - 10)),
  outQuart: x => 1 - (1 - x) ** 4,
  outCubic: x => 1 - (1 - x) ** 3,
  inOutCubic: x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
  inOutQuint: x => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2),
  outBack: x => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
}

function el(html, parent) {
  const holder = document.createElement('div')
  holder.innerHTML = html.trim()
  const node = holder.firstElementChild
  parent?.append(node)
  return node
}

/** Set a transform, opacity and blur in one go. */
function pose(node, { x = 0, y = 0, z = 0, s = 1, sx, sy, rx = 0, ry = 0, rz = 0, o = 1, blur = 0 } = {}) {
  node.style.transform = `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${sx ?? s}, ${sy ?? s})`
  node.style.opacity = String(clamp(o))
  node.style.filter = blur > 0.08 ? `blur(${blur.toFixed(2)}px)` : 'none'
}

/** A word that slams into place: big, blurred and fast, then a small wobble. */
function stomp(t, at, { from = 2.5, dur = 0.15, blur = 18 } = {}) {
  if (t < at) return { o: 0, s: from, blur }
  const x = t - at
  const k = ease.outQuart(clamp(x / dur))
  const wobble = x > dur ? 0.028 * Math.exp(-(x - dur) * 11) * Math.sin((x - dur) * 40) : 0
  return { o: clamp(x / 0.035), s: lerp(from, 1, k) + wobble, blur: blur * (1 - k) }
}

/** Red and blue fringes that settle right after a stomp. */
function fringe(node, t, at, size = 12) {
  const x = t - at
  const offset = x >= 0 ? size * Math.exp(-x * 13) : 0
  node.style.textShadow =
    offset > 0.2 ? `${offset}px 0 rgb(255 70 90 / 55%), ${-offset}px 0 rgb(60 170 255 / 55%)` : 'none'
}

function splitChars(node, text) {
  node.textContent = ''
  return [...text].map(character => el(`<span class="char"></span>`, node)).map((span, index) => {
    span.textContent = text[index]
    return span
  })
}

/** Letters rise and sharpen one after another. */
function rise(chars, t, at, { step = 0.03, dur = 0.32, dy = 40, blur = 10 } = {}) {
  chars.forEach((span, index) => {
    const k = ease.outExpo(prog(t, at + index * step, at + index * step + dur))
    pose(span, { y: dy * (1 - k), o: k, blur: blur * (1 - k) })
  })
}

/** Linear between [film, clip] pairs; real speed past either end. */
function clipTime(map, t) {
  if (t <= map[0][0]) return map[0][1] - (map[0][0] - t)
  for (let index = 1; index < map.length; index++) {
    const [f0, c0] = map[index - 1]
    const [f1, c1] = map[index]
    if (t <= f1) return lerp(c0, c1, (t - f0) / (f1 - f0))
  }
  const [f, c] = map.at(-1)
  return c + (t - f)
}

// ---------------------------------------------------------------- clips

const clips = {}
async function loadClips() {
  const names = ['write', 'dictate', 'novel', 'table', 'links', 'graph', 'palette', 'zen', 'settings', 'dark']
  await Promise.all(
    names.map(async name => {
      const response = await fetch(`${CLIPS}/${name}/index.json`)
      clips[name] = await response.json()
    })
  )
}

function frameUrl(name, time) {
  const { frames } = clips[name]
  let low = 0
  let high = frames.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (frames[middle].t <= time) low = middle
    else high = middle - 1
  }
  return `${CLIPS}/${name}/${frames[low].file}`
}

const pending = []
function makeWindow(parent) {
  const root = el(
    `<div class="window"><div class="content"><img alt="" /><div class="glow"></div></div><div class="sheen"></div></div>`,
    parent
  )
  return {
    root,
    content: root.querySelector('.content'),
    img: root.querySelector('img'),
    glow: root.querySelector('.glow'),
    sheen: root.querySelector('.sheen'),
    src: '',
  }
}

function show(win, name, time) {
  const url = frameUrl(name, time)
  if (url === win.src) return
  win.src = url
  win.img.src = url
  pending.push(win.img.decode().catch(() => {}))
}

/** Size and place a window on the stage, with a 3D pose. */
function placeWindow(win, { w, h, cx = 960, cy = 540, ...rest }) {
  win.w = w
  win.h = h
  Object.assign(win.root.style, { width: `${w}px`, height: `${h}px`, left: `${cx - w / 2}px`, top: `${cy - h / 2}px` })
  pose(win.root, rest)
}

const full = win => ({ s: win.w / 2560, cx: 1280, cy: 800 })
function focus(win, [x, y, w, h], fill = 0.9, cap = 2.2) {
  return { s: Math.min((win.w * fill) / w, (win.h * fill) / h, cap), cx: x + w / 2, cy: y + h / 2 }
}
function mix(a, b, k) {
  return { s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), k)), cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k) }
}
/** Point the camera inside a window, keeping the frame edges out of view. */
function look(win, view) {
  const halfW = win.w / 2 / view.s
  const halfH = win.h / 2 / view.s
  const cx = halfW * 2 >= 2560 ? 1280 : clamp(view.cx, halfW, 2560 - halfW)
  const cy = halfH * 2 >= 1600 ? 800 : clamp(view.cy, halfH, 1600 - halfH)
  win.content.style.transform = `translate(${win.w / 2 - cx * view.s}px, ${win.h / 2 - cy * view.s}px) scale(${view.s})`
}

/** A soft highlight over part of the frame, in frame pixels. */
function glow(win, [x, y, w, h], amount, color = '166 227 184') {
  Object.assign(win.glow.style, {
    left: `${x - 16}px`,
    top: `${y - 12}px`,
    width: `${w + 32}px`,
    height: `${h + 24}px`,
    background: `rgb(${color} / ${0.28 * amount})`,
    boxShadow: `0 0 0 ${4 * amount}px rgb(${color} / ${0.7 * amount}), 0 0 ${80 * amount}px rgb(${color} / ${0.6 * amount})`,
  })
}

function sheen(win, t, at) {
  const k = prog(t, at, at + 0.9)
  win.sheen.style.transform = `translateX(${lerp(-120, 120, ease.inOutCubic(k))}%)`
  win.sheen.style.opacity = String(k > 0 && k < 1 ? 1 : 0)
}

// ---------------------------------------------------------------- stage

const stage = document.getElementById('stage')
const world = document.getElementById('world')
const flash = document.getElementById('flash')
const bg = document.getElementById('bg')
const scenes = []
const builders = []

/** Scenes are built once the clips have loaded: they read clip metadata. */
function scene(name, build) {
  builders.push({ name, build })
}

function buildScenes() {
  for (const { name, build } of builders) {
    const layer = el(`<div class="layer" data-scene="${name}"></div>`, world)
    const [start, end] = SCENES[name]
    layer.style.display = 'block'
    const render = build(layer)
    layer.style.display = 'none'
    scenes.push({ name, start, end, layer, render })
  }
}

const LOGO = `<svg viewBox="428 396 405 459" xmlns="http://www.w3.org/2000/svg">
  <rect class="bar" x="428" y="396" width="81" height="459" fill="currentColor" />
  <polygon class="chevron" points="591,396 833,590 833,662 591,855 591,766 764,626 591,485" fill="currentColor" />
</svg>`

const ICONS = {
  doc: '<svg viewBox="0 0 48 48"><path d="M13 5h15l9 9v29H13z"/><path d="M28 5v9h9M19 24h12M19 31h12M19 38h8"/></svg>',
  pdf: '<svg viewBox="0 0 48 48"><path d="M13 5h15l9 9v29H13z"/><path d="M28 5v9h9"/><text x="25" y="34" text-anchor="middle" font-size="10" font-weight="700" fill="#f4f3ef" stroke="none" font-family="Inter Tight">PDF</text></svg>',
  image: '<svg viewBox="0 0 48 48"><rect x="6" y="9" width="36" height="30" rx="5"/><circle cx="17" cy="19" r="3.5"/><path d="M8 35l11-11 8 8 5-5 9 9"/></svg>',
  audio: '<svg viewBox="0 0 48 48"><path d="M8 20v8M15 14v20M22 8v32M29 16v16M36 11v26M43 21v6"/></svg>',
  video: '<svg viewBox="0 0 48 48"><rect x="5" y="10" width="38" height="28" rx="6"/><path d="M20 18l10 6-10 6z"/></svg>',
}

// ------------------------------------------------ 1. hook: who writes?

scene('hook', layer => {
  const line = el(`<div class="center" style="top:470px;font-size:78px;font-weight:500;letter-spacing:-0.025em"></div>`, layer)
  const chars = splitChars(line, HOOK.text)
  const caret = el(`<div class="caret" style="height:86px;top:2px"></div>`, line)
  const strike = el(`<div class="strike"></div>`, line)
  const big = el(`<div class="center display" style="top:330px;font-size:200px">You dictate.</div>`, layer)
  const small = el(`<div class="center" style="top:585px;font-size:96px;font-weight:600;letter-spacing:-0.04em;color:var(--dim)">Not the AI.</div>`, layer)
  const struck = [HOOK.text.indexOf('writes'), HOOK.text.length - 1]

  return t => {
    const typed = chars.filter((_, index) => t >= HOOK.start + index * HOOK.step).length
    chars.forEach((span, index) => {
      const k = prog(t, HOOK.start + index * HOOK.step, HOOK.start + index * HOOK.step + 0.05)
      const dimmed = index >= struck[0] ? lerp(1, 0.38, prog(t, 1.72, 1.9)) : 1
      pose(span, { y: 10 * (1 - k), o: k * dimmed })
    })
    const last = chars[Math.max(0, typed - 1)]
    const caretX = typed ? last.offsetLeft + last.offsetWidth + 8 : chars[0].offsetLeft - 4
    const typing = t >= HOOK.start && t < HOOK.start + chars.length * HOOK.step + 0.1
    const blinkOn = typing || Math.floor(t / 0.5) % 2 === 0
    caret.style.left = `${caretX}px`
    caret.style.opacity = blinkOn && t < 1.98 ? '1' : '0'
    const from = chars[struck[0]]
    const to = chars[struck[1]]
    const wipe = ease.outExpo(prog(t, 1.72, 1.92))
    Object.assign(strike.style, {
      left: `${from.offsetLeft - 6}px`,
      top: `${from.offsetTop + from.offsetHeight * 0.5}px`,
      width: `${to.offsetLeft + to.offsetWidth - from.offsetLeft + 12}px`,
      transform: `scaleX(${wipe})`,
      opacity: String(wipe > 0 ? 1 : 0),
    })
    const lift = ease.outExpo(prog(t, 1.98, 2.3))
    pose(line, { y: -150 * lift, s: 1 - 0.3 * lift, o: 1 - prog(t, 1.98, 2.18), blur: 8 * lift })
    pose(big, stomp(t, 2.0, { from: 2.8 }))
    fringe(big, t, 2.0, 16)
    pose(small, stomp(t, 2.5, { from: 1.9, dur: 0.13 }))
    const out = ease.inExpo(prog(t, 2.82, 3.05))
    pose(layer, { s: 1 + 0.9 * out, o: 1 - out, blur: 24 * out })
  }
})

// ------------------------------------------------ 2. you write; Tab keeps it

scene('tab', layer => {
  const you = el(`<div class="center display" style="top:250px;font-size:180px">You write.</div>`, layer)
  const row = el(`<div class="center" style="top:470px"></div>`, layer)
  const ghost = el(`<span class="serif" style="font-size:170px;color:var(--ghost)"></span>`, row)
  const ghostChars = splitChars(ghost, 'It suggests.')
  const key = el(`<span class="keycap" style="margin-left:48px;transform-origin:50% 50%">Tab</span>`, row)
  const note = el(`<div class="center" style="top:760px;font-size:46px;font-weight:500;letter-spacing:-0.02em;color:var(--dim)"></div>`, layer)
  const noteChars = splitChars(note, 'Nothing enters the page until you press Tab.')

  return t => {
    pose(you, stomp(t, 3.0, { from: 2.3 }))
    fringe(you, t, 3.0)
    rise(ghostChars, t, 3.3, { step: 0.03, dur: 0.3, dy: 30, blur: 14 })
    const kept = ease.outCubic(prog(t, 4.0, 4.22))
    ghost.style.color = `rgb(${lerp(122, 244, kept)} ${lerp(121, 243, kept)} ${lerp(117, 239, kept)})`
    ghost.style.textShadow = kept > 0 && t < 4.7 ? `0 0 ${50 * (1 - prog(t, 4.0, 4.7))}px rgb(166 227 184 / 80%)` : 'none'
    const pop = ease.outBack(prog(t, 3.55, 3.85))
    const press = t >= 4.0 && t < 4.14 ? 1 : t >= 4.14 ? 1 - prog(t, 4.14, 4.3) : 0
    pose(key, { y: 10 * press, s: (0.4 + 0.6 * pop) * (1 - 0.05 * press), o: pop * (1 - prog(t, 4.45, 4.7)) })
    key.style.boxShadow = press
      ? `inset 0 1px 0 rgb(255 255 255 / 18%), 0 ${10 - 8 * press}px 0 #0c0d0c, 0 0 ${70 * press}px rgb(166 227 184 / 60%)`
      : ''
    rise(noteChars, t, 4.45, { step: 0.011, dur: 0.35, dy: 18, blur: 6 })
    const out = ease.outCubic(prog(t, 5.08, 5.36))
    pose(layer, { y: -320 * out, s: 1 - 0.12 * out, o: 1 - out, blur: 22 * out })
  }
})

// ------------------------------------------------ 3. a real suggestion

scene('write', layer => {
  const win = makeWindow(layer)
  const waits = el(`<div class="center caption" style="top:62px"></div>`, layer)
  const waitChars = splitChars(waits, 'A suggestion from your own files.')
  const keeps = el(`<div class="center caption" style="top:62px">Tab keeps it.</div>`, layer)
  const { rects } = clips.write

  return t => {
    const enter = ease.outExpo(prog(t, 5.34, 6.15))
    const whip = ease.inExpo(prog(t, 8.95, 9.1))
    placeWindow(win, {
      w: 1376,
      h: 860,
      cy: 612,
      y: 900 * (1 - enter),
      rx: lerp(42, 13, enter) - 7 * prog(t, 6.1, 9.1),
      ry: lerp(-14, -6, enter) + 5 * prog(t, 6.1, 9.1),
      s: lerp(0.78, 1, enter),
      x: -1500 * whip,
      blur: 26 * whip,
      o: enter,
    })
    show(win, 'write', clipTime(CLIP_MAPS.write, t))
    const line = [800, 860, 1460, 260]
    look(win, mix(full(win), focus(win, line, 0.94), ease.inOutQuint(prog(t, 6.55, 7.3))))
    const ghost = rects.ghost ?? [922, 1012, 596, 44]
    glow(win, ghost, t >= 8.81 ? Math.exp(-(t - 8.81) * 3.2) : 0)
    sheen(win, t, 6.0)
    rise(waitChars, t, 7.2, { step: 0.018, dur: 0.35, dy: 26 })
    pose(waits, { o: 1 - prog(t, 8.7, 8.8), y: -20 * prog(t, 8.7, 8.8) })
    pose(keeps, { ...stomp(t, 8.81, { from: 1.7, dur: 0.12 }), x: -1500 * whip })
  }
})

// ------------------------------------------------ 4. every suggestion shows its source

scene('source', layer => {
  const win = makeWindow(layer)
  const caption = el(`<div class="center caption" style="top:62px"></div>`, layer)
  const chars = splitChars(caption, 'Every suggestion shows its source.')
  const menu = clips.write.rects.choices ?? [1723, 1060, 720, 236]
  const source = [menu[0] + 24, menu[1] + 116, 540, 42]

  return t => {
    const enter = ease.outExpo(prog(t, 9.0, 9.22))
    const out = ease.inExpo(prog(t, 10.92, 11.1))
    placeWindow(win, {
      w: 1376,
      h: 860,
      cy: 612,
      x: 1500 * (1 - enter),
      blur: 20 * (1 - enter) + 18 * out,
      rx: 7,
      ry: lerp(5, -3, prog(t, 9.0, 11.1)),
      s: 1 + 1.4 * out,
      o: 1 - out,
    })
    show(win, 'write', clipTime(CLIP_MAPS.source, t))
    const wide = focus(win, [700, 760, 1820, 640], 0.96)
    const close = focus(win, [820, menu[1] - 210, menu[0] + menu[2] + 40 - 820, menu[3] + 280], 0.96)
    look(win, mix(wide, close, ease.inOutQuint(prog(t, 9.3, 9.9))))
    const ring = t >= 9.75 && t < 10.7 ? Math.sin(Math.PI * prog(t, 9.75, 10.7)) : 0
    glow(win, source, ring)
    rise(chars, t, 9.5, { step: 0.016, dur: 0.35, dy: 26 })
    pose(caption, { o: 1 - out, blur: 12 * out })
  }
})

// ------------------------------------------------ 5. every kind of source, understood locally

scene('media', layer => {
  const words = ['Docs.', 'PDFs.', 'Images.', 'Audio.', 'Video.']
  const wordNodes = words.map(word => el(`<div class="center display" style="top:440px;font-size:210px">${word}</div>`, layer))
  const tiles = ['doc', 'pdf', 'image', 'audio', 'video'].map(icon => el(`<div class="tile">${ICONS[icon]}</div>`, layer))
  const ring = el(`<div style="position:absolute;left:960px;top:540px;border-radius:50%;border:3px solid rgb(166 227 184 / 70%)"></div>`, layer)
  const core = el(
    `<div class="core"><div style="font-size:78px;font-weight:700;letter-spacing:-0.04em">EmbeddingGemma 2</div><div class="sub" style="margin-top:12px;font-size:36px;font-weight:500;color:var(--mint)">understands them all, on your device</div></div>`,
    layer
  )
  const sub = core.querySelector('.sub')
  const beats = words.map((_, index) => 11.0 + index * 0.5)

  return t => {
    wordNodes.forEach((node, index) => {
      const next = beats[index + 1] ?? 13.45
      const leave = prog(t, next - 0.02, next + 0.06)
      const pose_ = stomp(t, beats[index], { from: 2.1, dur: 0.13, blur: 16 })
      pose(node, { ...pose_, o: pose_.o * (1 - leave), s: pose_.s * (1 - 0.2 * leave) })
      fringe(node, t, beats[index], 10)
    })
    const spin = t * 0.45
    const gather = ease.inExpo(prog(t, 13.45, 13.72))
    tiles.forEach((tile, index) => {
      const angle = spin + (index / tiles.length) * Math.PI * 2 - Math.PI / 2
      const arrive = ease.outExpo(prog(t, beats[index], beats[index] + 0.4))
      const radius = lerp(2.6, 1, arrive) * (1 - gather)
      const x = 960 + Math.cos(angle) * 560 * radius
      const y = 540 + Math.sin(angle) * 330 * radius
      tile.style.left = `${x}px`
      tile.style.top = `${y}px`
      pose(tile, { s: lerp(0.4, 1, arrive) * (1 - 0.7 * gather), o: arrive * (1 - gather), blur: 12 * (1 - arrive) + 10 * gather, rz: 8 * Math.sin(spin + index) })
    })
    const wave = prog(t, 13.7, 14.1)
    const size = 200 + 1500 * ease.outCubic(wave)
    Object.assign(ring.style, {
      width: `${size}px`,
      height: `${size}px`,
      marginLeft: `${-size / 2}px`,
      marginTop: `${-size / 2}px`,
      opacity: String(wave > 0 ? 1 - wave : 0),
    })
    const show_ = ease.outBack(prog(t, 13.68, 13.9))
    core.style.transform = `translate(-50%, -50%) scale(${lerp(0.5, 1, show_)})`
    core.style.opacity = String(clamp(show_ * 3) * (1 - prog(t, 13.98, 14.08)))
    pose(sub, { o: prog(t, 13.8, 13.95), y: 12 * (1 - prog(t, 13.8, 13.95)) })
  }
})

// ------------------------------------------------ 6. or dictate, literally

scene('dictate', layer => {
  const title = el(`<div style="position:absolute;inset:0"></div>`, layer)
  const big = el(`<div class="center display" style="top:330px;font-size:190px">Or dictate.</div>`, title)
  const lit = el(`<div class="center serif" style="top:540px;font-size:170px;color:var(--mint)">Literally.</div>`, title)
  const win = makeWindow(layer)
  const meter = el(
    `<div style="position:absolute;left:960px;top:1010px;transform:translate(-50%,-50%);display:flex;align-items:center;gap:7px;height:92px;padding:0 38px;border-radius:999px;background:rgb(10 12 11 / 82%);border:1px solid rgb(255 255 255 / 12%);box-shadow:0 20px 60px rgb(0 0 0 / 55%)"></div>`,
    layer
  )
  const bars = Array.from({ length: 44 }, () => el(`<span style="width:7px;border-radius:4px;background:var(--mint)"></span>`, meter))
  const badge = el(
    `<div class="pill" style="position:absolute;left:960px;top:1010px;transform:translate(-50%,-50%);white-space:nowrap;background:rgb(10 12 11 / 85%)"><b style="font-weight:700">Whistle</b><span style="color:var(--dim)">·</span><b style="font-weight:700">Fluid Speech Mini</b><span style="color:var(--mint)">on your device</span></div>`,
    layer
  )
  const { rects } = clips.dictate

  return t => {
    pose(big, stomp(t, 14.0, { from: 2.6 }))
    fringe(big, t, 14.0, 14)
    pose(lit, stomp(t, 14.5, { from: 1.8, dur: 0.13 }))
    const up = ease.inOutQuint(prog(t, 14.74, 15.12))
    title.style.transformOrigin = '50% 30%'
    const enter = ease.outExpo(prog(t, 15.0, 15.6))
    const out = ease.inExpo(prog(t, 17.8, 17.95))
    placeWindow(win, { w: 1312, h: 820, cy: 625, y: 900 * (1 - enter) - 700 * out, rx: lerp(36, 8, enter), ry: 4, s: lerp(0.8, 1, enter), o: enter, blur: 20 * out })
    show(win, 'dictate', clipTime(CLIP_MAPS.dictate, t))
    const chip = rects.listening ?? [860, 1201, 453, 48]
    look(win, mix(full(win), focus(win, [chip[0] - 70, chip[1] - 250, 1180, 400], 0.97), ease.inOutQuint(prog(t, 15.2, 15.8))))
    glow(win, rects.text ?? [844, 1196, 1360, 65], t >= 17.62 ? Math.exp(-(t - 17.62) * 3) * 0.8 : 0)
    const level = window.voiceLevel ?? (() => 0)
    const listening = prog(t, 14.3, 14.45) * (1 - prog(t, 17.38, 17.5))
    bars.forEach((bar, index) => {
      const v = level(t - (bars.length - index) * 0.012)
      bar.style.height = `${8 + 64 * v * listening}px`
      bar.style.opacity = String(0.45 + 0.55 * v)
    })
    pose(meter, { o: listening * (1 - out), x: 0 })
    meter.style.transform = `translate(-50%, -50%) scale(${lerp(0.7, 1, ease.outBack(prog(t, 14.3, 14.6)))})`
    const b = stomp(t, 17.5, { from: 1.4, dur: 0.12, blur: 10 })
    badge.style.opacity = String(b.o * (1 - out))
    badge.style.transform = `translate(-50%, -50%) scale(${b.s})`
    badge.style.filter = b.blur > 0.1 ? `blur(${b.blur}px)` : 'none'
    pose(title, { y: lerp(0, -305, up) - 600 * out, s: lerp(1, 0.42, up), o: 1 - out })
  }
})

// ------------------------------------------------ 7. local by default

scene('privacy', layer => {
  const head = el(`<div style="position:absolute;inset:0;transform-origin:50% 22%"></div>`, layer)
  const local = el(`<div class="center display" style="top:250px;font-size:260px;font-weight:900">Local</div>`, head)
  const byDefault = el(`<div class="center serif" style="top:500px;font-size:180px;color:var(--mint)">by default.</div>`, head)
  const list = el(`<div style="position:absolute;left:470px;top:430px;display:grid;gap:44px"></div>`, layer)
  const items = [
    'Your notes stay on your computer.',
    'Suggestions, search and dictation run on-device.',
    'Cloud models only when you choose them.',
  ].map(text =>
    el(`<div class="check"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" stroke-opacity=".35"/><path class="tick" d="M14 25l7 7 14-15" stroke-dasharray="40" /></svg><span>${text}</span></div>`, list)
  )
  const offline = el(
    `<div class="pill" style="position:absolute;left:960px;top:930px;transform:translate(-50%,-50%);white-space:nowrap"><svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="#a6e3b8" stroke-width="3.4" stroke-linecap="round"><path d="M6 18a27 27 0 0 1 36 0M12 25a18 18 0 0 1 24 0M18 32a9 9 0 0 1 12 0"/><circle cx="24" cy="39" r="2" fill="#a6e3b8"/><path d="M8 8l32 32" stroke="#f4f3ef"/></svg><span>Works offline, too.</span></div>`,
    layer
  )
  const beats = [19.0, 19.33, 19.66]

  return t => {
    pose(local, stomp(t, 18.0, { from: 2.6 }))
    fringe(local, t, 18.0, 16)
    pose(byDefault, stomp(t, 18.5, { from: 1.8, dur: 0.13 }))
    const up = ease.inOutQuint(prog(t, 18.8, 19.1))
    pose(head, { y: lerp(0, -175, up), s: lerp(1, 0.48, up) })
    items.forEach((item, index) => {
      const k = ease.outExpo(prog(t, beats[index], beats[index] + 0.35))
      pose(item, { x: 70 * (1 - k), o: k, blur: 8 * (1 - k) })
      item.querySelector('.tick').style.strokeDashoffset = String(40 * (1 - ease.outCubic(prog(t, beats[index] + 0.05, beats[index] + 0.3))))
    })
    const b = stomp(t, 20.0, { from: 1.5, dur: 0.12, blur: 10 })
    offline.style.opacity = String(b.o)
    offline.style.transform = `translate(-50%, -50%) scale(${b.s})`
    const out = ease.inExpo(prog(t, 20.42, 20.6))
    pose(layer, { s: 1 + 0.8 * out, o: 1 - out, blur: 22 * out })
  }
})

// ------------------------------------------------ 8. the rest, on the beat

scene('montage', layer => {
  const win = makeWindow(layer)
  // A lower third: the label sits on a dark fade inside the window.
  el(`<div style="position:absolute;left:0;right:0;bottom:0;height:46%;background:linear-gradient(to top, rgb(6 8 7 / 88%), rgb(6 8 7 / 55%) 45%, transparent);pointer-events:none"></div>`, win.root)
  const label = el(`<div class="label"></div>`, layer)
  const focusRects = {
    novel: clips.novel.rects.typed ? (([x, y, w, h]) => [x - 80, y - 140, w + 160, h + 300])(clips.novel.rects.typed) : [760, 380, 1520, 420],
    table: clips.table.rects.rendered ? (([x, y, w, h]) => [x - 200, y - 300, w + 700, h + 420])(clips.table.rects.rendered) : [640, 900, 1300, 640],
    links: [900, 940, 1100, 560],
    graph: [780, 470, 1000, 640],
    palette: clips.palette.rects.open ? (([x, y, w, h]) => [x - 140, y - 60, w + 280, h + 120])(clips.palette.rects.open) : [580, 230, 1400, 1160],
    zen: [300, 200, 1960, 1100],
    dark: [0, 0, 2560, 1600],
  }

  return t => {
    let cut = MONTAGE[0]
    for (const item of MONTAGE) if (t >= item.at) cut = item
    const local = t - cut.at
    const k = ease.outExpo(clamp(local / 0.16))
    const out = ease.inExpo(prog(t, 24.42, 24.6))
    placeWindow(win, { w: 1600, h: 1000, cy: 545, s: lerp(1.08, 1, k) * (1 + 0.5 * out), rx: 5, ry: -3 + 2 * Math.sin(t), blur: 14 * (1 - k) + 20 * out, o: 1 - out })
    show(win, cut.clip, cut.from + local)
    const view = focus(win, focusRects[cut.focus] ?? focusRects[cut.clip] ?? [0, 0, 2560, 1600], 0.98)
    look(win, { ...view, s: view.s * (1 + 0.05 * local) })
    glow(win, [0, 0, 0, 0], 0)
    if (label.dataset.text !== cut.label) {
      label.dataset.text = cut.label
      label.textContent = cut.label
    }
    pose(label, { ...stomp(t, cut.at, { from: 1.9, dur: 0.12, blur: 14 }), o: stomp(t, cut.at).o * (1 - out) })
    fringe(label, t, cut.at, 10)
  }
})

// ------------------------------------------------ 9. light, fast, yours

scene('claims', layer => {
  const row = el(`<div class="center" style="top:360px;display:flex;justify-content:center;gap:56px;align-items:baseline"></div>`, layer)
  const words = [
    el(`<span class="display" style="font-size:200px;font-weight:900;display:inline-block">Light.</span>`, row),
    el(`<span class="display" style="font-size:200px;font-weight:900;display:inline-block">Fast.</span>`, row),
    el(`<span class="serif" style="font-size:230px;color:var(--mint);display:inline-block">Yours.</span>`, row),
  ]
  const sub = el(`<div class="center" style="top:640px;font-size:42px;font-weight:500;color:var(--dim);letter-spacing:-0.01em"></div>`, layer)
  const subChars = splitChars(sub, 'Under 20 MB  ·  Free and open source  ·  macOS and Windows')

  return t => {
    words.forEach((word, index) => {
      pose(word, stomp(t, 24.5 + index * 0.5, { from: 2.4 }))
      fringe(word, t, 24.5 + index * 0.5, 12)
    })
    rise(subChars, t, 25.95, { step: 0.008, dur: 0.3, dy: 16, blur: 6 })
    const out = ease.inExpo(prog(t, 26.55, 26.8))
    pose(layer, { s: 1 + 1.1 * out, o: 1 - out, blur: 26 * out })
  }
})

// ------------------------------------------------ 10. the mark

scene('logo', layer => {
  const group = el(`<div style="position:absolute;left:0;top:0;width:1920px;height:1080px"></div>`, layer)
  const mark = el(`<div style="position:absolute;left:960px;top:470px;width:265px;height:300px;margin:-150px 0 0 -132px;color:var(--ink)">${LOGO}</div>`, group)
  const svg = mark.querySelector('svg')
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.style.overflow = 'visible'
  const bar = svg.querySelector('.bar')
  const chevron = svg.querySelector('.chevron')
  const word = el(`<div style="position:absolute;top:378px;font-size:190px;font-weight:700;letter-spacing:-0.045em;line-height:1;white-space:nowrap"></div>`, group)
  const wordChars = splitChars(word, 'TypeNext')
  const tagline = el(
    `<div class="center" style="top:720px;font-size:66px;font-weight:600;letter-spacing:-0.035em">You write. <span class="serif" style="font-size:78px;color:var(--mint);letter-spacing:-0.01em">AI suggests.</span></div>`,
    layer
  )
  const url = el(`<div class="center mono" style="top:880px;font-size:30px;color:var(--dim)">github.com/alshell7/typenext</div>`, layer)
  const ring = el(`<div style="position:absolute;left:960px;top:470px;border-radius:50%;border:2px solid rgb(244 243 239 / 60%)"></div>`, layer)
  let shift = null

  return t => {
    if (shift === null) {
      const total = 265 + 70 + word.offsetWidth
      shift = 960 - total / 2 + 132 - 960
      word.style.left = `${960 - total / 2 + 265 + 70}px`
    }
    const blink = t < 27.5 ? (t < 26.95 || (t >= 27.15 && t < 27.32) || t >= 27.42 ? 1 : 0) : 1
    bar.style.opacity = String(blink * prog(t, 26.75, 26.8))
    const c = stomp(t, 27.5, { from: 1.6, dur: 0.14, blur: 0 })
    chevron.style.opacity = String(c.o)
    chevron.style.transform = `translateX(${(c.s - 1) * 420}px)`
    chevron.style.transformBox = 'fill-box'
    mark.style.filter = t >= 27.5 ? `drop-shadow(0 0 ${60 * Math.exp(-(t - 27.5) * 2)}px rgb(166 227 184 / 90%))` : t > 27.2 ? `drop-shadow(0 0 ${30 * prog(t, 27.2, 27.5)}px rgb(244 243 239 / 60%))` : 'none'
    const slide = ease.inOutQuint(prog(t, 27.82, 28.3))
    mark.style.transform = `translateX(${shift * slide}px)`
    wordChars.forEach((span, index) => {
      const k = ease.outExpo(prog(t, 28.02 + index * 0.035, 28.42 + index * 0.035))
      pose(span, { x: 40 * (1 - k), o: k, blur: 12 * (1 - k) })
    })
    const tag = ease.outExpo(prog(t, 28.55, 29.05))
    pose(tagline, { y: 30 * (1 - tag), o: tag, blur: 8 * (1 - tag) })
    const u = ease.outExpo(prog(t, 29.05, 29.5))
    pose(url, { y: 16 * (1 - u), o: u })
    const wave = prog(t, 27.5, 28.2)
    const size = 300 + 2400 * ease.outCubic(wave)
    Object.assign(ring.style, { width: `${size}px`, height: `${size}px`, marginLeft: `${-size / 2}px`, marginTop: `${-size / 2}px`, opacity: String(wave > 0 ? (1 - wave) * 0.8 : 0) })
    pose(group, { s: 1 + 0.03 * prog(t, 27.5, 30) })
  }
})

// ---------------------------------------------------------------- frame

const grain = document.getElementById('grain')
const grainContext = grain.getContext('2d')
const noise = Array.from({ length: 8 }, (_, seed) => {
  const image = grainContext.createImageData(grain.width, grain.height)
  let state = 1234567 + seed * 7919
  for (let index = 0; index < image.data.length; index += 4) {
    state = (state * 1103515245 + 12345) >>> 0
    const value = state >>> 24
    image.data[index] = image.data[index + 1] = image.data[index + 2] = value
    image.data[index + 3] = 255
  }
  return image
})

function camera(t) {
  let dx = 0
  let dy = 0
  let punch = 0
  let light = 0
  for (const { t: at, power } of STOMPS) {
    const x = t - at
    if (x < 0 || x > 0.6) continue
    const amp = 16 * power * Math.exp(-x * 15)
    dx += amp * Math.sin(x * 91 + at * 13)
    dy += amp * Math.cos(x * 77 + at * 7)
    punch += 0.035 * power * Math.exp(-x * 11)
    light += (power >= 0.9 ? 0.16 : 0.07) * power * Math.exp(-x * 24)
  }
  world.style.transform = `translate(${dx}px, ${dy}px) scale(${1 + punch})`
  flash.style.opacity = String(clamp(light, 0, 0.5))
}

function backdrop(t) {
  bg.style.setProperty('--gx', `${30 + 12 * Math.sin(t * 0.31)}%`)
  bg.style.setProperty('--gy', `${32 + 10 * Math.cos(t * 0.23)}%`)
  bg.style.setProperty('--hx', `${72 + 10 * Math.cos(t * 0.27)}%`)
  bg.style.setProperty('--hy', `${78 + 8 * Math.sin(t * 0.19)}%`)
  const media = Math.sin(Math.PI * prog(t, 11, 14.1))
  const logo = prog(t, 27.5, 28.5)
  bg.style.setProperty('--ga', String(0.16 + 0.22 * media + 0.1 * logo))
}

window.renderAt = async t => {
  for (const item of scenes) {
    const visible = t >= item.start && t < item.end
    item.layer.style.display = visible ? 'block' : 'none'
    if (visible) item.render(t)
  }
  camera(t)
  backdrop(t)
  grainContext.putImageData(noise[Math.floor(t * 60) % noise.length], 0, 0)
  const waits = pending.splice(0)
  await Promise.all(waits)
}

async function start() {
  await document.fonts.ready
  await Promise.all(['800 100px "Inter Tight"', 'italic 100px "Instrument Serif"', '500 30px "JetBrains Mono"'].map(font => document.fonts.load(font)))
  await loadClips()
  try {
    const response = await fetch('../../artifacts/promo/voice-envelope.json')
    if (response.ok) {
      const { at, rate, values } = await response.json()
      window.voiceLevel = t => values[Math.round((t - at) * rate)] ?? 0
    }
  } catch {
    // The meter stays flat without the envelope.
  }
  buildScenes()
  const at = Number(new URLSearchParams(location.search).get('t') ?? 0)
  await window.renderAt(at)
  window.filmReady = true
}

await start()
