import { readFileSync } from 'node:fs'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { noteEditor, startNote } from './support/notes'
import { fresh, openCloud, setSecret } from './support/cloud'

/**
 * Two devices through a real Neon database, opt-in with
 * TYPENEXT_LIVE_SYNC=1 and Neon credentials in .env. It needs a database
 * without a TypeNext notebook yet, and erases the one it creates. Secrets
 * enter inputs through events; traces and screenshots on failure are off.
 */
test.use({ trace: 'off', screenshot: 'off', video: 'off' })
test.describe.configure({ retries: 0, timeout: 180_000 })

const live = process.env.TYPENEXT_LIVE_SYNC === '1'

function env(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync('.env', 'utf8')
        .split('\n')
        .filter(line => line.includes('=') && !line.trim().startsWith('#'))
        .map(line => {
          const index = line.indexOf('=')
          return [
            line.slice(0, index).trim(),
            line
              .slice(index + 1)
              .trim()
              .replace(/^["']|["']$/gu, ''),
          ]
        })
    )
  } catch {
    return {}
  }
}

const secrets = live ? env() : {}

async function neonQuery(query: string, params: unknown[] = []) {
  const connection = secrets.NEON_POSTGRES_CONN_STRING!
  const response = await fetch(`https://${new URL(connection).hostname}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': connection,
    },
    body: JSON.stringify({ query, params }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json()) as { rows?: Record<string, unknown>[] }
  if (!response.ok) throw new Error(`Neon returned HTTP ${response.status}.`)
  return body.rows ?? []
}

async function vaultIds(): Promise<string[]> {
  try {
    const rows = await neonQuery('select vault from typenext_vaults')
    return rows.map(row => String(row.vault))
  } catch {
    return []
  }
}

async function device(browser: Browser, name: string) {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  await fresh(page)
  return { context, page, name }
}

async function connectNeon(page: Page) {
  const dialog = await openCloud(page)
  await dialog.getByRole('button', { name: /Neon Postgres/ }).click()
  await setSecret(
    dialog.getByLabel('Connection string'),
    secrets.NEON_POSTGRES_CONN_STRING!
  )
  await dialog.getByLabel('Realtime URL').fill(secrets.NEON_REALTIME_URL!)
  await setSecret(
    dialog.getByLabel('Realtime secret'),
    secrets.NEON_REALTIME_SECRET!
  )
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  return dialog
}

test.describe('two devices through Neon', () => {
  test('sync, merge, presence and recovery between two devices', async ({
    browser,
  }, testInfo) => {
    test.skip(
      !live || !secrets.NEON_POSTGRES_CONN_STRING || !secrets.NEON_REALTIME_URL,
      'Set TYPENEXT_LIVE_SYNC=1 with Neon credentials in .env.'
    )
    const before = await vaultIds()
    test.skip(
      before.length > 0,
      'The Neon database already holds a TypeNext notebook; this test needs an empty one.'
    )
    const created: string[] = []
    const mac = await device(browser, 'Studio Mac')
    const laptop = await device(browser, 'Travel laptop')
    try {
      // The first device writes a note, then turns sync on.
      await startNote(mac.page, 'Trip plan')
      await mac.page.keyboard.type(
        'We leave on Friday at nine.\n\nPack the tent and the stove.\n\nCall the campsite.'
      )
      let dialog = await connectNeon(mac.page)
      await expect(
        dialog.getByRole('heading', { name: 'Create your sync key' })
      ).toBeVisible({ timeout: 20_000 })
      await dialog.getByLabel('Sync key', { exact: true }).fill('short')
      await dialog.getByLabel('Type it again').fill('short')
      await dialog.getByRole('button', { name: 'Encrypt and create' }).click()
      await expect(dialog).toContainText('Use at least 10 characters')
      await dialog.getByRole('button', { name: 'Suggest one' }).click()
      const suggested = await dialog
        .getByLabel('Sync key', { exact: true })
        .inputValue()
      expect(suggested.split('-')).toHaveLength(6)
      await dialog.getByLabel('Type it again').fill(suggested)
      await dialog.getByRole('button', { name: 'Encrypt and create' }).click()
      const keys = dialog.getByRole('group', { name: 'Recovery keys' })
      await expect(keys).toBeVisible({ timeout: 20_000 })
      created.push(...(await vaultIds()).filter(id => !before.includes(id)))
      const recovery = await keys.locator('code').first().innerText()
      expect(recovery).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/u)
      await expect(
        dialog.getByRole('button', { name: 'Start syncing' })
      ).toBeDisabled()
      await dialog.getByLabel('I have stored my recovery keys').check()
      await dialog.getByRole('button', { name: 'Start syncing' }).click()
      await dialog.getByLabel('This device’s name').fill(mac.name)
      await testInfo.attach('cloud-pane-connected', {
        body: await dialog.screenshot(),
        contentType: 'image/png',
      })
      await expect(dialog.getByText('Live', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await mac.page.keyboard.press('Escape')
      await expect(
        mac.page.getByRole('button', { name: /^Cloud sync: Synced/ })
      ).toBeVisible({ timeout: 30_000 })

      // The second device joins with a recovery key.
      dialog = await connectNeon(laptop.page)
      await expect(
        dialog.getByRole('heading', { name: 'Open your encrypted notebook' })
      ).toBeVisible({ timeout: 20_000 })
      await dialog.getByLabel('Sync key or recovery key').fill('wrong key here')
      await dialog.getByRole('button', { name: 'Open and sync' }).click()
      await expect(dialog).toContainText('does not open', { timeout: 20_000 })
      await dialog.getByLabel('Sync key or recovery key').fill(recovery)
      await dialog.getByRole('button', { name: 'Open and sync' }).click()
      await expect(dialog).toContainText('Opened with a recovery key', {
        timeout: 20_000,
      })
      await dialog.getByLabel('This device’s name').fill(laptop.name)
      await laptop.page.keyboard.press('Escape')
      const sidebar = laptop.page.getByRole('complementary', {
        name: 'Notebook',
      })
      await expect(sidebar.getByText('Trip plan')).toBeVisible({
        timeout: 30_000,
      })
      await sidebar.getByText('Trip plan').click()
      await expect(noteEditor(laptop.page)).toContainText('Friday at nine')

      // Both open the note: each sees the other.
      await expect(
        mac.page
          .getByRole('status')
          .filter({ hasText: /Travel laptop|Open on/ })
      ).toBeVisible({ timeout: 45_000 })
      await expect(
        laptop.page
          .getByRole('status')
          .filter({ hasText: /Studio Mac|Open on/ })
      ).toBeVisible({ timeout: 45_000 })

      // Edits to different paragraphs on both devices merge.
      await noteEditor(mac.page).click()
      await mac.page.keyboard.press('ControlOrMeta+Home')
      await mac.page.keyboard.press('End')
      await mac.page.keyboard.type(' Bring maps.')
      await noteEditor(laptop.page).click()
      await laptop.page.keyboard.press('ControlOrMeta+End')
      await laptop.page.keyboard.type(' Ask about fires.')
      for (const { page } of [mac, laptop])
        await expect(noteEditor(page)).toContainText(
          /Friday at nine\. Bring maps\.[\s\S]*campsite\. Ask about fires\./u,
          { timeout: 45_000 }
        )
      await testInfo.attach('presence-on-note', {
        body: await mac.page.screenshot(),
        contentType: 'image/png',
      })

      // The devices list shows both.
      dialog = await openCloud(mac.page)
      const devices = dialog.getByRole('list', { name: 'Devices' })
      await expect(devices).toContainText(mac.name)
      await expect(devices).toContainText(laptop.name, { timeout: 30_000 })
      await expect(devices).toContainText('This device')
      await testInfo.attach('devices', {
        body: await dialog.screenshot(),
        contentType: 'image/png',
      })
    } finally {
      await mac.context.close()
      await laptop.context.close()
      for (const vault of [
        ...created,
        ...(await vaultIds()).filter(id => !before.includes(id)),
      ])
        for (const table of [
          'typenext_records',
          'typenext_devices',
          'typenext_vaults',
        ])
          await neonQuery(`delete from ${table} where vault = $1`, [
            vault,
          ]).catch(() => {})
    }
  })
})

async function d1Query(sql: string, params: unknown[] = []) {
  const account = secrets.CLOUDFLARE_ACCOUNT_ID!
  const api = secrets.CLOUDFLARE_D1_API_KEY!
  const list = (await (
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?name=typenext-sync`,
      { headers: { Authorization: `Bearer ${api}` } }
    )
  ).json()) as { result?: { uuid: string; name: string }[] }
  const database = list.result?.find(item => item.name === 'typenext-sync')
  if (!database) return []
  const response = (await (
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database.uuid}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${api}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      }
    )
  ).json()) as { result?: { results?: Record<string, unknown>[] }[] }
  return response.result?.[0]?.results ?? []
}

test.describe('one device, two databases', () => {
  test('a second database receives the same encrypted notebook', async ({
    browser,
  }) => {
    test.skip(
      !live ||
        !secrets.NEON_POSTGRES_CONN_STRING ||
        !secrets.CLOUDFLARE_ACCOUNT_ID ||
        !secrets.CLOUDFLARE_D1_API_KEY,
      'Set TYPENEXT_LIVE_SYNC=1 with Neon and Cloudflare credentials in .env.'
    )
    const before = await vaultIds()
    const d1Before = (
      await d1Query('select vault from typenext_vaults').catch(() => [])
    ).map(row => String(row.vault))
    test.skip(
      before.length > 0 || d1Before.length > 0,
      'A database already holds a TypeNext notebook; this test needs empty ones.'
    )
    const mac = await device(browser, 'Studio Mac')
    try {
      await startNote(mac.page, 'Shared shopping')
      await mac.page.keyboard.type('Milk, bread and apples.')
      // First Cloudflare D1, through the development proxy.
      const dialog = await openCloud(mac.page)
      await dialog.getByRole('button', { name: /Cloudflare D1/ }).click()
      await dialog.getByLabel('Account ID').fill(secrets.CLOUDFLARE_ACCOUNT_ID!)
      await setSecret(
        dialog.getByLabel('API token'),
        secrets.CLOUDFLARE_D1_API_KEY!
      )
      await dialog.getByRole('button', { name: 'Choose a database' }).click()
      const select = dialog.getByRole('combobox', {
        name: 'Database',
        exact: true,
      })
      await expect(select).toBeVisible({ timeout: 20_000 })
      await expect(select).toHaveValue(/^[0-9a-f-]{36}$|^new$/u)
      await select.selectOption({ label: 'typenext-sync' })
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(
        dialog.getByRole('heading', { name: 'Create your sync key' })
      ).toBeVisible({ timeout: 30_000 })
      await dialog
        .getByLabel('Sync key', { exact: true })
        .fill('two databases, one key 7')
      await dialog.getByLabel('Type it again').fill('two databases, one key 7')
      await dialog.getByRole('button', { name: 'Encrypt and create' }).click()
      await dialog.getByLabel('I have stored my recovery keys').check({
        timeout: 20_000,
      })
      await dialog.getByRole('button', { name: 'Start syncing' }).click()
      await expect(dialog.getByText(/^Synced/)).toBeVisible({ timeout: 30_000 })

      // Then Neon: the same notebook, no new key.
      await dialog.getByRole('button', { name: /Add Neon Postgres/ }).click()
      await setSecret(
        dialog.getByLabel('Connection string'),
        secrets.NEON_POSTGRES_CONN_STRING!
      )
      await dialog.getByRole('switch', { name: /Live updates/ }).uncheck()
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
      await expect(dialog).toContainText('kept in this database too', {
        timeout: 30_000,
      })
      await expect(dialog.getByText(/^Synced/)).toHaveCount(2, {
        timeout: 30_000,
      })
      const d1Vaults = (await d1Query('select vault from typenext_vaults')).map(
        row => String(row.vault)
      )
      const neonVaults = await vaultIds()
      expect(d1Vaults).toHaveLength(1)
      expect(neonVaults).toEqual(d1Vaults)
      // Both hold the note, encrypted.
      const records = await neonQuery(
        'select body from typenext_records where vault = $1',
        [neonVaults[0]]
      )
      expect(records.length).toBeGreaterThan(20)
      expect(JSON.stringify(records)).not.toContain('Milk')
    } finally {
      await mac.context.close()
      for (const vault of (await vaultIds()).filter(id => !before.includes(id)))
        for (const table of [
          'typenext_records',
          'typenext_devices',
          'typenext_vaults',
        ])
          await neonQuery(`delete from ${table} where vault = $1`, [
            vault,
          ]).catch(() => {})
      for (const row of await d1Query(
        'select vault from typenext_vaults'
      ).catch(() => []))
        if (!d1Before.includes(String(row.vault)))
          for (const table of [
            'typenext_records',
            'typenext_devices',
            'typenext_vaults',
          ])
            await d1Query(`delete from ${table} where vault = ?1`, [
              String(row.vault),
            ]).catch(() => {})
    }
  })
})
