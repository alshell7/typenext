// State for the faux editor in the live demo. Pure functions only, so the
// interaction rules stay easy to follow and to test.

export type Part =
  | { id: number; kind: 'text'; text: string; fresh?: boolean }
  | { id: number; kind: 'link'; title: string; missing?: boolean }

export type Choice = { text: string; source: string }

export type Menu =
  | { kind: 'choices'; index: number }
  | { kind: 'insert'; index: number; query: string }
  | { kind: 'link'; index: number; query: string }

export type DemoNote = { title: string; excerpt: string; edited: string; links: number }

export const NOTES: DemoNote[] = [
  {
    title: 'Guest list',
    excerpt: 'Eight rooms, two late arrivals. The garden room is kept for the Hallorans.',
    edited: 'Edited today',
    links: 3,
  },
  {
    title: 'Breakfast menu',
    excerpt: 'Bread from the night before, eggs from the farm on the hill, and plenty of tea.',
    edited: 'Edited yesterday',
    links: 1,
  },
  {
    title: 'Garden plan',
    excerpt: 'Roses along the south wall. The bench needs paint before the season starts.',
    edited: 'Edited on Monday',
    links: 2,
  },
]

export const SCRIPT = 'Guests arrive at Bramble House just after nine,'

const SCRIPT_CHOICES: Choice[] = [
  { text: ' when the kitchen still smells of bread.', source: 'Recall · Breakfast menu' },
  { text: ' and the garden room is ready for the Hallorans.', source: 'Recall · Guest list' },
  { text: ' so the first hour belongs to the kettle.', source: 'Writing starter' },
]

const SENTENCE_CHOICES: Choice[] = [
  { text: ' Then the house goes quiet again.', source: 'Writing starter' },
  { text: ' The roses can wait until noon.', source: 'Recall · Garden plan' },
  { text: ' Nobody hurries here.', source: 'Writing starter' },
]

const PHRASE_CHOICES: Choice[] = [
  { text: ' before anyone else is awake.', source: 'Writing starter' },
  { text: ' with a pot of tea on the porch.', source: 'Recall · Breakfast menu' },
  { text: ' and the day begins.', source: 'Writing starter' },
]

export type InsertItem = { id: 'date' | 'time' | 'note' | 'suggest'; label: string; section: string }

export const INSERT_ITEMS: InsertItem[] = [
  { id: 'date', label: 'Today’s date', section: 'Insert' },
  { id: 'time', label: 'Current time', section: 'Insert' },
  { id: 'note', label: 'Link to a note', section: 'Insert' },
  { id: 'suggest', label: 'Suggest a continuation', section: 'Actions' },
]

/** The longest paragraph the demo grows to, so the page layout stays calm. */
export const MAX_LENGTH = 300

export type State = {
  phase: 'waiting' | 'typing' | 'ready'
  typed: number
  parts: Part[]
  choices: Choice[]
  choice: number
  /** The current choice, with its spacing fixed when it was offered. */
  base: string
  /** Characters of the current choice that the visitor typed through. */
  consumed: number
  ghost: boolean
  menu: Menu | null
  /** After Escape, no new suggestion until the visitor writes again. */
  quiet: boolean
  offeredScript: boolean
  nextId: number
  edits: number
  announcement: string
}

export const initialState = (skipTyping = false): State =>
  skipTyping
    ? {
        ...base(),
        phase: 'ready',
        typed: SCRIPT.length,
        parts: [{ id: 1, kind: 'text', text: SCRIPT }],
        nextId: 2,
      }
    : base()

const base = (): State => ({
  phase: 'waiting',
  typed: 0,
  parts: [],
  choices: SCRIPT_CHOICES,
  choice: 0,
  base: '',
  consumed: 0,
  ghost: false,
  menu: null,
  quiet: false,
  offeredScript: false,
  nextId: 1,
  edits: 0,
  announcement: '',
})

export type Action =
  | { type: 'start' }
  | { type: 'tick' }
  | { type: 'finishScript' }
  | { type: 'suggest' }
  | { type: 'accept'; word?: boolean }
  | { type: 'dismiss' }
  | { type: 'type'; char: string }
  | { type: 'backspace' }
  | { type: 'openChoices' }
  | { type: 'openInsert' }
  | { type: 'openLink' }
  | { type: 'menuMove'; delta: number }
  | { type: 'menuApply'; index?: number }
  | { type: 'menuClose' }
  | { type: 'replay'; skipTyping: boolean }

export const plainText = (parts: Part[]) =>
  parts.map(part => (part.kind === 'text' ? part.text : part.title)).join('')

const lastChar = (parts: Part[]) => {
  const text = plainText(parts)
  return text.charAt(text.length - 1)
}

const append = (state: State, text: string, fresh = false): State => {
  const parts = state.parts.slice()
  const last = parts[parts.length - 1]
  if (!fresh && last?.kind === 'text' && !last.fresh) {
    parts[parts.length - 1] = { ...last, text: last.text + text }
    return { ...state, parts }
  }
  parts.push({ id: state.nextId, kind: 'text', text, fresh })
  return { ...state, parts, nextId: state.nextId + 1 }
}

/** The visible ghost text of the current choice, adjusted to the spacing at the cursor. */
export const ghostText = (state: State): string =>
  state.ghost || state.menu?.kind === 'choices' ? state.base.slice(state.consumed) : ''

export const choiceText = (state: State, index: number) => {
  const choice = state.choices[index]
  if (!choice) return ''
  const text = plainText(state.parts)
  return text === '' || /\s$/.test(text) ? choice.text.trimStart() : choice.text
}

const pick = (state: State, index: number): State => ({
  ...state,
  choice: index,
  base: choiceText(state, index),
  consumed: 0,
})

export const insertMatches = (query: string) => {
  const q = query.trim().toLowerCase()
  return q ? INSERT_ITEMS.filter(item => item.label.toLowerCase().includes(q)) : INSERT_ITEMS
}

export type LinkOption = { title: string; missing: boolean }

export const linkMatches = (query: string): LinkOption[] => {
  const q = query.trim().toLowerCase()
  const notes = NOTES.filter(note => note.title.toLowerCase().includes(q)).map(note => ({
    title: note.title,
    missing: false,
  }))
  if (q && !NOTES.some(note => note.title.toLowerCase() === q))
    notes.push({ title: query.trim(), missing: true })
  return notes
}

const menuLength = (menu: Menu, state: State) =>
  menu.kind === 'choices'
    ? state.choices.length
    : menu.kind === 'insert'
      ? insertMatches(menu.query).length
      : linkMatches(menu.query).length

const ensureScript = (state: State): State =>
  state.phase === 'ready'
    ? state
    : {
        ...state,
        phase: 'ready',
        typed: SCRIPT.length,
        parts: [{ id: state.nextId, kind: 'text', text: SCRIPT }],
        nextId: state.nextId + 1,
      }

const setFor = (state: State): Choice[] => {
  if (!state.offeredScript) return SCRIPT_CHOICES
  return /[.!?]\s*$/.test(plainText(state.parts)) ? SENTENCE_CHOICES : PHRASE_CHOICES
}

const offer = (state: State): State => {
  const choices = setFor(state)
  return {
    ...pick({ ...state, choices }, 0),
    ghost: true,
    quiet: false,
    offeredScript: true,
    announcement: `Suggestion: ${choices[0].text.trim()} Press Tab to accept or Escape to dismiss.`,
  }
}

const withTrigger = (state: State, menu: Menu): State => {
  // Closing an insert or link menu without a choice keeps what was typed.
  if (menu.kind === 'insert') return append(state, `/${menu.query}`)
  if (menu.kind === 'link') return append(state, `[[${menu.query}`)
  return state
}

const accept = (state: State, word: boolean): State => {
  const full = ghostText(state)
  if (!full) return state
  if (word) {
    const match = /^\s*\S+/.exec(full)
    const piece = match ? match[0] : full
    const rest = full.slice(piece.length)
    const next = append(state, piece, true)
    return rest
      ? { ...next, consumed: state.consumed + piece.length, menu: null, edits: state.edits + 1, announcement: `Accepted “${piece.trim()}”.` }
      : { ...next, ghost: false, menu: null, consumed: 0, edits: state.edits + 1, announcement: 'Accepted.' }
  }
  return {
    ...append(state, full, true),
    ghost: false,
    menu: null,
    consumed: 0,
    edits: state.edits + 1,
    announcement: 'Accepted the suggestion.',
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'replay':
      return initialState(action.skipTyping)
    case 'start':
      return state.phase === 'waiting' ? { ...state, phase: 'typing' } : state
    case 'tick': {
      if (state.phase !== 'typing') return state
      const typed = state.typed + 1
      if (typed < SCRIPT.length) return { ...state, typed }
      return ensureScript({ ...state, typed })
    }
    case 'finishScript':
      return ensureScript(state)
    case 'suggest':
      if (state.phase !== 'ready' || state.ghost || state.menu || state.quiet) return state
      if (plainText(state.parts).length >= MAX_LENGTH) return state
      return offer(state)
    case 'accept':
      return accept(ensureScript(state), Boolean(action.word))
    case 'dismiss':
      if (state.menu) return reducer(state, { type: 'menuClose' })
      if (!state.ghost) return state
      return { ...state, ghost: false, consumed: 0, quiet: true, announcement: 'Suggestion dismissed.' }
    case 'type': {
      let next = ensureScript(state)
      const { char } = action
      if (next.menu?.kind === 'insert' || next.menu?.kind === 'link') {
        if (next.menu.kind === 'insert' && char === '/') {
          // A second slash closes the menu and keeps both slashes.
          return { ...withTrigger({ ...next, menu: null }, next.menu), edits: next.edits + 1 }
        }
        const query = (next.menu.query + char).slice(0, 24)
        return { ...next, menu: { ...next.menu, query, index: 0 } }
      }
      if (next.menu?.kind === 'choices') next = { ...next, menu: null, ghost: true }
      if (plainText(next.parts).length >= MAX_LENGTH) {
        return { ...next, announcement: 'The demo note is full. Select Replay to start again.' }
      }
      const ghost = ghostText(next)
      if (next.ghost && ghost && ghost[0] === char) {
        // Typing the suggestion's next character keeps the rest of it.
        return { ...append(next, char), consumed: next.consumed + 1, edits: next.edits + 1 }
      }
      next = { ...next, ghost: false, consumed: 0, quiet: false, edits: next.edits + 1 }
      const before = lastChar(next.parts)
      if (char === '/' && (before === '' || /[\s([{>]/.test(before))) {
        return { ...next, menu: { kind: 'insert', index: 0, query: '' }, announcement: 'Insert menu. Use the arrow keys and Enter.' }
      }
      if (char === '[' && before === '[') {
        const parts = next.parts.slice()
        const last = parts[parts.length - 1]
        if (last?.kind === 'text') {
          const text = last.text.slice(0, -1)
          if (text) parts[parts.length - 1] = { ...last, text }
          else parts.pop()
        }
        return { ...next, parts, menu: { kind: 'link', index: 0, query: '' }, announcement: 'Link a note. Use the arrow keys and Enter.' }
      }
      return append(next, char)
    }
    case 'backspace': {
      const next = ensureScript(state)
      if (next.menu?.kind === 'insert' || next.menu?.kind === 'link') {
        if (next.menu.query) return { ...next, menu: { ...next.menu, query: next.menu.query.slice(0, -1), index: 0 } }
        if (next.menu.kind === 'link') return { ...append({ ...next, menu: null }, '['), edits: next.edits + 1 }
        return { ...next, menu: null, edits: next.edits + 1 }
      }
      const parts = next.parts.slice()
      const last = parts[parts.length - 1]
      if (!last) return next
      if (last.kind === 'link' || last.text.length <= 1) parts.pop()
      else parts[parts.length - 1] = { ...last, text: last.text.slice(0, -1) }
      return { ...next, parts, ghost: false, menu: null, consumed: 0, quiet: false, edits: next.edits + 1 }
    }
    case 'openChoices': {
      let next = ensureScript(state)
      if (next.menu?.kind === 'choices') {
        const index = (next.menu.index + 1) % next.choices.length
        return { ...pick(next, index), menu: { kind: 'choices', index }, announcement: `Choice ${index + 1} of ${next.choices.length}: ${next.choices[index].text.trim()}` }
      }
      if (next.menu) next = withTrigger({ ...next, menu: null }, next.menu)
      if (!next.ghost) next = offer(next)
      return {
        ...next,
        ghost: true,
        menu: { kind: 'choices', index: next.choice },
        announcement: `${next.choices.length} choices. Use the arrow keys to preview, Enter to accept.`,
      }
    }
    case 'openInsert': {
      let next = ensureScript(state)
      if (next.menu) next = withTrigger({ ...next, menu: null }, next.menu)
      if (!/(^|\s)$/.test(plainText(next.parts))) next = append(next, ' ')
      return { ...next, ghost: false, consumed: 0, menu: { kind: 'insert', index: 0, query: '' }, announcement: 'Insert menu. Use the arrow keys and Enter.' }
    }
    case 'openLink': {
      let next = ensureScript(state)
      if (next.menu) next = withTrigger({ ...next, menu: null }, next.menu)
      if (!/(^|\s)$/.test(plainText(next.parts))) next = append(next, ' ')
      return { ...next, ghost: false, consumed: 0, menu: { kind: 'link', index: 0, query: '' }, announcement: 'Link a note. Use the arrow keys and Enter.' }
    }
    case 'menuMove': {
      if (!state.menu) return state
      const length = menuLength(state.menu, state)
      if (!length) return state
      const index = (state.menu.index + action.delta + length) % length
      if (state.menu.kind === 'choices') return { ...pick(state, index), menu: { ...state.menu, index } }
      return { ...state, menu: { ...state.menu, index } }
    }
    case 'menuApply': {
      const menu = state.menu
      if (!menu) return state
      const index = action.index ?? menu.index
      if (menu.kind === 'choices') return accept(pick(state, index), false)
      if (menu.kind === 'insert') {
        const item = insertMatches(menu.query)[index]
        const closed = { ...state, menu: null }
        if (!item) return withTrigger(closed, menu)
        const now = new Date()
        if (item.id === 'date')
          return { ...append(closed, now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), true), edits: state.edits + 1 }
        if (item.id === 'time')
          return { ...append(closed, now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), true), edits: state.edits + 1 }
        if (item.id === 'note') return reducer(closed, { type: 'openLink' })
        return reducer(closed, { type: 'openChoices' })
      }
      const option = linkMatches(menu.query)[index]
      if (!option) return withTrigger({ ...state, menu: null }, menu)
      const parts: Part[] = [...state.parts, { id: state.nextId, kind: 'link', title: option.title, missing: option.missing }]
      return {
        ...state,
        parts,
        nextId: state.nextId + 1,
        menu: null,
        edits: state.edits + 1,
        announcement: option.missing ? `Linked “${option.title}”, a note not written yet.` : `Linked “${option.title}”.`,
      }
    }
    case 'menuClose': {
      if (!state.menu) return state
      if (state.menu.kind === 'choices') return { ...state, menu: null, announcement: 'Choices closed.' }
      return { ...withTrigger({ ...state, menu: null }, state.menu), quiet: true }
    }
  }
}
