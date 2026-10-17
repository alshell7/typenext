import { useLayoutEffect, useRef } from 'react'
import type { AiIndicatorStyle } from '../types/notebook'
import { pulseElement } from '../components/notebook/ai-pulse'
import './ai-pulse.css'

/** The model-at-work animation, for React surfaces. Off renders nothing. */
export function AiPulse({
  style,
  instant = false,
  className = '',
}: {
  style: AiIndicatorStyle
  /** Skip the short delay, for previews. */
  instant?: boolean
  className?: string
}) {
  const host = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || style === 'off') return
    const pulse = pulseElement(style)
    if (instant) pulse.classList.add('is-instant')
    element.replaceChildren(pulse)
    return () => element.replaceChildren()
  }, [style, instant])
  if (style === 'off') return null
  return <span ref={host} className={`ai-pulse-host ${className}`} />
}
