import { expect, test } from '@playwright/test'
import { fresh, openCloud, setSecret } from './support/cloud'

/**
 * Cloud sync preferences, without a network. The two-device test is in
 * cloud-sync-live.spec.ts.
 */

test.describe('cloud sync preferences', () => {
  test.beforeEach(async ({ page }) => {
    await fresh(page)
  })

  test('offers both databases and explains what stays private', async ({
    page,
  }) => {
    const dialog = await openCloud(page)
    await expect(
      dialog.getByRole('heading', { name: 'Cloud sync', level: 2 })
    ).toBeVisible()
    await expect(dialog).toContainText('encrypted on this device')
    const choices = dialog.getByRole('group', { name: 'Add a database' })
    await expect(choices.getByRole('button')).toHaveCount(2)
    await expect(choices).toContainText('Neon Postgres')
    await expect(choices).toContainText('Cloudflare D1')
    // The Git pane keeps its place under a clearer name.
    await expect(
      dialog.getByRole('tab', { name: 'Git sync', exact: true })
    ).toBeVisible()
    // Nothing runs before a database is added.
    await expect(
      page.getByRole('button', { name: /^Cloud sync:/ })
    ).toHaveCount(0)
  })

  test('checks a Neon connection string before connecting', async ({
    page,
  }) => {
    const dialog = await openCloud(page)
    await dialog.getByRole('button', { name: /Neon Postgres/ }).click()
    await expect(
      dialog.getByRole('heading', { name: 'Connect Neon Postgres' })
    ).toBeVisible()
    const field = dialog.getByLabel('Connection string')
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('type', 'password')
    await field.fill('mysql://someone@example.com/db')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(
      dialog.getByRole('status').filter({ hasText: 'postgresql://' })
    ).toBeVisible()
    await field.fill('postgresql://user:pass@db.example.com/neondb')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toContainText('neon.tech')
    // Live updates ask for both Realtime fields.
    await field.fill('postgresql://user:pass@ep-x.neon.tech/neondb')
    await dialog.getByLabel('Realtime URL').fill('https://ep-x.rt.neon.tech')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toContainText('Paste the Realtime secret too')
    // Show and hide.
    await dialog.getByRole('button', { name: 'Show' }).first().click()
    await expect(field).toHaveAttribute('type', 'text')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(
      dialog.getByRole('group', { name: 'Add a database' })
    ).toBeVisible()
  })

  test('checks the Cloudflare account before asking the API', async ({
    page,
  }) => {
    const dialog = await openCloud(page)
    await dialog.getByRole('button', { name: /Cloudflare D1/ }).click()
    await dialog.getByLabel('Account ID').fill('not-an-account')
    await setSecret(dialog.getByLabel('API token'), 'synthetic')
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(dialog).toContainText('The account ID has 32 letters')
  })
})
