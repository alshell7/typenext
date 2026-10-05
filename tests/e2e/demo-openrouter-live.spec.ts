import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Only the public, fictional demo may leave this isolated test context. */
const enabled = process.env.TYPENEXT_DEMO_OPENROUTER === '1'
const dryRun = process.env.TYPENEXT_DEMO_OPENROUTER_DRY_RUN === '1'
const model =
  process.env.TYPENEXT_DEMO_MODEL ??
  process.env.TYPENEXT_LIVE_MODEL ??
  'nvidia/nemotron-3.5-lightning:free'
const endpoint = 'https://openrouter.ai/api/v1/chat/completions'
const fragment = 'Guests arrive at Bramble House'
const title = 'A morning at Bramble House'
const arrivalFact = 'Guests arrive at Bramble House on Friday at 16:00.'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test.describe.configure({ retries: 0, timeout: 120_000 })

interface CatalogModel {
  id: string
  pricing?: { prompt?: string; completion?: string; request?: string }
  reasoning?: { mandatory?: boolean }
}
interface RequestBody {
  model?: string
  max_tokens?: number
  reasoning?: { enabled?: boolean; exclude?: boolean }
  messages?: { role?: string; content?: string }[]
}
interface WritingData {
  noteTitle?: string
  objective?: string
  beforeCursor?: string
  afterCursor?: string
  references?: { name?: string; text?: string }[]
}

function redacted(value: string, secret: string): string {
  return value
    .replaceAll(secret || 'unused-secret-marker', '[redacted]')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/gu, '[redacted]')
    .slice(0, 220)
}

async function keyFromIgnoredFile(): Promise<string> {
  const credentials = await readFile(resolve('CREDENTIALS.txt'), 'utf8')
  const key = credentials.match(/sk-or-v1-[A-Za-z0-9_-]+/u)?.[0]
  if (!key)
    throw new Error(
      'No OpenRouter key was found in the ignored credentials file.'
    )
  return key
}

async function setSessionKey(input: Locator, secret: string): Promise<void> {
  // Avoid locator.fill(secret), whose value can appear in a failed call log.
  await input.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    if (!setter) throw new Error('The password input setter is unavailable.')
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, secret)
}

async function preferences(
  page: Page,
  pane: 'Local suggestions' | 'External models'
) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog.getByRole('tab', { name: pane, exact: true }).click()
  return dialog
}

async function writingText(editor: Locator): Promise<string> {
  return editor.evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll('.cm-ghost-suggestion')
      .forEach(ghost => ghost.remove())
    return Array.from(
      clone.querySelectorAll('.cm-line'),
      line => line.textContent ?? ''
    ).join('\n')
  })
}

test('the shipped demo grounds one real free automatic OpenRouter suggestion after typing', async ({
  page,
}, testInfo) => {
  test.skip(
    !enabled && !dryRun,
    'Set TYPENEXT_DEMO_OPENROUTER=1 for the authorized real synthetic-demo check.'
  )

  let secret = ''
  let allowed = false
  let hostedAttempts = 0
  let permittedRequests = 0
  let promptIsGrounded = false
  let boundedRequest = false
  let inferenceError = ''
  const evidence: Record<string, unknown> = {
    model,
    mode: dryRun
      ? 'synthetic response; no inference API call'
      : 'real free API',
    demo: 'Bramble House fictional sample',
    trigger: 'typing and automatic pause; no Ctrl/Command Space',
    expectedArrival: 'Friday at 16:00',
    outcome: 'not run',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  }
  try {
    const catalogResponse = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(30_000),
    })
    evidence.catalogHttpStatus = catalogResponse.status
    evidence.catalogCheckedAt = new Date().toISOString()
    if (!catalogResponse.ok)
      throw new Error(
        `Public model catalog returned HTTP ${catalogResponse.status}.`
      )
    const catalog = (await catalogResponse.json()) as { data?: CatalogModel[] }
    const selected = catalog.data?.find(candidate => candidate.id === model)
    if (
      !selected ||
      selected.pricing?.prompt !== '0' ||
      selected.pricing.completion !== '0' ||
      Number(selected.pricing.request ?? 0) !== 0 ||
      selected.reasoning?.mandatory
    )
      throw new Error(
        'The configured smoke model is unavailable, paid, or requires reasoning. No inference request was sent.'
      )
    evidence.inputPrice = selected.pricing.prompt
    evidence.outputPrice = selected.pricing.completion
    evidence.requestPrice = selected.pricing.request ?? '0'
    secret = dryRun ? 'synthetic-session-key' : await keyFromIgnoredFile()

    await page.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        return route.continue()
      if (url.hostname === 'openrouter.ai' && request.method() === 'OPTIONS') {
        if (dryRun)
          return route.fulfill({
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-methods': 'POST, OPTIONS',
              'access-control-allow-headers': 'authorization, content-type',
            },
          })
        return route.continue()
      }
      hostedAttempts += 1
      if (
        request.url() !== endpoint ||
        request.method() !== 'POST' ||
        !allowed ||
        permittedRequests >= 1
      )
        return route.abort('blockedbyclient')
      const body = request.postDataJSON() as RequestBody
      let data: WritingData = {}
      try {
        data = JSON.parse(
          body.messages?.find(message => message.role === 'user')?.content ??
            '{}'
        ) as WritingData
      } catch {
        inferenceError = 'The request did not carry structured writing context.'
      }
      const system =
        body.messages?.find(message => message.role === 'system')?.content ?? ''
      boundedRequest =
        body.model === model &&
        typeof body.max_tokens === 'number' &&
        body.max_tokens > 0 &&
        body.max_tokens <= 64 &&
        body.reasoning?.enabled === false &&
        body.reasoning.exclude === true &&
        !system.includes('"insertions"')
      promptIsGrounded =
        data.noteTitle === title &&
        data.beforeCursor?.endsWith(fragment) === true &&
        data.afterCursor === '' &&
        data.references?.some(
          reference =>
            reference.name === 'house.md' &&
            reference.text?.includes(arrivalFact)
        ) === true
      const correctCredential =
        request.headers().authorization === `Bearer ${secret}`
      if (
        !boundedRequest ||
        !promptIsGrounded ||
        !correctCredential ||
        JSON.stringify(body).includes(secret)
      ) {
        inferenceError =
          'The automatic request failed its synthetic-context, credential or budget guard. No inference request was sent.'
        return route.abort('blockedbyclient')
      }
      // Reserve the single permitted POST before continuing the network call.
      permittedRequests += 1
      if (dryRun)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            choices: [
              {
                message: { content: ' on Friday at 16:00.' },
                finish_reason: 'stop',
              },
            ],
            usage: { cost: 0 },
          }),
        })
      return route.continue()
    })

    await page.goto('/')
    await page
      .getByRole('button', { name: 'Try a sample', exact: true })
      .click()
    await expect(
      page.getByRole('textbox', { name: 'Note title', exact: true })
    ).toHaveValue(title)
    const editor = page.getByRole('textbox', {
      name: 'Note content',
      exact: true,
    })
    const original = await writingText(editor)
    expect(original.endsWith(fragment)).toBe(true)

    let dialog = await preferences(page, 'Local suggestions')
    await dialog
      .getByRole('switch', { name: /^Suggest after a pause/ })
      .uncheck()
    await dialog.getByLabel('Pause before suggesting').selectOption('1800')
    await dialog.getByLabel('Suggestion length').selectOption('short')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    // Re-type only the unfinished sample line; retain its public introduction.
    await editor.fill(original.slice(0, -fragment.length))

    dialog = await preferences(page, 'External models')
    await dialog.getByLabel('Configure provider').selectOption('openrouter')
    await dialog.getByLabel('Model', { exact: true }).fill(model)
    await setSessionKey(dialog.getByLabel('API key', { exact: true }), secret)
    await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
    await expect(
      dialog.getByText('Ready for this session.', { exact: true })
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    expect(hostedAttempts, 'Configuration must not send writing.').toBe(0)

    dialog = await preferences(page, 'Local suggestions')
    await dialog.getByRole('switch', { name: /^Suggest after a pause/ }).check()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await page
      .getByRole('button', { name: 'Choose suggestion engine', exact: true })
      .click()
    const chooser = page.getByRole('dialog', {
      name: 'Choose your suggestion engine',
    })
    await chooser
      .getByRole('group', { name: 'External providers' })
      .getByRole('button', { name: 'OpenRouter', exact: true })
      .click()
    await chooser
      .getByRole('button', { name: 'Use OpenRouter continuously', exact: true })
      .click()
    expect(
      hostedAttempts,
      'Deliberate activation alone must not send writing.'
    ).toBe(0)

    await editor.focus()
    await editor.press('Control+End')
    const responsePromise = page.waitForResponse(
      response =>
        response.url() === endpoint && response.request().method() === 'POST',
      { timeout: dryRun ? 12_000 : 70_000 }
    )
    allowed = true
    const started = Date.now()
    await editor.pressSequentially(fragment, { delay: 15 })
    const response = await responsePromise
    allowed = false
    evidence.httpStatus = response.status()
    evidence.latencyIncludingTypingAndPauseMs = Date.now() - started
    const json = (await response.json()) as {
      error?: { message?: string }
      choices?: { message?: { content?: string }; finish_reason?: string }[]
      usage?: { cost?: number }
    }
    if (!response.ok() || json.error) {
      const detail = redacted(
        json.error?.message ?? 'The provider rejected the request.',
        secret
      )
      evidence.outcome = `Provider error: ${detail}`
      throw new Error(
        `Demo OpenRouter returned HTTP ${response.status()}: ${detail}`
      )
    }
    if (typeof json.usage?.cost === 'number') {
      evidence.reportedCost = json.usage.cost
      expect(
        json.usage.cost,
        'Freshly verified free generation must report zero cost.'
      ).toBe(0)
    }
    evidence.finishReason = json.choices?.[0]?.finish_reason ?? 'unknown'
    const raw = json.choices?.[0]?.message?.content ?? ''
    if (raw.includes(secret) || /sk-or-v1-[A-Za-z0-9_-]+/u.test(raw)) {
      await page.goto('about:blank')
      throw new Error('Sensitive provider output was discarded.')
    }
    const ghost = page.locator('.cm-ghost-text')
    await expect(ghost).toBeVisible({ timeout: 10_000 })
    const insertion = (await ghost.textContent()) ?? ''
    expect(
      Boolean(insertion.trim()),
      'A real automatic insertion must be visible.'
    ).toBe(true)
    evidence.insertion = insertion
    evidence.rawModelText = raw.slice(0, 500)
    const friday = /\bFri(?:day)?\b/iu.test(insertion)
    const time = /\b16[:.]00\b|\b4(?::00)?\s*p\.?\s*m\.?\b/iu.test(insertion)
    evidence.arrivalDayCorrect = friday
    evidence.arrivalTimeCorrect = time
    // Report model fact quality independently of transport/acceptance. No retry.
    expect
      .soft(
        friday && time,
        'The continuation should retain Friday at 16:00 from the retrieved demo.'
      )
      .toBe(true)
    expect(await writingText(editor)).toBe(original)

    // End the deliberately activated mode after this single automatic offer.
    await page
      .getByRole('button', { name: 'Choose suggestion engine', exact: true })
      .click()
    await page.getByRole('button', { name: /On this device/ }).click()
    // Opening the chooser correctly dismisses the ghost; verify the generated
    // text and preserved writing without asking for a second insertion.
    expect(await writingText(editor)).toBe(original)
    const keyPersisted = await page.evaluate(
      value =>
        Object.values(localStorage).some(stored => stored.includes(value)),
      secret
    )
    expect(keyPersisted, 'The browser key must remain session-only.').toBe(
      false
    )
    expect(promptIsGrounded).toBe(true)
    expect(boundedRequest).toBe(true)
    expect(permittedRequests).toBe(1)
    expect(hostedAttempts).toBe(1)
    evidence.previewDidNotModifyDocument = true
    evidence.returnedToLocal = true
    evidence.outcome =
      friday && time ? 'passed' : 'transport passed; arrival facts differed'
  } catch (failure) {
    allowed = false
    if (evidence.outcome === 'not run')
      evidence.outcome =
        inferenceError || 'failed before a successful automatic suggestion'
    throw failure
  } finally {
    allowed = false
    // Playwright can save DOM error context even with visual artifacts off.
    await page
      .locator('input[type="password"]')
      .evaluateAll(elements => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set
        elements.forEach(element => {
          setter?.call(element, '')
          element.dispatchEvent(new Event('input', { bubbles: true }))
        })
      })
      .catch(() => undefined)
    evidence.hostedAttempts = hostedAttempts
    evidence.permittedRequests = permittedRequests
    evidence.realInferencePosts = dryRun ? 0 : permittedRequests
    evidence.promptIncludedArrivalFact = promptIsGrounded
    evidence.boundedRequest = boundedRequest
    const directory = resolve('artifacts/demo-openrouter-live')
    await mkdir(directory, { recursive: true })
    const modelSlug = model.replace(/[^A-Za-z0-9.-]+/gu, '-')
    const resultSlug = evidence.outcome === 'passed' ? 'passed' : 'failed'
    const reportName = `${dryRun ? 'dry-run' : 'live'}-${modelSlug}-http-${evidence.httpStatus ?? 'none'}-${resultSlug}-posts-${dryRun ? 0 : permittedRequests}-${Date.now()}.json`
    evidence.retainedReport = reportName
    const summary = JSON.stringify(evidence, null, 2)
    await writeFile(resolve(directory, reportName), summary + '\n', {
      flag: 'wx',
    })
    await writeFile(
      resolve(directory, dryRun ? 'dry-run.json' : 'live.json'),
      summary + '\n'
    )
    await testInfo.attach('safe-demo-summary', {
      body: Buffer.from(summary),
      contentType: 'application/json',
    })
    console.info('Demo OpenRouter summary:', JSON.stringify(evidence))
    secret = ''
  }
})
