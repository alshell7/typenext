// The TypeNext film: every frame is a pure function of time, so the
// renderer can step through it at a fixed rate. Open film.html?t=12.3 in a
// browser to look at one moment.
//
// Layers, back to front: the WebGL stage (three-scenes.js: light, dust, the
// knowledge core, the 3D mark), the DOM world (kinetic type, real app
// windows, Lottie animations), then flash, vignette and grain.
import {
  CHECKS,
  CLIP_MAPS,
  HEIGHT,
  HOOK,
  LOGO as LOGO_CUE,
  MONTAGE,
  SCENES,
  STOMPS,
  WIDTH,
  b,
} from './timeline.mjs'
import { LOTTIE } from './lottie-assets.mjs'
import { createStage3D } from './three-scenes.js'

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

/** A word that slams into place: big, tilted back, blurred, then a wobble. */
function stomp(t, at, { from = 2.5, dur = 0.17, blur = 18, tilt = 38 } = {}) {
  if (t < at) return { o: 0, s: from, blur, rx: tilt }
  const x = t - at
  const k = ease.outQuart(clamp(x / dur))
  const wobble = x > dur ? 0.026 * Math.exp(-(x - dur) * 10) * Math.sin((x - dur) * 36) : 0
  return { o: clamp(x / 0.04), s: lerp(from, 1, k) + wobble, blur: blur * (1 - k), rx: tilt * (1 - k) }
}

/**
 * Deep type: stacked shadows give the letters a lit, extruded side, plus
 * red and blue fringes right after a stomp.
 */
function extrude(node, t, at, { depth = 9, fringe = 12, color = '20 32 25' } = {}) {
  const layers = []
  for (let i = 1; i <= depth; i++) layers.push(`0 ${i}px 0 rgb(${color} / ${1 - i / (depth + 4)})`)
  layers.push(`0 ${depth + 6}px 28px rgb(0 0 0 / 55%)`)
  const x = t - at
  const offset = x >= 0 ? fringe * Math.exp(-x * 12) : 0
  if (offset > 0.2) layers.unshift(`${offset}px 0 rgb(255 70 90 / 50%)`, `${-offset}px 0 rgb(60 170 255 / 50%)`)
  node.style.textShadow = layers.join(', ')
}

function splitChars(node, text) {
  node.textContent = ''
  return [...text].map(character => {
    const span = el(`<span class="char"></span>`, node)
    span.textContent = character
    return span
  })
}

/** Letters rise and sharpen one after another, with a slight 3D tip. */
function rise(chars, t, at, { step = 0.03, dur = 0.4, dy = 40, blur = 10, tilt = 0 } = {}) {
  chars.forEach((span, index) => {
    const k = ease.outExpo(prog(t, at + index * step, at + index * step + dur))
    pose(span, { y: dy * (1 - k), o: k, blur: blur * (1 - k), rx: tilt * (1 - k) })
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

// ---------------------------------------------------------------- Lottie

/** A Lottie animation stepped to an exact frame for each film frame. */
function lottiePlayer(parent, data, { size, className = '' }) {
  const node = el(`<div class="lottie ${className}" style="width:${size}px;height:${size}px"></div>`, parent)
  const animation = window.lottie.loadAnimation({ container: node, renderer: 'svg', loop: false, autoplay: false, animationData: data })
  const frames = data.op
  let last = -1
  return {
    node,
    /** Show the animation `seconds` after its start, or hide it. */
    at(seconds, { loop = false } = {}) {
      if (seconds === null || seconds < 0) {
        node.style.display = 'none'
        return
      }
      // A finished animation holds its last frame.
      node.style.display = ''
      const frame = loop ? (seconds * 60) % frames : Math.min(frames - 1, seconds * 60)
      if (Math.abs(frame - last) > 0.01) {
        animation.goToAndStop(frame, true)
        last = frame
      }
    },
  }
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
    `<div class="window"><div class="slab"></div><div class="screen"><div class="content"><img alt="" /><div class="glow"></div></div><div class="sheen"></div></div></div>`,
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
    background: `rgb(${color} / ${0.26 * amount})`,
    boxShadow: `0 0 0 ${4 * amount}px rgb(${color} / ${0.7 * amount}), 0 0 ${80 * amount}px rgb(${color} / ${0.55 * amount})`,
  })
}

function sheen(win, t, at) {
  const k = prog(t, at, at + 1.1)
  win.sheen.style.transform = `translateX(${lerp(-120, 120, ease.inOutCubic(k))}%)`
  win.sheen.style.opacity = String(k > 0 && k < 1 ? 1 : 0)
}

/** Centre a stage element on the screen position of a window's glow box. */
function overGlow(win, node, size) {
  const box = win.glow.getBoundingClientRect()
  node.style.left = `${box.left + box.width / 2 - size / 2}px`
  node.style.top = `${box.top + box.height / 2 - size / 2}px`
}

// ---------------------------------------------------------------- stage

const world = document.getElementById('world')
// Flat, above the 3D world: sparkles must never hide behind a tilted window.
const overlay = document.getElementById('overlay')
const flash = document.getElementById('flash')
const scenes = []
const builders = []
let stage3d = null
let mark3d = null

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

// ------------------------------------------------ 1. hook: who writes?

scene('hook', layer => {
  const line = el(`<div class="center" style="top:470px;font-size:78px;font-weight:500;letter-spacing:-0.025em"></div>`, layer)
  const chars = splitChars(line, HOOK.text)
  const caret = el(`<div class="caret" style="height:86px;top:2px"></div>`, line)
  const strike = el(`<div class="strike"></div>`, line)
  const head = el(`<div style="position:absolute;inset:0;perspective:1400px;transform-style:preserve-3d"></div>`, layer)
  const big = el(`<div class="center display" style="top:330px;font-size:204px">You dictate.</div>`, head)
  const small = el(`<div class="center" style="top:590px;font-size:98px;font-weight:600;letter-spacing:-0.04em;color:var(--dim)">Not the AI.</div>`, head)
  const struck = [HOOK.text.indexOf('writes'), HOOK.text.length - 1]
  const typedEnd = HOOK.start + chars.length * HOOK.step

  return t => {
    const typed = chars.filter((_, index) => t >= HOOK.start + index * HOOK.step).length
    chars.forEach((span, index) => {
      const k = prog(t, HOOK.start + index * HOOK.step, HOOK.start + index * HOOK.step + 0.06)
      const dimmed = index >= struck[0] ? lerp(1, 0.36, prog(t, b(5), b(5) + 0.25)) : 1
      pose(span, { y: 10 * (1 - k), o: k * dimmed })
    })
    const last = chars[Math.max(0, typed - 1)]
    const caretX = typed ? last.offsetLeft + last.offsetWidth + 8 : chars[0].offsetLeft - 4
    const typing = t >= HOOK.start && t < typedEnd + 0.1
    caret.style.left = `${caretX}px`
    caret.style.opacity = (typing || Math.floor(t / 0.5) % 2 === 0) && t < b(6) - 0.02 ? '1' : '0'
    const from = chars[struck[0]]
    const to = chars[struck[1]]
    const wipe = ease.outExpo(prog(t, b(5), b(5) + 0.3))
    Object.assign(strike.style, {
      left: `${from.offsetLeft - 6}px`,
      top: `${from.offsetTop + from.offsetHeight * 0.5}px`,
      width: `${to.offsetLeft + to.offsetWidth - from.offsetLeft + 12}px`,
      transform: `scaleX(${wipe})`,
      opacity: String(wipe > 0 ? 1 : 0),
    })
    const lift = ease.outExpo(prog(t, b(6) - 0.02, b(6) + 0.4))
    pose(line, { y: -170 * lift, s: 1 - 0.3 * lift, o: 1 - prog(t, b(6) - 0.02, b(6) + 0.22), blur: 8 * lift })
    pose(big, stomp(t, b(6), { from: 2.8 }))
    extrude(big, t, b(6), { depth: 10, fringe: 16 })
    pose(small, stomp(t, b(7), { from: 1.9, dur: 0.15, tilt: 24 }))
    extrude(small, t, b(7), { depth: 5, fringe: 8 })
    const out = ease.inExpo(prog(t, 4.62, 4.95))
    pose(layer, { s: 1 + 0.9 * out, o: 1 - out, blur: 24 * out })
  }
})

// ------------------------------------------------ 2. you write; Tab keeps it

scene('tab', layer => {
  const you = el(`<div class="center display" style="top:240px;font-size:186px">You write.</div>`, layer)
  const row = el(`<div class="center" style="top:470px;perspective:900px"></div>`, layer)
  const ghost = el(`<span class="serif" style="font-size:172px;color:var(--ghost)"></span>`, row)
  const ghostChars = splitChars(ghost, 'It suggests.')
  const key = el(`<span class="keycap"><span class="keycap-top">Tab</span></span>`, row)
  const spark = lottiePlayer(layer, LOTTIE.sparkle(), { size: 340, className: 'stage-lottie' })
  layer.insertBefore(spark.node, row)
  const note = el(`<div class="center" style="top:770px;font-size:46px;font-weight:500;letter-spacing:-0.02em;color:var(--dim)"></div>`, layer)
  const noteChars = splitChars(note, 'Nothing enters the page until you press Tab.')
  const press = b(11)

  return t => {
    pose(you, stomp(t, b(8), { from: 2.3 }))
    extrude(you, t, b(8), { depth: 9 })
    rise(ghostChars, t, 5.25, { step: 0.05, dur: 0.45, dy: 30, blur: 14 })
    const kept = ease.outCubic(prog(t, press, press + 0.25))
    ghost.style.color = `rgb(${lerp(122, 244, kept)} ${lerp(121, 243, kept)} ${lerp(117, 239, kept)})`
    ghost.style.textShadow = kept > 0 && t < press + 0.9 ? `0 0 ${50 * (1 - prog(t, press, press + 0.9))}px rgb(166 227 184 / 80%)` : 'none'
    const pop = ease.outBack(prog(t, 5.85, 6.25))
    const down = t >= press && t < press + 0.12 ? 1 : t >= press + 0.12 ? 1 - prog(t, press + 0.12, press + 0.32) : 0
    pose(key, { s: (0.4 + 0.6 * pop) * (1 - 0.04 * down), rx: lerp(55, 18, pop), o: pop * (1 - prog(t, 7.4, 7.7)) })
    key.style.setProperty('--press', String(down))
    const box = key.getBoundingClientRect()
    spark.node.style.left = `${box.left + box.width / 2 - 170}px`
    spark.node.style.top = `${box.top + box.height / 2 - 170}px`
    spark.at(t >= press ? t - press : null)
    rise(noteChars, t, 7.0, { step: 0.014, dur: 0.45, dy: 18, blur: 6 })
    const out = ease.outCubic(prog(t, 8.7, 9.05))
    pose(layer, { y: -320 * out, s: 1 - 0.12 * out, o: 1 - out, blur: 22 * out })
  }
})

// ------------------------------------------------ 3. a real suggestion

scene('write', layer => {
  const win = makeWindow(layer)
  const waits = el(`<div class="center caption" style="top:58px"></div>`, layer)
  const waitChars = splitChars(waits, 'A suggestion from your own files.')
  const keeps = el(`<div class="center caption" style="top:58px">Tab keeps it.</div>`, layer)
  const spark = lottiePlayer(overlay, LOTTIE.sparkle(), { size: 300, className: 'stage-lottie' })
  const { rects } = clips.write
  const accept = b(23)

  return t => {
    const enter = ease.outExpo(prog(t, 9.0, 10.1))
    const whip = ease.inExpo(prog(t, 14.35, 14.55))
    const drift = prog(t, 9.6, 14.5)
    placeWindow(win, {
      w: 1376,
      h: 860,
      cy: 618,
      y: 940 * (1 - enter),
      z: lerp(-500, 0, enter),
      rx: lerp(46, 12, enter) - 8 * drift,
      ry: lerp(-24, -7, enter) + 8 * drift,
      x: -1600 * whip,
      blur: 26 * whip,
      o: enter,
    })
    show(win, 'write', clipTime(CLIP_MAPS.write, t))
    look(win, mix(full(win), focus(win, [800, 860, 1460, 260], 0.94), ease.inOutQuint(prog(t, 11.2, 12.2))))
    const ghost = rects.ghost ?? [922, 1012, 596, 44]
    glow(win, ghost, t >= accept ? Math.exp(-(t - accept) * 2.6) : 0)
    sheen(win, t, 9.8)
    if (t >= accept && t < accept + 0.9) overGlow(win, spark.node, 300)
    spark.at(t >= accept ? t - accept : null)
    rise(waitChars, t, 12.25, { step: 0.02, dur: 0.45, dy: 26 })
    pose(waits, { o: 1 - prog(t, accept - 0.12, accept), y: -20 * prog(t, accept - 0.12, accept) })
    const k = stomp(t, accept, { from: 1.7, dur: 0.14, tilt: 30 })
    pose(keeps, { ...k, x: -1600 * whip })
    extrude(keeps, t, accept, { depth: 5, fringe: 8 })
  }
})

// ------------------------------------------------ 4. every suggestion shows its source

scene('source', layer => {
  const win = makeWindow(layer)
  const caption = el(`<div class="center caption" style="top:58px"></div>`, layer)
  const chars = splitChars(caption, 'Every suggestion shows its source.')
  const menu = clips.write.rects.choices ?? [1723, 1060, 720, 236]
  const source = [menu[0] + 24, menu[1] + 116, 540, 42]

  return t => {
    const enter = ease.outExpo(prog(t, 14.4, 14.7))
    const out = ease.inExpo(prog(t, 17.3, 17.55))
    placeWindow(win, {
      w: 1376,
      h: 860,
      cy: 618,
      x: 1600 * (1 - enter),
      blur: 20 * (1 - enter) + 18 * out,
      rx: 8,
      ry: lerp(9, -5, prog(t, 14.4, 17.5)),
      s: 1 + 1.4 * out,
      o: 1 - out,
    })
    show(win, 'write', clipTime(CLIP_MAPS.source, t))
    const wide = focus(win, [700, 760, 1820, 640], 0.96)
    const close = focus(win, [820, menu[1] - 210, menu[0] + menu[2] + 40 - 820, menu[3] + 280], 0.96)
    look(win, mix(wide, close, ease.inOutQuint(prog(t, 14.8, 15.6))))
    const ring = t >= 15.4 && t < 16.7 ? Math.sin(Math.PI * prog(t, 15.4, 16.7)) : 0
    glow(win, source, ring)
    rise(chars, t, 14.9, { step: 0.02, dur: 0.45, dy: 26 })
    pose(caption, { o: 1 - out, blur: 12 * out })
  }
})

// ------------------------------------------------ 5. every kind of source, understood locally

scene('media', layer => {
  const words = ['Docs.', 'PDFs.', 'Images.', 'Audio.', 'Video.']
  const head = el(`<div style="position:absolute;inset:0;perspective:1400px"></div>`, layer)
  const wordNodes = words.map(word => el(`<div class="center display" style="top:800px;font-size:150px">${word}</div>`, head))
  const chip = el(
    `<div class="core-chip"><div class="core-title">EmbeddingGemma 2</div><div class="core-sub">understands them all, on your device</div></div>`,
    layer
  )
  const sub = chip.querySelector('.core-sub')
  const beats = [29, 30, 31, 32, 33].map(b)

  return t => {
    wordNodes.forEach((node, index) => {
      const next = beats[index + 1] ?? b(34)
      const leave = prog(t, next - 0.02, next + 0.08)
      const value = stomp(t, beats[index], { from: 2.1, dur: 0.15, blur: 16, tilt: 30 })
      pose(node, { ...value, o: value.o * (1 - leave), s: value.s * (1 - 0.2 * leave) })
      extrude(node, t, beats[index], { depth: 7, fringe: 10 })
    })
    const show_ = ease.outBack(prog(t, b(35), b(35) + 0.3))
    chip.style.transform = `translate(-50%, -50%) scale(${lerp(0.5, 1, show_)})`
    chip.style.opacity = String(clamp(show_ * 3) * (1 - prog(t, 22.05, 22.3)))
    pose(sub, { o: prog(t, b(35) + 0.2, b(35) + 0.45), y: 12 * (1 - prog(t, b(35) + 0.2, b(35) + 0.45)) })
  }
})

// ------------------------------------------------ 6. or dictate, literally

scene('dictate', layer => {
  const title = el(`<div style="position:absolute;inset:0;transform-origin:50% 30%;perspective:1400px"></div>`, layer)
  const big = el(`<div class="center display" style="top:320px;font-size:196px">Or dictate.</div>`, title)
  const lit = el(`<div class="center serif" style="top:540px;font-size:176px;color:var(--mint)">Literally.</div>`, title)
  const win = makeWindow(layer)
  const meter = el(`<div class="meter"></div>`, overlay)
  const mic = lottiePlayer(meter, LOTTIE.microphone(), { size: 120, className: 'meter-mic' })
  const bars = Array.from({ length: 40 }, () => el(`<span class="meter-bar"></span>`, meter))
  const badge = el(
    `<div class="pill" style="position:absolute;left:960px;top:1012px;transform:translate(-50%,-50%);white-space:nowrap;background:rgb(10 12 11 / 85%)"><b style="font-weight:700">Whistle</b><span style="color:var(--dim)">·</span><b style="font-weight:700">Fluid Speech Mini</b><span style="color:var(--mint)">on your device</span></div>`,
    overlay
  )
  const { rects } = clips.dictate
  const textAt = 27.16

  return t => {
    pose(big, stomp(t, b(37), { from: 2.6 }))
    extrude(big, t, b(37), { depth: 10, fringe: 14 })
    pose(lit, stomp(t, b(38), { from: 1.8, dur: 0.15, tilt: 26 }))
    const up = ease.inOutQuint(prog(t, 22.95, 23.4))
    const out = ease.inExpo(prog(t, 28.15, 28.35))
    const enter = ease.outExpo(prog(t, 22.95, 23.8))
    placeWindow(win, { w: 1312, h: 820, cy: 632, y: 940 * (1 - enter) - 700 * out, z: lerp(-400, 0, enter), rx: lerp(40, 9, enter), ry: lerp(-14, 5, prog(t, 23, 28.2)), s: lerp(0.8, 1, enter), o: enter, blur: 20 * out })
    show(win, 'dictate', clipTime(CLIP_MAPS.dictate, t))
    const chipRect = rects.listening ?? [860, 1201, 453, 48]
    look(win, mix(full(win), focus(win, [chipRect[0] - 70, chipRect[1] - 250, 1180, 400], 0.97), ease.inOutQuint(prog(t, 23.6, 24.4))))
    glow(win, rects.text ?? [844, 1196, 1360, 65], t >= textAt ? Math.exp(-(t - textAt) * 2.4) * 0.85 : 0)
    const level = window.voiceLevel ?? (() => 0)
    const listening = prog(t, 23.0, 23.2) * (1 - prog(t, 27.05, 27.2))
    bars.forEach((bar, index) => {
      const v = level(t - (bars.length - index) * 0.014)
      bar.style.height = `${8 + 62 * v * listening}px`
      bar.style.opacity = String(0.4 + 0.6 * v)
    })
    mic.at(t >= 23.0 ? t - 23.0 : null, { loop: true })
    meter.style.display = ''
    badge.style.display = ''
    meter.style.opacity = String(listening * (1 - out))
    meter.style.transform = `translate(-50%, -50%) scale(${lerp(0.7, 1, ease.outBack(prog(t, 23.0, 23.35)))})`
    const badgeIn = stomp(t, textAt + 0.05, { from: 1.4, dur: 0.14, blur: 10, tilt: 0 })
    badge.style.opacity = String(badgeIn.o * (1 - out))
    badge.style.transform = `translate(-50%, -50%) scale(${badgeIn.s})`
    pose(title, { y: lerp(0, -300, up) - 600 * out, s: lerp(1, 0.42, up), o: 1 - out })
  }
})

// ------------------------------------------------ 7. local by default

scene('privacy', layer => {
  const head = el(`<div style="position:absolute;inset:0;transform-origin:50% 26%;perspective:1400px"></div>`, layer)
  const padlock = lottiePlayer(head, LOTTIE.lock(), { size: 300, className: 'stage-lottie' })
  padlock.node.style.left = '810px'
  padlock.node.style.top = '40px'
  const local = el(`<div class="center display" style="top:330px;font-size:250px;font-weight:900">Local</div>`, head)
  const byDefault = el(`<div class="center serif" style="top:560px;font-size:176px;color:var(--mint)">by default.</div>`, head)
  const list = el(`<div class="checklist"></div>`, layer)
  const items = [
    'Your notes stay on your computer.',
    'Suggestions, search and dictation run on-device.',
    'Cloud models only when you choose them.',
  ].map(text => {
    const row = el(`<div class="check"></div>`, list)
    const tick = lottiePlayer(row, LOTTIE.check(), { size: 64, className: 'check-lottie' })
    el(`<span>${text}</span>`, row)
    return { row, tick }
  })
  const offline = el(
    `<div class="pill" style="position:absolute;left:960px;top:948px;transform:translate(-50%,-50%);white-space:nowrap"><svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="#a6e3b8" stroke-width="3.4" stroke-linecap="round"><path d="M6 18a27 27 0 0 1 36 0M12 25a18 18 0 0 1 24 0M18 32a9 9 0 0 1 12 0"/><circle cx="24" cy="39" r="2" fill="#a6e3b8"/><path d="M8 8l32 32" stroke="#f4f3ef"/></svg><span>Works offline, too.</span></div>`,
    layer
  )

  return t => {
    padlock.at(t >= b(47) - 0.1 ? t - (b(47) - 0.1) : null)
    pose(padlock.node, { o: prog(t, b(47) - 0.1, b(47) + 0.1), s: lerp(0.8, 1, ease.outBack(prog(t, b(47) - 0.1, b(47) + 0.3))) })
    pose(local, stomp(t, b(47), { from: 2.6 }))
    extrude(local, t, b(47), { depth: 11, fringe: 16 })
    pose(byDefault, stomp(t, b(48), { from: 1.8, dur: 0.15, tilt: 24 }))
    const up = ease.inOutQuint(prog(t, 29.0, 29.45))
    pose(head, { y: lerp(0, -170, up), s: lerp(1, 0.46, up) })
    items.forEach(({ row, tick }, index) => {
      const at = CHECKS[index]
      const k = ease.outExpo(prog(t, at - 0.05, at + 0.4))
      pose(row, { x: 70 * (1 - k), o: k, blur: 8 * (1 - k), ry: -18 * (1 - k) })
      tick.at(t >= at - 0.05 ? t - (at - 0.05) : null)
    })
    const pill = stomp(t, b(52), { from: 1.5, dur: 0.13, blur: 10, tilt: 0 })
    offline.style.opacity = String(pill.o)
    offline.style.transform = `translate(-50%, -50%) scale(${pill.s})`
    const out = ease.inExpo(prog(t, 31.65, 31.95))
    pose(layer, { s: 1 + 0.8 * out, o: 1 - out, blur: 22 * out })
  }
})

// ------------------------------------------------ 8. the rest, on the beat

scene('montage', layer => {
  const stage = el(`<div style="position:absolute;inset:0;perspective:2400px;transform-style:preserve-3d"></div>`, layer)
  const win = makeWindow(stage)
  el(`<div class="lower-third"></div>`, win.root.querySelector('.screen'))
  const label = el(`<div class="label"></div>`, overlay)
  const spark = lottiePlayer(overlay, LOTTIE.sparkle(), { size: 300, className: 'stage-lottie' })
  const grow = ([x, y, w, h], dx, dy, dw, dh) => [x - dx, y - dy, w + dw, h + dh]
  const focusRects = {
    novel: clips.novel.rects.typed ? grow(clips.novel.rects.typed, 80, 140, 160, 300) : [760, 380, 1520, 420],
    table: clips.table.rects.rendered ? grow(clips.table.rects.rendered, 200, 300, 700, 420) : [640, 900, 1300, 640],
    links: [900, 940, 1100, 560],
    graph: [780, 470, 1000, 640],
    palette: clips.palette.rects.open ? grow(clips.palette.rects.open, 140, 60, 280, 120) : [580, 230, 1400, 1160],
    zen: [300, 200, 1960, 1100],
    dark: [0, 0, 2560, 1600],
  }
  const novelAccept = b(54)

  return t => {
    let cut = MONTAGE[0]
    for (const item of MONTAGE) if (t >= item.at) cut = item
    const local = t - cut.at
    const k = ease.outExpo(clamp(local / 0.2))
    const out = ease.inExpo(prog(t, 38.35, 38.55))
    // Each cut swings in on its own axis, like cards in space.
    const index = MONTAGE.indexOf(cut)
    const swing = (index % 2 ? 1 : -1) * 16
    placeWindow(win, { w: 1600, h: 1000, cy: 528, z: lerp(-260, 0, k), ry: swing * (1 - k) + (index % 2 ? -3 : 3), rx: 5, s: 1 + 0.5 * out, blur: 14 * (1 - k) + 20 * out, o: 1 - out })
    show(win, cut.clip, cut.from + local)
    const view = focus(win, focusRects[cut.focus] ?? [0, 0, 2560, 1600], 0.98)
    look(win, { ...view, s: view.s * (1 + 0.04 * local) })
    glow(win, [0, 0, 0, 0], 0)
    if (label.dataset.text !== cut.label) {
      label.dataset.text = cut.label
      label.textContent = cut.label
    }
    label.style.display = ''
    const l = stomp(t, cut.at, { from: 1.9, dur: 0.14, blur: 14, tilt: 30 })
    pose(label, { ...l, o: l.o * (1 - out) })
    extrude(label, t, cut.at, { depth: 7, fringe: 10 })
    if (cut.clip === 'novel') {
      spark.node.style.left = '1050px'
      spark.node.style.top = '300px'
    }
    spark.at(cut.clip === 'novel' && t >= novelAccept ? t - novelAccept : null)
  }
})

// ------------------------------------------------ 9. light, fast, yours

scene('claims', layer => {
  const row = el(`<div class="center" style="top:350px;display:flex;justify-content:center;gap:58px;align-items:baseline;perspective:1400px"></div>`, layer)
  const words = [
    el(`<span class="display" style="font-size:206px;font-weight:900;display:inline-block">Light.</span>`, row),
    el(`<span class="display" style="font-size:206px;font-weight:900;display:inline-block">Fast.</span>`, row),
    el(`<span class="serif" style="font-size:236px;color:var(--mint);display:inline-block">Yours.</span>`, row),
  ]
  const sub = el(`<div class="center" style="top:640px;font-size:42px;font-weight:500;color:var(--dim);letter-spacing:-0.01em"></div>`, layer)
  const subChars = splitChars(sub, 'Under 20 MB  ·  Free and open source  ·  macOS and Windows')

  return t => {
    words.forEach((word, index) => {
      pose(word, stomp(t, b(64 + index), { from: 2.4 }))
      if (index < 2) extrude(word, t, b(64 + index), { depth: 10, fringe: 12 })
    })
    rise(subChars, t, 40.2, { step: 0.01, dur: 0.4, dy: 16, blur: 6 })
    const out = ease.inExpo(prog(t, 41.1, 41.4))
    pose(layer, { s: 1 + 1.1 * out, o: 1 - out, blur: 26 * out })
  }
})

// ------------------------------------------------ 10. the mark (3D, in three-scenes.js)

scene('logo', layer => {
  const word = el(`<div class="wordmark"></div>`, layer)
  const wordChars = splitChars(word, 'TypeNext')
  const tagline = el(
    `<div class="center" style="top:730px;font-size:66px;font-weight:600;letter-spacing:-0.035em">You write. <span class="serif" style="font-size:78px;color:var(--mint);letter-spacing:-0.01em">AI suggests.</span></div>`,
    layer
  )
  const url = el(`<div class="center mono" style="top:880px;font-size:30px;color:var(--dim)">github.com/alshell7/typenext</div>`, layer)
  const slam = LOGO_CUE.slam

  return t => {
    const right = mark3d?.right ?? 820
    word.style.left = `${right + 70}px`
    wordChars.forEach((span, index) => {
      const k = ease.outExpo(prog(t, slam + 0.55 + index * 0.04, slam + 1.0 + index * 0.04))
      pose(span, { x: 40 * (1 - k), o: k, blur: 12 * (1 - k), ry: -40 * (1 - k) })
    })
    const tag = ease.outExpo(prog(t, slam + 1.3, slam + 1.9))
    pose(tagline, { y: 30 * (1 - tag), o: tag, blur: 8 * (1 - tag) })
    const u = ease.outExpo(prog(t, slam + 1.85, slam + 2.3))
    pose(url, { y: 16 * (1 - u), o: u })
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
    if (x < 0 || x > 0.7) continue
    const amp = 15 * power * Math.exp(-x * 13)
    dx += amp * Math.sin(x * 91 + at * 13)
    dy += amp * Math.cos(x * 77 + at * 7)
    punch += 0.032 * power * Math.exp(-x * 10)
    light += (power >= 0.9 ? 0.15 : 0.06) * power * Math.exp(-x * 22)
  }
  world.style.transform = `translate(${dx}px, ${dy}px) scale(${1 + punch})`
  flash.style.opacity = String(clamp(light, 0, 0.45))
  return { x: dx * 0.004, y: -dy * 0.004 }
}

const mediaCue = { range: SCENES.media, beats: [29, 30, 31, 32, 33].map(b), gather: b(34), hit: b(35) }
const markCue = { range: SCENES.logo, bar: LOGO_CUE.bar, slam: LOGO_CUE.slam }

window.renderAt = async t => {
  for (const item of scenes) {
    const visible = t >= item.start && t < item.end
    item.layer.style.display = visible ? 'block' : 'none'
  }
  for (const node of overlay.children) node.style.display = 'none'
  const shake = camera(t)
  const info = stage3d.render(t, { shake, mediaCue, markCue })
  mark3d = info.mark
  for (const item of scenes) if (t >= item.start && t < item.end) item.render(t)
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
  stage3d = createStage3D(document.getElementById('gl'), WIDTH, HEIGHT)
  buildScenes()
  const at = Number(new URLSearchParams(location.search).get('t') ?? 0)
  await window.renderAt(at)
  window.filmReady = true
}

await start()
