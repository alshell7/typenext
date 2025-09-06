import { cn } from '@/lib/utils'
import { Plate, usePlateEditor } from 'platejs/react'

import { Editor, EditorContainer } from '@/components/ui/editor';

import type { Value } from 'platejs';
import { FixedToolbarKit } from '@/components/fixed-toolbar-kit';
import { EditorKit } from '../editor-kit';

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

const initialValue: Value = [
  {
    type: 'p',
    children: [
      { text: 'Hello! Try out the ' },
      { text: 'bold', bold: true },
      { text: ', ' },
      { text: 'italic', italic: true },
      { text: ', and ' },
      { text: 'underline', underline: true },
      { text: ' formatting.' },
    ],
  },
  // Add more paragraphs to demonstrate scrolling
  ...Array(30).fill(null).map(() => ({
    type: 'p',
    children: [{ text: 'This is another paragraph to demonstrate scrolling behavior. Add more content to see the scrollbar in action.' }],
  })),
];

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const editor = usePlateEditor({
    plugins: [
      ...EditorKit,
      ...FixedToolbarKit,
    ],
    value: initialValue,
  });

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {children || (
        <Plate editor={editor}>
          <EditorContainer variant="default" className="h-full overflow-y-auto">
            <Editor placeholder="Type your amazing content here..." />
          </EditorContainer>
        </Plate>
      )}
    </div>
  )
}

export default MainWindowContent