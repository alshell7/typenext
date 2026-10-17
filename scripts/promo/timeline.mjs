// One timeline for the picture (film.js, three-scenes.js) and the sound
// (soundtrack.mjs). Times are in seconds. The music runs at 100 BPM, so a
// beat is 0.6 s; stomps, cuts and accents sit on beats.
export const FPS = 60
export const DURATION = 45
export const WIDTH = 1920
export const HEIGHT = 1080
export const BPM = 100
export const BEAT = 60 / BPM
/** Beat number to seconds. */
export const b = n => Math.round(n * BEAT * 1000) / 1000

/** The hook line types itself one character at a time. */
export const HOOK = { text: 'Most AI writes for you.', start: 0.9, step: 0.065 }
export const hookKeys = () => [...HOOK.text].map((_, index) => HOOK.start + index * HOOK.step)

export const SCENES = {
  hook: [0, 4.95],
  tab: [4.8, 9.15],
  write: [9.0, 14.55],
  source: [14.4, 17.55],
  media: [17.4, 22.35],
  dictate: [22.2, 28.35],
  privacy: [28.2, 31.95],
  montage: [31.8, 38.55],
  claims: [38.4, 41.45],
  logo: [41.4, 45],
}

/** Real app scenes in the montage: one to three beats each. */
export const MONTAGE = [
  { clip: 'novel', at: b(53), length: b(3), from: 8.59, label: 'Novels.', focus: 'novel' },
  { clip: 'table', at: b(56), length: b(2), from: 3.4, label: 'Tables.', focus: 'table' },
  { clip: 'links', at: b(58), length: b(2), from: 3.3, label: 'Links.', focus: 'links' },
  { clip: 'graph', at: b(60), length: b(1), from: 1.0, label: 'Graph.', focus: 'graph' },
  { clip: 'palette', at: b(61), length: b(1), from: 1.6, label: '⌘ P', focus: 'palette' },
  { clip: 'zen', at: b(62), length: b(1), from: 2.6, label: 'Zen.', focus: 'zen' },
  { clip: 'dark', at: b(63), length: b(1), from: 1.3, label: 'Dark.', focus: 'dark' },
]

export const STOMPS = [
  { t: b(6), power: 1 },
  { t: b(7), power: 0.7 },
  { t: b(8), power: 0.9 },
  ...[29, 30, 31, 32].map(n => ({ t: b(n), power: 0.72 })),
  { t: b(33), power: 0.85 },
  { t: b(35), power: 1.1 },
  { t: b(37), power: 1 },
  { t: b(38), power: 0.6 },
  { t: b(47), power: 1 },
  { t: b(48), power: 0.7 },
  { t: b(64), power: 0.9 },
  { t: b(65), power: 0.9 },
  { t: b(66), power: 1 },
  { t: b(70), power: 1.4 },
]

/** Fast camera moves and cuts. */
export const WHOOSHES = [4.7, 8.95, 14.35, 17.3, 22.1, 28.1, 31.7, 41.3]
/** The Tab key: on the title card and each time the real app accepts. */
export const TABS = [b(11), b(23), b(28), b(54)]
/** Lottie sparkle bursts, at the same moments as the Tab key. */
export const SPARKLES = TABS
/** Checkmarks drawing in, then the offline pill. */
export const CHECKS = [b(49), b(50), b(51)]
export const TICKS = [...CHECKS, b(52), ...MONTAGE.map(cut => cut.at)]
/** The dictated sentence plays, at its natural speed, while Whistle listens. */
export const VOICE = { file: 'artifacts/promo/fixtures/dictation.wav', at: 23.3, tempo: 1, gain: 0.95 }
/** Builds: into the knowledge core, and into the mark. */
export const RISERS = [
  [b(33) + 0.3, b(35)],
  [b(66) + 0.3, b(70)],
]
export const LOGO = { bar: b(69), slam: b(70) }

/**
 * Film time to clip time for the real app scenes: [film, clip] pairs,
 * linear between them. Typing plays near real speed; only the wait for a
 * suggestion is shortened. A suggestion, Tab and the source play at 1×.
 */
export const CLIP_MAPS = {
  write: [[9.0, 3.658], [11.41, 6.55], [12.18, 8.86], [b(23), 10.479], [14.6, 11.28]],
  source: [[14.4, 12.0], [15.159, 12.759], [b(28), 14.471], [17.6, 15.27]],
  dictate: [[22.9, 0.2], [26.6, 3.9], [27.2, 5.2], [28.4, 6.4]],
}
