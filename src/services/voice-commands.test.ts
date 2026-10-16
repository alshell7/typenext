import { describe, expect, it } from 'vitest'
import { hasScratch, parseVoiceCommands } from './voice-commands'

describe('voice commands', () => {
  it.each([
    ['New line.', 'newLine'],
    ['new paragraph', 'newParagraph'],
    ['Period.', 'period'],
    ['Full stop.', 'period'],
    ['Comma.', 'comma'],
    ['Question mark?', 'questionMark'],
    ['Exclamation mark!', 'exclamationMark'],
    ['Exclamation point.', 'exclamationMark'],
    ['Colon.', 'colon'],
    ['Open quote.', 'openQuote'],
    ['Close quote.', 'closeQuote'],
    ['Bullet point.', 'bullet'],
    ['New bullet.', 'bullet'],
    ['Bullet.', 'bullet'],
    ['Scratch that.', 'scratchThat'],
  ])('recognizes "%s" as a whole phrase', (text, command) => {
    expect(parseVoiceCommands(text)).toEqual({
      lead: [command],
      words: '',
      trail: [],
    })
  })

  it('takes commands at the end of a phrase and drops the model punctuation for them', () => {
    expect(parseVoiceCommands('Guests arrive on Friday, comma.')).toEqual({
      lead: [],
      words: 'Guests arrive on Friday',
      trail: ['comma'],
    })
    expect(
      parseVoiceCommands('Is everyone coming question mark?')
    ).toMatchObject({ words: 'Is everyone coming', trail: ['questionMark'] })
    expect(
      parseVoiceCommands('The guests arrived. Period. New paragraph.')
    ).toEqual({
      lead: [],
      // Sentence marks stay; spoken punctuation replaces them on insertion.
      words: 'The guests arrived.',
      trail: ['period', 'newParagraph'],
    })
  })

  it('keeps commands that appear in the middle of a phrase as words', () => {
    expect(
      parseVoiceCommands('We started a new line of products last year.')
    ).toEqual({
      lead: [],
      words: 'We started a new line of products last year.',
      trail: [],
    })
    expect(parseVoiceCommands('Put a comma here and go on.').trail).toEqual([])
  })

  it('reads nouns as words, not marks', () => {
    for (const text of [
      'The trial period.',
      'There is a grace period',
      'He dodged the bullet.',
      'We need a new line',
      'Add the comma',
      'Use a colon',
    ])
      expect(parseVoiceCommands(text).trail).toEqual([])
    expect(parseVoiceCommands('He dodged the bullet.').words).toBe(
      'He dodged the bullet.'
    )
  })

  it('lets list and paragraph commands lead a phrase', () => {
    expect(parseVoiceCommands('New bullet buy milk.')).toEqual({
      lead: ['bullet'],
      words: 'buy milk.',
      trail: [],
    })
    expect(parseVoiceCommands('Bullet point eggs')).toMatchObject({
      lead: ['bullet'],
      words: 'eggs',
    })
    expect(
      parseVoiceCommands('New paragraph. The guests arrived.')
    ).toMatchObject({ lead: ['newParagraph'], words: 'The guests arrived.' })
    // Without a pause mark, "New line" opens a sentence.
    expect(parseVoiceCommands('New line items were added.').lead).toEqual([])
    expect(parseVoiceCommands('Bullet holes everywhere.').lead).toEqual([])
  })

  it('marks scratch commands', () => {
    expect(hasScratch(parseVoiceCommands('Scratch that.'))).toBe(true)
    expect(
      parseVoiceCommands('They arrive on Friday, scratch that.')
    ).toMatchObject({ words: 'They arrive on Friday', trail: ['scratchThat'] })
    expect(
      parseVoiceCommands('Scratch that. They arrive on Saturday.')
    ).toMatchObject({
      lead: ['scratchThat'],
      words: 'They arrive on Saturday.',
    })
    expect(hasScratch(parseVoiceCommands('A scratch on the car.'))).toBe(false)
  })

  it('leaves ordinary dictation untouched', () => {
    expect(
      parseVoiceCommands('Guests arrive at Bramble House on Friday afternoon.')
    ).toEqual({
      lead: [],
      words: 'Guests arrive at Bramble House on Friday afternoon.',
      trail: [],
    })
    expect(parseVoiceCommands('')).toEqual({ lead: [], words: '', trail: [] })
  })
})
