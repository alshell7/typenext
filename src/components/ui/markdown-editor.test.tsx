import { render, screen } from '@testing-library/react'
import { MarkdownEditor } from './markdown-editor'
import { ThemeProvider } from '@/components/ThemeProvider'

// Mock the overtype module
jest.mock('overtype', () => ({
  default: {
    init: jest.fn(() => [{}])
  }
}))

// Mock the useTheme hook
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({
    theme: 'light',
    setTheme: jest.fn()
  })
}))

describe('MarkdownEditor', () => {
  it('renders without crashing', () => {
    render(
      <ThemeProvider>
        <MarkdownEditor value="" onChange={jest.fn()} />
      </ThemeProvider>
    )
    expect(screen.getByRole('generic')).toBeInTheDocument()
  })
})