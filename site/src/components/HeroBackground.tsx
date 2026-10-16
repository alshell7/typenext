import { Suspense, lazy, useEffect, useState } from 'react'
import { useReducedMotion } from '../hooks/useMediaQuery'
import { useTheme } from '../hooks/useTheme'

const Aurora = lazy(() => import('./reactbits/Aurora/Aurora'))

const supportsWebGL2 = () => {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'))
  } catch {
    return false
  }
}

const COLORS = {
  light: ['#b9d3bf', '#7fa58a', '#a9bccf'],
  dark: ['#2f4a3a', '#5d7690', '#3d5d4a'],
}

/**
 * A very soft aurora behind the hero. The WebGL effect loads after the page is idle,
 * and never with reduced motion or without WebGL 2; a static gradient stays underneath.
 */
export default function HeroBackground() {
  const reduced = useReducedMotion()
  const { theme } = useTheme()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (reduced || !supportsWebGL2()) {
      setReady(false)
      return
    }
    const idle = window.requestIdleCallback
    if (idle) {
      const id = idle(() => setReady(true), { timeout: 1500 })
      return () => window.cancelIdleCallback(id)
    }
    const id = window.setTimeout(() => setReady(true), 400)
    return () => window.clearTimeout(id)
  }, [reduced])

  return (
    <div className="hero-bg" aria-hidden="true">
      <div className="hero-bg-static" />
      {ready && (
        <Suspense fallback={null}>
          <Aurora
            key={theme}
            className="hero-aurora"
            colorStops={COLORS[theme]}
            lightMode={theme === 'light'}
            opacity={0.6}
            amplitude={0.9}
            blend={0.75}
            speed={0.35}
            height={0.42}
            glow={0.5}
            layers={2}
            brightness={theme === 'light' ? 0.9 : 0.8}
            mouseInteraction
            dpr={1}
          />
        </Suspense>
      )}
    </div>
  )
}
