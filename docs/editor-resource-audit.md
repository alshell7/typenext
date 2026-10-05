# Editor resource audit

Measured on 5 October 2026 with synthetic notes in a fresh, isolated headless Microsoft Edge context. This audit covers the Markdown editor and its browser lifecycle. Native crash recovery, local-model memory, and retrieval cache sizing have separate evidence.

## Changes and bounds

The editor now materializes a CodeMirror document into a string once per document identity. Cursor movements reuse that string. Completion configuration compares primitive metadata and source-text values rather than serializing entire reference files on every render. Cache keys use weak document/configuration identities, cursor position, and provider; note and reference bodies are absent from the keys. Same-length source edits still invalidate requests and cached results.

Cancelled work is removed from the pending completion queue immediately. A single active inference request and at most one pending request are retained. Typing, cursor movement, composition, blur, disabled suggestions, tab changes, and unmount all invalidate stale results. The active transport receives the abort signal; a late result cannot change the new note or its status.

Inactive editor states retain the document, selection, scroll position, byte counter, and undo history. They drop Markdown parser state, view plugins, and React callback closures. At most 16 note entries remain. Retained document/history weight is capped at 2,500,000 estimated UTF-16 units per note and 6,000,000 across inactive notes. Heavier or older entries retain cursor/scroll metadata and obtain their writing from the notebook when reopened; their old undo history is discarded.

Active history uses a conservative changed-text ledger. It is rebuilt only after estimated retained weight exceeds 1,500,000 units and at least 128,000 units of new work have accumulated. Recent history targets a shared 1,000,000-unit budget. Each branch's immediate undo or redo action is protected, including a single large paste or deletion that exceeds that budget. A composition finishes before rebuilding. The ghost suggestion, accepted-text highlight, selection, and scroll position survive that rebuild.

These history weights are estimates, not exact heap-byte limits. Protected immediate actions may exceed the active-history target. The notebook still owns its saved writing independently of the editor cache.

The suggestion cache contains at most 16 results and 500,000 combined key/result/source-label characters. Document and identity lookup maps are weak maps. View destruction clears inference debounce timers, queued completion work, and accepted-highlight timers.

Manual suggestions now expose at most three distinct choices in one CodeMirror tooltip. Alternatives count towards that same cache bound. Arrow-key preview reuses the existing tooltip and makes no inference request; only explicit acceptance changes the document. A rare history rebuild closes the tooltip while keeping its inline preview. The popup and automatic blank-page hint use short, cancellable timers, with no polling or continuous animation.

Notes have an exact 8 MiB UTF-8 limit matching durable storage. An incremental transaction filter measures changed spans with their surrogate boundaries; it does not scan the entire document on each edit. An oversized insertion is rejected as a whole and reports an actionable document error. Existing writing is preserved, and the application does not alter the clipboard.

## Controlled browser comparison

The browser workload opened an actual Markdown file containing 1,014,848 characters and 11,803 lines, attached a 258,000-character plain-text reference, typed 20 keys, moved the cursor 30 times, requested and cancelled a suggestion, switched tabs eight times, and closed the large view. Autosave and automatic suggestions were disabled through the real preferences UI. The single manual request used a fake local model and an intercepted loopback transport; no model ran and no hosted inference occurred.

CodeMirror `Text.toString` was observed inside that isolated browser only. Each interaction waited for two animation frames before its timer stopped. Heap figures came from Chrome DevTools Protocol after an explicit garbage collection. A fresh browser context was used for each run; user notes, credentials, and browser profiles were never loaded.

| Metric                                           |     Before | Editor/UI changes | Final, including word-count scanner |
| ------------------------------------------------ | ---------: | ----------------: | ----------------------------------: |
| Markdown file open                               |  197.38 ms |         204.30 ms |                           198.46 ms |
| Typed-key median                                 |   49.98 ms |          50.12 ms |                            33.80 ms |
| Typed-key p95, 20 keys                           |   82.75 ms |          99.47 ms |                            83.54 ms |
| Cursor-move median                               |   33.30 ms |          33.36 ms |                            33.34 ms |
| Tab-switch median                                |   96.81 ms |          82.96 ms |                            80.12 ms |
| Request cancellation                             |   53.35 ms |          36.57 ms |                            38.15 ms |
| Full-document conversions during typing          |         40 |                20 |                                  20 |
| Characters materialized during typing            | 40,594,340 |        20,297,170 |                          20,297,170 |
| Full-document conversions during cursor movement |         30 |                 0 |                                   0 |
| Characters materialized during cursor movement   | 30,446,040 |                 0 |                                   0 |
| Idle JavaScript heap                             |   10.56 MB |          10.81 MB |                            10.82 MB |
| Loaded JavaScript heap, before inference request |   19.91 MB |          19.65 MB |                            19.68 MB |

The eliminated cursor conversions and halved typing conversions are direct counts. The first before/after pair did **not** demonstrate lower typed-key latency: its median was essentially unchanged, and its p95 was higher. A later shared word-count improvement removed the per-key match-array allocation; its independent evidence is in [the services resource audit](services-resource-audit.md). The final browser run, after that scanner and the Windows line-ending cache regression were fixed, measured a 33.80 ms median, about 32% below the baseline. Its p95 was essentially unchanged at 83.54 ms. This is one small final sample, not a repeated statistical latency guarantee.

The new initial byte scan adds bounded work when a document is created. App memoization, storage-hook work, retrieval work, palette code, and word counting changed across these snapshots, so overall browser time and heap differences cannot be assigned entirely to editor changes.

Every run observed one request and one abort, zero stale ghost suggestions, zero page errors, zero unload prompts, and exactly one mounted editor after switching and closing views.

The initial harness unnecessarily retained the sampled view in a browser-global variable. Its after-close heap figures were therefore excluded from the comparison. A corrected fresh run, with no retained observer view, measured:

| Corrected cleanup stage         | JavaScript heap |
| ------------------------------- | --------------: |
| Idle                            |        10.81 MB |
| Large note and reference loaded |        19.67 MB |
| Large view closed               |        15.08 MB |

That corrected run released about 4.58 MB from the loaded stage while retaining the note in the notebook. The last stage also includes the local retrieval cache created by the manual request, so it is not an editor-only heap measurement. The repeat confirmed 20 typing conversions, zero cursor conversions, one abort, no stale ghost or page errors, and one editor DOM node. Its typed-key median was 33.93 ms with p95 99.10 ms, illustrating the variance of these short runs rather than establishing a general latency improvement.

The final run also used the corrected observer. Its heap measured 10.82 MB idle, 19.68 MB loaded, and 15.09 MB after closing the large view, releasing about 4.59 MB from the loaded stage. The original before/after after-close figures remain excluded because they retained the sampled view.

## Incremental byte-check cost

A separate Node 24.17.0 microbenchmark compared bare CodeMirror state changes with the same state changes plus the exact UTF-8 field and size filter. Each result is the median of three rounds of 5,000 one-character replacements after 500 warm-up changes. It does not include React, Markdown parsing, paint, persistence, or model work.

| Synthetic document   | Bare state updates | With exact size guard | Added time per change |
| -------------------- | -----------------: | --------------------: | --------------------: |
| 1,000,000 characters |   13.01 ms / 5,000 |      16.49 ms / 5,000 |             0.0007 ms |
| 8,387,584 characters |   14.99 ms / 5,000 |      19.14 ms / 5,000 |             0.0008 ms |

This indicates the incremental guard cost stays small for ordinary edits as the document grows. It is not a browser typing-latency claim. The initial size calculation remains linear in the loaded document.

## Reproduce

Install project dependencies and start the development server on port 1420. Keep runtime source files unchanged during a comparison, and avoid concurrent model runs, builds, or other browser workloads.

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 1420 --strictPort
```

In a second terminal:

```sh
node tests/perf/editor-profile.mjs repeat
node --expose-gc tests/perf/editor-byte-benchmark.mjs
npx vitest run src/components/notebook/MarkdownEditor.test.tsx
```

The browser harness uses Edge at its standard Windows location when available. Elsewhere it uses Playwright's Chromium; install that browser with `npx playwright install chromium`. `TYPENEXT_BROWSER_EXECUTABLE` can select another Chromium executable. The measurement label uses lowercase letters, numbers, or hyphens. Results are written under ignored `artifacts/` paths, with no screenshots, traces, credentials, or note exports.

The captured datasets were `editor-resource-baseline.json`, `editor-resource-after.json`, `editor-resource-after-cleanup.json`, `editor-resource-final.json`, and `editor-byte-benchmark.json`. The current public harness contains the observer cleanup correction. The figures above preserve the chronological measured snapshots; running it now measures the current implementation.

All 28 focused editor tests passed after the changes. They include stale response suppression, bounded queued work and timer cleanup, reuse across copied source objects, same-length source invalidation, large replacement history trimming, protection of the next large undo action, inactive-cache eviction without lost writing or cursor, deferred IME trimming, preserved ghost/highlight behavior, independent `TextEncoder` checks over Unicode edits, atomic rejection at the exact UTF-8 limit, and consistent cursor offsets for imported CRLF/CR line endings.

The browser timing sample is small and includes a two-frame wait of roughly 33 ms on this machine. Dev-mode parsing, JIT, garbage collection, and scheduling can dominate a particular key. These figures measure JavaScript heap rather than whole-process resident memory, and they do not include model memory or establish behavior on every Windows/macOS machine.
