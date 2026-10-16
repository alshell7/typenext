import { useState } from 'react'
import Reveal from '../components/Reveal'
import { shortcutGroups } from '../content'
import { isApple } from '../hooks/usePlatform'

export default function Shortcuts() {
  const [mac, setMac] = useState(isApple)
  return (
    <section className="section shortcuts" id="shortcuts" aria-labelledby="shortcuts-title">
      <div className="container">
        <div className="shortcuts-head">
          <Reveal className="section-head">
            <span className="eyebrow">Keyboard</span>
            <h2 id="shortcuts-title" className="section-title">
              Keep your hands on the keys.
            </h2>
            <p className="section-lead">The shortcuts you will use every day. The user guide lists them all.</p>
          </Reveal>
          <span className="segmented segmented-lg" role="group" aria-label="Keyboard layout">
            <button type="button" aria-pressed={mac} onClick={() => setMac(true)}>
              macOS
            </button>
            <button type="button" aria-pressed={!mac} onClick={() => setMac(false)}>
              Windows &amp; Linux
            </button>
          </span>
        </div>
        <div className="shortcut-grid">
          {shortcutGroups.map((group, index) => (
            <Reveal key={group.title} className="shortcut-group" delay={index * 70}>
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map(row => {
                  const keys = mac ? row.mac : row.other
                  return (
                    <div key={row.action} className="shortcut-row">
                      <dt>{row.action}</dt>
                      <dd>
                        {keys.map((key, i) => (
                          <kbd key={`${key}-${i}`}>{key}</kbd>
                        ))}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
