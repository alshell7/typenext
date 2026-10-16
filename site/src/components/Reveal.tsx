import type { ElementType, ReactNode } from 'react'
import { useInView } from '../hooks/useInView'

type RevealProps = {
  children: ReactNode
  as?: ElementType
  className?: string
  delay?: number
  id?: string
}

/** Fades content up once as it scrolls into view. Reduced motion shows it at once (CSS). */
export default function Reveal({ children, as: Tag = 'div', className = '', delay = 0, id }: RevealProps) {
  const [ref, seen] = useInView<HTMLElement>()
  return (
    <Tag
      ref={ref}
      id={id}
      className={`reveal${seen ? ' is-visible' : ''}${className ? ` ${className}` : ''}`}
      style={delay ? ({ '--reveal-delay': `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  )
}
