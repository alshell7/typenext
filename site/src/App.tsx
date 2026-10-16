import Engines from './sections/Engines'
import Faq from './sections/Faq'
import Features from './sections/Features'
import Film from './sections/Film'
import FinalCta from './sections/FinalCta'
import Footer from './sections/Footer'
import Gallery from './sections/Gallery'
import Header from './sections/Header'
import Hero from './sections/Hero'
import Privacy from './sections/Privacy'
import Shortcuts from './sections/Shortcuts'

export default function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div id="top" />
      <Header />
      <main id="main" tabIndex={-1}>
        <Hero />
        <Film />
        <Features />
        <Privacy />
        <Engines />
        <Gallery />
        <Shortcuts />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  )
}
