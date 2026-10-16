import { useMemo } from 'react'
import LogoLoop, { type LogoItem } from '../components/reactbits/LogoLoop/LogoLoop'
import Reveal from '../components/Reveal'
import { engines, type Engine } from '../content'
import { useReducedMotion } from '../hooks/useMediaQuery'

function Badge({ engine }: { engine: Engine }) {
  return (
    <span className={`engine-badge is-${engine.where}`}>
      <span className="engine-badge-dot" aria-hidden="true" />
      <span className="engine-badge-name">{engine.name}</span>
      {engine.detail && <span className="engine-badge-detail">{engine.detail}</span>}
    </span>
  )
}

const toItems = (list: Engine[]): LogoItem[] =>
  list.map(engine => ({
    node: <Badge engine={engine} />,
    title: engine.name,
    ariaLabel: `${engine.name}${engine.detail ? `, ${engine.detail}` : ''}`,
  }))

export default function Engines() {
  const reduced = useReducedMotion()
  const local = useMemo(() => engines.filter(e => e.where === 'device'), [])
  const external = useMemo(() => engines.filter(e => e.where === 'external'), [])
  const localItems = useMemo(() => toItems(local), [local])
  const externalItems = useMemo(() => toItems(external), [external])

  return (
    <section className="section engines" aria-labelledby="engines-title">
      <div className="container">
        <Reveal className="section-head is-center">
          <span className="eyebrow">Engines</span>
          <h2 id="engines-title" className="section-title">
            Local first. Your choice after that.
          </h2>
          <p className="section-lead">
            Suggestions, search and dictation run on your device. External providers are there when you want
            them, and only after you choose one.
          </p>
        </Reveal>
        <div className="engines-legend" aria-hidden="true">
          <span>
            <i className="is-device" /> On your device
          </span>
          <span>
            <i className="is-external" /> Opt-in external provider
          </span>
        </div>
      </div>
      {reduced ? (
        <div className="container engines-static">
          {[...local, ...external].map(engine => (
            <Badge key={engine.name} engine={engine} />
          ))}
        </div>
      ) : (
        <div className="engines-loops">
          <LogoLoop
            logos={localItems}
            speed={34}
            gap={14}
            logoHeight={40}
            pauseOnHover
            fadeOut
            fadeOutWidth={0.1}
            draggable={false}
            ariaLabel="On-device engines"
          />
          <LogoLoop
            logos={externalItems}
            speed={28}
            direction="right"
            gap={14}
            logoHeight={40}
            pauseOnHover
            fadeOut
            fadeOutWidth={0.1}
            draggable={false}
            ariaLabel="Optional external providers"
          />
        </div>
      )}
    </section>
  )
}
