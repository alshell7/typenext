import { useEffect, useState } from 'react'
import GitHubButton from '../components/GitHubButton'
import ThemeToggle from '../components/ThemeToggle'
import { offer } from '../components/DownloadButton'

const nav = [
  { href: '#demo', label: 'Try it' },
  { href: '#film', label: 'Film' },
  { href: '#features', label: 'Features' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#shortcuts', label: 'Shortcuts' },
  { href: '#faq', label: 'FAQ' },
]

export default function Header() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`site-header${scrolled ? ' is-scrolled' : ''}`}>
      <div className="container header-inner">
        <a className="wordmark" href="#top" aria-label="TypeNext, back to top">
          <img src={`${import.meta.env.BASE_URL}assets/Icon.png`} width="26" height="26" alt="" />
          <span>TypeNext</span>
        </a>
        <nav className="header-nav" aria-label="Sections">
          {nav.map(item => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <GitHubButton compact />
          <ThemeToggle />
          <a className="btn btn-primary btn-small header-download" href={offer.href}>
            Download
          </a>
        </div>
      </div>
    </header>
  )
}
