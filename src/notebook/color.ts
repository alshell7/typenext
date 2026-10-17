/** Colour conversions for the colour picker. Hex is #rrggbb, lower case. */

export interface Hsv {
  /** 0–360 */
  h: number
  /** 0–1 */
  s: number
  /** 0–1 */
  v: number
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([\da-f]{6})$/iu.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

export function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map(part =>
      Math.round(Math.min(255, Math.max(0, part)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const [red, green, blue] = rgb.map(part => part / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0
  if (delta) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return { h: hue, s: max ? delta / max : 0, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360
  const chroma = v * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = v - chroma
  const [red, green, blue] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return rgbToHex((red + m) * 255, (green + m) * 255, (blue + m) * 255)
}

/** Accepts #abc, abc, #aabbcc and aabbcc. */
export function normalizeHex(value: string): string | null {
  const text = value.trim().replace(/^#/u, '')
  if (/^[\da-f]{3}$/iu.test(text))
    return `#${[...text].map(part => part + part).join('')}`.toLowerCase()
  if (/^[\da-f]{6}$/iu.test(text)) return `#${text}`.toLowerCase()
  return null
}
