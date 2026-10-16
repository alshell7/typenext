import { useEffect, useRef, useState } from 'react'
import Reveal from '../components/Reveal'
import { useReducedMotion } from '../hooks/useMediaQuery'

const FILM = `${import.meta.env.BASE_URL}assets/typenext-film.mp4`
const POSTER = `${import.meta.env.BASE_URL}assets/typenext-film-poster.jpg`

/**
 * The 30-second film. It plays without sound while it is on screen and
 * pauses when it scrolls away. With reduced motion it waits for a click.
 */
export default function Film() {
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [muted, setMuted] = useState(true)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const element = video.current
    const holder = frame.current
    if (!element || !holder || reduced || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void element.play().catch(() => {})
        else element.pause()
      },
      { threshold: 0.45 }
    )
    observer.observe(holder)
    return () => observer.disconnect()
  }, [reduced])

  const toggleSound = () => {
    const element = video.current
    if (!element) return
    element.muted = !element.muted
    setMuted(element.muted)
    if (!element.muted && element.ended) element.currentTime = 0
    void element.play().catch(() => {})
  }

  const replay = () => {
    const element = video.current
    if (!element) return
    element.currentTime = 0
    void element.play().catch(() => {})
  }

  return (
    <section className="section film" id="film" aria-labelledby="film-title">
      <div className="container">
        <Reveal className="section-head is-center">
          <span className="eyebrow">The film</span>
          <h2 id="film-title" className="section-title">
            You dictate. Not the AI.
          </h2>
          <p className="section-lead">
            Thirty seconds of the real app: suggestions from your own files, dictation on your device, and a writing
            space that stays out of the way.
          </p>
        </Reveal>
        <Reveal className="film-frame" delay={80}>
          <div ref={frame} className="film-screen">
            <video
              ref={video}
              src={FILM}
              poster={POSTER}
              muted={muted}
              playsInline
              loop
              preload="metadata"
              controls={reduced}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              aria-label="TypeNext film, 30 seconds"
            />
            {!reduced && (
              <div className="film-controls">
                <button type="button" className="film-button" onClick={toggleSound} aria-pressed={!muted}>
                  {muted ? 'Sound on' : 'Sound off'}
                </button>
                <button type="button" className="film-button" onClick={replay}>
                  {playing ? 'Replay' : 'Play'}
                </button>
              </div>
            )}
          </div>
          <p className="film-note">
            Recorded in TypeNext with its own suggestions and Whistle dictation. Music and motion are made for the film.{' '}
            <a href={FILM} download>
              Download the film
            </a>
          </p>
        </Reveal>
      </div>
    </section>
  )
}
