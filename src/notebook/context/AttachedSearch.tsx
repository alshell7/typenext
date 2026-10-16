import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Search } from 'lucide-react'
import type {
  Note,
  NotebookSettings,
  RetrievedChunk,
} from '../../types/notebook'
import { retrieveContext } from '../../services/retrieval'
import { retrieveHybrid } from '../../services/semantic-retrieval'
import { semanticOn, semanticStatusLabel, useSemanticStatus } from './media'
import { GroupIcon } from './source-kinds'

const MATCH_LABELS: Record<NonNullable<RetrievedChunk['match']>, string> = {
  lexical: 'words',
  semantic: 'meaning',
  hybrid: 'both',
}
const MATCH_TITLES: Record<NonNullable<RetrievedChunk['match']>, string> = {
  lexical: 'Matched your words',
  semantic: 'Matched by meaning',
  hybrid: 'Matched words and meaning',
}

/** Explicit search over the note's included context; never runs on typing. */
export function AttachedSearch({
  resolved,
  enabled,
  settings,
}: {
  resolved: Note
  enabled: number
  settings?: NotebookSettings
}) {
  const semantic = semanticOn(settings)
  const status = useSemanticStatus(semantic)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [retrieval, setRetrieval] = useState<{
    snapshot: (string | boolean)[]
    results: RetrievedChunk[]
  } | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const snapshot = [
    resolved.id,
    ...resolved.sources.flatMap(source => [
      source.id,
      source.name,
      source.text,
      source.enabled,
    ]),
  ]
  const current =
    retrieval &&
    retrieval.snapshot.length === snapshot.length &&
    retrieval.snapshot.every((value, index) => value === snapshot[index])
  const statusLabel = semantic ? semanticStatusLabel(status) : ''
  const progress =
    status.state === 'indexing' && status.total
      ? Math.min(1, status.indexed / status.total)
      : null

  function cancel() {
    controller.current?.abort()
    controller.current = null
    setPending(false)
  }

  return (
    <details className="context-attached-search">
      <summary>
        <Search size={14} aria-hidden="true" /> Find in attached context
        {statusLabel && progress !== null && (
          <span className="context-index-dot" aria-hidden="true" />
        )}
      </summary>
      <p>
        {semantic
          ? 'Matches your words with BM25 and their meaning with EmbeddingGemma, on this device. Suggestions receive only matching excerpts.'
          : 'BM25 finds relevant passages on this device; model receives only matching excerpts.'}
      </p>
      {statusLabel && (
        <div
          className={`context-index-status is-${status.state}`}
          role="status"
        >
          <span>{statusLabel}</span>
          {progress !== null && (
            <span className="context-index-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${progress})` }} />
            </span>
          )}
        </div>
      )}
      <form
        onSubmit={event => {
          event.preventDefault()
          const text = query
          if (!text.trim() || !enabled) return
          const taken = snapshot
          if (!settings || !semantic) {
            setRetrieval({
              snapshot: taken,
              results: retrieveContext(resolved, text, 4),
            })
            return
          }
          controller.current?.abort()
          const signal = new AbortController()
          controller.current = signal
          setPending(true)
          retrieveHybrid(resolved, text, settings, {
            limit: 4,
            signal: signal.signal,
          })
            .catch(() => retrieveContext(resolved, text, 4))
            .then(results => {
              if (signal.signal.aborted) return
              controller.current = null
              setPending(false)
              setRetrieval({ snapshot: taken, results })
            })
        }}
      >
        <label className="field-label" htmlFor="attached-context-search">
          Search attached references
        </label>
        <div className="context-attached-query">
          <input
            id="attached-context-search"
            type="search"
            value={query}
            placeholder={
              semantic
                ? 'A detail, idea, or picture'
                : 'A detail, phrase, or topic'
            }
            maxLength={4000}
            onChange={event => {
              setQuery(event.target.value)
              setRetrieval(null)
              if (pending) cancel()
            }}
          />
          <button
            type="submit"
            className="button secondary"
            disabled={!query.trim() || !enabled || pending}
          >
            {pending && <LoaderCircle size={13} className="spin" />}
            Find passages
          </button>
        </div>
      </form>
      {!enabled && (
        <p className="context-attached-empty">
          Include a reference above to search its text.
        </p>
      )}
      {pending && (
        <p className="context-attached-empty" role="status">
          Searching your context…
        </p>
      )}
      {current && !pending && (
        <div
          className="context-attached-results"
          aria-label="Matching context passages"
        >
          <p role="status">
            {retrieval.results.length
              ? `${retrieval.results.length} matching ${retrieval.results.length === 1 ? 'passage' : 'passages'}`
              : 'No matching passages. Try another phrase.'}
          </p>
          {retrieval.results.map((passage, index) => (
            <article key={`${passage.sourceId}-${index}`}>
              <header>
                {passage.mediaKind && (
                  <GroupIcon group={passage.mediaKind} size={12} />
                )}
                <h4>{passage.sourceName}</h4>
                {semantic && passage.match && (
                  <span
                    className={`context-match is-${passage.match}`}
                    title={MATCH_TITLES[passage.match]}
                  >
                    {MATCH_LABELS[passage.match]}
                  </span>
                )}
              </header>
              <p>{passage.text}</p>
            </article>
          ))}
        </div>
      )}
      {retrieval && !current && !pending && (
        <p role="status" className="context-attached-empty">
          References changed. Search again for current passages.
        </p>
      )}
    </details>
  )
}
