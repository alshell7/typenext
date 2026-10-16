# Architecture guide

This guide gives the high-level structure of TypeNext and the patterns to follow. System guides in `docs/developer/` give the details.

## Principles

1. **Clarity over cleverness.** Use predictable patterns.
2. **Local first.** Writing, references and vectors stay on the device. A network request needs a deliberate action by the writer.
3. **Markdown is the source of truth.** The editor never keeps a second document model.
4. **Bounded work.** Every cache, queue, import and prompt has a limit. Every asynchronous request can be cancelled.
5. **Performance by design.** Typing must stay fast in a long note.

## Active code

TypeNext started from a Tauri React template. `tsconfig.json` compiles only the active paths below. Template code in `src/legacy`, `src/store`, `src/lib/commands`, `src/components/layout` and similar folders is not part of the app or the bundle.

```
src/
├── App.tsx                  Window shell: sidebar, tabs, toolbar, zen mode, dialogs, global keys
├── app-shell.css            Shell layout, macOS title bar space, zen levels
├── notebook/                Notes, contexts, Preferences, graph, model chooser
│   ├── useNotebook.ts       Workspace state, load and autosave
│   ├── model.ts             Defaults, note creation, automatic titles
│   ├── context/             Context panel parts: Intent, connection board, search
│   ├── preferences/         Preference panes
│   ├── NoteGraph.tsx        Graph dialog (canvas and list)
│   └── note-links.ts        [[link]] parsing, resolution, graph data
├── components/notebook/     CodeMirror editor and its extensions
├── services/                Completion, retrieval, semantic search, web facts, storage, native bridge
└── types/notebook.ts        Shared types
src-tauri/src/
├── lib.rs                   Tauri setup, menus, command registration, exit handling
├── workspace.rs             Atomic workspace and Markdown file storage
├── credentials.rs           Operating system credential vault
├── http.rs                  Native HTTP with public-address checks
└── embedding.rs             Managed llama.cpp embedding server
```

## State

The workspace (notes, contexts, settings) is one `Workspace` object. `useNotebook` loads it, holds it in React state and saves it after typing stops (650 ms idle, 2 s maximum wait). Component state stays in `useState`. Editor state stays in CodeMirror `StateField`s. The active app does not use Zustand or TanStack Query.

Rules:

- Change settings through the `update` and `latest()` functions that the Preferences panes receive. `latest()` prevents lost updates from stale closures.
- Normalise stored data in `services/storage.ts` and `notebook/model.ts`. Every new setting needs a default and a migration for old workspaces.
- Use `useSyncExternalStore` for service status that changes outside React, for example the embedding runtime and the semantic index.

## Bridge between React and Rust

- **React → Rust:** `invoke('command_name', args)` through `services/native.ts`. Do not call `@tauri-apps/api` from components.
- **Rust → React:** `app.emit("event-name", payload)` and `listen("event-name", handler)`. Example: `embedding-runtime-status`.
- **Native menus** emit events that `App.tsx` handles, for example `menu-preferences`.

Rust commands: `load_workspace`, `persist_workspace`, `open_workspace_folder`, `write_markdown_file`, `get_secret`, `set_secret`, `http_request`, `cancel_http_request`, `exit_app`, and the six `embedding_runtime_*` commands.

## Systems

| System                    | Guide or source                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- |
| Editor                    | [editor.md](./editor.md)                                                        |
| Semantic search           | [semantic-search.md](./semantic-search.md)                                      |
| Suggestions and retrieval | [AI design](../ai-design.md), `services/completion.ts`, `services/retrieval.ts` |
| Web facts                 | `services/web-facts.ts`, [AI design](../ai-design.md#web-facts)                 |
| Storage and recovery      | [reliability](../reliability.md), `src-tauri/src/workspace.rs`                  |
| Testing                   | [testing.md](./testing.md)                                                      |
| Releases                  | [releases.md](./releases.md)                                                    |

### Suggestions

`MarkdownEditor.tsx` schedules a request after a pause or on Ctrl/⌘ Space. `completion.ts` resolves the sources of the note, runs hybrid retrieval, builds a bounded prompt and calls one engine: recall and starters, built-in SmolLM2, a local server, or an external provider. Only one generation request runs at a time. A revision check drops results for a changed document or cursor.

### Retrieval

BM25 (`retrieval.ts`) always runs. Semantic search (`semantic-retrieval.ts`) runs when it is on and stays within a latency budget. Reciprocal rank fusion merges the two lists. When semantic search is slow or fails, BM25 results are used alone.

### Note graph

`note-links.ts` parses links outside code and builds nodes and edges from links and context use. `note-graph-layout.ts` runs a seeded force layout with a Barnes–Hut approximation. `NoteGraph.tsx` draws on a canvas and offers a list view for screen readers.

### Window shell

`App.tsx` owns zen mode (`settings.zenLevel`: `sidebars`, `chrome`, `full`). `app-shell.css` hides the chrome and shows it at the window edges. On macOS, `tauri.macos.conf.json` uses an overlay title bar with native window buttons. On Windows and Linux, the base configuration has no decorations and `App.tsx` draws the window buttons.

## Security

- All file writes happen in Rust and are atomic: write a temporary file, then rename it.
- Native HTTP for website import and link previews uses `publicOnly` to refuse private addresses, pins DNS and checks redirects again.
- Keys come from the credential vault or session memory. They never enter notes, prompts or `localStorage`.
- The embedding server listens on `127.0.0.1` only and needs a random key for each start.
- Downloaded runtimes and models are pinned by SHA-256.

## Quality gates

```sh
npm run check:all
```

This runs the TypeScript type check, ESLint with zero warnings, Vitest, `cargo fmt --check` and `cargo clippy -D warnings`. Also run `cargo test --manifest-path src-tauri/Cargo.toml` and `npm run test:e2e`. See [testing.md](./testing.md).

## Add a feature

1. Read the guide for the system that you change.
2. Put logic in `services/` or a pure module. Keep components thin.
3. Add a setting with a default in `model.ts` and validation in `storage.ts`.
4. Add a bound to every new cache, queue or request.
5. Add unit tests, and a browser test for a new user flow.
6. Update the user guide (`docs/userguide/userguide.md`) and this folder.

## Template documents

These documents come from the original template: `command-system.md`, `keyboard-shortcuts.md`, `menus.md`, `notifications.md`, `state-management.md`, `data-persistence.md`, `auto-updates.md`, `architectural-patterns.md`, `performance-patterns.md`, `bundle-optimization.md`, `logging.md`. Parts of them do not agree with the active app, for example the Zustand and TanStack Query patterns. When a template document and the active code do not agree, follow the code and this guide.
