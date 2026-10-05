import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { waitForNormalNativeQuit } from './shutdown.mjs'

const targetClosed = () =>
  new Error('page.evaluate: Target page, context or browser has been closed')
function fakeChild() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
}
function stop(child, code = 0, signal = null) {
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
}
test('normal quit observes an exit even when it precedes the action reply', async () => {
  const child = fakeChild()
  const result = await waitForNormalNativeQuit(child, () => {
    stop(child)
  })
  assert.deepEqual(result, {
    exitCode: 0,
    signal: null,
    targetClosedBeforeReply: false,
  })
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('error'), 0)
})
test('target closure before the normal exit event is an expected quit race', async () => {
  const child = fakeChild()
  const result = await waitForNormalNativeQuit(child, () => {
    queueMicrotask(() => stop(child))
    throw targetClosed()
  })
  assert.deepEqual(result, {
    exitCode: 0,
    signal: null,
    targetClosedBeforeReply: true,
  })
})
test('target closure after normal process exit is also accepted', async () => {
  const child = fakeChild()
  const result = await waitForNormalNativeQuit(child, () => {
    stop(child)
    throw targetClosed()
  })
  assert.equal(result.targetClosedBeforeReply, true)
})
test('target closure never masks a nonzero exit or signal termination', async () => {
  for (const [code, signal] of [
    [7, null],
    [null, 'SIGTERM'],
  ]) {
    const child = fakeChild()
    await assert.rejects(
      waitForNormalNativeQuit(child, () => {
        stop(child, code, signal)
        throw targetClosed()
      }),
      /quit abnormally/u
    )
    assert.equal(child.listenerCount('exit'), 0)
  }
})
test('an exit event without actual stopped-state metadata is rejected', async () => {
  const child = fakeChild()
  await assert.rejects(
    waitForNormalNativeQuit(child, () => {
      child.emit('exit', 0, null)
      throw targetClosed()
    }),
    /did not confirm a stopped process/u
  )
})
test('a process already stopped before dispatch cannot count as a successful quit', async () => {
  const child = fakeChild()
  stop(child)
  let dispatched = false
  await assert.rejects(
    waitForNormalNativeQuit(child, () => {
      dispatched = true
      throw targetClosed()
    }),
    /before the quit action/u
  )
  assert.equal(dispatched, false)
})
test('unrelated action failures remain failures despite a normal exit', async () => {
  const child = fakeChild(),
    failure = new Error('The save operation failed')
  await assert.rejects(
    waitForNormalNativeQuit(child, () => {
      stop(child)
      throw failure
    }),
    error => error === failure
  )
})
test('a closed WebView with a live native process times out and removes listeners', async () => {
  const child = fakeChild()
  await assert.rejects(
    waitForNormalNativeQuit(
      child,
      () => {
        throw targetClosed()
      },
      { timeoutMs: 20 }
    ),
    /confirmed normal exit/u
  )
  assert.equal(child.exitCode, null)
  assert.equal(child.listenerCount('exit'), 0)
  assert.equal(child.listenerCount('error'), 0)
})
test('spawn/process errors are preserved and do not leave listeners behind', async () => {
  const child = fakeChild(),
    failure = new Error('Native process failed')
  await assert.rejects(
    waitForNormalNativeQuit(child, () => {
      child.emit('error', failure)
    }),
    error => error === failure
  )
  assert.equal(child.listenerCount('exit'), 0)
})
test('real child process exit codes are checked when CDP rejects its final reply', async t => {
  for (const code of [0, 9]) {
    const child = spawn(
      process.execPath,
      ['-e', `process.stdin.once('data', () => process.exit(${code}))`],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
    )
    t.after(() => {
      if (child.exitCode === null) child.kill()
    })
    const operation = waitForNormalNativeQuit(
      child,
      () => {
        child.stdin.end('quit')
        throw targetClosed()
      },
      { timeoutMs: 5_000 }
    )
    if (code === 0)
      assert.deepEqual(await operation, {
        exitCode: 0,
        signal: null,
        targetClosedBeforeReply: true,
      })
    else await assert.rejects(operation, /code=9/u)
    assert.equal(child.exitCode, code)
    assert.equal(child.signalCode, null)
  }
})
