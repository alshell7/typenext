# Cloud sync

Cloud sync keeps one notebook the same on several devices through databases the writer owns: Neon Postgres, Cloudflare D1, or both. It is end-to-end encrypted. A database stores record ids, revision numbers, sizes, times and ciphertext, nothing else.

## Components

| Part | File | Task |
| --- | --- | --- |
| Encryption | `src/services/cloud-sync/crypto.ts` | Vault header, sync key, recovery keys, record sealing, opaque record ids. |
| Records | `src/services/cloud-sync/records.ts` | The notebook as records, and applying remote records with merges. |
| Merges | `src/services/cloud-sync/merge.ts` | diff3 over lines then words, field merges, id-set merges, canonical JSON. |
| Engine | `src/services/cloud-sync/engine.ts` | One sync with one database: pull, merge, push, retry refused writes. |
| Transports | `src/services/cloud-sync/transport.ts` | The SQL for Neon (HTTP SQL endpoint) and D1 (Cloudflare REST API). |
| Local state | `src/services/cloud-sync/state.ts` | Per-database cursor and merge bases, and unlocked keys, in IndexedDB. |
| Session | `src/services/cloud-sync/session.ts` | Credentials, vault discovery, key changes, device ids, presence. |
| Live updates | `src/services/cloud-sync/realtime.ts` | Neon Realtime live queries, loaded only when configured. |
| Controller | `src/notebook/cloud/controller.ts` | Runtimes per database, cadence, polling, presence, back-off, status store. |
| Interface | `src/notebook/preferences/CloudPane.tsx`, `src/notebook/cloud/CloudStatus.tsx` | Preferences pane, sidebar line, note presence chip. |
| Desktop | `src-tauri/src/cloud_sync.rs` | `cloud_paths_exist`, for mapping other devices' file links. |

## Keys

- A random 256-bit **data key** encrypts everything. HKDF derives an AES-256-GCM record key and an HMAC-SHA256 id key from it.
- The **vault header** (table `typenext_vaults`) holds the data key wrapped by the **sync key** (PBKDF2-SHA256, 600,000 rounds, random salt) and by three **recovery keys** (160 random bits, Crockford base 32, HKDF-SHA256). A recovery key can therefore set a new sync key without re-encrypting a record.
- Each wrap's AES-GCM associated data names the vault, slot kind and slot id, so slots cannot move between vaults.
- After unlocking, a device stores the derived keys in IndexedDB as **non-extractable** Web Crypto keys. Nothing on disk holds key bytes.
- Header writes are compare-and-set on `updated`. Key changes read, change and retry.
- **Revocation** is cooperative: the header lists removed device ids, and such a device forgets its key at its next check. A device that kept the data key could still read old data; rotating the data key (the header `epoch`, already part of every record's associated data) is the way to extend this.

## Records

Each item is one row in `typenext_records`:

| Kind | Item | Left out (stays on the device) |
| --- | --- | --- |
| `note` | a note | `filePath`, `exportedAt` |
| `folder`, `tag` | organization | `collapsed` |
| `space`, `layout` | workspaces and their order | `gitFolder`, `openNoteIds`, `activeNoteId` |
| `source`, `package` | context library and contexts | — |
| `setting` | one preference from `SYNCED_SETTINGS` | the `local` model profile |
| `links` | one device's file paths | (read only by other devices, for mapping) |

Items without a workspace id are written with an explicit one, because devices may order workspaces differently. The record id is `HMAC(id key, kind:id)`. The body is `version | flags | epoch | iv | AES-GCM(deflate?(JSON))`, with associated data naming the vault, record id and epoch: a database cannot swap, move or replay records between slots unnoticed.

## One sync

1. **Pull.** Ask for `id, rev, size` after the cursor, 500 at a time. Fetch the bodies of records newer than their base, in batches below 3 MB. Decrypt, validate with the notebook parsers (`syncParsers` in `storage.ts`), and apply in one `setWorkspace` call against the latest notebook.
2. **Apply.** An item unchanged here since its base takes the remote version. Otherwise:
   - notes merge with diff3, first by lines, then by words inside lines both changed. Where both changed the same words, this device's text stays and the remote note becomes a copy named after the other device;
   - other items merge field by field, nested objects one level deep. A field both changed goes to the later change (`t` in the payload against the time this device first saw its own change);
   - tags, context folders, context sources and the workspace order merge as id sets;
   - an edit wins over a deletion.
3. **Push.** Hash every in-scope item (canonical JSON, cached by object identity) and send those that differ from their base, containers first. Each write names its base revision. The database accepts it only if the row is still at that revision.
4. **Refused writes** are fetched by id, merged and sent again, up to four rounds.

Revisions rise per write: Neon uses a sequence under a per-vault advisory lock, so commit order equals revision order and a reader never skips a late commit; D1 serializes writers and takes `max(rev) + 1` inside the statement.

## Scheduling

| Cadence | Sends | Receives |
| --- | --- | --- |
| Live | 3.5 s after the last change, 0.9 s when another device has the same note open | Neon Realtime at once; otherwise a head check every 20 s (4 s when paired, 2 min hidden) |
| On a schedule | every N minutes | every N minutes |
| Only when I ask | Sync now | Sync now |

One sync runs at a time. After an error the next attempt waits 15 s, doubling to 10 minutes. Visibility and network changes wake the scheduler.

## Presence

Each device writes an encrypted row to `typenext_devices` every 25 s while visible, at once when the open note changes, and at most every 8 s while typing. Ages use the database clock, so device clocks do not matter. A device is active when seen within 75 s, and editing when it typed within 25 s. With Neon Realtime, a live query on the device table refreshes the list at once.

## Neon Realtime

`watchVault` seals two read-only live queries with the Realtime secret, the newest revision and the device rows, and subscribes over WebSocket. Seals last 60 s and are renewed 12 s early. The SDK (`@neon/realtime`) loads only when Live updates are configured; its optional Node `ws` import resolves to the browser stub. The production CSP allows `wss:`.

## Browser and desktop

- Neon's HTTP endpoint allows browser requests, but no `Content-Type` header: the JSON goes as `text/plain`.
- The Cloudflare API refuses browser requests from other origins. The desktop app calls it from Rust (`http_request`); `npm run dev` proxies `/__cloudflare` to it for testing. A production browser build cannot use D1.
- Credentials (`cloud:<target>:connection|realtime|api`) live in the OS credential vault on the desktop and in memory in the browser.
- Settings field names must not end in `key` or `token`, or contain `secret` or `password`: the desktop save drops such fields.

## Tests

- `crypto.test.ts`: key slots, recovery, tampering, opaque ids.
- `merge.test.ts`: diff3 and field merges.
- `engine.test.ts`: several devices against an in-memory database (`memory-transport.ts`), with merges, conflict copies, deletions, refused writes, relaying between two databases, selections and unreadable records.
- `src/notebook/cloud/controller.test.ts`: cadence, locked and missing-credential states, revocation.
- `sync-live.test.ts` (opt-in, `TYPENEXT_LIVE_SYNC=1`): the same scenario against real Neon and D1, and a Realtime round trip.
- `tests/e2e/cloud-sync.spec.ts`: the preferences pane without a network.
- `tests/e2e/cloud-sync-live.spec.ts` (opt-in): two browser profiles as two devices through Neon, and one device with D1 and Neon at once. It needs databases without a TypeNext notebook and erases what it creates.
