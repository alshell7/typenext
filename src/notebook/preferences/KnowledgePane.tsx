import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import {
  Download,
  LoaderCircle,
  Play,
  Plug,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { checkEmbeddingServer } from '../../services/embedding-client'
import {
  EMBEDDING_RUNTIME,
  cancelEmbeddingInstall,
  getEmbeddingRuntimeStatus,
  installEmbeddingRuntime,
  refreshEmbeddingRuntime,
  removeEmbeddingRuntime,
  resolveEmbeddingEndpoint,
  startEmbeddingRuntime,
  stopEmbeddingRuntime,
  subscribeEmbeddingRuntime,
  type EmbeddingRuntimeStatus,
} from '../../services/embedding-runtime'
import { MEDIA_LIMITS } from '../../services/media-sources'
import { isDesktop } from '../../services/native'
import {
  getSemanticIndexStatus,
  subscribeSemanticIndex,
} from '../../services/semantic-retrieval'
import type {
  EmbeddingDimensions,
  EmbeddingQuantization,
  NotebookSettings,
  SemanticSettings,
} from '../../types/notebook'
import {
  CommandBlock,
  Group,
  Pill,
  Row,
  Section,
  Segmented,
  StatusLine,
  SwitchRow,
  errorText,
  formatBytes,
  type Tone,
} from './controls'
import { KeyField } from './KeyField'
import type { PaneProps } from './types'

const QUANTIZATIONS = Object.keys(
  EMBEDDING_RUNTIME.models
) as EmbeddingQuantization[]

const DIMENSION_HELP: Record<EmbeddingDimensions, string> = {
  128: 'Smallest index and fastest search. Use it for text only.',
  256: 'Nearly lossless for text at half the size of 512.',
  512: 'The default balance of accuracy and index size.',
  768: 'Full width. The largest index, best with images and audio.',
}

function portOf(endpoint: string) {
  try {
    return new URL(endpoint).port || '8080'
  } catch {
    return '8080'
  }
}

export function serverCommand(semantic: SemanticSettings): string {
  const model = EMBEDDING_RUNTIME.models[semantic.quantization].file
  return [
    'llama-server',
    `-m ${model}`,
    ...(semantic.media ? [`--mmproj ${EMBEDDING_RUNTIME.media.file}`] : []),
    '--embeddings --pooling mean',
    '--ctx-size 8192 --batch-size 8192 --ubatch-size 8192',
    `--host 127.0.0.1 --port ${portOf(semantic.endpoint)}`,
  ].join(' ')
}

function runtimePill(status: EmbeddingRuntimeStatus, ready: boolean) {
  switch (status.state) {
    case 'unsupported':
      return <Pill>Desktop app only</Pill>
    case 'downloading':
      return <Pill tone="busy">Downloading</Pill>
    case 'starting':
      return <Pill tone="busy">Starting</Pill>
    case 'running':
      return <Pill tone="ok">Running</Pill>
    case 'error':
      return <Pill tone="error">Needs attention</Pill>
    default:
      return ready ? (
        <Pill tone="ok">Installed</Pill>
      ) : (
        <Pill>Not installed</Pill>
      )
  }
}

function ManagedRuntime({
  semantic,
  patch,
}: {
  semantic: SemanticSettings
  patch(next: Partial<SemanticSettings>): void
}) {
  const status = useSyncExternalStore(
    subscribeEmbeddingRuntime,
    getEmbeddingRuntimeStatus,
    getEmbeddingRuntimeStatus
  )
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void refreshEmbeddingRuntime().catch(error => {
      if (mounted.current)
        setFailure(errorText(error, 'The embedding runtime did not respond.'))
    })
    return () => {
      mounted.current = false
    }
  }, [])
  const run = async (name: string, action: () => Promise<unknown>) => {
    setPending(name)
    setFailure('')
    try {
      await action()
    } catch (error) {
      if (mounted.current)
        setFailure(errorText(error, 'The embedding runtime did not respond.'))
    } finally {
      if (mounted.current) setPending(null)
    }
  }
  const installed = status.installed
  const runtimeReady = installed.runtime
  const modelReady = installed.models.includes(semantic.quantization)
  const mediaReady = !semantic.media || installed.media
  const ready = runtimeReady && modelReady && mediaReady
  const needed =
    (runtimeReady ? 0 : EMBEDDING_RUNTIME.runtimeBytes) +
    (modelReady ? 0 : EMBEDDING_RUNTIME.models[semantic.quantization].bytes) +
    (mediaReady ? 0 : EMBEDDING_RUNTIME.media.bytes)
  const downloading = status.state === 'downloading'
  const progress = status.progress
  const fraction =
    progress && progress.totalBytes > 0
      ? Math.min(1, progress.downloadedBytes / progress.totalBytes)
      : 0
  const anythingInstalled =
    installed.runtime ||
    installed.models.length > 0 ||
    installed.media ||
    status.diskBytes > 0
  const message =
    failure ||
    status.error ||
    (status.state === 'running' && status.running
      ? `Running privately on this device with ${EMBEDDING_RUNTIME.models[status.running.quantization].label}.`
      : ready
        ? 'Installed. TypeNext starts it when semantic search is needed.'
        : `Downloads llama.cpp and EmbeddingGemma 2 from pinned, verified sources. Your notes are never sent.`)
  const tone: Tone = failure || status.error ? 'error' : 'neutral'
  return (
    <div
      className="pref-card pref-runtime"
      role="group"
      aria-label="Managed embedding runtime"
    >
      <div className="pref-card-heading">
        <div>
          <h4>EmbeddingGemma 2</h4>
          <p className="pref-help">
            llama.cpp {EMBEDDING_RUNTIME.llamaCppRelease} on a private loopback
            port
          </p>
        </div>
        {runtimePill(status, ready)}
      </div>
      <Row label="Quality">
        <Segmented
          label="Embedding quality"
          size="small"
          value={semantic.quantization}
          onChange={quantization => patch({ quantization })}
          options={QUANTIZATIONS.map(value => ({
            value,
            label: `${EMBEDDING_RUNTIME.models[value].label} · ${formatBytes(EMBEDDING_RUNTIME.models[value].bytes)}`,
            disabled: downloading,
          }))}
        />
      </Row>
      {downloading && (
        <div className="pref-progress">
          <div className="pref-progress-label">
            <span>{progress?.file ?? 'Preparing download'}</span>
            <span>
              {progress
                ? `${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)} · ${Math.floor(fraction * 100)}%`
                : 'Starting…'}
            </span>
          </div>
          <div
            className="pref-progress-track"
            role="progressbar"
            aria-label="Embedding model download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(fraction * 100)}
          >
            <span
              className="pref-progress-fill"
              style={{ '--progress': fraction } as CSSProperties}
            />
          </div>
        </div>
      )}
      <div className="pref-actions">
        {downloading ? (
          <button
            type="button"
            className="button secondary is-compact"
            disabled={pending === 'cancel'}
            onClick={() => {
              void run('cancel', cancelEmbeddingInstall)
            }}
          >
            <X size={14} /> Cancel download
          </button>
        ) : !ready ? (
          <button
            type="button"
            className="button primary is-compact"
            disabled={pending !== null || status.state === 'unsupported'}
            onClick={() => {
              void run('install', () =>
                installEmbeddingRuntime(semantic.quantization, semantic.media)
              )
            }}
          >
            {pending === 'install' ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Download size={14} />
            )}
            Download {formatBytes(needed)}
          </button>
        ) : status.state === 'running' ? (
          <button
            type="button"
            className="button secondary is-compact"
            disabled={pending !== null}
            onClick={() => {
              void run('stop', stopEmbeddingRuntime)
            }}
          >
            <Square size={13} /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="button secondary is-compact"
            disabled={pending !== null || status.state === 'starting'}
            onClick={() => {
              void run('start', () => startEmbeddingRuntime(semantic))
            }}
          >
            {pending === 'start' || status.state === 'starting' ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Play size={14} />
            )}
            Start
          </button>
        )}
        {anythingInstalled && !downloading && (
          <span className="pref-actions-end">
            {confirmRemove ? (
              <span
                className="pref-confirm"
                role="group"
                aria-label="Confirm removal"
              >
                <span>
                  Remove{' '}
                  {status.diskBytes
                    ? formatBytes(status.diskBytes)
                    : 'the files'}
                  ?
                </span>
                <button
                  type="button"
                  className="button subtle is-compact"
                  onClick={() => setConfirmRemove(false)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="button destructive is-compact"
                  disabled={pending !== null}
                  onClick={() => {
                    setConfirmRemove(false)
                    void run('remove', removeEmbeddingRuntime)
                  }}
                >
                  Remove
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="button subtle is-compact"
                disabled={pending !== null}
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
          </span>
        )}
      </div>
      <StatusLine tone={tone}>{message}</StatusLine>
      {status.diskBytes > 0 && (
        <p className="pref-help">
          Using {formatBytes(status.diskBytes)} on this device.
        </p>
      )}
    </div>
  )
}

function ConnectionCheck({ semantic }: { semantic: SemanticSettings }) {
  const [state, setState] = useState<{ tone: Tone; text: string }>({
    tone: 'neutral',
    text: '',
  })
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    request.current?.abort()
    setState({ tone: 'neutral', text: '' })
  }, [
    semantic.runtime,
    semantic.endpoint,
    semantic.quantization,
    semantic.media,
  ])
  const check = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setState({ tone: 'busy', text: 'Checking the embedding server…' })
    try {
      const endpoint = await resolveEmbeddingEndpoint(semantic)
      const info = await checkEmbeddingServer(endpoint, controller.signal)
      if (controller.signal.aborted) return
      const reads = [
        'text',
        ...(info.modalities.vision ? ['images'] : []),
        ...(info.modalities.audio ? ['audio'] : []),
        ...(info.modalities.video ? ['video'] : []),
      ]
      const list =
        reads.length > 1
          ? `${reads.slice(0, -1).join(', ')} and ${reads[reads.length - 1]}`
          : reads[0]
      setState({
        tone: 'ok',
        text: `Connected in ${info.latencyMs} ms. Reads ${list}.`,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({
        tone: 'error',
        text: errorText(error, 'The embedding server did not respond.'),
      })
    }
  }
  return (
    <div className="pref-check-row">
      <button
        type="button"
        className="button secondary is-compact"
        disabled={state.tone === 'busy'}
        onClick={() => {
          void check()
        }}
      >
        <Plug size={14} /> Check connection
      </button>
      <StatusLine tone={state.tone} reserve={false}>
        {state.text}
      </StatusLine>
    </div>
  )
}

function IndexStatus() {
  const index = useSyncExternalStore(
    subscribeSemanticIndex,
    getSemanticIndexStatus,
    getSemanticIndexStatus
  )
  const fraction = index.total ? Math.min(1, index.indexed / index.total) : 0
  const text =
    index.state === 'off'
      ? 'Not indexed yet. Indexing begins when this note has references.'
      : index.state === 'unavailable'
        ? 'Waiting for the embedding server.'
        : index.state === 'error'
          ? (index.error ?? 'Indexing stopped.')
          : `Indexed ${index.indexed} of ${index.total} passage${index.total === 1 ? '' : 's'}`
  return (
    <Row label="This note" description={text}>
      {index.state === 'indexing' || index.state === 'ready' ? (
        <span
          className="pref-meter"
          role="progressbar"
          aria-label="Semantic index progress"
          aria-valuemin={0}
          aria-valuemax={index.total}
          aria-valuenow={index.indexed}
          style={{ '--progress': fraction } as CSSProperties}
        >
          <span />
        </span>
      ) : index.state === 'error' ? (
        <Pill tone="error">Error</Pill>
      ) : (
        <Pill>Idle</Pill>
      )}
    </Row>
  )
}

export function KnowledgePane({ settings, update, latest }: PaneProps) {
  const semantic = settings.semantic
  const desktop = isDesktop()
  const runtime: SemanticSettings['runtime'] = desktop
    ? semantic.runtime
    : 'server'
  const patch = (next: Partial<SemanticSettings>) =>
    update({ semantic: { ...latest().semantic, ...next } })
  const effective = { ...semantic, runtime }
  return (
    <>
      <div className="pref-hero">
        <p>
          <strong>Semantic search</strong> finds passages by meaning, even when
          the words differ. <strong>BM25</strong> finds passages with matching
          words. TypeNext uses both to pick the references beside your cursor.
        </p>
      </div>
      <Section title="Semantic search">
        <Group>
          <SwitchRow
            label="Semantic search"
            description="Index your references with EmbeddingGemma 2, on this device."
            checked={semantic.enabled}
            onChange={enabled => patch({ enabled })}
          />
          {semantic.enabled && <IndexStatus />}
          <Row
            label="Run with"
            description={
              desktop
                ? runtime === 'managed'
                  ? 'TypeNext downloads and runs the model for you.'
                  : 'Start llama.cpp yourself with the command below.'
                : 'The browser preview needs your own server.'
            }
          >
            <Segmented
              label="Run with"
              value={runtime}
              onChange={value => patch({ runtime: value })}
              options={[
                {
                  value: 'managed',
                  label: 'Inside TypeNext',
                  disabled: !desktop,
                  title: desktop ? undefined : 'Needs the desktop app',
                },
                { value: 'server', label: 'My own server' },
              ]}
            />
          </Row>
        </Group>
        <div className="pref-reveal" key={runtime}>
          {runtime === 'managed' ? (
            <ManagedRuntime semantic={semantic} patch={patch} />
          ) : (
            <div className="pref-card pref-form">
              <label className="pref-field-label" htmlFor="embedding-endpoint">
                Embedding server
              </label>
              <input
                id="embedding-endpoint"
                type="url"
                spellCheck={false}
                value={semantic.endpoint}
                placeholder="http://127.0.0.1:8080"
                onChange={event => patch({ endpoint: event.target.value })}
              />
              <p className="pref-help">
                A llama.cpp server on localhost. Start it with:
              </p>
              <CommandBlock
                label="Server command"
                command={serverCommand(semantic)}
              />
              <label className="pref-field-label" htmlFor="embedding-quant">
                Model file
              </label>
              <select
                id="embedding-quant"
                value={semantic.quantization}
                onChange={event =>
                  patch({
                    quantization: event.target.value as EmbeddingQuantization,
                  })
                }
              >
                {QUANTIZATIONS.map(value => (
                  <option key={value} value={value}>
                    {EMBEDDING_RUNTIME.models[value].file} (
                    {formatBytes(EMBEDDING_RUNTIME.models[value].bytes)})
                  </option>
                ))}
              </select>
              <p className="pref-help">
                From{' '}
                <a
                  href={`https://huggingface.co/${EMBEDDING_RUNTIME.modelRepository}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {EMBEDDING_RUNTIME.modelRepository}
                </a>
                .
              </p>
            </div>
          )}
        </div>
        <ConnectionCheck semantic={effective} />
      </Section>
      <Section title="Index">
        <Group>
          <Row
            label="Vector size"
            description={`${DIMENSION_HELP[semantic.dimensions]} Changing it re-indexes your references.`}
          >
            <Segmented
              label="Vector size"
              size="small"
              value={semantic.dimensions}
              onChange={dimensions => patch({ dimensions })}
              options={([128, 256, 512, 768] as EmbeddingDimensions[]).map(
                value => ({ value, label: String(value) })
              )}
            />
          </Row>
          <SwitchRow
            label="Images, audio and video"
            description={
              <>
                Adds the media encoder (
                {formatBytes(EMBEDDING_RUNTIME.media.bytes)}
                {runtime === 'server' ? ', started with --mmproj' : ''}). Images
                up to {MEDIA_LIMITS.image.label}, audio up to{' '}
                {MEDIA_LIMITS.audio.label}, video up to{' '}
                {MEDIA_LIMITS.video.label}.
              </>
            }
            checked={semantic.media}
            onChange={media => patch({ media })}
          />
        </Group>
      </Section>
      <WebsiteImport settings={settings} update={update} />
    </>
  )
}

function WebsiteImport({
  settings,
  update,
}: {
  settings: NotebookSettings
  update: PaneProps['update']
}) {
  return (
    <Section
      title="Website import"
      description="Ordinary websites are read directly. Firecrawl can help with sites that need JavaScript; it receives the website URL."
    >
      <Group>
        <Row label="Website importer" htmlFor="website-importer">
          <select
            id="website-importer"
            value={settings.websiteImporter}
            onChange={event =>
              update({
                websiteImporter: event.target
                  .value as NotebookSettings['websiteImporter'],
              })
            }
          >
            <option value="direct">Direct import</option>
            <option value="firecrawl">Firecrawl (external service)</option>
          </select>
        </Row>
      </Group>
      {settings.websiteImporter === 'firecrawl' && (
        <div className="pref-reveal pref-card pref-form">
          <KeyField id="firecrawl" label="Firecrawl API key" />
        </div>
      )}
    </Section>
  )
}
