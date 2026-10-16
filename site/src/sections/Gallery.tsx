import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Reveal from '../components/Reveal'
import { shots } from '../content'
import { useTheme, type Theme } from '../hooks/useTheme'

const asset = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`

export default function Gallery() {
  const { theme } = useTheme()
  const [index, setIndex] = useState(0)
  const [look, setLook] = useState<Theme>(theme)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const shot = shots[index]
  const src = look === 'dark' && shot.dark ? shot.dark : shot.light

  useEffect(() => setLook(theme), [theme])

  const select = (next: number, focus = false) => {
    const wrapped = (next + shots.length) % shots.length
    setIndex(wrapped)
    if (focus) tabs.current[wrapped]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    if (event.key in keys) {
      event.preventDefault()
      select(index + keys[event.key], true)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      select(event.key === 'Home' ? 0 : shots.length - 1, true)
    }
  }

  return (
    <section className="section gallery" id="screenshots" aria-labelledby="gallery-title">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Screenshots</span>
          <h2 id="gallery-title" className="section-title">
            A quiet page, with context close by.
          </h2>
          <p className="section-lead">Real screenshots of TypeNext with example writing.</p>
        </Reveal>
        <Reveal className="gallery-layout">
          <div className="gallery-tabs" role="tablist" aria-label="Screenshots" aria-orientation="vertical" onKeyDown={onKeyDown}>
            {shots.map((item, i) => (
              <button
                key={item.id}
                ref={el => {
                  tabs.current[i] = el
                }}
                type="button"
                role="tab"
                id={`shot-tab-${item.id}`}
                aria-selected={i === index}
                aria-controls="shot-panel"
                tabIndex={i === index ? 0 : -1}
                className="gallery-tab"
                onClick={() => select(i)}
              >
                <span className="gallery-tab-num" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {item.label}
              </button>
            ))}
          </div>
          <div className="gallery-stage" role="tabpanel" id="shot-panel" aria-labelledby={`shot-tab-${shot.id}`}>
            <figure className="gallery-figure">
              <div className="gallery-frame">
                <img key={src} src={asset(src)} alt={shot.alt} width="1440" height="960" loading="lazy" decoding="async" />
              </div>
              <figcaption className="gallery-caption">
                <span>{shot.caption}</span>
                {shot.dark && (
                  <span className="segmented" role="group" aria-label="Screenshot appearance">
                    {(['light', 'dark'] as const).map(value => (
                      <button key={value} type="button" aria-pressed={look === value} onClick={() => setLook(value)}>
                        {value === 'light' ? 'Light' : 'Dark'}
                      </button>
                    ))}
                  </span>
                )}
              </figcaption>
            </figure>
            <div className="gallery-nav">
              <button type="button" className="icon-btn" onClick={() => select(index - 1)} aria-label="Previous screenshot">
                ‹
              </button>
              <span className="gallery-count" aria-live="polite">
                {index + 1} / {shots.length}
              </span>
              <button type="button" className="icon-btn" onClick={() => select(index + 1)} aria-label="Next screenshot">
                ›
              </button>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
