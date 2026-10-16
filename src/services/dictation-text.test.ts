import { describe, expect, it } from 'vitest'
import {
  atSentenceStart,
  composeDictationEdit,
  countWords,
  isFillerOnly,
  plainDictation,
  stripFillers,
} from './dictation-text'
import { parseVoiceCommands, type DictationPiece } from './voice-commands'

const words = (text: string): DictationPiece => ({
  lead: [],
  words: text,
  trail: [],
})
const spoken = (text: string) => parseVoiceCommands(text)
function apply(before: string, pieces: DictationPiece[], after = '') {
  const edit = composeDictationEdit(pieces, before, after)
  return before.slice(0, before.length - edit.remove) + edit.text + after
}

describe('dictation text', () => {
  it('recognizes and trims hesitation sounds', () => {
    expect(isFillerOnly('Um.')).toBe(true)
    expect(isFillerOnly('Uh, um...')).toBe(true)
    expect(isFillerOnly('Hmm?')).toBe(true)
    expect(isFillerOnly('Um, yes.')).toBe(false)
    expect(stripFillers('Um, the guests arrive.')).toBe('the guests arrive.')
    expect(stripFillers('I, uh, think so.')).toBe('I think so.')
    expect(stripFillers('They left, um.')).toBe('They left.')
    expect(stripFillers('Ah, I see.')).toBe('Ah, I see.')
    expect(stripFillers('Um')).toBe('')
    expect(apply('Hello. ', [words('Um.')])).toBe('Hello. ')
  })

  it('counts words', () => {
    expect(countWords("Guests don't arrive on Friday, 12 May.")).toBe(7)
    expect(countWords('\n\n- ')).toBe(0)
  })

  it('knows where a sentence starts', () => {
    expect(atSentenceStart('')).toBe(true)
    expect(atSentenceStart('Done. ')).toBe(true)
    expect(atSentenceStart('Done.')).toBe(true)
    expect(atSentenceStart('He said "Go."')).toBe(true)
    expect(atSentenceStart('First line\n')).toBe(true)
    expect(atSentenceStart('- ')).toBe(true)
    expect(atSentenceStart('Notes\n- [ ] ')).toBe(true)
    expect(atSentenceStart('## ')).toBe(true)
    expect(atSentenceStart('and then')).toBe(false)
    expect(atSentenceStart('so, ')).toBe(false)
  })

  it('adds the spaces the position needs and nothing more', () => {
    expect(apply('Hello', [words('world')], ' tomorrow')).toBe(
      'Hello world tomorrow'
    )
    expect(apply('Hello ', [words('world')], 'tomorrow')).toBe(
      'Hello world tomorrow'
    )
    expect(apply('Hello', [words(', yes')], '')).toBe('Hello, yes')
    expect(apply('Hello', [words('world')], '.')).toBe('Hello world.')
    expect(apply('(', [words('aside')], ')')).toBe('(aside)')
    expect(apply('', [words('hello')], '')).toBe('Hello')
  })

  it('capitalizes after sentence ends and continues sentences in lower case', () => {
    expect(apply('Done.', [words('the guests left.')])).toBe(
      'Done. The guests left.'
    )
    expect(apply('We walked', [words('To the lake.')])).toBe(
      'We walked to the lake.'
    )
    // Proper nouns and "I" keep their capital mid-sentence.
    expect(apply('We met', [words('Bramble House guests.')])).toBe(
      'We met Bramble House guests.'
    )
    expect(apply('and then', [words("I'm sure.")])).toBe("and then I'm sure.")
    // A word the writer used in lower case is a common word for them.
    expect(apply('The guests and', [words('Guests arrived.')])).toBe(
      'The guests and guests arrived.'
    )
    expect(apply('Notes\n', [words('first idea')])).toBe('Notes\nFirst idea')
    expect(apply('- ', [words('buy milk')])).toBe('- Buy milk')
  })

  it('avoids double punctuation', () => {
    expect(apply('Hello,', [words(', and more')])).toBe('Hello, and more')
    expect(apply('We arrived.', [spoken('Question mark.')])).toBe('We arrived?')
    expect(apply('We arrived. ', [spoken('Period.')])).toBe('We arrived.')
    expect(apply('', [spoken('They arrived. Period.')])).toBe('They arrived.')
    expect(apply('', [spoken('Is it Friday, question mark.')])).toBe(
      'Is it Friday?'
    )
    expect(apply('Wait...', [spoken('Comma.')])).toBe('Wait...,')
    expect(apply('', [spoken('Comma.')])).toBe('')
  })

  it('applies line, paragraph and quote commands', () => {
    expect(apply('Dear Ana', [spoken('New line.')])).toBe('Dear Ana\n')
    expect(apply('Done.', [spoken('New paragraph.'), words('next')])).toBe(
      'Done.\n\nNext'
    )
    expect(apply('Done.\n', [spoken('New paragraph.')])).toBe('Done.\n\n')
    expect(apply('Done.\n\n', [spoken('New paragraph.')])).toBe('Done.\n\n')
    expect(apply('', [spoken('New paragraph.')])).toBe('')
    expect(
      apply('He said', [
        spoken('Open quote.'),
        words('hello'),
        spoken('Close quote.'),
        words('and left'),
      ])
    ).toBe('He said "Hello" and left')
  })

  it('starts and continues Markdown list items', () => {
    expect(apply('Groceries', [spoken('New bullet milk.')])).toBe(
      'Groceries\n- Milk.'
    )
    expect(apply('- milk', [spoken('And eggs, new bullet.')])).toBe(
      '- milk and eggs\n- '
    )
    expect(apply('  * tea', [spoken('Bullet point.')])).toBe('  * tea\n  * ')
    expect(apply('3. tea', [spoken('Bullet point.')])).toBe('3. tea\n4. ')
    expect(apply('- [x] done', [spoken('New bullet.')])).toBe(
      '- [x] done\n- [ ] '
    )
    expect(apply('Notes\n', [spoken('Bullet point.')])).toBe('Notes\n- ')
    expect(apply('- ', [spoken('Bullet point.')])).toBe('- ')
  })

  it('joins several phrases as if each was inserted after the last', () => {
    expect(
      apply('Plan:', [
        words('Guests arrive Friday.'),
        words('They leave Sunday.'),
        spoken('New paragraph.'),
        words('menu next'),
      ])
    ).toBe('Plan: Guests arrive Friday. They leave Sunday.\n\nMenu next')
    expect(plainDictation([words('one.'), words('two')])).toBe('One. Two')
  })
})
