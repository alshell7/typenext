// One timeline for the picture (film.js) and the sound (soundtrack.mjs).
// Times are in seconds. The music runs at 120 BPM, so a beat is 0.5 s and
// every stomp sits on a beat.
export const FPS = 60
export const DURATION = 30
export const WIDTH = 1920
export const HEIGHT = 1080
export const BEAT = 0.5

/** The hook line types itself one character at a time. */
export const HOOK = { text: 'Most AI writes for you.', start: 0.55, step: 0.046 }
export const hookKeys = () => [...HOOK.text].map((_, index) => HOOK.start + index * HOOK.step)

export const SCENES = {
  hook: [0, 3.05],
  tab: [3.0, 5.6],
  write: [5.3, 9.1],
  source: [9.0, 11.1],
  media: [11.0, 14.1],
  dictate: [14.0, 17.95],
  privacy: [17.75, 20.6],
  montage: [20.5, 24.6],
  claims: [24.5, 26.8],
  logo: [26.75, 30],
}

/** Real app scenes in the montage, one or two beats each. */
export const MONTAGE = [
  { clip: 'novel', at: 20.5, length: 1.0, from: 8.6, label: 'Novels.', focus: 'typed' },
  { clip: 'table', at: 21.5, length: 0.5, from: 4.15, label: 'Tables.', focus: 'rendered' },
  { clip: 'links', at: 22.0, length: 0.5, from: 3.75, label: 'Links.', focus: 'card' },
  { clip: 'graph', at: 22.5, length: 0.5, from: 1.2, label: 'Graph.', focus: 'graph' },
  { clip: 'palette', at: 23.0, length: 0.5, from: 1.7, label: '⌘ P', focus: 'open' },
  { clip: 'zen', at: 23.5, length: 0.5, from: 3.0, label: 'Zen.', focus: 'zen' },
  { clip: 'dark', at: 24.0, length: 0.5, from: 1.4, label: 'Dark.', focus: 'dark' },
]

export const STOMPS = [
  { t: 2.0, power: 1 },
  { t: 2.5, power: 0.7 },
  { t: 3.0, power: 0.9 },
  { t: 11.0, power: 0.75 },
  { t: 11.5, power: 0.75 },
  { t: 12.0, power: 0.75 },
  { t: 12.5, power: 0.75 },
  { t: 13.0, power: 0.85 },
  { t: 14.0, power: 1 },
  { t: 14.5, power: 0.6 },
  { t: 18.0, power: 1 },
  { t: 18.5, power: 0.7 },
  { t: 24.5, power: 0.9 },
  { t: 25.0, power: 0.9 },
  { t: 25.5, power: 1 },
  { t: 27.5, power: 1.4 },
]

/** Fast camera moves and cuts. */
export const WHOOSHES = [2.88, 5.25, 8.95, 10.95, 13.45, 17.85, 20.42, 26.6]
/** The Tab key: on the title card and when the real app accepts. */
export const TABS = [4.0, 8.81, 10.76, 20.82]
/** Checklist ticks and montage cuts. */
export const TICKS = [19.0, 19.33, 19.66, 20.0, ...MONTAGE.map(cut => cut.at)]
/** The dictated sentence plays while Whistle listens. */
export const VOICE = { file: 'artifacts/promo/fixtures/dictation.wav', at: 14.35, tempo: 1.15, gain: 0.9 }
export const RISER = [25.6, 27.5]

/**
 * Film time to clip time for the real app scenes: [film, clip] pairs,
 * linear between them. Waiting is shortened; the moments that matter
 * (a suggestion, Tab, the source) play at real speed.
 */
export const CLIP_MAPS = {
  write: [[5.3, 4.6], [6.607, 6.56], [7.187, 8.88], [9.31, 11.0]],
  source: [[9.0, 12.3], [9.536, 12.836], [10.761, 14.551], [11.2, 14.99]],
  dictate: [[14.3, 0.3], [17.3, 4.5], [17.9, 5.6], [18.0, 5.7]],
}
