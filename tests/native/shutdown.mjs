/** A closing WebView may disappear before its final IPC reply reaches CDP. */
export function isClosedTargetError(error) {
  return (
    error instanceof Error &&
    error.message.includes('Target page, context or browser has been closed')
  )
}

export async function waitForNormalNativeQuit(
  child,
  action,
  { timeoutMs = 10_000 } = {}
) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(
      'The native application stopped before the quit action was dispatched.'
    )
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error('Invalid native quit timeout.')

  let onExit, onError, timer
  const exit = new Promise((resolve, reject) => {
    onError = reject
    onExit = (code, signal) => {
      if (code !== 0 || signal !== null)
        reject(
          new Error(
            `Native app quit abnormally: code=${code}, signal=${signal}.`
          )
        )
      else if (child.exitCode !== 0 || child.signalCode !== null)
        reject(
          new Error(
            'Native exit event did not confirm a stopped process with exit code 0.'
          )
        )
      else resolve({ exitCode: code, signal })
    }
    // Subscribe before dispatch so fast exits cannot be missed.
    child.once('exit', onExit)
    child.once('error', onError)
  })
  const reply = Promise.resolve()
    .then(action)
    .then(
      () => ({ targetClosedBeforeReply: false }),
      error => {
        if (!isClosedTargetError(error)) throw error
        return { targetClosedBeforeReply: true }
      }
    )
  try {
    const [response, stopped] = await Promise.race([
      Promise.all([reply, exit]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Native save/quit did not complete with a confirmed normal exit.'
              )
            ),
          timeoutMs
        )
      }),
    ])
    return { ...stopped, ...response }
  } finally {
    clearTimeout(timer)
    child.removeListener('exit', onExit)
    child.removeListener('error', onError)
  }
}
