import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type SetStateAction,
} from 'react'
import type { CloudSyncSettings, Workspace } from '../../types/notebook'
import {
  CloudController,
  getCloudSyncState,
  subscribeCloudSync,
} from './controller'

let controller: CloudController | null = null

/** Sync now from anywhere in the interface. */
export function cloudSyncNow(): Promise<boolean> {
  return controller ? controller.syncAll() : Promise.resolve(false)
}

/** Reconnect after databases, credentials or keys changed. */
export function reloadCloudSync(): Promise<void> {
  return controller
    ? controller.configure(controllerSettings)
    : Promise.resolve()
}

export function refreshCloudDevices(): Promise<void> {
  return controller ? controller.readDevices() : Promise.resolve()
}

export function cloudDeviceId(): string | null {
  return controller?.device ?? null
}

let controllerSettings: CloudSyncSettings

/** What changes need a reconnect, as opposed to a new cadence or selection. */
function connectionKey(settings: CloudSyncSettings) {
  return JSON.stringify({
    enabled: settings.enabled,
    targets: settings.targets.map(target => [
      target.id,
      target.enabled,
      target.vaultId,
      target.realtimeUrl,
      target.accountId,
      target.databaseId,
    ]),
  })
}

/**
 * Keep the notebook in sync with its databases. Notebook changes only
 * reset timers here; the work happens in the controller, off render.
 */
export function useCloudSync(
  workspace: Workspace,
  getWorkspace: () => Workspace,
  setWorkspace: (action: SetStateAction<Workspace>) => void,
  notify: (message: string) => void,
  ready: boolean
) {
  const settings = workspace.settings.cloud
  const io = useRef({ getWorkspace, setWorkspace, notify })
  io.current = { getWorkspace, setWorkspace, notify }
  controllerSettings = settings

  useEffect(() => {
    const instance = new CloudController(
      {
        getWorkspace: () => io.current.getWorkspace(),
        setWorkspace: action => io.current.setWorkspace(action),
        notify: message => io.current.notify(message),
      },
      controllerSettings
    )
    controller = instance
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(version =>
        instance.setIo({
          getWorkspace: () => io.current.getWorkspace(),
          setWorkspace: action => io.current.setWorkspace(action),
          notify: message => io.current.notify(message),
          appVersion: version,
        })
      )
      .catch(() => {})
    const onVisibility = () => instance.visibilityChanged()
    const onOnline = () => instance.wake()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onOnline)
      instance.dispose()
      if (controller === instance) controller = null
    }
  }, [])

  const key = connectionKey(settings)
  useEffect(() => {
    if (!ready) return
    void controller?.configure(controllerSettings)
  }, [key, ready])

  useEffect(() => {
    controller?.update(settings)
  }, [settings])

  useEffect(() => {
    if (ready) controller?.noteChanged(workspace)
  }, [workspace, ready])
}

export function useCloudSyncState() {
  return useSyncExternalStore(
    subscribeCloudSync,
    getCloudSyncState,
    getCloudSyncState
  )
}
