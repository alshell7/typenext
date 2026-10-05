import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
  onCloseAutoFocus,
  onEscapeKeyDown,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  description: string
  children: ReactNode
  className?: string
  onCloseAutoFocus?(event: Event): void
  onEscapeKeyDown?(event: KeyboardEvent): void
}) {
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) return
    const rememberFocus = () => {
      const element = document.activeElement
      if (
        element instanceof HTMLElement &&
        element !== document.body &&
        element !== document.documentElement &&
        !element.closest('[role="dialog"]')
      )
        returnFocus.current = element
    }
    rememberFocus()
    document.addEventListener('focusin', rememberFocus)
    return () => document.removeEventListener('focusin', rememberFocus)
  }, [open])
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content ${className}`}
          onEscapeKeyDown={onEscapeKeyDown}
          onCloseAutoFocus={event => {
            onCloseAutoFocus?.(event)
            if (event.defaultPrevented) return
            event.preventDefault()
            if (
              returnFocus.current?.isConnected &&
              !document.querySelector('[role="dialog"]')
            )
              returnFocus.current.focus({ preventScroll: true })
          }}
        >
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="dialog-description">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
