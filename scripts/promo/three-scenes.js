// The 3D layer of the film: a background of drifting light and dust for the
// whole film, the knowledge core with orbiting source tiles, and the
// extruded TypeNext mark. Everything is a pure function of time.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const lerp = (a, b, k) => a + (b - a) * k
const prog = (t, a, b) => clamp((t - a) / (b - a))
const outExpo = x => (x >= 1 ? 1 : 1 - 2 ** (-10 * x))
const inExpo = x => (x <= 0 ? 0 : 2 ** (10 * x - 10))
const inOutCubic = x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2)
const outBack = x => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2

/** Seeded random numbers, so every render matches. */
function random(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function softDot(size = 64) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = gradient
  g.fillRect(0, 0, size, size)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// ------------------------------------------------------------------ icons

const ICON_PATHS = {
  doc: ['M13 5h15l9 9v29H13z', 'M28 5v9h9M19 24h12M19 31h12M19 38h8'],
  pdf: ['M13 5h15l9 9v29H13z', 'M28 5v9h9'],
  image: ['M8 11h32a2 2 0 0 1 2 2v22a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V13a2 2 0 0 1 2-2z', 'M8 35l11-11 8 8 5-5 9 9'],
  audio: ['M8 20v8M15 14v20M22 8v32M29 16v16M36 11v26M43 21v6'],
  video: ['M10 10h28a5 5 0 0 1 5 5v18a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V15a5 5 0 0 1 5-5z', 'M20 18l10 6-10 6z'],
}

function iconTexture(name) {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  // Frosted glass face with a soft top light.
  const face = g.createLinearGradient(0, 0, 0, size)
  face.addColorStop(0, '#2b3a31')
  face.addColorStop(1, '#121a15')
  g.fillStyle = face
  g.fillRect(0, 0, size, size)
  const shine = g.createRadialGradient(size * 0.3, size * 0.1, 10, size * 0.3, size * 0.1, size * 0.9)
  shine.addColorStop(0, 'rgba(255,255,255,0.22)')
  shine.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = shine
  g.fillRect(0, 0, size, size)
  g.save()
  g.translate(size * 0.2, size * 0.2)
  g.scale((size * 0.6) / 48, (size * 0.6) / 48)
  g.strokeStyle = '#f4f3ef'
  g.lineWidth = 2.6
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const d of ICON_PATHS[name]) g.stroke(new Path2D(d))
  if (name === 'pdf') {
    g.fillStyle = '#a6e3b8'
    g.font = '700 10px Inter Tight, sans-serif'
    g.textAlign = 'center'
    g.fillText('PDF', 25, 35)
  }
  g.restore()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

function roundedRect(w, h, r) {
  const shape = new THREE.Shape()
  const x = -w / 2, y = -h / 2
  shape.moveTo(x + r, y)
  shape.lineTo(x + w - r, y)
  shape.quadraticCurveTo(x + w, y, x + w, y + r)
  shape.lineTo(x + w, y + h - r)
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  shape.lineTo(x + r, y + h)
  shape.quadraticCurveTo(x, y + h, x, y + h - r)
  shape.lineTo(x, y + r)
  shape.quadraticCurveTo(x, y, x + r, y)
  return shape
}

// ------------------------------------------------------------------ stage

export function createStage3D(canvas, width, height) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#050706')
  scene.fog = new THREE.FogExp2('#050706', 0.035)
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 200)
  camera.position.set(0, 0, 12)

  const composer = new EffectComposer(renderer)
  composer.setSize(width, height)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.55, 0.6, 0.78)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  // --------------------------------------------------------- background
  const dot = softDot()
  const nebula = new THREE.Group()
  scene.add(nebula)
  const glows = [
    { color: '#2c5b3d', x: -9, y: 4, z: -40, s: 46 },
    { color: '#1b3a4e', x: 11, y: -6, z: -46, s: 52 },
    { color: '#24432f', x: 4, y: 8, z: -55, s: 40 },
  ].map(item => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: dot, color: item.color, transparent: true, opacity: 0.55, depthWrite: false, fog: false }))
    sprite.position.set(item.x, item.y, item.z)
    sprite.scale.setScalar(item.s)
    nebula.add(sprite)
    return { sprite, item }
  })

  const rand = random(7)
  const count = 1400
  const positions = new Float32Array(count * 3)
  const seeds = []
  for (let i = 0; i < count; i++) {
    seeds.push({ x: (rand() - 0.5) * 40, y: (rand() - 0.5) * 24, z: -rand() * 36 + 4, speed: 0.08 + rand() * 0.25, phase: rand() * Math.PI * 2 })
  }
  const dustGeometry = new THREE.BufferGeometry()
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const dust = new THREE.Points(
    dustGeometry,
    new THREE.PointsMaterial({ map: dot, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0.55, depthWrite: false, color: '#cfe8d6', blending: THREE.AdditiveBlending })
  )
  scene.add(dust)

  // --------------------------------------------------------- knowledge core
  const media = new THREE.Group()
  scene.add(media)
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.05, 8),
    new THREE.MeshPhysicalMaterial({ color: '#1d3b2a', metalness: 0.05, roughness: 0.22, transmission: 0.6, thickness: 1.4, ior: 1.45, clearcoat: 1, clearcoatRoughness: 0.35, envMapIntensity: 0.45, emissive: '#3f8a5c', emissiveIntensity: 0.3, iridescence: 0.4, iridescenceIOR: 1.3 })
  )
  const heart = new THREE.Mesh(new THREE.SphereGeometry(0.42, 48, 48), new THREE.MeshBasicMaterial({ color: '#c8f5d6' }))
  const ringMaterial = new THREE.MeshBasicMaterial({ color: '#a6e3b8', transparent: true, opacity: 0.55 })
  const rings = [1.55, 1.85, 2.2].map((radius, index) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.006 + index * 0.002, 8, 220), ringMaterial)
    media.add(ring)
    return ring
  })
  const shock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.02, 8, 200), new THREE.MeshBasicMaterial({ color: '#d9ffe6', transparent: true, opacity: 0 }))
  const coreLight = new THREE.PointLight('#8fe0ac', 0, 18, 1.6)
  media.add(core, heart, shock, coreLight)
  const tileShape = roundedRect(1.05, 1.05, 0.22)
  const tileGeometry = new THREE.ExtrudeGeometry(tileShape, { depth: 0.09, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 4, curveSegments: 12 })
  tileGeometry.center()
  const sideMaterial = new THREE.MeshPhysicalMaterial({ color: '#203327', metalness: 0.4, roughness: 0.25, clearcoat: 1 })
  const tiles = ['doc', 'pdf', 'image', 'audio', 'video'].map(name => {
    const texture = iconTexture(name)
    texture.repeat.set(1 / 1.05, 1 / 1.05)
    texture.offset.set(0.5, 0.5)
    const face = new THREE.MeshPhysicalMaterial({ map: texture, roughness: 0.35, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.15, emissive: '#ffffff', emissiveMap: texture, emissiveIntensity: 0.18 })
    const mesh = new THREE.Mesh(tileGeometry, [face, sideMaterial])
    media.add(mesh)
    return mesh
  })
  const key = new THREE.DirectionalLight('#ffffff', 1.6)
  key.position.set(4, 6, 8)
  const rim = new THREE.DirectionalLight('#7fd6a0', 1.4)
  rim.position.set(-6, -2, -4)
  media.add(key, rim)

  // --------------------------------------------------------- the mark
  const mark = new THREE.Group()
  scene.add(mark)
  // Geometry of public/brand/logo-master.png (1254 px canvas), in units.
  const unit = 2.6 / 459
  const toShape = points => {
    const shape = new THREE.Shape()
    points.forEach(([x, y], index) => {
      const px = (x - 630.5) * unit, py = -(y - 625.5) * unit
      if (index) shape.lineTo(px, py)
      else shape.moveTo(px, py)
    })
    return shape
  }
  const extrude = { depth: 0.42, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.035, bevelSegments: 6, curveSegments: 4 }
  const ceramic = new THREE.MeshPhysicalMaterial({ color: '#e9e8e2', metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 0.9, emissive: '#ffffff', emissiveIntensity: 0 })
  const barGeometry = new THREE.ExtrudeGeometry(toShape([[428, 396], [509, 396], [509, 855], [428, 855]]), extrude)
  const chevronGeometry = new THREE.ExtrudeGeometry(
    toShape([[591, 396], [833, 590], [833, 662], [591, 855], [591, 766], [764, 626], [591, 485]]),
    extrude
  )
  const bar = new THREE.Mesh(barGeometry, ceramic)
  const chevron = new THREE.Mesh(chevronGeometry, ceramic)
  const markInner = new THREE.Group()
  markInner.add(bar, chevron)
  markInner.position.z = -0.21
  mark.add(markInner)
  // A faded mirror image for a quiet floor reflection.
  const mirror = markInner.clone()
  const fade = (() => {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 256
    const g = canvas.getContext('2d')
    const gradient = g.createLinearGradient(0, 0, 0, 256)
    gradient.addColorStop(0, '#000')
    gradient.addColorStop(0.55, '#000')
    gradient.addColorStop(1, '#fff')
    g.fillStyle = gradient
    g.fillRect(0, 0, 4, 256)
    const texture = new THREE.CanvasTexture(canvas)
    texture.repeat.set(1 / 2.7, 1 / 2.7)
    texture.offset.set(0.5, 0.5)
    return texture
  })()
  mirror.traverse(child => {
    if (child.isMesh) child.material = new THREE.MeshBasicMaterial({ color: '#9aa39d', transparent: true, opacity: 0.14, alphaMap: fade, depthWrite: false })
  })
  mirror.scale.y = -1
  mirror.position.y = -2.95
  mark.add(mirror)
  const markKey = new THREE.SpotLight('#ffffff', 22, 30, 0.55, 0.6)
  markKey.position.set(4, 6, 8)
  const markFill = new THREE.DirectionalLight('#cfe0ff', 0.6)
  markFill.position.set(-5, 2, 6)
  mark.add(markFill)
  const markRim = new THREE.PointLight('#a6e3b8', 0, 20, 1.5)
  markRim.position.set(-3, 1, -2)
  mark.add(markKey, markRim)
  const markShock = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 220), new THREE.MeshBasicMaterial({ color: '#f4f3ef', transparent: true, opacity: 0 }))
  mark.add(markShock)

  const projected = new THREE.Vector3()
  /** Screen x of the mark's right edge, for placing the word mark. */
  function markRightEdge() {
    const box = new THREE.Box3().setFromObject(markInner)
    projected.set(box.max.x, 0, box.max.z).project(camera)
    return ((projected.x + 1) / 2) * width
  }

  function background(t, shake) {
    for (const { sprite, item } of glows) {
      sprite.position.x = item.x + Math.sin(t * 0.12 + item.z) * 2.5
      sprite.position.y = item.y + Math.cos(t * 0.09 + item.x) * 1.8
    }
    for (let i = 0; i < count; i++) {
      const seed = seeds[i]
      positions[i * 3] = seed.x + Math.sin(t * 0.15 + seed.phase) * 0.6 + t * seed.speed * 0.25
      positions[i * 3 + 1] = seed.y + Math.cos(t * 0.11 + seed.phase) * 0.4 + t * seed.speed * 0.12
      positions[i * 3 + 2] = seed.z
    }
    dustGeometry.attributes.position.needsUpdate = true
    camera.position.set(Math.sin(t * 0.07) * 0.35 + shake.x, Math.cos(t * 0.05) * 0.2 + shake.y, 12)
    camera.lookAt(0, 0, -6)
  }

  /** The knowledge core: tiles arrive on the beats, then fall into it. */
  function renderMedia(t, cue) {
    const [start, end] = cue.range
    const on = t >= start - 0.05 && t < end
    media.visible = on
    if (!on) return
    const gather = inExpo(prog(t, cue.gather, cue.gather + 0.6))
    const hit = t - cue.hit
    const flash = hit >= 0 ? Math.exp(-hit * 4) : 0
    const appear = outExpo(prog(t, start, start + 0.6))
    const leave = inExpo(prog(t, end - 0.35, end))
    media.position.set(0, 0.15, lerp(-6, 0, appear) - 4 * leave)
    media.rotation.set(0.18 + Math.sin(t * 0.3) * 0.05, t * 0.18, 0)
    const pulse = 1 + 0.04 * Math.sin(t * 3.4) + 0.35 * flash
    core.scale.setScalar(lerp(0.4, 1, appear) * pulse * (1 + 0.25 * gather))
    core.rotation.y = t * 0.5
    heart.scale.setScalar(0.7 + 0.4 * gather + 1.6 * flash)
    heart.material.color.setRGB(0.78 + flash * 0.2, 0.96, 0.84 + flash * 0.1)
    coreLight.intensity = 6 + 40 * gather + 90 * flash
    rings.forEach((ring, index) => {
      ring.rotation.set(Math.PI / 2 + 0.35 * Math.sin(t * 0.6 + index), t * (0.4 + index * 0.25), index * 0.9)
      ring.scale.setScalar(1 - 0.5 * gather + 0.3 * flash)
      ring.material.opacity = 0.5 * appear
    })
    shock.material.opacity = hit >= 0 ? Math.max(0, 0.9 - hit * 1.2) : 0
    shock.scale.setScalar(1 + Math.max(0, hit) * 9)
    shock.rotation.set(Math.PI / 2 - 0.25, 0, 0)
    tiles.forEach((tile, index) => {
      const arrive = outExpo(prog(t, cue.beats[index], cue.beats[index] + 0.7))
      const angle = -t * 0.55 + (index / tiles.length) * Math.PI * 2
      const radius = lerp(9, 3.1, arrive) * (1 - gather)
      const spiral = gather * 3.5
      tile.position.set(
        Math.cos(angle + spiral) * radius,
        Math.sin(angle * 1.3 + index) * 0.55 * (1 - gather) + lerp(3, 0, arrive),
        Math.sin(angle + spiral) * radius * 0.55
      )
      tile.rotation.set(Math.sin(t + index) * 0.25, -media.rotation.y + Math.sin(t * 0.7 + index) * 0.4, Math.sin(t * 0.5 + index) * 0.12)
      tile.scale.setScalar(Math.max(0.0001, arrive * (1 - 0.85 * gather)))
      tile.visible = arrive > 0.001 && gather < 0.999
    })
  }

  /** The mark: the cursor bar, then the chevron slams in, in 3D. */
  function renderMark(t, cue) {
    const on = t >= cue.range[0]
    mark.visible = on
    if (!on) return null
    const enter = outExpo(prog(t, cue.bar, cue.bar + 0.5))
    const blink = t < cue.slam ? (t < cue.bar + 0.28 || (t >= cue.bar + 0.4 && t < cue.bar + 0.52) || t >= cue.bar + 0.58 ? 1 : 0.04) : 1
    bar.scale.set(1, 1, Math.max(0.0001, enter))
    ceramic.emissiveIntensity = t < cue.slam ? 0.12 * blink : 0.12 * Math.exp(-(t - cue.slam) * 4)
    bar.visible = blink > 0.5
    const slam = clamp((t - cue.slam) / 0.16)
    const k = slam <= 0 ? 0 : 1 - (1 - slam) ** 4
    chevron.visible = t >= cue.slam - 0.02
    chevron.position.set(lerp(4.2, 0, k), 0, lerp(3.5, 0, k))
    chevron.rotation.set(0, lerp(-1.2, 0, k), lerp(0.4, 0, k))
    const hit = t - cue.slam
    const settle = hit > 0.16 ? 0.05 * Math.exp(-(hit - 0.16) * 9) * Math.sin((hit - 0.16) * 40) : 0
    const slide = inOutCubic(prog(t, cue.slam + 0.25, cue.slam + 0.95))
    const turn = outBack(prog(t, cue.bar, cue.slam + 0.95))
    mark.position.set(lerp(0, -2.2, slide), 0.3, 0.6)
    mark.rotation.set(lerp(0.32, 0.04, turn), lerp(-0.55, 0.12, turn) + 0.04 * Math.sin(t * 0.6), 0)
    mark.scale.setScalar(1 + settle)
    // The reflection follows the live pieces.
    markInner.children.forEach((piece, index) => {
      const echo = mirror.children[index]
      echo.position.copy(piece.position)
      echo.rotation.copy(piece.rotation)
      echo.scale.copy(piece.scale)
      echo.visible = piece.visible
    })
    markRim.intensity = hit > 0 ? 6 + 30 * Math.exp(-hit * 2.5) : 3
    markShock.material.opacity = hit >= 0 ? Math.max(0, 0.45 - hit * 0.7) : 0
    markShock.scale.setScalar(1.2 + Math.max(0, hit) * 10)
    return { right: markRightEdge() }
  }

  return {
    /** Render the 3D layer at time t. Returns layout hints for the DOM. */
    render(t, { shake = { x: 0, y: 0 }, mediaCue, markCue }) {
      background(t, shake)
      renderMedia(t, mediaCue)
      const markInfo = renderMark(t, markCue)
      bloom.strength = mark.visible ? 0.32 : 0.5 + (media.visible ? 0.35 : 0)
      bloom.threshold = mark.visible ? 0.9 : 0.78
      composer.render()
      return { mark: markInfo }
    },
  }
}
