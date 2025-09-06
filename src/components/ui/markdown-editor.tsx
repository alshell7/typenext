import { useEffect, useRef } from 'react'
import { useTheme } from '@/hooks/use-theme'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
}

// Define theme colors for light and dark modes
const themeColors = {
  light: {
    bgPrimary: 'oklch(1 0 0)', // --background
    bgSecondary: 'oklch(0.97 0 0)', // --secondary
    text: 'oklch(0.145 0 0)', // --foreground
    h1: 'oklch(0.205 0 0)', // --primary
    h2: 'oklch(0.205 0 0)', // --primary
    h3: 'oklch(0.205 0 0)', // --primary
    strong: 'oklch(0.205 0 0)', // --primary
    em: 'oklch(0.205 0 0)', // --primary
    link: 'oklch(0.623 0.214 259.815)', // --brand
    code: 'oklch(0.145 0 0)', // --foreground
    codeBg: 'oklch(0.97 0 0)', // --secondary with opacity
    blockquote: 'oklch(0.556 0 0)', // --muted-foreground
    hr: 'oklch(0.922 0 0)', // --border
    syntaxMarker: 'oklch(0.708 0 0)', // --ring
    cursor: 'oklch(0.205 0 0)', // --primary
    selection: 'oklch(0.922 0 0 / 0.4)', // --border with opacity
  },
  dark: {
    bgPrimary: 'oklch(0.145 0 0)', // --background
    bgSecondary: 'oklch(0.269 0 0)', // --secondary
    text: 'oklch(0.985 0 0)', // --foreground
    h1: 'oklch(0.922 0 0)', // --primary
    h2: 'oklch(0.922 0 0)', // --primary
    h3: 'oklch(0.922 0 0)', // --primary
    strong: 'oklch(0.922 0 0)', // --primary
    em: 'oklch(0.922 0 0)', // --primary
    link: 'oklch(0.707 0.165 254.624)', // --brand
    code: 'oklch(0.985 0 0)', // --foreground
    codeBg: 'oklch(0.269 0 0)', // --secondary with opacity
    blockquote: 'oklch(0.708 0 0)', // --muted-foreground
    hr: 'oklch(1 0 0 / 10%)', // --border
    syntaxMarker: 'oklch(0.556 0 0)', // --ring
    cursor: 'oklch(0.922 0 0)', // --primary
    selection: 'oklch(1 0 0 / 10% / 0.4)', // --border with opacity
  }
}

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const ref = useRef<HTMLDivElement>(null)
  const editorRef = useRef<any>(null)
  const { theme } = useTheme()

  useEffect(() => {
    if (ref.current) {
      // Dynamically import OverType to avoid SSR issues and type errors
      import('overtype').then((OverTypeModule: any) => {
        const OverType = OverTypeModule.default || OverTypeModule
        if (ref.current) {
          const [instance] = (OverType as any).init(ref.current, {
            value,
            onChange,
            theme: {
              name: theme,
              colors: themeColors[theme === 'dark' ? 'dark' : 'light']
            }
          })
          editorRef.current = instance
        }
      }).catch((error) => {
        console.error('Failed to load OverType editor:', error)
      })
    }

    return () => {
      if (editorRef.current && typeof editorRef.current.destroy === 'function') {
        editorRef.current.destroy()
      }
    }
  }, [theme])

  useEffect(() => {
    if (editorRef.current && value !== editorRef.current.getValue()) {
      editorRef.current.setValue(value)
    }
  }, [value])

  return <div ref={ref} style={{ height: '200px' }} className="border rounded-md" />
}