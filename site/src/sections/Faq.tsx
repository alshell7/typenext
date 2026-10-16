import Reveal from '../components/Reveal'
import { ChevronIcon } from '../components/Icons'
import { faqs, links } from '../content'

export default function Faq() {
  return (
    <section className="section faq" id="faq" aria-labelledby="faq-title">
      <div className="container faq-layout">
        <Reveal className="section-head">
          <span className="eyebrow">Questions</span>
          <h2 id="faq-title" className="section-title">
            Good to know.
          </h2>
          <p className="section-lead">
            More in the <a href={links.guide}>user guide</a>, or ask on <a href={links.issues}>GitHub</a>.
          </p>
        </Reveal>
        <Reveal className="faq-list">
          {faqs.map(item => (
            <details key={item.q} className="faq-item">
              <summary>
                <span>{item.q}</span>
                <ChevronIcon size={18} className="faq-chevron" />
              </summary>
              <div className="faq-answer">
                {item.a.map(paragraph => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  )
}
