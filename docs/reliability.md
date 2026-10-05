# Saving, crash recovery, and resource limits

TypeNext saves the writer's workspace locally. A completed desktop save acknowledges a complete, validated snapshot after the native file and rename barriers have returned. It does not acknowledge characters typed after that snapshot was captured. Sudden termination can still lose the latest unsaved typing.

## Autosave and closing

Workspace autosave runs after a 650 ms pause. During continuous typing it requests a save within 2 seconds of the first change since the previous request. These are scheduling deadlines: a busy JavaScript thread, background timer throttling, slow storage, or an outstanding native write can delay completion. They are not a guarantee that every character reaches disk within 2 seconds.

Dirty detection uses immutable workspace revisions rather than serializing the entire notebook on each edit. There is one active workspace write and one latest pending snapshot. New save requests replace an obsolete pending snapshot; an older completion cannot mark a newer revision saved. The synchronous workspace setter/getter also lets immediate edit → Save or Close actions capture the latest state before React renders.

Markdown files have a separate native autosave schedule: a 1 second pause or a 2 second maximum wait during continuous editing, with one active batch. A file write records the content it actually exported, so edits made during that write stay dirty. The workspace remains the primary recovery copy while a Markdown mirror catches up.

Normal desktop window closing and application Quit are intercepted. Closing waits for already requested writes, then saves current workspace and dirty Markdown files before allowing native exit. If autosave is off, the writer chooses whether to save or discard later edits. Waiting for an earlier requested write does not implicitly save those later edits. Autosave-off edits are also left unsaved during blur, visibility changes, and page hiding.

## Native files and recovery

Desktop data lives in Tauri's per-user app-data directory:

| File                           | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `workspace-v1.json`            | Latest committed workspace                                 |
| `workspace-v1.backup.json`     | Previous validated workspace                               |
| `workspace-v1.corrupt-*.json`  | Preserved bytes of a damaged primary before replacement    |
| `.workspace-v1.json.pending-*` | Sibling temporary file left by an interrupted primary save |

The backend validates a prospective workspace, writes a sibling temporary file, flushes its bytes, and replaces the destination without deleting the existing file first. A valid previous primary is committed to the backup before the new primary is replaced. JSON output is bounded to 64 MiB while it is written; oversized or failed writes cannot commit a partial primary. Markdown exports use the same atomic replacement helper.

Windows uses `FlushFileBuffers` through Rust's `sync_all`, followed by same-volume `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` and `MOVEFILE_WRITE_THROUGH`. Cross-volume copy-and-delete fallback is disabled. See [Microsoft's MoveFileExW documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) for the platform flags.

Unix saves also sync the containing directory after rename. On macOS, `F_FULLFSYNC` requests a drive-cache flush after the directory barrier, because ordinary `fsync` does not provide that additional request. Unsupported flush operations or I/O failures are reported instead of acknowledging a successful save. See [Apple's fsync documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html).

Startup prefers the primary, then the validated backup. Before a damaged primary is replaced, its original bytes are retained in a unique recovery file; an archive failure prevents replacement. If neither committed snapshot is readable, startup can recover a complete, validated abandoned primary temp. This also covers a first-ever save interrupted before a primary exists. The fallback scans at most 256 matching temp files. An incomplete temp is preserved and reported rather than silently treated as an empty notebook. A recovered load carries transient response metadata so the frontend can show recovery feedback after decoding; that metadata never enters saved files.

When no complete copy can be read, saving is paused. **Open saved files** opens only the app-data folder, allowing the writer to locate original and recovery copies. Corruption archives and interrupted temps are retained for manual recovery, so repeated faults can consume additional disk space. The snapshot backup is one previous save, not a version history or protection against intentionally deleting content.

## Browser fallback and bounds

The browser fallback uses a primary and backup in localStorage. Browser `pagehide`, hidden visibility, blur, and unload handlers submit a synchronous localStorage write so it is not stranded behind a pending promise. A sequence guard prevents an older queued write from replacing that newer snapshot. Loading a valid backup leaves the corrupt primary untouched; a subsequent save preserves that primary under a unique `typenext.workspace.v1.corrupt.*` key before replacing it. Quota failures leave existing data intact and report that saving failed.

A browser's successful localStorage call acknowledges browser storage acceptance. It cannot request a filesystem flush, and browser eviction, profile removal, or a browser/OS crash can affect persistence. Desktop file synchronization provides stronger control. Lifecycle events may also be omitted during an abrupt process or operating-system termination.

Stored schema limits are 64 MiB of serialized JSON per workspace, 8 MiB of UTF-8 note text or source text, 1 MiB of note context, 64 KiB of objective text, 10,000 notes, and 256 sources per note. Import guards additionally cap attached-source text at 2,000,000 characters per note and check the prospective workspace before insertion. Linked notes store identity rather than duplicate writing. JSON sizing accounts for Unicode and escape expansion; the UI never truncates the writer's text to fit a save. Keys and unknown settings fields are excluded from workspace projections.

## Verification and remaining limits

The native `interrupted_saves_keep_a_complete_primary_or_recovery_copy` test performs **10 actual child-process terminations** in isolated temporary app-data folders. Eight kills cover backup and primary at four checkpoints: fully written, file-synced, replaced, and durability barriers complete. Two more kill the first-ever save after writing and after file sync. The parent uses `TerminateProcess` on Windows or `SIGKILL` on Unix, waits for exit, and verifies complete old/new snapshots, backup recovery after deliberate primary corruption, and initial-temp recovery. The child runs no Tauri window or OS credential-vault operation.

Additional regressions cover partial-write failure, serialization overflow, multiple preserved corruption originals, unreadable recovery paths, incomplete initial temps, failed browser writes, synchronous unload ordering, bounded continuous-typing requests, save coalescing, requests arriving during save-completion microtasks, and deliberate autosave-off behavior. Run them with:

```sh
npm run test:run -- src/services/storage.test.ts src/notebook/useNotebook.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

An optional isolated resource diagnostic is available with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib workspace::tests::measure_workspace_save_cost -- --ignored --nocapture
```

On the development Windows machine, an approximately 2.18 MB synthetic notebook in an unoptimized Rust test build took 15.1 ms on average to read and 150.6 ms to complete a durable save. The former buffered parser took 13.9 ms. A per-byte streaming-parser experiment took 158.6 ms, so it was removed. The retained bounded buffered reader avoids that CPU cost, while bounded streaming output avoids an additional complete serialized-output allocation. These are diagnostic timings, not release-build benchmarks or limits for other machines. Frontend sizing caches are weakly held and dirty checks do not scan note bodies on each keystroke.

Physical power removal and OS-kernel failure have **not** been exercised by these tests. Filesystem behavior, initial directory creation, device write caches, and storage hardware can affect power-loss durability despite requested barriers. Concurrent independent TypeNext processes sharing one app-data folder are also outside the tested single-writer model. Recovery protects complete saved snapshots; typing that was never submitted or acknowledged, deliberate discard, media failure, and deletion of all local copies still require external backups or Markdown exports for protection.
