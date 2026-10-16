import BlurText from '../components/reactbits/BlurText/BlurText'
import ShinyText from '../components/reactbits/ShinyText/ShinyText'
import DownloadButton, { offer } from '../components/DownloadButton'
import GitHubButton from '../components/GitHubButton'
import HeroBackground from '../components/HeroBackground'
import { links } from '../content'
import LiveDemo from '../demo/LiveDemo'
import { useMediaQuery, useReducedMotion } from '../hooks/useMediaQuery'
import { useTheme } from '../hooks/useTheme'

const LINES = ['Your words.', 'A little room to keep going.']
// On a phone the second line breaks where the sentence breathes.
const NARROW_LINES = ['Your words.', 'A little room', 'to keep going.']

export default function Hero() {
  const reduced = useReducedMotion()
  const { theme } = useTheme()
  const narrow = useMediaQuery('(max-width: 560px)')
  const lines = narrow ? NARROW_LINES : LINES

  return (
    <section className="hero" aria-labelledby="hero-title">
      <HeroBackground />
      <div className="container hero-inner">
        <a className="hero-badge" href={links.repo}>
          <span className="hero-badge-dot" aria-hidden="true" />
          <ShinyText
            text="Free and open source · MIT"
            color={theme === 'dark' ? '#b7b8b6' : '#51564f'}
            shineColor={theme === 'dark' ? '#ffffff' : '#42644d'}
            speed={3.2}
            delay={2.5}
            disabled={reduced}
          />
        </a>
        <h1 id="hero-title" className="hero-title">
          {reduced ? (
            lines.map(line => (
              <span key={line} className="hero-line">
                {line}
              </span>
            ))
          ) : (
            <>
              {lines.map((line, index) => (
                <BlurText
                  key={line}
                  as="span"
                  text={line}
                  className="hero-line"
                  trigger="load"
                  delay={70}
                  stepDuration={0.32}
                  blur={8}
                  distance={18}
                  initialDelay={index * 0.22}
                />
              ))}
            </>
          )}
        </h1>
        <p className="hero-lead">
          TypeNext is a local-first Markdown notepad. You write; a suggestion at the cursor helps you continue,
          and <kbd>Tab</kbd> accepts it. Your notes stay on your device.
        </p>
        <div className="hero-actions">
          <DownloadButton />
          <GitHubButton />
        </div>
        <p className="hero-platforms">
          {offer.detail} · <a href={links.releases}>All downloads</a>
        </p>
      </div>
      <div className="container hero-demo" id="demo">
        <LiveDemo />
      </div>
    </section>
  )
}
