import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Download, LoaderCircle, Power, Trash2, X } from 'lucide-react'
import {
  checkBuiltinCache,
  downloadBuiltinModel,
  getBuiltinState,
  getBuiltinBackendPreference,
  loadBuiltinModel,
  removeBuiltinModel,
  subscribeBuiltinState,
  unloadBuiltinModel,
  type BuiltinBackend,
} from '../services/builtin-engine'
import { BUILTIN_MODEL } from '../services/builtin-model'
import './BuiltinModelPanel.css'

export interface BuiltinModelPanelProps {
  active: boolean
  onUse(): void
  onDisable?(): void
}

export function BuiltinModelPanel({
  active,
  onUse,
  onDisable,
}: BuiltinModelPanelProps) {
  const state = useSyncExternalStore(
    subscribeBuiltinState,
    getBuiltinState,
    getBuiltinState
  )
  const [backend, setBackend] = useState<BuiltinBackend>(
    getBuiltinBackendPreference
  )
  const [message, setMessage] = useState('')
  const controller = useRef<AbortController | null>(null)
  const busy = ['checking', 'downloading', 'loading', 'generating'].includes(
    state.status
  )
  const ready = state.status === 'ready' || state.status === 'generating'
  useEffect(() => {
    void checkBuiltinCache()
  }, [])
  // Closing Preferences keeps an already loaded model available to the editor.
  // The explicit Cancel/Unload controls terminate work; no automatic download runs.
  const run = async (download: boolean) => {
    controller.current?.abort()
    const task = new AbortController()
    controller.current = task
    setMessage('')
    try {
      if (download) await downloadBuiltinModel({ backend, signal: task.signal })
      else await loadBuiltinModel({ backend, signal: task.signal })
      setMessage('Ready. Choose Use this model when you want local inference.')
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError'))
        setMessage(
          error instanceof Error
            ? error.message
            : 'The offline model could not start.'
        )
    } finally {
      if (controller.current === task) controller.current = null
    }
  }
  const unload = () => {
    controller.current?.abort()
    unloadBuiltinModel()
    onDisable?.()
    setMessage('Model unloaded. Writing starters are still available.')
  }
  const remove = async () => {
    setMessage('')
    onDisable?.()
    try {
      await removeBuiltinModel()
      setMessage('Downloaded model removed from this device.')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The model could not be removed.'
      )
    }
  }
  const status =
    state.status === 'ready'
      ? active
        ? 'In use'
        : 'Ready'
      : state.status === 'generating'
        ? 'Writing a suggestion'
        : state.status === 'downloading'
          ? 'Downloading'
          : state.status === 'loading'
            ? 'Loading from this device'
            : state.status === 'checking'
              ? 'Checking device storage'
              : state.cached
                ? 'Downloaded'
                : 'Optional download'
  return (
    <section className="builtin-model" aria-label="Built-in offline model">
      <div className="builtin-model-heading">
        <div>
          <h3>{BUILTIN_MODEL.name}</h3>
        </div>
        <span className={`builtin-model-status ${ready ? 'is-ready' : ''}`}>
          {busy ? (
            <LoaderCircle size={13} className="spin" />
          ) : ready ? (
            <Check size={13} />
          ) : (
            <span className="builtin-status-dot" />
          )}
          {status}
        </span>
      </div>
      <p className="builtin-model-description">
        A small English writing model, without a separate app or server.
        Download once, then load it from your device whenever you need it.
      </p>
      <div className="builtin-model-facts">
        <span>139 MB download</span>
        <span>Apache 2.0</span>
        <span>Short suggestions</span>
      </div>
      {state.status === 'downloading' && (
        <div className="builtin-download-progress">
          <progress
            aria-label="Offline model download progress"
            value={state.progress}
            max={100}
          />
          <span>
            {Math.floor(state.downloadedBytes / 1_000_000)} / 139 MB{' '}
            <span>{Math.floor(state.progress)}%</span>
          </span>
        </div>
      )}
      <div className="builtin-model-actions">
        {state.status === 'downloading' || state.status === 'loading' ? (
          <button className="button secondary" onClick={unload}>
            <X size={14} /> Cancel
          </button>
        ) : ready ? (
          <>
            {!active && (
              <button className="button primary" onClick={onUse}>
                <Check size={14} /> Use this model
              </button>
            )}
            <button className="button secondary" onClick={unload}>
              <Power size={14} /> Unload model
            </button>
          </>
        ) : (
          <button
            className="button primary"
            disabled={busy || state.status === 'unavailable'}
            onClick={() => {
              void run(!state.cached)
            }}
          >
            {state.cached ? <Power size={14} /> : <Download size={14} />}
            {state.cached ? 'Load downloaded model' : 'Download model'}
          </button>
        )}
        {state.cached && !busy && (
          <button
            className="button subtle builtin-remove"
            onClick={() => {
              void remove()
            }}
            aria-label="Remove downloaded offline model"
          >
            <Trash2 size={14} /> Remove
          </button>
        )}
      </div>
      <p className="builtin-model-message" role="status">
        {message ||
          state.error ||
          (ready
            ? `${state.backend === 'webgpu' ? 'GPU acceleration' : 'CPU mode'} · unloads after five idle minutes, or when you close TypeNext.`
            : state.cached
              ? 'Loading uses the device cache and makes no model download requests.'
              : 'Download contacts Hugging Face for model files. It never sends your notes.')}
      </p>
      <details className="builtin-model-details">
        <summary>Performance and model limits</summary>
        <label className="field-label" htmlFor="builtin-backend">
          Run the offline model with
        </label>
        <select
          id="builtin-backend"
          value={backend}
          disabled={ready || busy}
          onChange={event => setBackend(event.target.value as BuiltinBackend)}
        >
          <option value="auto">Automatic · GPU when available</option>
          <option value="wasm">CPU · widest compatibility</option>
          <option value="webgpu">GPU · requires WebGPU</option>
        </select>
        <p>
          This tiny model can help continue a thought, but may miss instructions
          or invent details. Review each insertion. It understands English best
          and uses a short context window. Allow about 1 GB of free memory for
          CPU inference; actual use depends on your device. CPU mode can be
          slower. Unload it to free memory, or let the five minute idle timer do
          that for you.
        </p>
        <a
          href={`https://huggingface.co/${BUILTIN_MODEL.original}`}
          target="_blank"
          rel="noreferrer"
        >
          Model details and license
        </a>
      </details>
    </section>
  )
}
