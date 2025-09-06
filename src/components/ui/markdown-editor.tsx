import { useEffect, useRef } from 'react'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
}

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const ref = useRef<HTMLDivElement>(null)
  const editorRef = useRef<any>(null)

  useEffect(() => {
    if (ref.current) {
      // Dynamically import OverType to avoid SSR issues and type errors
      import('overtype').then((OverTypeModule: any) => {
        const OverType = OverTypeModule.default || OverTypeModule
        if (ref.current) {
          const [instance] = (OverType as any).init(ref.current, {
            value,
            onChange
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
  }, [])

  useEffect(() => {
    if (editorRef.current && value !== editorRef.current.getValue()) {
      editorRef.current.setValue(value)
    }
  }, [value])

  return <div ref={ref} style={{ height: '200px' }} className="border rounded-md" />
}