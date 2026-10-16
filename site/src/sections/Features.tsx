import type { CSSProperties, ReactNode } from 'react'
import SpotlightCard from '../components/reactbits/SpotlightCard/SpotlightCard'
import Reveal from '../components/Reveal'
import { CheckIcon } from '../components/Icons'
import { useInView } from '../hooks/useInView'
import { useTheme } from '../hooks/useTheme'
import { isApple } from '../hooks/usePlatform'

const asset = (name: string) => `${import.meta.env.BASE_URL}assets/${name}`
const mod = isApple ? '⌘' : 'Ctrl'

function Shot({ src, alt, focus = '50% 50%', zoom = 1 }: { src: string; alt: string; focus?: string; zoom?: number }) {
  return (
    <div className="bento-shot">
      <img
        src={asset(src)}
        alt={alt}
        width="1440"
        height="960"
        loading="lazy"
        decoding="async"
        style={{ objectPosition: focus, transformOrigin: focus, '--z': zoom } as CSSProperties}
      />
    </div>
  )
}

function EngineList() {
  const rows = [
    { name: 'Writing starters & recall', note: 'Default · no setup', on: true },
    { name: 'Built-in SmolLM2', note: '139 MB download' },
    { name: 'Local server', note: 'LM Studio, Jan, Lemonade, llama.cpp' },
    { name: 'External provider', note: 'Opt-in · OpenRouter, OpenAI, Anthropic, Cloudflare, custom', external: true },
  ]
  return (
    <ul className="engine-list" aria-label="Suggestion engines">
      {rows.map(row => (
        <li key={row.name} className={row.on ? 'is-on' : undefined}>
          <span className={`engine-dot${row.external ? ' is-external' : ''}`} aria-hidden="true" />
          <span className="engine-text">
            <span className="engine-name">{row.name}</span>
            <span className="engine-note">{row.note}</span>
          </span>
          {row.on && (
            <span className="engine-check">
              <CheckIcon size={15} />
              <span className="sr-only">Selected</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function SearchBars() {
  const [ref, seen] = useInView<HTMLDivElement>()
  return (
    <div ref={ref} className={`search-demo${seen ? ' is-visible' : ''}`} aria-hidden="true">
      <div className="search-query">
        <span>⌕</span> a quiet room for late guests
      </div>
      <div className="search-row">
        <span className="search-label">Words · BM25</span>
        <span className="search-bar">
          <i style={{ '--w': '46%' } as CSSProperties} />
        </span>
      </div>
      <div className="search-row">
        <span className="search-label">Meaning · EmbeddingGemma 2</span>
        <span className="search-bar is-meaning">
          <i style={{ '--w': '88%' } as CSSProperties} />
        </span>
      </div>
      <p className="search-hit">“…the garden room is kept for the Hallorans, who arrive after dark.”</p>
    </div>
  )
}

function Waveform() {
  return (
    <div className="wave-demo" aria-hidden="true">
      <span className="wave-mic" />
      <span className="wave-bars">
        {Array.from({ length: 22 }, (_, i) => (
          <i key={i} style={{ '--i': i } as CSSProperties} />
        ))}
      </span>
      <span className="wave-phrase">
        Guests arrive<span className="wave-live"> just after nine</span>
      </span>
    </div>
  )
}

function GitLine() {
  return (
    <div className="git-demo" aria-hidden="true">
      <div className="git-track">
        <span className="git-node" />
        <span className="git-node" />
        <span className="git-node is-pulse" />
        <span className="git-node is-ghost" />
      </div>
      <div className="git-log">
        <span>
          <b>commit</b> After a pause in writing
        </span>
        <span>
          <b>pull</b> Changes from your other computers
        </span>
        <span>
          <b>keep both</b> When one note changed in two places
        </span>
      </div>
    </div>
  )
}

type Card = {
  area: string
  tag: string
  title: string
  body: ReactNode
  visual: ReactNode
}

const cards: Card[] = [
  {
    area: 'write',
    tag: 'Writing',
    title: 'A Markdown editor that stays out of the way',
    body: (
      <>
        Live preview of bullets, task boxes and tables. A <kbd>/</kbd> insert menu with your own commands, a format
        bar on selection, an outline, typewriter scrolling, focus dimming, smart typography and a daily word goal.
      </>
    ),
    visual: <Shot src="insert-menu.png" alt="The insert menu open in a TypeNext note." focus="42% 78%" zoom={1.25} />,
  },
  {
    area: 'ai',
    tag: 'Suggestions',
    title: 'Help that starts on your device',
    body: 'A short continuation at the cursor. Tab accepts it, Escape lets it go. Choose any engine from the status bar.',
    visual: <EngineList />,
  },
  {
    area: 'sem',
    tag: 'Retrieval',
    title: 'Find passages by words and by meaning',
    body: 'Hybrid retrieval: a local BM25 index, plus optional semantic search with Google EmbeddingGemma 2 through llama.cpp on your computer.',
    visual: <SearchBars />,
  },
  {
    area: 'ctx',
    tag: 'Contexts',
    title: 'Reusable contexts, attached by drag and drop',
    body: 'Group files, folders, PDFs, DOCX, websites and live notes into a named context, and attach it to any note. With semantic search, images, audio and video too.',
    visual: <Shot src="context-board.png" alt="The Context panel with an intent and attached contexts." focus="100% 22%" zoom={1.2} />,
  },
  {
    area: 'graph',
    tag: 'Links',
    title: 'Note links, hover cards and a graph',
    body: (
      <>
        Type <kbd>[[</kbd> to link a note and point at a link to read it. <kbd>{mod}</kbd> <kbd>Shift</kbd>{' '}
        <kbd>G</kbd> shows how your notes connect.
      </>
    ),
    visual: <Shot src="note-graph.png" alt="The note graph of linked notes." focus="50% 50%" zoom={2.3} />,
  },
  {
    area: 'dict',
    tag: 'Dictation',
    title: 'Speak, on your device',
    body: 'Whistle (17 MB) or Fluid Speech Mini (347 MB, English, by FluidVoice). Live phrases while you speak, voice commands, and a stop after silence.',
    visual: <Waveform />,
  },
  {
    area: 'zen',
    tag: 'Zen',
    title: 'Three levels of quiet',
    body: 'Hide the side panels, the toolbars, or everything but the page. Escape leaves zen.',
    visual: <Shot src="zen-levels.png" alt="The zen mode level menu in TypeNext." focus="100% 0%" zoom={1.5} />,
  },
  {
    area: 'git',
    tag: 'Git sync',
    title: 'Plain files, synced with Git',
    body: 'Every note is a Markdown file in your repository. TypeNext commits after you stop writing, with the system Git and your own sign-in.',
    visual: <GitLine />,
  },
]

const extras = [
  `Notes start at once · ${mod} N`,
  `Command palette · ${mod} P`,
  'Web facts with citations, on request',
  'Tabs, recent notes and autosave',
  'Light, dark and custom palettes',
  'Hugging Face token guide',
]

export default function Features() {
  const { theme } = useTheme()
  return (
    <section className="section features" id="features" aria-labelledby="features-title">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">Features</span>
          <h2 id="features-title" className="section-title">
            Everything close at hand. Nothing in the way.
          </h2>
          <p className="section-lead">
            A broad page for your prose, with notes, context and suggestions one key away. Nothing appears in
            your note until you accept it.
          </p>
        </Reveal>
        <div className="bento">
          {cards.map((card, index) => (
            <Reveal key={card.area} className={`bento-cell bento-${card.area}`} delay={(index % 3) * 70}>
              <SpotlightCard
                className="bento-card"
                theme={theme}
                spotlightColor={theme === 'dark' ? '#a6b6c8' : '#42644d'}
                intensity={theme === 'dark' ? 0.08 : 0.35}
                spotlightSize={340}
                borderGlow={0.45}
                proximity={40}
                style={
                  {
                    '--spotlight-card-surface': 'var(--paper)',
                    '--spotlight-card-border': 'var(--line)',
                    '--spotlight-card-shadow': 'var(--shadow-sm)',
                  } as CSSProperties
                }
              >
                <div className="bento-copy">
                  <span className="bento-tag">{card.tag}</span>
                  <h3 className="bento-title">{card.title}</h3>
                  <p className="bento-body">{card.body}</p>
                </div>
                <div className="bento-visual">{card.visual}</div>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
        <Reveal className="extras">
          <h3 className="sr-only">Also in TypeNext</h3>
          <ul>
            {extras.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  )
}
