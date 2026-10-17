/**
 * Starting points for Suggestion instructions. Each is short, so the model
 * keeps its budget for the writing, and each says what to keep as well as
 * what to do. Writers edit them freely after choosing one.
 */
export interface InstructionTemplate {
  id: string
  name: string
  /** A few words under the name. */
  hint: string
  text: string
}

export const INSTRUCTION_TEMPLATES: readonly InstructionTemplate[] = [
  {
    id: 'voice',
    name: 'Keep my voice',
    hint: 'Sound like me, only a step ahead',
    text: 'Keep my voice, vocabulary and rhythm. Continue what I am already saying rather than adding new ideas. Prefer concrete words to abstract ones. Never add filler, clichés or a summary.',
  },
  {
    id: 'concise',
    name: 'Clear and concise',
    hint: 'Short sentences, no padding',
    text: 'Write plainly and briefly. Use short sentences and common words. Put the main point first. Cut hedges such as "very", "really" and "in order to". One idea per sentence.',
  },
  {
    id: 'technical',
    name: 'Technical writing',
    hint: 'Docs, guides and READMEs',
    text: 'Write precise technical prose for developers. Use exact names for commands, files, settings and APIs, and put them in `code`. Prefer the active voice and present tense. State steps in order. Do not guess version numbers or behaviour that the note does not give.',
  },
  {
    id: 'architecture',
    name: 'Architecture notes',
    hint: 'ADRs, designs and trade-offs',
    text: 'Write like a solution architect documenting a decision. Name the context, the options, the trade-offs (cost, risk, performance, operability) and the consequences. Be specific about components and data flow. Mark assumptions as assumptions. Avoid marketing language.',
  },
  {
    id: 'fiction',
    name: 'Fiction',
    hint: 'Scene, character and detail',
    text: 'Continue the scene in the same point of view and tense. Show through action, sensory detail and dialogue rather than explanation. Keep each character’s voice consistent. Do not resolve tension or move the plot forward unless the text is already heading there.',
  },
  {
    id: 'essay',
    name: 'Essays and articles',
    hint: 'Argument that flows',
    text: 'Help the argument flow. Link each sentence to the one before it. Support claims with the evidence and references in my context, and never invent sources, quotes or numbers. Keep a confident but measured tone.',
  },
  {
    id: 'academic',
    name: 'Academic',
    hint: 'Formal, careful, cited',
    text: 'Use a formal academic register. Be careful with claims: distinguish findings from interpretation. Use field-appropriate terms. Refer only to sources in my context, by author and year when given. No contractions.',
  },
  {
    id: 'business',
    name: 'Business and email',
    hint: 'Polite, direct, actionable',
    text: 'Write professional, friendly and direct messages. Lead with the purpose, then the details, then the next step or request. Keep paragraphs short. Use a warm but not effusive tone. Never promise dates, prices or commitments that are not in the note.',
  },
  {
    id: 'notes',
    name: 'Meeting notes',
    hint: 'Decisions and actions',
    text: 'Capture notes in terse, factual phrases. Prefer lists for decisions, owners and action items. Keep names and dates exactly as written. Do not add opinions or items that were not discussed.',
  },
  {
    id: 'plain',
    name: 'Plain English',
    hint: 'For a general reader',
    text: 'Write for a general reader. Explain jargon in a few words the first time it appears. Use everyday examples. Keep sentences under 20 words where possible.',
  },
  {
    id: 'poetry',
    name: 'Poetry',
    hint: 'Image, sound and line',
    text: 'Continue in the same form, metre and line length. Favour fresh images and sound over explanation. Keep the line breaks of the poem. Never rhyme for its own sake.',
  },
  {
    id: 'uk',
    name: 'British English',
    hint: 'Spelling and usage',
    text: 'Use British English spelling and usage (colour, organise, travelled), single quotation marks and dates as 18 October 2026. Keep my voice otherwise.',
  },
]
