import type { AiIndicatorStyle } from '../../types/notebook'

/**
 * A small animation that says "a model is working" without words. Each style
 * is plain DOM with CSS animation (ai-pulse.css), so the editor widget and
 * React components share one look. It fades in after a short delay, so a
 * fast answer never flickers.
 */

export interface PulseStyle {
  id: Exclude<AiIndicatorStyle, 'off'>
  name: string
  description: string
}

export const PULSE_STYLES: readonly PulseStyle[] = [
  {
    id: 'orb',
    name: 'Orb',
    description: 'A swirl of colour breathes inside a glass sphere',
  },
  {
    id: 'spark',
    name: 'Spark',
    description: 'A four-point star twinkles through blue, violet and rose',
  },
  {
    id: 'bloom',
    name: 'Bloom',
    description: 'Three soft lights circle and melt together',
  },
  {
    id: 'firefly',
    name: 'Firefly',
    description: 'A glowing point drifts in a figure eight',
  },
  { id: 'ink', name: 'Ink', description: 'A drop blooms into soft rings' },
  { id: 'scribble', name: 'Scribble', description: 'A pen draws a quick loop' },
  { id: 'orbit', name: 'Orbit', description: 'Two moons circle each other' },
  { id: 'dots', name: 'Dots', description: 'Three dots breathe in a wave' },
]

const SVG = 'http://www.w3.org/2000/svg'
let gradients = 0

function part(className: string) {
  const element = document.createElement('span')
  element.className = className
  return element
}

export function pulseElement(style: AiIndicatorStyle): HTMLElement {
  const root = document.createElement('span')
  root.className = `ai-pulse is-${style}`
  root.setAttribute('aria-hidden', 'true')
  if (style === 'orb') {
    root.append(part('ai-pulse-orb-glow'), part('ai-pulse-orb'))
  } else if (style === 'spark') {
    // A gradient needs a document-unique id.
    const id = `ai-spark-${++gradients}`
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    const defs = document.createElementNS(SVG, 'defs')
    const gradient = document.createElementNS(SVG, 'linearGradient')
    gradient.setAttribute('id', id)
    gradient.setAttribute('x1', '0')
    gradient.setAttribute('y1', '0')
    gradient.setAttribute('x2', '1')
    gradient.setAttribute('y2', '1')
    for (const [offset, color] of [
      ['0', '#4f8dff'],
      ['0.5', '#9b6bff'],
      ['1', '#ff6fae'],
    ]) {
      const stop = document.createElementNS(SVG, 'stop')
      stop.setAttribute('offset', offset!)
      stop.setAttribute('stop-color', color!)
      gradient.append(stop)
    }
    defs.append(gradient)
    const star = document.createElementNS(SVG, 'path')
    // Four curved points, as in a sparkle.
    star.setAttribute(
      'd',
      'M12 1.5 C 12.9 7.6, 16.4 11.1, 22.5 12 C 16.4 12.9, 12.9 16.4, 12 22.5 C 11.1 16.4, 7.6 12.9, 1.5 12 C 7.6 11.1, 11.1 7.6, 12 1.5 Z'
    )
    star.setAttribute('fill', `url(#${id})`)
    star.setAttribute('class', 'ai-pulse-star')
    const small = star.cloneNode() as SVGPathElement
    small.setAttribute('class', 'ai-pulse-star-small')
    svg.append(defs, star, small)
    root.append(svg)
  } else if (style === 'bloom') {
    for (let index = 0; index < 3; index++)
      root.append(part(`ai-pulse-light ai-pulse-light-${index}`))
  } else if (style === 'firefly')
    for (let index = 0; index < 4; index++)
      root.append(part(`ai-pulse-dot ai-pulse-dot-${index}`))
  else if (style === 'ink') {
    root.append(part('ai-pulse-ring'), part('ai-pulse-ring ai-pulse-ring-late'))
    root.append(part('ai-pulse-drop'))
  } else if (style === 'orbit') {
    const spin = part('ai-pulse-spin')
    spin.append(
      part('ai-pulse-moon'),
      part('ai-pulse-moon ai-pulse-moon-small')
    )
    root.append(part('ai-pulse-core'), spin)
  } else if (style === 'dots')
    for (let index = 0; index < 3; index++) root.append(part('ai-pulse-bead'))
  else if (style === 'scribble') {
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 30 14')
    svg.setAttribute('width', '30')
    svg.setAttribute('height', '14')
    const path = document.createElementNS(SVG, 'path')
    // A cursive "e" loop that runs on: the shape of handwriting.
    path.setAttribute(
      'd',
      'M2 10 C 6 10, 9 7, 9 5 C 9 2.5, 6 2.5, 6 5 C 6 8.5, 10 11, 14 9 C 17 7.5, 18 4, 16 3.5 C 14 3, 13.5 7, 16 9.5 C 18.5 12, 23 10, 28 6'
    )
    path.setAttribute('pathLength', '100')
    svg.append(path)
    root.append(svg)
  }
  return root
}
