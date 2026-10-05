import {
  expect,
  test,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test'
import type { BuiltinPrompt } from '../../src/services/builtin-model'

const workspaceKey = 'typenext.workspace.v1'
const appOrigin = 'http://127.0.0.1:1420'
interface WorkerFixture {
  loads: number
  prompts: BuiltinPrompt[]
}
interface FixtureOutput {
  raw: string
  echoPrefix?: boolean
}

const editor = (page: Page) =>
  page.getByRole('textbox', { name: 'Note content', exact: true })
const choices = (page: Page) =>
  page.getByRole('listbox', { name: 'Suggestions', exact: true })

async function preferences(page: Page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Make yourself at home' })
  await dialog
    .getByRole('tab', { name: 'Local suggestions', exact: true })
    .click()
  return dialog
}

async function createNote(page: Page) {
  await page.getByRole('button', { name: 'Start a note', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Where would you like to begin?',
  })
  await dialog.getByLabel('Title', { exact: true }).fill('A patient morning')
  await dialog.getByRole('button', { name: 'Create note', exact: true }).click()
  await expect(editor(page)).toBeVisible()
  return editor(page)
}

async function writingText(content: Locator) {
  return content.evaluate(element => {
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

async function savedText(page: Page) {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const workspace = JSON.parse(raw) as {
      activeNoteId: string
      notes: { id: string; content: string }[]
    }
    return workspace.notes.find(note => note.id === workspace.activeNoteId)
      ?.content
  }, workspaceKey)
}

async function workerState(worker: Worker): Promise<WorkerFixture> {
  return worker.evaluate(
    () =>
      (globalThis as unknown as { __builtinOutputFixture: WorkerFixture })
        .__builtinOutputFixture
  )
}

async function setupEmbedded(
  page: Page,
  output: FixtureOutput,
  automatic: boolean
) {
  const outgoing: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.context().on('request', request => {
    if (
      /^https?:/u.test(request.url()) &&
      new URL(request.url()).origin !== appOrigin
    )
      outgoing.push(request.url())
  })
  // This fixture bypasses only model weights/inference. The real dedicated worker
  // transport, engine lifecycle, completion filtering/fallback and editor stay real.
  await page.context().route('**/*', async route => {
    if (
      /^https?:/u.test(route.request().url()) &&
      new URL(route.request().url()).origin !== appOrigin
    )
      await route.abort()
    else await route.continue()
  })
  await page
    .context()
    .route('**/src/services/builtin-engine.worker.ts*', async route => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
      const output = ${JSON.stringify(output)};
      self.__builtinOutputFixture = { loads: 0, prompts: [] };
      self.onmessage = ({data: command}) => {
        if (command.type === 'cancel') return;
        if (command.type === 'load') self.__builtinOutputFixture.loads += 1;
        if (command.type === 'generate') self.__builtinOutputFixture.prompts.push(command.prompt);
        const text = command.type === 'generate'
          ? (output.echoPrefix ? command.prompt.beforeCursor : '') + output.raw : '';
        self.postMessage({ type: 'done', id: command.id, text, backend: 'wasm' });
      };
    `,
      })
    })
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
  // Tiny responses advertise the pinned metadata only in this fresh test cache.
  // The synthetic worker never reads them and no real model is downloaded.
  await page.evaluate(async () => {
    const modulePath = '/src/services/builtin-model.ts'
    const model = (await import(
      modulePath
    )) as typeof import('../../src/services/builtin-model')
    const cache = await caches.open(model.BUILTIN_MODEL.cache)
    for (const file of model.BUILTIN_MODEL.files) {
      await cache.put(
        model.builtinFileUrl(file.name),
        new Response('', {
          headers: {
            'content-length': String(file.bytes),
            'x-typenext-sha256': file.sha256,
          },
        })
      )
    }
  })
  const content = await createNote(page)
  const dialog = await preferences(page)
  await dialog
    .getByRole('switch', { name: /^Suggest after a pause/ })
    .setChecked(automatic)
  await dialog.getByLabel('Pause before suggesting').selectOption('650')
  await dialog.getByLabel('Suggestion length').selectOption('short')
  const panel = dialog.getByRole('region', { name: 'Built-in offline model' })
  const nextWorker = page.waitForEvent('worker')
  await panel
    .getByRole('button', { name: 'Load downloaded model', exact: true })
    .click()
  const worker = await nextWorker
  expect(worker.url()).toContain('/src/services/builtin-engine.worker.ts')
  await panel
    .getByRole('button', { name: 'Use this model', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  expect((await workerState(worker)).loads).toBe(1)
  return { content, worker, outgoing, errors }
}

async function assertStarterPreview(page: Page) {
  const ghost = page.locator('.cm-ghost-text')
  await expect(ghost).toBeVisible()
  await expect(page.locator('.suggestion-message')).toContainText(
    'Writing starter'
  )
  const insertion = (await ghost.textContent())!
  expect(insertion.trim()).not.toBe('')
  expect(insertion).not.toMatch(/<|>|&lt;|&gt;|```|MODEL_CODE|boilerplate/iu)
  return insertion
}

const malformedOutputs: { name: string; output: FixtureOutput }[] = [
  {
    name: 'screenshot-like HTML with an echoed prose prefix',
    output: {
      echoPrefix: true,
      raw: '</p>\n<pre><code>const content = "MODEL_CODE";</code></pre><p>Unrelated boilerplate</p>',
    },
  },
  {
    name: 'markup after a useful first sentence, before clipping',
    output: { raw: ' make a little room. <div>Unrelated boilerplate</div>' },
  },
  {
    name: 'escaped HTML markup',
    output: {
      raw: ' &lt;html&gt;&lt;body&gt;Unrelated boilerplate&lt;/body&gt;&lt;/html&gt;',
    },
  },
  {
    name: 'a fenced Python response',
    output: { raw: "```python\nprint('MODEL_CODE')\n```" },
  },
]

for (const fixture of malformedOutputs) {
  test(`embedded prose rejects ${fixture.name} for automatic ghost and manual choices`, async ({
    page,
  }) => {
    const { content, worker, outgoing, errors } = await setupEmbedded(
      page,
      fixture.output,
      true
    )
    await content.fill('I want t')
    await content.press('o')
    await expect
      .poll(async () => (await workerState(worker)).prompts.length)
      .toBe(1)
    const automaticInsertion = await assertStarterPreview(page)
    await expect(choices(page)).toHaveCount(0)
    expect(await writingText(content)).toBe('I want to')
    await content.press('Tab')
    expect(await writingText(content)).toBe('I want to' + automaticInsertion)
    await content.press('Control+z')
    expect(await writingText(content)).toBe('I want to')

    const settings = await preferences(page)
    await settings
      .getByRole('switch', { name: /^Suggest after a pause/ })
      .uncheck()
    await settings.getByRole('button', { name: 'Done', exact: true }).click()
    // A different cursor prompt forces the manual path through actual generation
    // rather than accepting the already-filtered automatic cache entry.
    await content.fill('The next step is')
    await content.press('Control+End')
    await content.press('Control+Space')
    await expect
      .poll(async () => (await workerState(worker)).prompts.length)
      .toBe(2)
    const menu = choices(page)
    await expect(menu).toBeVisible()
    const optionCount = await menu.getByRole('option').count()
    expect(optionCount).toBeGreaterThanOrEqual(1)
    expect(optionCount).toBeLessThanOrEqual(3)
    for (const option of await menu.getByRole('option').all()) {
      await expect(option).toContainText('Writing starter')
      await expect(
        option.locator('.cm-suggestion-option-text')
      ).not.toContainText(/<|>|&lt;|&gt;|```|MODEL_CODE|boilerplate/iu)
    }
    const manualInsertion = await assertStarterPreview(page)
    await content.press('Enter')
    await expect(menu).toHaveCount(0)
    expect(await writingText(content)).toBe(
      'The next step is' + manualInsertion
    )
    await expect
      .poll(() => savedText(page))
      .toBe('The next step is' + manualInsertion)
    await content.press('Control+z')
    await expect.poll(() => savedText(page)).toBe('The next step is')
    expect(
      (await workerState(worker)).prompts.map(prompt => prompt.inCode)
    ).toEqual([false, false])
    expect(
      outgoing,
      'Rejected local output must never trigger model downloads, localhost server inference or cloud fallback'
    ).toEqual([])
    expect(errors).toEqual([])
  })
}

test('an unmatched prose cursor with malformed embedded output stays unchanged without any model fallback', async ({
  page,
}) => {
  const { content, worker, outgoing, errors } = await setupEmbedded(
    page,
    { raw: '<div>Unrelated boilerplate</div>' },
    false
  )
  const original = 'I’m just testing if'
  await content.fill(original)
  await content.press('Control+End')
  await content.press('Control+Space')
  await expect
    .poll(async () => (await workerState(worker)).prompts.length)
    .toBe(1)
  await expect(page.locator('.suggestion-message')).toContainText(
    'Try a new line'
  )
  await expect(page.locator('.cm-ghost-suggestion')).toHaveCount(0)
  await expect(choices(page)).toHaveCount(0)
  expect(await writingText(content)).toBe(original)
  await expect.poll(() => savedText(page)).toBe(original)
  expect(outgoing).toEqual([])
  expect(errors).toEqual([])
})

test('the author’s actual fenced HTML context still accepts embedded code between the unchanged prefix and suffix', async ({
  page,
}) => {
  const insertion = '  <span>quiet morning</span>'
  const { content, worker, outgoing, errors } = await setupEmbedded(
    page,
    { raw: insertion },
    false
  )
  const prefix = 'An example:\n\n```html\n<div>\n'
  const suffix = '\n</div>\n```\n'
  const original = prefix + suffix
  await content.fill(original)
  await content.press('Control+Home')
  for (let index = 0; index < prefix.length; index++)
    await content.press('ArrowRight')
  await content.press('Control+Space')
  await expect
    .poll(async () => (await workerState(worker)).prompts.length)
    .toBe(1)
  const prompt = (await workerState(worker)).prompts[0]!
  expect(prompt.inCode).toBe(true)
  expect(prompt.beforeCursor).toBe(prefix)
  expect(prompt.afterCursor).toBe(suffix)
  await expect(page.locator('.cm-ghost-text')).toHaveText(insertion)
  await expect(
    choices(page).getByRole('option', { selected: true })
  ).toContainText('Local model')
  expect(await writingText(content)).toBe(original)
  await content.press('Tab')
  await expect(choices(page)).toHaveCount(0)
  expect(await writingText(content)).toBe(prefix + insertion + suffix)
  await expect.poll(() => savedText(page)).toBe(prefix + insertion + suffix)
  await content.press('Control+z')
  await expect.poll(() => savedText(page)).toBe(original)
  expect(outgoing).toEqual([])
  expect(errors).toEqual([])
})
