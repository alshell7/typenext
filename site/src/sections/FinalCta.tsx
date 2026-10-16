import DownloadButton, { offer } from '../components/DownloadButton'
import GitHubButton from '../components/GitHubButton'
import Reveal from '../components/Reveal'
import { links } from '../content'

export default function FinalCta() {
  return (
    <section className="section final" aria-labelledby="final-title">
      <div className="container">
        <Reveal className="final-card">
          <img
            className="final-icon"
            src={`${import.meta.env.BASE_URL}assets/Icon.png`}
            width="56"
            height="56"
            alt=""
            loading="lazy"
          />
          <h2 id="final-title" className="section-title">
            Give your words a little room.
          </h2>
          <p className="section-lead">Free, open source and local-first. Start a note in a second.</p>
          <div className="hero-actions">
            <DownloadButton magnetic={false} />
            <GitHubButton />
          </div>
          <p className="hero-platforms">
            {offer.detail} · <a href={links.releases}>All downloads</a>
          </p>
        </Reveal>
      </div>
    </section>
  )
}
