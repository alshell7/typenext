# Testing

This guide tells you how to run and write tests for TypeNext. The record of verification runs and the live test commands are in [docs/testing.md](../testing.md).

## Quick start

```sh
npm run check:all                                   # typecheck, lint, unit tests, cargo fmt --check, clippy
npm run test                                        # Vitest in watch mode
npm run test:run                                    # Vitest, one run
npm run test:e2e                                    # Playwright browser tests
cargo test --manifest-path src-tauri/Cargo.toml     # Rust tests
npm run test:all                                    # Vitest and cargo test
```

`npm run check:all` does not run `cargo test` or Playwright. Run them before a pull request. CI (`.github/workflows/check.yml`) runs typecheck, lint, Vitest, the build and Playwright on Chromium. It also runs `cargo fmt --check`, `cargo test --locked`, clippy with `-D warnings` and a `tauri build --no-bundle` for each target.

CAUTION: Do not start a second dev server or Playwright run while another run is active. Playwright starts its own dev server on `http://127.0.0.1:1420`.

## Layout

| Location                                  | Runner     | Notes                                                                   |
| ----------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `src/notebook/**/*.test.{ts,tsx}`         | Vitest     | Components, preferences, graph, context panel, model and storage logic. |
| `src/services/*.test.ts`                  | Vitest     | Completion, retrieval, semantic search, web facts, media, providers.    |
| `src/components/notebook/*.test.{ts,tsx}` | Vitest     | CodeMirror editor and Markdown editing commands.                        |
| `tests/e2e/*.spec.ts`                     | Playwright | Browser flows. Helpers are in `tests/e2e/support/notes.ts`.             |
| `src-tauri/src/**` (`#[cfg(test)]`)       | cargo      | Native storage, HTTP, credentials and the embedding runtime manager.    |

`vitest.config.ts` includes only the three Vitest paths above. Tests in `src/store` and `src/test` belong to the original template and do not run. The setup file is `src/notebook/test-setup.ts`. It loads `@testing-library/jest-dom` and mocks `window.matchMedia`.

## Unit test patterns

### Mock the native bridge

Services call Tauri through `src/services/native.ts`. Mock this module, not `@tauri-apps/api`:

```ts
vi.mock('./native', () => ({
  isDesktop: () => false,
  asError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  getSecret: vi.fn(async () => 'sk-test'),
  requestJson: vi.fn(),
  requestText: vi.fn(),
}))
```

Then assert the request with `vi.mocked(requestJson).mock.calls`. Use synthetic text and fake keys only.

### Test editor commands

`markdown-editing.ts` contains pure functions over an `EditorView`. Create a view with the text and selection, run the command, then compare the document and the selection. Test the insert menu sources (`slashSource`, `wikiLinkSource`) through a `CompletionContext`. See `src/components/notebook/markdown-editing.test.ts`.

### Test semantic search

`src/services/semantic.test.ts` replaces the embedding server with a fake `fetch`. Return 768-value vectors from `/v1/embeddings` and a `/props` body with `media_marker` and `modalities`. Check that queries go before background jobs, that a slow server falls back to BM25 within the budget, and that cached vectors are reused.

### Test Preferences panes

`src/notebook/Preferences.test.tsx` mocks `../services/native` and `../services/builtin-engine`. Find controls by their accessible names, for example `getByRole('switch', { name: 'Semantic search' })`. Keep the visible labels and the tests in agreement. The user guide quotes the same labels.

## Browser test patterns

- Start each test from an empty notebook: go to `/`, clear `localStorage`, reload, then wait for the heading **A little room to think.**
- Use `startNote(page, title?, context?)` to create a note. It fills the title and **Background & voice** only when you give them.
- Use `noteEditor(page)` for the editor (`Note content`) and `savedMarkdown(page, expected)` to wait for autosave.
- Use `process.platform === 'darwin' ? 'Meta' : 'Control'` for Ctrl/⌘ shortcuts.
- Prefer roles and accessible names over CSS classes. Use classes such as `.cm-insert-menu`, `.cm-lp-table` and `.cm-link-card` only for CodeMirror widgets without a role.

### Performance budget

`tests/e2e/editor-features.spec.ts` contains a typing-latency test on a long note with lists, tables and links. The median frame must be below 40 ms and the 95th percentile below 120 ms. Do not raise these limits to make a change pass. Find the slow extension instead.

## Rust tests

Put unit tests in a `#[cfg(test)] mod tests` block in the same file. Use `tempfile` folders for file operations. `src-tauri/src/embedding.rs` has tests for the pinned archives and URLs, safe archive extraction, server arguments, the key in the environment and orphan cleanup.

Ignored tests need real files or processes:

| Test                                             | Needs                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `managed_server_serves_authenticated_embeddings` | `TYPENEXT_EMBEDDING_TEST_DIR` with the pinned llama.cpp archive and model files. |
| `orphan_fixture_child`                           | A helper process for the orphan-cleanup test. Do not run it alone.               |
| Two tests in `src-tauri/src/workspace.rs`        | Diagnostic helpers.                                                              |

Run the managed server test:

```sh
TYPENEXT_EMBEDDING_TEST_DIR=/path/to/folder \
cargo test --manifest-path src-tauri/Cargo.toml managed_server -- --ignored
```

## Live tests

Live tests are skipped by default. They contact a real embedding server or a real provider. The commands and environment variables are in [docs/testing.md](../testing.md#opt-in-live-tests).

CAUTION: Never write a key in a test, a document or a commit. Read keys from the local `.env` file or from `CREDENTIALS.txt`. Both are in `.gitignore`.

## Rules

1. Add tests for each change to business logic: retrieval, completion, storage, editing commands.
2. Keep tests deterministic. Use seeded layouts, fake timers and mocked servers.
3. Test cancellation and stale results for every asynchronous request.
4. Test the privacy boundary. An offline flow must make no network request.
5. Keep the labels in tests, the app and the user guide the same.
