import type { DictationPiece, VoiceCommand } from './voice-commands'

/**
 * Turns transcribed phrases into the exact text to insert at the dictation
 * position, using the writing before and after it: spacing, sentence
 * capitalization, no doubled punctuation, list items and paragraph breaks.
 */

const FILLERS = new Set([
  'um',
  'umm',
  'ummm',
  'uh',
  'uhh',
  'uhm',
  'er',
  'erm',
  'ah',
  'hmm',
  'hm',
  'mm',
  'mhm',
])
/** "Ah" can be meant; it is dropped only when it is all that was said. */
const EDGE_FILLER = (word: string) => {
  const value = bare(word)
  return value !== 'ah' && FILLERS.has(value)
}
/** Mid-phrase fillers to drop. "Ah" can be meant, so it stays. */
const MID_FILLER = /,?\s+\b(?:um+|uh+|uhm|erm?|hmm+)\b,?(?=\s|$)/giu

const COMMON_WORDS = new Set(
  (
    'a an and are as at be because been before but by can could did do does ' +
    'each even every for from had has have he her here his how if in into is ' +
    'it its just like many may maybe might more most much must my no not now ' +
    'of on once one only or other our out over perhaps since so some still ' +
    'such than that the their them then there these they this those though ' +
    'through to too under until up very was we were what when where which ' +
    'while who why will with without would yet you your also after about ' +
    'again all almost already although any anyway besides both either else ' +
    'especially otherwise rather instead meanwhile however therefore'
  ).split(' ')
)

const SENTENCE_END = /[.!?…]["'”’)\]]*\s*$/u
const LIST_MARKER = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))\s+(\[[ xX]\]\s+)?/u
const LINE_PREFIX_ONLY =
  /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|>\s*|#{1,6}\s+)$/u
const OPENERS = /[([{“‘]$/u
const CLOSERS = /^[,.;:!?…)\]}”’]/u

function words(text: string): string[] {
  return text.match(/\S+/gu) ?? []
}

function bare(word: string) {
  return word.toLocaleLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
}

/** True when a phrase contains only hesitation sounds. */
export function isFillerOnly(text: string): boolean {
  const list = words(text).map(bare)
  return list.length > 0 && list.every(word => !word || FILLERS.has(word))
}

/** Drop hesitation sounds at the edges and "um"/"uh" within a phrase. */
export function stripFillers(text: string): string {
  if (isFillerOnly(text)) return ''
  let list = words(text.replace(MID_FILLER, ''))
  while (list.length > 1 && EDGE_FILLER(list[0]!)) list = list.slice(1)
  while (list.length > 1 && EDGE_FILLER(list[list.length - 1]!)) {
    const last = list[list.length - 1]!
    const mark = /[.!?]$/u.exec(last)?.[0] ?? ''
    list = list.slice(0, -1)
    if (mark)
      list[list.length - 1] =
        list[list.length - 1]!.replace(/[,;:]$/u, '') + mark
  }
  return list.join(' ')
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length
}

function currentLine(text: string) {
  return text.slice(text.lastIndexOf('\n') + 1)
}

/** At the start of a sentence, a line, or a list item. */
export function atSentenceStart(before: string): boolean {
  if (!before.trim()) return true
  if (/\n\s*$/u.test(before) && !/\S/u.test(currentLine(before))) return true
  if (LINE_PREFIX_ONLY.test(currentLine(before))) return true
  return SENTENCE_END.test(before)
}

function opensQuote(before: string) {
  // A straight quote after a space or at a line start opens a quotation.
  return /(?:^|[\s([{])"$/u.test(before)
}

function needsSpace(before: string, next: string) {
  if (!before || /\s$/u.test(before) || !next) return false
  if (OPENERS.test(before) || opensQuote(before)) return false
  if (CLOSERS.test(next)) return false
  return true
}

function capitalize(text: string) {
  return text.replace(
    /^(["'“‘([]*)(\p{Ll})/u,
    (_all, open: string, letter: string) => open + letter.toLocaleUpperCase()
  )
}

function continueSentence(text: string, before: string) {
  const match = /^(["'“‘([]*)(\p{Lu}[\p{Ll}'’]*)(?=$|[^\p{L}])/u.exec(text)
  if (!match) return text
  const word = match[2]!
  if (/^I(?:['’].*)?$/u.test(word)) return text
  const lower = word.toLocaleLowerCase()
  const known =
    COMMON_WORDS.has(lower) ||
    new RegExp(`(?:^|[^\\p{L}])${lower}(?:$|[^\\p{L}])`, 'u').test(before)
  if (!known) return text
  return match[1] + lower + text.slice(match[0].length)
}

const MARKS: Partial<Record<VoiceCommand, string>> = {
  period: '.',
  comma: ',',
  questionMark: '?',
  exclamationMark: '!',
  colon: ':',
}

export interface DictationEdit {
  /** Characters to remove just before the position: spaces or one mark. */
  remove: number
  text: string
}

/**
 * Compose the insertion for one or more phrases. `before` is the writing just
 * before the position (a few hundred characters is enough), `after` the
 * character or two after it. The edit may replace trailing spaces or a single
 * punctuation mark before the position, so "question mark" after "arrived."
 * gives "arrived?" rather than "arrived.?".
 */
export function composeDictationEdit(
  pieces: readonly DictationPiece[],
  before: string,
  after = ''
): DictationEdit {
  let base = before.slice(-600)
  let remove = 0
  let out = ''
  const tail = () => base + out
  /** Remove characters from the end, ours first, then the writer's. */
  const drop = (count: number) => {
    const own = Math.min(count, out.length)
    out = out.slice(0, out.length - own)
    const rest = count - own
    if (rest > 0) {
      base = base.slice(0, base.length - rest)
      remove += rest
    }
  }
  /** Spaces and tabs only: a line break before the position stays. */
  const trimSpaces = () => {
    const spaces = /[ \t]+$/u.exec(tail())?.[0].length ?? 0
    if (spaces) drop(spaces)
  }
  const command = (name: VoiceCommand) => {
    const mark = MARKS[name]
    if (mark) {
      trimSpaces()
      const text = tail()
      if (!text.trim() || /\n$/u.test(text)) return
      const last = /[,.;:!?…]$/u.exec(text)?.[0]
      if (last === mark) return
      // Spoken punctuation replaces the mark the model or writer just put.
      if (last && !(last === '.' && /\.\.$/u.test(text))) drop(1)
      out += mark
      return
    }
    switch (name) {
      case 'newLine':
        trimSpaces()
        if (tail()) out += '\n'
        return
      case 'newParagraph': {
        trimSpaces()
        const text = tail()
        if (!text.trim()) return
        if (text.endsWith(',')) drop(1)
        out += /\n\n$/u.test(text) ? '' : /\n$/u.test(text) ? '\n' : '\n\n'
        return
      }
      case 'bullet': {
        const open = currentLine(tail())
        if (LINE_PREFIX_ONLY.test(open) && LIST_MARKER.test(open)) return
        trimSpaces()
        const line = currentLine(tail())
        const list = LIST_MARKER.exec(line)
        let marker = '- '
        if (list) {
          const [, indent = '', bullet, number, delimiter, task] = list
          marker =
            indent +
            (number ? `${Number(number) + 1}${delimiter}` : bullet) +
            ' ' +
            (task ? '[ ] ' : '')
        }
        out += (line.trim() ? '\n' : '') + marker
        return
      }
      case 'openQuote':
        out += (needsSpace(tail(), '"') ? ' ' : '') + '"'
        return
      case 'closeQuote':
        trimSpaces()
        out += '"'
        return
      default:
        // "scratch that" is handled by the dictation session.
        return
    }
  }
  const append = (raw: string) => {
    let text = stripFillers(raw)
    if (!text) return
    const context = tail()
    if (/[,.;:!?]$/u.test(context.trimEnd()))
      text = text.replace(/^[,.;:!?]+\s*/u, '')
    if (!text) return
    text =
      atSentenceStart(context) || opensQuote(context)
        ? capitalize(text)
        : continueSentence(text, context)
    out += (needsSpace(context, text) ? ' ' : '') + text
  }
  for (const piece of pieces) {
    piece.lead.forEach(command)
    append(piece.words)
    piece.trail.forEach(command)
  }
  if (
    out &&
    after &&
    !/\s$/u.test(out) &&
    !/^\s/u.test(after) &&
    !CLOSERS.test(after) &&
    !OPENERS.test(out) &&
    !opensQuote(tail())
  )
    out += ' '
  return { remove, text: out }
}

/** Plain text of phrases, for a transcript kept outside the note. */
export function plainDictation(pieces: readonly DictationPiece[]): string {
  return composeDictationEdit(pieces, '').text.trim()
}
