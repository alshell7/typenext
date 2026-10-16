import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUpRight, Check, KeyRound, LoaderCircle } from 'lucide-react'
import { Modal } from './Modal'
import { isDesktop, setSecret } from '../services/native'
import {
  dismissHuggingFacePrompt,
  getHuggingFacePrompt,
  HUGGING_FACE_SECRET,
  HUGGING_FACE_TOKEN_URL,
  huggingFaceIssue,
  requestHuggingFaceToken,
  subscribeHuggingFacePrompt,
  verifyHuggingFaceToken,
  type HuggingFacePrompt,
} from '../services/huggingface'
import {
  getEmbeddingRuntimeStatus,
  subscribeEmbeddingRuntime,
  EMBEDDING_RUNTIME,
} from '../services/embedding-runtime'
import {
  getSpeechRuntimeStatus,
  subscribeSpeechRuntime,
  SPEECH_RUNTIME,
} from '../services/speech-runtime'
import {
  getBuiltinState,
  subscribeBuiltinState,
} from '../services/builtin-engine'
import { BUILTIN_MODEL } from '../services/builtin-model'
import { getWhistleState, subscribeWhistleState } from '../services/whistle'
import { WHISTLE_MODEL } from '../services/whistle-model'
import './huggingface-guide.css'

interface Watch {
  source: NonNullable<HuggingFacePrompt['source']>
  model: string
  repository: string
  subscribe(listener: () => void): () => void
  issue(): ReturnType<typeof huggingFaceIssue>
}

/** Every download that can come from Hugging Face. */
const WATCHES: Watch[] = [
  {
    source: 'embedding',
    model: 'EmbeddingGemma 2',
    repository: EMBEDDING_RUNTIME.modelRepository,
    subscribe: subscribeEmbeddingRuntime,
    issue: () => {
      const status = getEmbeddingRuntimeStatus()
      return status.errorCode
        ? huggingFaceIssue(status.errorCode)
        : huggingFaceIssue(status.error)
    },
  },
  {
    source: 'speech',
    model: 'Fluid Speech Mini',
    repository: SPEECH_RUNTIME.modelRepository,
    subscribe: subscribeSpeechRuntime,
    issue: () => {
      const status = getSpeechRuntimeStatus()
      return huggingFaceIssue(status.errorCode ?? status.error)
    },
  },
  {
    source: 'builtin',
    model: 'SmolLM2',
    repository: BUILTIN_MODEL.id,
    subscribe: subscribeBuiltinState,
    issue: () => {
      const error = getBuiltinState().error
      return error?.startsWith('huggingface-') ? huggingFaceIssue(error) : null
    },
  },
  {
    source: 'whistle',
    model: 'Whistle',
    repository: WHISTLE_MODEL.id,
    subscribe: subscribeWhistleState,
    issue: () => {
      const error = getWhistleState().error
      return error?.startsWith('huggingface-') ? huggingFaceIssue(error) : null
    },
  },
]

/** Show the guide once for each new refusal, never for an old error. */
function useDownloadWatch() {
  const seen = useRef(new Map<string, string | null>())
  useEffect(() => {
    const stops = WATCHES.map(watch => {
      const check = () => {
        const issue = watch.issue()
        const previous = seen.current.get(watch.source) ?? null
        seen.current.set(watch.source, issue)
        if (issue && issue !== previous)
          requestHuggingFaceToken({
            issue,
            model: watch.model,
            repository: watch.repository,
            source: watch.source,
          })
      }
      seen.current.set(watch.source, watch.issue())
      return watch.subscribe(check)
    })
    return () => stops.forEach(stop => stop())
  }, [])
}

/**
 * A short, step-by-step guide when Hugging Face asks for a token. The token
 * is verified before it is saved, and is sent only to huggingface.co.
 */
export function HuggingFaceGuide({
  onRetry,
}: {
  /** Start the refused download again. */
  onRetry?(source: HuggingFacePrompt['source']): void
}) {
  useDownloadWatch()
  const prompt = useSyncExternalStore(
    subscribeHuggingFacePrompt,
    getHuggingFacePrompt,
    getHuggingFacePrompt
  )
  const [token, setToken] = useState('')
  const [remember, setRemember] = useState(isDesktop())
  const [state, setState] = useState<{
    phase: 'idle' | 'checking' | 'saved' | 'error'
    text: string
  }>({ phase: 'idle', text: '' })
  useEffect(() => {
    if (!prompt) {
      setToken('')
      setState({ phase: 'idle', text: '' })
    }
  }, [prompt])
  const save = async () => {
    setState({
      phase: 'checking',
      text: 'Checking the token with Hugging Face…',
    })
    try {
      const account = await verifyHuggingFaceToken(token)
      await setSecret(HUGGING_FACE_SECRET, token.trim(), remember)
      setState({
        phase: 'saved',
        text: `Saved. Signed in as ${account.name}.`,
      })
    } catch (error) {
      setState({
        phase: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const rateLimited = prompt?.issue === 'rate-limit'
  return (
    <Modal
      open={Boolean(prompt)}
      onOpenChange={open => {
        if (!open) dismissHuggingFacePrompt()
      }}
      title={
        rateLimited
          ? 'Hugging Face is limiting downloads'
          : 'Hugging Face asks you to sign in'
      }
      description={
        rateLimited
          ? `TypeNext downloads ${prompt?.model ?? 'the model'} from Hugging Face. Too many downloads came from your network without an account. A free token removes this limit.`
          : `TypeNext downloads ${prompt?.model ?? 'the model'} from Hugging Face. This model needs a free Hugging Face account and a read token.`
      }
      className="hf-guide"
    >
      <ol className="hf-guide-steps">
        <li>
          <span>Open Hugging Face and sign in, or create a free account.</span>
          <a
            className="button secondary is-compact"
            href={HUGGING_FACE_TOKEN_URL}
            target="_blank"
            rel="noreferrer"
          >
            Create a read token <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </li>
        <li>
          <span>
            Give the token a name, for example “TypeNext”. Keep the type{' '}
            <strong>Read</strong>. Select <strong>Create token</strong>, then
            copy it.
          </span>
        </li>
        {!rateLimited && prompt?.repository && (
          <li>
            <span>
              Open the model page. If it shows terms, read them and select{' '}
              <strong>Agree</strong>.
            </span>
            <a
              className="button subtle is-compact"
              href={`https://huggingface.co/${prompt.repository}`}
              target="_blank"
              rel="noreferrer"
            >
              Model page <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </li>
        )}
        <li>
          <span>Paste the token here.</span>
        </li>
      </ol>
      <form
        className="hf-guide-form"
        onSubmit={event => {
          event.preventDefault()
          if (token.trim()) void save()
        }}
      >
        <label className="field-label" htmlFor="hf-token">
          Hugging Face token
        </label>
        <div className="hf-guide-input">
          <KeyRound size={15} aria-hidden="true" />
          <input
            id="hf-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            placeholder="hf_…"
            onChange={event => {
              setToken(event.target.value)
              if (state.phase !== 'checking')
                setState({ phase: 'idle', text: '' })
            }}
          />
        </div>
        {isDesktop() && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={remember}
              onChange={event => setRemember(event.target.checked)}
            />
            Remember in the device credential vault
          </label>
        )}
        <p
          className={`hf-guide-status ${state.phase === 'error' ? 'is-error' : ''}`}
          role="status"
        >
          {state.text ||
            'TypeNext sends this token only to huggingface.co, and only to download models.'}
        </p>
        <div className="dialog-footer">
          <button
            type="button"
            className="button subtle"
            onClick={dismissHuggingFacePrompt}
          >
            Not now
          </button>
          {state.phase === 'saved' ? (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                const source = prompt?.source
                dismissHuggingFacePrompt()
                onRetry?.(source)
              }}
            >
              <Check size={15} /> Try the download again
            </button>
          ) : (
            <button
              type="submit"
              className="button primary"
              disabled={!token.trim() || state.phase === 'checking'}
            >
              {state.phase === 'checking' && (
                <LoaderCircle size={15} className="spin" />
              )}
              Check and save token
            </button>
          )}
        </div>
      </form>
    </Modal>
  )
}
