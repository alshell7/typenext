/**
 * When to offer an automatic suggestion. A writer in full flow should not be
 * interrupted; a writer who pauses at a sentence end, or who just accepted a
 * suggestion, is ready sooner.
 */
export interface TypingRhythm {
  /** Time of the last typed change. */
  lastKeyAt: number
  /** Smoothed time between typed changes, in milliseconds. */
  interval: number
  /** Time of the last accepted suggestion. */
  acceptedAt: number
}

export const MIN_DELAY = 200
export const MAX_DELAY = 5_000

export function newRhythm(): TypingRhythm {
  return { lastKeyAt: 0, interval: 400, acceptedAt: 0 }
}

/** Update the rhythm for one typed change. Long gaps start a new burst. */
export function noteKeystroke(rhythm: TypingRhythm, now: number): TypingRhythm {
  const gap = now - rhythm.lastKeyAt
  const interval =
    rhythm.lastKeyAt && gap < 2_000
      ? rhythm.interval * 0.7 + gap * 0.3
      : rhythm.interval
  return { ...rhythm, lastKeyAt: now, interval }
}

export function noteAccepted(rhythm: TypingRhythm, now: number): TypingRhythm {
  return { ...rhythm, acceptedAt: now }
}

export function automaticDelay(options: {
  base: number
  adaptive: boolean
  rhythm: TypingRhythm
  now: number
  lineBefore: string
}): number {
  const base = Math.min(MAX_DELAY, Math.max(MIN_DELAY, options.base))
  if (!options.adaptive) return base
  let factor = 1
  const { rhythm, now, lineBefore } = options
  const typing = now - rhythm.lastKeyAt < 2_000
  if (typing && rhythm.interval < 160) factor *= 1.5
  else if (typing && rhythm.interval > 600) factor *= 0.85
  if (rhythm.acceptedAt && now - rhythm.acceptedAt < 4_000) factor *= 0.6
  if (!lineBefore.trim() || /[.!?:;]["”’)\]]*\s*$/u.test(lineBefore))
    factor *= 0.8
  else if (/[\p{L}\p{N}]$/u.test(lineBefore)) factor *= 1.2
  return Math.round(Math.min(MAX_DELAY, Math.max(MIN_DELAY, base * factor)))
}

/** Places where an automatic suggestion only gets in the way. */
export function automaticAllowed(options: {
  lineBefore: string
  minCharacters: number
  documentEmpty: boolean
}): boolean {
  const { lineBefore } = options
  // A blank page may offer one quiet starter.
  if (options.documentEmpty) return true
  if (lineBefore.trim().length < options.minCharacters) return false
  // Inside a web address or a link destination.
  if (/(?:https?:\/\/|www\.)\S*$/iu.test(lineBefore)) return false
  if (/\]\([^)\s]*$/u.test(lineBefore)) return false
  // While choosing a note link or typing an inline code span.
  if (/\[\[[^\]]*$/u.test(lineBefore)) return false
  if ((lineBefore.match(/`/gu)?.length ?? 0) % 2 === 1) return false
  // Right after a list marker or table pipe the writer is choosing structure.
  if (/^\s*(?:[-*+]|\d+[.)])$/u.test(lineBefore)) return false
  return true
}
