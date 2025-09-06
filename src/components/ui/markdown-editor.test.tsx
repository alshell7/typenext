import { render, screen } from '@testing-library/react'
import { MarkdownEditor } from './markdown-editor'

// Mock the overtype module
jest.mock('overtype', () => ({
  default: {
    init: jest.fn(() => [{}])
  }
}))

describe('MarkdownEditor', () => {
  it('renders without crashing', () => {
    render(<MarkdownEditor value="" onChange={jest.fn()} />)
    expect(screen.getByRole('generic')).toBeInTheDocument()
  })
})