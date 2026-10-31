/**
 * Neon Realtime: the database tells this device the moment another device
 * writes, instead of being asked every few seconds. Two read-only live
 * queries are watched: the newest revision of the notebook and the device
 * list. Each query is sealed here with the Realtime secret (the writer's own
 * database, so this device is trusted) and renewed before its seal expires.
 * The SDK loads only when Live updates are configured.
 */

export interface LiveWatch {
  stop(): void
}

export interface LiveCallbacks {
  onHead(head: number): void
  onDevices(): void
  onStatus(live: boolean, message?: string): void
}

const RENEW_EARLY_MS = 12_000
const RETRY_MS = 5_000

export async function watchVault(
  options: {
    url: string
    secret: string
    database: string
    vaultId: string
    webSocketFactory?: (url: string, protocols?: string | string[]) => WebSocket
  },
  callbacks: LiveCallbacks
): Promise<LiveWatch> {
  const [{ createRealtime, rawSql }, { createRealtimeClient }] =
    await Promise.all([
      import('@neon/realtime/server'),
      import('@neon/realtime/client'),
    ])
  const sealer = createRealtime({
    secret: options.secret,
    db: options.database,
  })
  const client = createRealtimeClient({
    url: options.url,
    ...(options.webSocketFactory
      ? { webSocketFactory: options.webSocketFactory }
      : {}),
  })
  const queries = [
    rawSql<{ head: string | null }>(
      'select max(rev)::text as head from typenext_records where vault = $1',
      [options.vaultId]
    ),
    rawSql<{ seen: string }>(
      'select device, seen::text as seen from typenext_devices where vault = $1',
      [options.vaultId]
    ),
  ] as const
  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (run: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!stopped) run()
    }, delay)
    timers.add(timer)
  }
  const statuses = ['connecting', 'connecting']
  const report = () => {
    const live = statuses.every(status => status === 'live')
    callbacks.onStatus(
      live,
      statuses.includes('error')
        ? 'Live updates stopped. Syncing on a timer.'
        : undefined
    )
  }

  const watch = async (index: 0 | 1) => {
    const sealed = await sealer.seal({ query: queries[index] })
    const subscription = client.subscribe(sealed)
    const renew = (expiresAt: number) =>
      later(
        async () => {
          try {
            const next = await sealer.seal({ query: queries[index] })
            await subscription.renew(next)
            renew(next.expiresAt)
          } catch {
            later(() => renew(Date.now() + RENEW_EARLY_MS), RETRY_MS)
          }
        },
        Math.max(1_000, expiresAt - Date.now() - RENEW_EARLY_MS)
      )
    renew(sealed.expiresAt)
    subscription.onStateChange(state => {
      statuses[index] = state.status
      report()
    })
    subscription.onChange(snapshot => {
      if (index === 0) {
        const head = Number(
          (snapshot.data as { head: string | null }[])[0]?.head ?? 0
        )
        callbacks.onHead(Number.isFinite(head) ? head : 0)
      } else callbacks.onDevices()
    })
  }

  try {
    await Promise.all([watch(0), watch(1)])
  } catch (error) {
    client.close()
    throw error
  }
  return {
    stop() {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      client.close()
    },
  }
}
