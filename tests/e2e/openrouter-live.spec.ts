import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Explicit opt-in only. Credentials never enter source, snapshots or traces. */
const enabled = process.env.TYPENEXT_LIVE_OPENROUTER === '1'
const dryRun = process.env.TYPENEXT_LIVE_DRY_RUN === '1'
const model = process.env.TYPENEXT_LIVE_MODEL ?? 'qwen/qwen3.8-27b:free'
const prefix = 'At dawn, the garden'
const suffix = ' while the city was still asleep.'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test.describe.configure({ retries: 0, timeout: 120_000 })

interface CatalogModel {
  id: string
  pricing?: { prompt?: string; completion?: string; request?: string }
  reasoning?: { mandatory?: boolean; default_enabled?: boolean }
}

async function setSessionKey(input: Locator, secret: string): Promise<void> {
  // locator.fill can put its argument in a failure call log. Evaluate an input
  // event instead; live traces are disabled and this argument stays in memory.
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

async function openExternalSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  await page.getByRole('tab', { name: 'External models' }).click()
}

test('live free model requires explicit consent and inserts only at the cursor', async ({
  page,
}, testInfo) => {
  test.skip(
    !enabled && !dryRun,
    'Set TYPENEXT_LIVE_OPENROUTER=1 to run this authorized live check.'
  )

  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(30_000),
  })
  if (!catalogResponse.ok)
    throw new Error(
      `The public model catalog returned HTTP ${catalogResponse.status}.`
    )
  const catalog = (await catalogResponse.json()) as { data?: CatalogModel[] }
  const selected = catalog.data?.find(candidate => candidate.id === model)
  if (
    !selected ||
    selected.pricing?.prompt !== '0' ||
    selected.pricing.completion !== '0' ||
    Number(selected.pricing.request ?? 0) !== 0 ||
    selected.reasoning?.mandatory
  ) {
    throw new Error(
      'The fixed smoke model is unavailable, costs money, or requires reasoning. No request was sent.'
    )
  }

  const credentials = dryRun
    ? ''
    : await readFile(resolve('CREDENTIALS.txt'), 'utf8')
  let secret = dryRun
    ? 'synthetic-session-key'
    : (credentials.match(/sk-or-v1-[A-Za-z0-9_-]+/u)?.[0] ?? '')
  if (!secret)
    throw new Error(
      'No OpenRouter credential was found in the ignored credentials file.'
    )

  let hostedRequests = 0
  let permittedRequests = 0
  let requestWasBounded = false
  let promptHadBothSides = false
  const evidence: Record<string, unknown> = {
    model,
    mode: dryRun ? 'mock transport; no API request' : 'real API',
    inputPrice: selected.pricing.prompt,
    outputPrice: selected.pricing.completion,
    outcome: 'not run',
  }

  // A live test must never spend money or send an accidental second request.
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      await route.continue()
      return
    }
    if (url.hostname === 'openrouter.ai' && request.method() === 'OPTIONS') {
      if (dryRun)
        await route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type',
          },
        })
      else await route.continue()
      return
    }
    hostedRequests += 1
    if (
      url.hostname !== 'openrouter.ai' ||
      url.pathname !== '/api/v1/chat/completions' ||
      request.method() !== 'POST' ||
      permittedRequests >= 1
    ) {
      await route.abort('blockedbyclient')
      return
    }
    const body = request.postDataJSON() as {
      model?: string
      max_tokens?: number
      reasoning?: { enabled?: boolean; exclude?: boolean }
      messages?: { role?: string; content?: string }[]
    }
    requestWasBounded =
      body.model === model &&
      typeof body.max_tokens === 'number' &&
      body.max_tokens > 0 &&
      body.max_tokens <= 64 &&
      body.reasoning?.enabled === false &&
      body.reasoning.exclude === true
    const writerData = JSON.parse(
      body.messages?.find(message => message.role === 'user')?.content ?? '{}'
    ) as {
      beforeCursor?: string
      afterCursor?: string
    }
    promptHadBothSides =
      writerData.beforeCursor === prefix && writerData.afterCursor === suffix
    if (!requestWasBounded || !promptHadBothSides) {
      await route.abort('blockedbyclient')
      return
    }
    permittedRequests += 1
    if (dryRun) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          choices: [
            {
              message: { content: ' held the scent of morning rain' },
              finish_reason: 'stop',
            },
          ],
          usage: { cost: 0 },
        }),
      })
    } else await route.continue()
  })

  try {
    await page.goto('/')
    await openExternalSettings(page)
    await page.getByLabel('Configure provider').selectOption('openrouter')
    await page.getByLabel('Model', { exact: true }).fill(model)
    await setSessionKey(page.getByLabel('API key', { exact: true }), secret)
    await page.getByRole('button', { name: 'Save key', exact: true }).click()
    await expect(
      page.getByText('Ready for this session.', { exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Done', exact: true }).click()

    await page
      .getByRole('button', { name: 'Start a note', exact: true })
      .click()
    await page
      .getByLabel('Title', { exact: true })
      .fill('Synthetic live completion check')
    await page
      .getByLabel(/^Context for suggestions/)
      .fill(
        'A quiet sentence about fresh morning air. Fill only a natural short phrase at the cursor. Keep the existing words on both sides.'
      )
    await page.getByRole('button', { name: 'Create note', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Note content' })
    await editor.fill(prefix + suffix)
    await editor.press('Control+End')
    for (let i = 0; i < suffix.length; i += 1) await editor.press('ArrowLeft')
    // An automatic pause and the ordinary manual shortcut must stay local.
    await page.waitForTimeout(1_350)
    await editor.press('Control+Space')
    await page.waitForTimeout(200)
    expect(
      hostedRequests,
      'Routine suggestions must not contact a hosted provider.'
    ).toBe(0)

    await page
      .getByRole('button', { name: 'Choose suggestion engine', exact: true })
      .click()
    await expect(
      page.getByRole('dialog', { name: 'Choose your suggestion engine' })
    ).toBeVisible()
    expect(
      hostedRequests,
      'Opening the consent dialog must not send writing.'
    ).toBe(0)
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click()
    expect(hostedRequests, 'Cancelling must not send writing.').toBe(0)

    await page
      .getByRole('button', { name: 'Choose suggestion engine', exact: true })
      .click()
    const responsePromise = page.waitForResponse(
      response =>
        response.url() === 'https://openrouter.ai/api/v1/chat/completions' &&
        response.request().method() === 'POST',
      { timeout: dryRun ? 10_000 : 70_000 }
    )
    const started = Date.now()
    await page
      .getByRole('button', { name: 'Use OpenRouter continuously', exact: true })
      .click()
    await editor.focus()
    await editor.press('Control+Space')
    const response = await responsePromise
    evidence.httpStatus = response.status()
    evidence.latencyMs = Date.now() - started
    const responseBody = (await response.json()) as {
      error?: {
        message?: string
        metadata?: { raw?: string; provider_name?: string }
      }
      choices?: { message?: { content?: string }; finish_reason?: string }[]
      usage?: { cost?: number }
    }
    if (!response.ok() || responseBody.error) {
      let upstreamDetail = responseBody.error?.metadata?.raw ?? ''
      try {
        const upstream = JSON.parse(upstreamDetail) as {
          error?: { message?: string }
          message?: string
        }
        upstreamDetail = upstream.error?.message ?? upstream.message ?? ''
      } catch {
        // A bounded provider error string is useful; never dump its metadata.
      }
      const detail = [
        responseBody.error?.message ?? 'The provider rejected the request.',
        upstreamDetail,
      ]
        .filter(Boolean)
        .join(' ')
        .replaceAll(secret, '[redacted]')
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/gu, '[redacted]')
        .slice(0, 220)
      evidence.outcome = `Provider error: ${detail}`
      throw new Error(
        `Live OpenRouter returned HTTP ${response.status()}: ${detail}`
      )
    }
    evidence.finishReason =
      responseBody.choices?.[0]?.finish_reason ?? 'unknown'
    if (typeof responseBody.usage?.cost === 'number')
      evidence.reportedCost = responseBody.usage.cost
    const ghost = page.locator('.cm-ghost-text')
    await expect(ghost).toBeVisible({ timeout: 10_000 })
    const insertion = (await ghost.textContent()) ?? ''
    expect(
      Boolean(insertion.trim()),
      'A meaningful visible insertion is required.'
    ).toBe(true)
    if (insertion.includes(secret))
      throw new Error(
        'The provider output contained sensitive data and was discarded.'
      )
    evidence.insertion = insertion
    evidence.insertionWords = insertion.trim().split(/\s+/u).length
    evidence.prefix = prefix
    evidence.suffix = suffix

    // Ghost text has not changed the document. Accepting inserts precisely there.
    const textWithoutGhost = await editor.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement
      clone
        .querySelectorAll('.cm-ghost-suggestion')
        .forEach(ghostElement => ghostElement.remove())
      return clone.textContent
    })
    expect(textWithoutGhost).toBe(prefix + suffix)
    await editor.press('Tab')
    await expect(ghost).toHaveCount(0)
    await expect(editor).toHaveText(prefix + insertion + suffix)
    expect(await editor.textContent()).toBe(prefix + insertion + suffix)
    evidence.reconstruction = prefix + insertion + suffix
    evidence.prefixAndSuffixPreserved = true
    expect(requestWasBounded).toBe(true)
    expect(promptHadBothSides).toBe(true)
    expect(permittedRequests).toBe(1)
    expect(hostedRequests).toBe(1)

    await page.getByRole('button', { name: 'Choose suggestion engine' }).click()
    await page.getByRole('button', { name: /On this device/ }).click()
    await editor.press('Control+End')
    await editor.press('Control+Space')
    await page.waitForTimeout(200)
    expect(
      hostedRequests,
      'Switching back to local must stop hosted requests.'
    ).toBe(1)
    const keyPersisted = await page.evaluate(
      value => Object.values(localStorage).some(item => item.includes(value)),
      secret
    )
    expect(
      keyPersisted,
      'API keys must not be persisted in browser storage.'
    ).toBe(false)
    evidence.outcome = 'passed'
  } catch (error) {
    if (evidence.outcome === 'not run')
      evidence.outcome = 'failed before a successful insertion'
    throw error
  } finally {
    // Playwright may save an accessibility error context even with traces and
    // screenshots off. Clear password controls before that context is captured.
    await page
      .locator('input[type="password"]')
      .evaluateAll(elements => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value'
        )?.set
        for (const element of elements) {
          setter?.call(element, '')
          element.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      .catch(() => undefined)
    evidence.hostedRequests = hostedRequests
    evidence.permittedRequests = permittedRequests
    evidence.trace = 'off'
    evidence.screenshot = 'off'
    evidence.video = 'off'
    console.info('OpenRouter live smoke:', JSON.stringify(evidence))
    await testInfo.attach('safe-live-summary', {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: 'application/json',
    })
    // The isolated browser context is destroyed by Playwright after the test.
    secret = ''
  }
})
