import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, Download, LoaderCircle, Power, Trash2, X } from 'lucide-react'
import {
  checkWhistleCache,
  downloadWhistleModel,
  getWhistleState,
  loadWhistleModel,
  removeWhistleModel,
  subscribeWhistleState,
  unloadWhistleModel,
} from '../services/whistle'
import './whistle.css'

export function WhistleModelPanel() {
  const state = useSyncExternalStore(
    subscribeWhistleState,
    getWhistleState,
    getWhistleState
  )
  const [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    void checkWhistleCache()
    return () => {
      request.current?.abort()
    }
  }, [])
  const busy = ['checking', 'downloading', 'loading', 'transcribing'].includes(
    state.status
  )
  const ready = state.status === 'ready' || state.status === 'transcribing'
  const run = async () => {
    const controller = new AbortController()
    request.current?.abort()
    request.current = controller
    setMessage('')
    try {
      if (!state.cached)
        await downloadWhistleModel({ signal: controller.signal })
      else await loadWhistleModel({ signal: controller.signal })
      if (!controller.signal.aborted)
        setMessage(
          state.cached
            ? 'Loaded for offline dictation.'
            : 'Downloaded. You can record offline now.'
        )
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof Error ? error.message : 'Whistle could not start.'
        )
    } finally {
      if (request.current === controller) request.current = null
    }
  }
  const remove = async () => {
    try {
      await removeWhistleModel()
      setMessage('Whistle removed from this device.')
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The model could not be removed.'
      )
    }
  }
  return (
    <section className="whistle-model" aria-label="Offline dictation model">
      <div className="whistle-model-heading">
        <h3>Whistle</h3>
        <span className="whistle-model-state">
          {busy ? (
            <LoaderCircle size={13} className="spin" />
          ) : ready || state.cached ? (
            <Check size={13} />
          ) : null}
          {state.status === 'downloading'
            ? 'Downloading'
            : state.status === 'loading'
              ? 'Loading'
              : state.status === 'checking'
                ? 'Checking storage'
                : ready
                  ? 'Ready'
                  : state.cached
                    ? 'Downloaded'
                    : 'Optional download'}
        </span>
      </div>
      <p>
        Turn speech into words on this device. A one-time 17 MB download
        supports seven languages, with no separate server.
      </p>
      {state.status === 'downloading' && (
        <div className="whistle-progress">
          <progress
            aria-label="Whistle download progress"
            max={100}
            value={state.progress}
          />
          <span>{Math.floor(state.progress)}%</span>
        </div>
      )}
      <div className="whistle-model-actions">
        {state.status === 'downloading' || state.status === 'loading' ? (
          <button
            className="button secondary"
            onClick={() => {
              request.current?.abort()
              unloadWhistleModel()
            }}
          >
            <X size={14} /> Cancel setup
          </button>
        ) : ready ? (
          <button
            className="button secondary"
            disabled={busy}
            onClick={unloadWhistleModel}
          >
            <Power size={14} /> Unload model
          </button>
        ) : (
          <button
            className="button primary"
            disabled={busy || state.status === 'unavailable'}
            onClick={() => {
              void run()
            }}
          >
            {state.cached ? <Power size={14} /> : <Download size={14} />}
            {state.cached
              ? 'Load downloaded model'
              : 'Download Whistle · 17 MB'}
          </button>
        )}
        {state.cached && !busy && (
          <button
            className="button subtle"
            onClick={() => {
              void remove()
            }}
          >
            <Trash2 size={14} /> Remove download
          </button>
        )}
      </div>
      <p className="whistle-model-message" role="status">
        {message ||
          state.error ||
          (state.cached
            ? 'Audio stays on this device. The model unloads after a minute without use.'
            : 'Download contacts Hugging Face for the public model file. It sends no audio or notes.')}
      </p>
    </section>
  )
}
