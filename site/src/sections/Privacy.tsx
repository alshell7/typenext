import Reveal from '../components/Reveal'
import { DeviceIcon, ToggleIcon } from '../components/Icons'

const stays = [
  { title: 'Notes and references', body: 'Stored on your device. Files are parsed locally.' },
  { title: 'On-device suggestions', body: 'Writing starters & recall, built-in SmolLM2 and local servers send nothing.' },
  { title: 'Semantic search', body: 'Vectors stay in a local cache; the embedding server runs on your computer.' },
  { title: 'Dictation', body: 'Whistle and Fluid Speech Mini transcribe on your device. No audio goes to a service.' },
  { title: 'Keys', body: 'Kept in memory, or in the system credential vault if you choose it.' },
]

const leaves = [
  { title: 'External provider', when: 'When you choose Use continuously', body: 'Nearby writing, the objective, your instructions and relevant attached context.' },
  { title: 'Web facts', when: 'Only on request', body: 'The selected text, nearby writing, note title and objective, to OpenAI.' },
  { title: 'Git sync', when: 'When you set up a remote', body: 'Your notes as Markdown files, only to the Git remote that you choose.' },
  { title: 'Website link cards', when: 'Notes & web, the default', body: 'A request to the linked website for its title. No note text. Choose Notes or Off to contact no website.' },
  { title: 'Website import', when: 'When you import a website', body: 'A request to that website. With the optional Firecrawl importer, the address goes to Firecrawl.' },
  { title: 'Model downloads', when: 'Only when you ask', body: 'Files from Hugging Face. An optional read token goes only to huggingface.co.' },
  { title: 'Update checks', when: 'Desktop, on by default', body: 'A request to GitHub for the latest version. No notes or settings. Turn it off in Preferences → Updates.' },
]

export default function Privacy() {
  return (
    <section className="section privacy" id="privacy" aria-labelledby="privacy-title">
      <div className="container">
        <Reveal className="section-head is-center">
          <span className="eyebrow">Privacy</span>
          <h2 id="privacy-title" className="section-title">
            Your writing stays with you.
          </h2>
          <p className="section-lead">
            Your notes never leave your device by themselves. An external provider, web facts, a Git remote and
            website previews each send only what is listed here.
          </p>
        </Reveal>
        <div className="privacy-grid">
          <Reveal className="privacy-col is-stays">
            <div className="privacy-col-head">
              <span className="privacy-icon">
                <DeviceIcon size={20} />
              </span>
              <div>
                <h3>Stays on your device</h3>
                <p>Always. No setup needed.</p>
              </div>
            </div>
            <ul className="privacy-list">
              {stays.map(item => (
                <li key={item.title}>
                  <span className="privacy-mark is-local" aria-hidden="true" />
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.body}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal className="privacy-col is-leaves" delay={90}>
            <div className="privacy-col-head">
              <span className="privacy-icon">
                <ToggleIcon size={20} />
              </span>
              <div>
                <h3>Leaves only for what you choose</h3>
                <p>What each feature sends, and where.</p>
              </div>
            </div>
            <ul className="privacy-list">
              {leaves.map(item => (
                <li key={item.title}>
                  <span className="privacy-switch" aria-hidden="true" />
                  <div>
                    <strong>
                      {item.title} <em>{item.when}</em>
                    </strong>
                    <span>{item.body}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
