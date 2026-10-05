import type { CursorContext, Note } from '../types/notebook'

const MAX_WINDOW = 5_000
const MAX_TOPIC = 48

function insideFence(prefix: string): boolean {
  let marker = ''
  let width = 0
  for (const match of prefix.matchAll(
    /(?:^|\n)[\t ]{0,3}(`{3,}|~{3,})([^\n]*)/gu
  )) {
    const fence = match[1] ?? ''
    if (!marker) {
      marker = fence.charAt(0)
      width = fence.length
    } else if (
      fence.charAt(0) === marker &&
      fence.length >= width &&
      !match[2]?.trim()
    ) {
      marker = ''
      width = 0
    }
  }
  return Boolean(marker)
}

function topicPhrase(value: string): string {
  const phrase = value
    .slice(0, 160)
    .trim()
    .replace(/[.!?]+$/u, '')
  // Only a short plain phrase may be embedded in a template. Long instructions,
  // Markdown syntax and full clauses stay out of deterministic prose.
  if (
    !phrase ||
    phrase.length > MAX_TOPIC ||
    !/^[\p{Script=Latin}\p{M}\d][\p{Script=Latin}\p{M}\d '\u2019-]*$/u.test(
      phrase
    ) ||
    phrase.split(/\s+/u).length > 4 ||
    /\b(?:is|are|was|were|should|will|must|can|could|would|has|have|does|did)\b/iu.test(
      phrase
    ) ||
    /^(?:why|how|what|who|when|where|which|plan|review|write|explain|describe|discuss|compare|explore|consider|decide|reflect|think)\b/iu.test(
      phrase
    ) ||
    /\b(?:returns|means|brings|makes|creates|changes|matters|feels|needs|becomes)\b/iu.test(
      phrase
    ) ||
    /^(?:I|we|you|they|he|she)\b/iu.test(phrase)
  )
    return ''
  return phrase.replace(/^(?:A|An|The|My|Our)(?= )/u, article =>
    article.toLowerCase()
  )
}

function topic(note: Note, prefix: string): string {
  const objective = note.objective.slice(0, 800)
  const directed = objective.match(
    /^(?:please\s+)?(?:reflect on|think about|write (?:about|on)|explore|describe|discuss|explain|compare|consider)\s+(.+)$/iu
  )?.[1]
  const goal = directed
    ? topicPhrase(
        directed.split(/\b(?:without|while|using|rather than)\b/iu)[0] ?? ''
      )
    : ''
  if (goal) return goal
  const recent = prefix
    .slice(-900)
    .trimEnd()
    .match(/\b(?:about|regarding|considering)\s+([^.!?\n]{3,80})[.!?]?$/iu)?.[1]
  const currentTopic = recent ? topicPhrase(recent) : ''
  if (currentTopic) return currentTopic
  const brief = note.context.slice(0, 1_200)
  const background = topicPhrase(
    brief.replace(/^(?:topic|subject|background)\s*:\s*/iu, '')
  )
  if (
    background &&
    !/\b(?:essay|journal|story|poem|plan|proposal|outline|personal|reflective)\b/iu.test(
      background
    )
  )
    return background
  const title = note.title.slice(0, 160)
  return /^(?:untitled|new note|note|draft|thoughts|my thoughts)$/iu.test(
    title.trim()
  )
    ? ''
    : topicPhrase(title)
}

function supportedLanguage(note: Note, prefix: string): boolean {
  const sample = `${prefix.slice(-900)} ${note.objective.slice(0, 800)} ${note.context.slice(0, 400)} ${note.title.slice(0, 160)}`
  const letters = sample.match(/\p{L}/gu) ?? []
  if (letters.some(letter => !/\p{Script=Latin}/u.test(letter))) return false
  // English templates are not a translator. Respect an explicit other-language
  // brief and obvious non-English sentence cues rather than replacing its voice.
  if (
    /\b(?:in|en)\s+(?:french|spanish|german|italian|portuguese|hindi|bengali|japanese|chinese|korean|arabic|russian)\b/iu.test(
      sample
    )
  )
    return false
  return !/\b(?:bonjour|je suis|je veux|quiero|mis pensamientos|ich möchte|ich bin|eu quero|voglio)\b/iu.test(
    sample
  )
}

/** Small English writing scaffolds, never inference or factual source material. */
export function offlineStarters(note: Note, context: CursorContext): string[] {
  if (context.inCode) return []
  const prefix = context.text.slice(
    Math.max(0, context.cursor - MAX_WINDOW),
    context.cursor
  )
  const suffix = context.text.slice(context.cursor, context.cursor + 1_500)
  // A starter never invents a bridge to text already on the same line.
  if (
    context.text.length - context.cursor > suffix.length &&
    !suffix.includes('\n')
  )
    return []
  if (!/^[\t ]*(?:\r?\n|$)/u.test(suffix)) return []
  if (insideFence(prefix) || !supportedLanguage(note, prefix)) return []
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  if (
    /^[\t ]*(?:#{1,6}(?:\s|$)| {4}|\t)/u.test(line) ||
    /[`*_[\]{}<>|\\]/u.test(line)
  )
    return []
  const subject = topic(note, prefix)
  let phrases: string[]
  if (/\bI (?:want|hope|plan|need) to[\t ]*$/iu.test(line)) {
    phrases = [
      subject ? `explore ${subject}` : 'make this thought clearer',
      'understand what matters most',
      'find a useful starting point',
    ]
  } else if (/\b(?:the|my|our) next step is[\t ]*$/iu.test(line)) {
    phrases = [
      'to name the question more clearly',
      'to consider the available options',
      'to decide what needs attention first',
    ]
  } else if (
    /\b(?:what matters(?: most)?|the question) is[\t ]*$/iu.test(line)
  ) {
    phrases = [
      'what I want to make clear',
      'how this connects to the bigger question',
      'where I want to go next',
    ]
  } else if (
    /\bI (?:am thinking|keep thinking|think) about[\t ]*$/iu.test(line)
  ) {
    phrases = [
      subject || 'what I want to say next',
      'what feels most important',
      'the question I want to explore',
    ]
  } else if (/\bI (?:want|hope)[\t ]*$/iu.test(line)) {
    phrases = [
      'to give this thought a clearer shape',
      'to understand the question better',
      'to find a place to begin',
    ]
  } else if (/\bfor example,[\t ]*$/iu.test(line)) {
    phrases = [
      'one possibility to consider is',
      'a useful question to ask is',
      'one way to approach this is',
    ]
  } else {
    const plainLine = line.replace(/^[\t ]*(?:[-+>]\s+|\d+[.)]\s+)/u, '')
    const boundary =
      !plainLine.trim() || /[.!?]["\u201d\u2019')]*[\t ]*$/u.test(line)
    if (!boundary) return []
    const intent = `${note.objective.slice(0, 800)} ${note.context.slice(0, 1_200)} ${note.title.slice(0, 160)}`
    if (subject) {
      phrases = [
        `Thinking about ${subject},`,
        `What matters about ${subject} is`,
        `A question about ${subject} is`,
      ]
    } else if (
      /\b(?:plan|steps?|task|proposal|project|decision|decide)\b/iu.test(intent)
    ) {
      phrases = [
        'The next step is',
        'Before deciding, I want to consider',
        'The question to settle first is',
      ]
    } else if (
      /\b(?:explain|compare|distinction|article|argument)\b/iu.test(intent)
    ) {
      phrases = [
        'The question I want to answer is',
        'A useful place to begin is',
        'The distinction I want to make is',
      ]
    } else if (
      /\b(?:story|fiction|scene|character|narrative)\b/iu.test(intent)
    ) {
      phrases = [
        'The detail that matters here is',
        'I want this scene to convey',
        'At this point in the story,',
      ]
    } else if (
      /\b(?:reflect|reflective|personal|journal|remember|thoughts)\b/iu.test(
        intent
      )
    ) {
      phrases = [
        'What I keep coming back to is',
        'One detail I want to remember is',
        'The question I am sitting with is',
      ]
    } else {
      phrases = [
        'One thought I want to explore is',
        'The question on my mind is',
        'A useful place to begin is',
      ]
    }
  }
  const separator = prefix && !/\s$/u.test(prefix) ? ' ' : ''
  return phrases.slice(0, 3).map(phrase => `${separator}${phrase} `)
}
