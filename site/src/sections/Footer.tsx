import { links } from '../content'

const asset = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <a className="wordmark" href="#top">
            <img src={asset('Icon.png')} width="22" height="22" alt="" loading="lazy" />
            <span>TypeNext</span>
          </a>
          <p>A place for your words.</p>
        </div>
        <nav className="footer-links" aria-label="Project">
          <a href={links.releases}>Releases</a>
          <a href={links.guide}>User guide</a>
          <a href={links.repo}>Source</a>
          <a href={links.issues}>Issues</a>
        </nav>
        <div className="footer-legal">
          <p>
            TypeNext is free software under the <a href={links.license}>MIT licence</a>. Bundled libraries keep
            their own licences; see the <a href={links.notices}>third-party notices</a>.
          </p>
          <p>
            Interface effects on this site from <a href={links.reactBits}>React Bits</a> by David Haz (
            <a href={asset('React-Bits-LICENSE.txt')}>MIT + Commons Clause</a>). Type set in Source Sans Pro (
            <a href={asset('Source-Sans-Pro-LICENSE.txt')}>OFL</a>) and Merriweather (
            <a href={asset('Merriweather-LICENSE.txt')}>OFL</a>).
          </p>
        </div>
      </div>
    </footer>
  )
}
