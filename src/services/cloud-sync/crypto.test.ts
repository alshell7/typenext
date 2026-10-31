import { describe, expect, it } from 'vitest'
import {
  WrongKeyError,
  createVault,
  decodeHeader,
  encodeHeader,
  fromBase64,
  open,
  openVault,
  parseRecoveryKey,
  recordId,
  replaceRecoveryKeys,
  seal,
  setSyncKey,
  suggestSyncKey,
  syncKeyProblem,
  syncKeyStrength,
  toBase64,
} from './crypto'

const FAST = { iterations: 100_000 }
const PASS = 'correct horse battery'

describe('vault keys', () => {
  it('opens with the sync key and every recovery key, and nothing else', async () => {
    const vault = await createVault(PASS, FAST)
    expect(vault.recoveryKeys).toHaveLength(3)
    expect(new Set(vault.recoveryKeys).size).toBe(3)
    expect(vault.recoveryKeys[0]).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/u)

    const byKey = await openVault(vault.header, PASS)
    expect(byKey.via).toBe('sync-key')
    expect(toBase64(byKey.dataKey)).toBe(toBase64(vault.dataKey))
    for (const code of vault.recoveryKeys) {
      const opened = await openVault(vault.header, code)
      expect(opened.via).toBe('recovery-key')
      expect(toBase64(opened.dataKey)).toBe(toBase64(vault.dataKey))
    }
    await expect(
      openVault(vault.header, 'correct horse battery!')
    ).rejects.toBeInstanceOf(WrongKeyError)
    await expect(openVault(vault.header, '')).rejects.toBeInstanceOf(
      WrongKeyError
    )
  })

  it('accepts recovery keys typed loosely', async () => {
    const vault = await createVault(PASS, FAST)
    const code = vault.recoveryKeys[1]!
    const sloppy = ` ${code.toLowerCase().replaceAll('-', ' ').replaceAll('0', 'o')} `
    expect(parseRecoveryKey(sloppy)).not.toBeNull()
    expect((await openVault(vault.header, sloppy)).via).toBe('recovery-key')
    expect(parseRecoveryKey('ABCD-EFGH')).toBeNull()
  })

  it('resets the sync key with a recovery key, keeping the data key', async () => {
    const vault = await createVault(PASS, FAST)
    const recovered = await openVault(vault.header, vault.recoveryKeys[2]!)
    const header = await setSyncKey(
      vault.header,
      recovered.dataKey,
      'a brand new passphrase',
      FAST
    )
    await expect(openVault(header, PASS)).rejects.toBeInstanceOf(WrongKeyError)
    const reopened = await openVault(header, 'a brand new passphrase')
    expect(toBase64(reopened.dataKey)).toBe(toBase64(vault.dataKey))
    // Recovery keys keep working until they are replaced.
    expect((await openVault(header, vault.recoveryKeys[0]!)).via).toBe(
      'recovery-key'
    )
  })

  it('retires old recovery keys when new ones are made', async () => {
    const vault = await createVault(PASS, FAST)
    const renewed = await replaceRecoveryKeys(vault.header, vault.dataKey)
    for (const code of vault.recoveryKeys)
      await expect(openVault(renewed.header, code)).rejects.toBeInstanceOf(
        WrongKeyError
      )
    expect(
      (await openVault(renewed.header, renewed.recoveryKeys[0]!)).via
    ).toBe('recovery-key')
    expect((await openVault(renewed.header, PASS)).via).toBe('sync-key')
  })

  it('refuses a header slot moved into another vault', async () => {
    const one = await createVault(PASS, FAST)
    const two = await createVault(PASS, FAST)
    const forged = {
      ...two.header,
      kdf: one.header.kdf,
      slots: one.header.slots,
    }
    await expect(openVault(forged, PASS)).rejects.toBeInstanceOf(WrongKeyError)
  })

  it('rejects weak sync keys and rates strong ones higher', () => {
    expect(syncKeyProblem('short')).toMatch(/10 characters/u)
    expect(syncKeyProblem('aaaaaaaaaaaa')).toMatch(/varied/u)
    expect(syncKeyProblem(PASS)).toBe('')
    expect(syncKeyStrength('aaaaaaaaaaaa')).toBe(0)
    expect(syncKeyStrength('Tr0ub4dor&3-river-quartz-77')).toBeGreaterThan(
      syncKeyStrength('abcdefghij')
    )
    const suggestion = suggestSyncKey()
    expect(syncKeyProblem(suggestion)).toBe('')
    expect(suggestion.split('-')).toHaveLength(6)
  })

  it('reads only well-formed headers', async () => {
    const vault = await createVault(PASS, FAST)
    expect(decodeHeader(encodeHeader(vault.header))?.vaultId).toBe(
      vault.header.vaultId
    )
    expect(decodeHeader('not json')).toBeNull()
    expect(decodeHeader(JSON.stringify({ ...vault.header, v: 2 }))).toBeNull()
    expect(
      decodeHeader(
        JSON.stringify({
          ...vault.header,
          kdf: { ...vault.header.kdf, iterations: 10 },
        })
      )
    ).toBeNull()
  })
})

describe('records', () => {
  it('round-trips values and compresses large ones', async () => {
    const { keyring } = await createVault(PASS, FAST)
    const small = { k: 'tag', v: { name: 'ideas' } }
    expect(
      await open(keyring, 'slot', await seal(keyring, 'slot', small))
    ).toEqual(small)
    const text = 'All work and no play. '.repeat(2_000)
    const sealed = await seal(keyring, 'slot', { text })
    expect(sealed.length).toBeLessThan(text.length / 4)
    expect(await open(keyring, 'slot', sealed)).toEqual({ text })
  })

  it('detects tampering, swapped slots and other vaults', async () => {
    const { keyring } = await createVault(PASS, FAST)
    const other = (await createVault(PASS, FAST)).keyring
    const sealed = await seal(keyring, 'note-a', { content: 'secret' })
    await expect(open(keyring, 'note-b', sealed)).rejects.toBeInstanceOf(
      WrongKeyError
    )
    await expect(open(other, 'note-a', sealed)).rejects.toBeInstanceOf(
      WrongKeyError
    )
    const bytes = fromBase64(sealed)
    bytes[bytes.length - 3]! ^= 1
    await expect(
      open(keyring, 'note-a', toBase64(bytes))
    ).rejects.toBeInstanceOf(WrongKeyError)
    const epoch = fromBase64(sealed)
    epoch[5] = 9
    await expect(open(keyring, 'note-a', toBase64(epoch))).rejects.toThrow(
      /different encryption key/u
    )
  })

  it('never shows plain text or ids in what the database stores', async () => {
    const { keyring } = await createVault(PASS, FAST)
    const id = await recordId(keyring, 'note', 'grocery-list')
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/u)
    expect(await recordId(keyring, 'note', 'grocery-list')).toBe(id)
    expect(await recordId(keyring, 'tag', 'grocery-list')).not.toBe(id)
    const other = (await createVault(PASS, FAST)).keyring
    expect(await recordId(other, 'note', 'grocery-list')).not.toBe(id)
    const sealed = await seal(keyring, id, {
      title: 'Grocery list',
      content: 'milk',
    })
    expect(atob(sealed)).not.toMatch(/Grocery|milk/u)
  })
})
