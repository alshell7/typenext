import { expect, type Locator, type Page } from '@playwright/test'

export async function fresh(page: Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    localStorage.clear()
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase('typenext-cloud-sync')
      request.onsuccess = request.onerror = request.onblocked = resolve
    })
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'A little room to think.' })
  ).toBeVisible()
}

export async function openCloud(page: Page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: 'Cloud sync', exact: true }).click()
  return dialog
}

/** Secrets go in through an input event, never through a call log. */
export async function setSecret(input: Locator, secret: string) {
  await input.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, secret)
}
