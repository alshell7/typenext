/**
 * Spoken commands in a dictated phrase. A command counts only when it is the
 * whole phrase or ends it, so ordinary prose ("a new line of products") keeps
 * its words. Two structural exceptions may also lead a phrase: "bullet point"
 * and "new bullet" ("new bullet buy milk"), and "new line" or "new paragraph"
 * when the model put a pause mark right after them ("New paragraph. The…").
 */
export type VoiceCommand =
  | 'newLine'
  | 'newParagraph'
  | 'period'
  | 'comma'
  | 'questionMark'
  | 'exclamationMark'
  | 'colon'
  | 'openQuote'
  | 'closeQuote'
  | 'bullet'
  | 'scratchThat'

/** One dictated phrase: commands before the words, the words, commands after. */
export interface DictationPiece {
  lead: VoiceCommand[]
  words: string
  trail: VoiceCommand[]
}

/** For Preferences: what to say and what it does. */
export const VOICE_COMMANDS: ReadonlyArray<{
  command: VoiceCommand
  say: string
  does: string
}> = [
  { command: 'newLine', say: 'new line', does: 'Line break' },
  { command: 'newParagraph', say: 'new paragraph', does: 'Blank line' },
  { command: 'period', say: 'period · full stop', does: '.' },
  { command: 'comma', say: 'comma', does: ',' },
  { command: 'questionMark', say: 'question mark', does: '?' },
  { command: 'exclamationMark', say: 'exclamation mark', does: '!' },
  { command: 'colon', say: 'colon', does: ':' },
  { command: 'openQuote', say: 'open quote · close quote', does: '" … "' },
  {
    command: 'bullet',
    say: 'bullet point · new bullet',
    does: 'New list item',
  },
  {
    command: 'scratchThat',
    say: 'scratch that',
    does: 'Remove the last phrase',
  },
]

const PHRASES: ReadonlyArray<readonly [string, VoiceCommand]> = [
  ['new paragraph', 'newParagraph'],
  ['next paragraph', 'newParagraph'],
  ['new line', 'newLine'],
  ['newline', 'newLine'],
  ['next line', 'newLine'],
  ['line break', 'newLine'],
  ['full stop', 'period'],
  ['period', 'period'],
  ['comma', 'comma'],
  ['question mark', 'questionMark'],
  ['exclamation mark', 'exclamationMark'],
  ['exclamation point', 'exclamationMark'],
  ['colon', 'colon'],
  ['open quote', 'openQuote'],
  ['open quotes', 'openQuote'],
  ['begin quote', 'openQuote'],
  ['close quote', 'closeQuote'],
  ['close quotes', 'closeQuote'],
  ['end quote', 'closeQuote'],
  ['unquote', 'closeQuote'],
  ['bullet point', 'bullet'],
  ['new bullet', 'bullet'],
  ['next bullet', 'bullet'],
  ['bullet', 'bullet'],
  ['scratch that', 'scratchThat'],
].map(([say, command]) => [say!, command as VoiceCommand] as const)

/** Before these words, "period", "comma" or "colon" is a noun, not a mark. */
const NOUN_CONTEXT = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'each',
  'every',
  'one',
  'no',
  'any',
  'same',
  'given',
  'certain',
  'short',
  'long',
  'serial',
  'oxford',
])
const PERIOD_COMPOUNDS = new Set([
  'trial',
  'grace',
  'time',
  'waiting',
  'notice',
  'cooling',
  'rest',
  'probation',
  'probationary',
  'billing',
  'reporting',
  'study',
  'transition',
  'holding',
  'menstrual',
  'class',
  'free',
  'lunch',
  'second',
  'third',
  'fourth',
  'first',
])
const NOUN_COMMANDS = new Set<VoiceCommand>([
  'period',
  'comma',
  'colon',
  'questionMark',
  'exclamationMark',
  'newLine',
  'newParagraph',
  'bullet',
])
const LEADING_WITH_BOUNDARY = new Set<VoiceCommand>([
  'newLine',
  'newParagraph',
  'scratchThat',
])

interface Token {
  word: string
  start: number
  end: number
}

function tokens(text: string): Token[] {
  const list: Token[] = []
  for (const match of text.matchAll(/\S+/gu)) {
    const word = match[0]
      .toLocaleLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (!word) continue
    list.push({ word, start: match.index, end: match.index + match[0].length })
  }
  return list
}

function matchAt(
  list: Token[],
  from: number,
  direction: 'end' | 'start'
): { command: VoiceCommand; size: number } | null {
  for (const [say, command] of PHRASES) {
    const parts = say.split(' ')
    const size = parts.length
    const begin = direction === 'end' ? from - size + 1 : from
    if (begin < 0 || begin + size > list.length) continue
    if (parts.every((part, index) => list[begin + index]?.word === part))
      return { command, size }
  }
  return null
}

/** "the new line", "a comma", "the trial period": nouns, not commands. */
function nounUse(command: VoiceCommand, previous: string | undefined) {
  if (!previous || !NOUN_COMMANDS.has(command)) return false
  if (NOUN_CONTEXT.has(previous)) return true
  return command === 'period' && PERIOD_COMPOUNDS.has(previous)
}

/** Split commands from the words of one transcribed phrase. */
export function parseVoiceCommands(text: string): DictationPiece {
  const source = text.trim()
  const list = tokens(source)
  const trail: VoiceCommand[] = []
  let end = list.length
  // Peel commands from the end: "…arrived period new paragraph".
  while (end > 0 && trail.length < 4) {
    const found = matchAt(list, end - 1, 'end')
    if (!found) break
    const start = end - found.size
    // A lone "bullet" is a command only as the whole phrase ("the bullet").
    if (found.command === 'bullet' && found.size === 1 && start > 0) break
    if (start > 0 && nounUse(found.command, list[start - 1]?.word)) break
    trail.unshift(found.command)
    end = start
  }
  const lead: VoiceCommand[] = []
  let start = 0
  while (start < end && lead.length < 3) {
    const found = matchAt(list, start, 'start')
    if (!found || start + found.size > end) break
    const last = list[start + found.size - 1]!
    const rest = start + found.size < end
    const boundary = /[.,;:!?]["'”’)]*$/u.test(
      source.slice(last.start, last.end)
    )
    if (
      !rest ||
      found.command === 'bullet' ||
      (LEADING_WITH_BOUNDARY.has(found.command) && boundary)
    ) {
      if (found.command === 'bullet' && found.size === 1 && rest) break
      lead.push(found.command)
      start += found.size
    } else break
  }
  const from = start < list.length ? list[start]!.start : source.length
  const to = end > 0 ? list[end - 1]!.end : 0
  let words = from < to ? source.slice(from, to) : ''
  // The punctuation the model wrote for the command words belongs to them.
  words = words.replace(/^[,.;:!?\s]+/u, '')
  // A pause comma before a trailing command belongs to the command.
  if (trail.length) words = words.replace(/[\s,;:]+$/u, '')
  if (!words) {
    // A command alone: keep its intent, never its words.
    return { lead: [...lead, ...trail], words: '', trail: [] }
  }
  return { lead, words, trail }
}

export function hasScratch(piece: DictationPiece): boolean {
  return (
    piece.lead.includes('scratchThat') || piece.trail.includes('scratchThat')
  )
}
