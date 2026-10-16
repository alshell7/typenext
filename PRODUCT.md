# TypeNext

TypeNext is an open-source, local-first Markdown notepad for writers. The writer owns the words. A suggestion is a short continuation at the cursor. The writer accepts it explicitly. Suggestions stay within the objective of the note and its attached context.

## Platform

Desktop on Windows and macOS through Tauri 2, with Linux support and a browser development mode. React and TypeScript render the interface. Rust handles native storage, credentials, HTTP and the managed embedding server.

## People and purpose

Writers, researchers and people who record thoughts need a calm place to write. They do not want a chat interface or a busy document toolbar. Success means: write, find recent notes, and accept or dismiss a useful suggestion without leaving the page.

## Product requirements

### Notes

- Plain Markdown files, several note tabs, local autosave, recent notes, native file open and Markdown export.
- A new note opens at once, with no dialog and no required title. An untitled note takes its title from its first line until the writer types a title.
- An optional objective and background, set later in the **Intent** section of the Context panel. The first line of the note is the fallback context.
- `[[note links]]` with title completion, hover cards and Ctrl/⌘-click to open. An unresolved link can create its note.
- A note graph (Ctrl/⌘ Shift G) that shows links, notes used as context and notes not written yet.

### Editor

- GitHub Flavored Markdown with a live preview of bullets, task boxes, rules, quotes, code blocks and tables. The writer can turn the preview off.
- An insert menu at a trigger character (default `/`), with built-in entries and custom commands. Custom templates accept `{cursor}`, `{date}` and `{time}`.
- Table, list and task editing with Tab, Shift+Tab and Enter. Ctrl/⌘ Enter toggles a task.
- Link hover cards with three levels: off, notes only, or notes and websites. Website cards contact the website for its title only.

### Appearance

- Light, dark and system themes, pure black and contrast presets, custom colours, font and size preferences.
- Three zen levels: hide side panels, hide toolbars (they show at the window edge), full screen. Escape leaves zen.
- Native window buttons on macOS. Custom window buttons on Windows and Linux.

### Suggestions

- Short inline suggestions. Tab accepts, Escape dismisses. Ctrl/⌘ Space opens a menu with arrow-key preview and explicit acceptance. A hosted chat model returns up to three fresh choices from one request. Moving through the choices makes no new request.
- Suggestions without attached references, from the note's own context. Offline writing starters are labelled separately from recalled phrases and model output.
- Optional OpenRouter, OpenAI, Anthropic, local and custom compatible endpoints, with temperature control, saved models, custom suggestion instructions and a deliberate continuous external mode. A local error never starts an external request.
- Optional in-app SmolLM2 text inference and Whistle dictation, with verified downloads, cancellable worker jobs and idle unloading.
- Inline Whistle recording: Ctrl/⌘ Shift D starts and stops, Escape cancels, 30-second limit. The writer can type during a recording. The transcript enters the mapped recording position. A failed insertion keeps an editable transcript.

### Context and retrieval

- Named, reusable contexts that contain folder snapshots, files, websites and live notes. A note can attach several contexts. Shared source text is stored once. A linked note contributes only its own writing.
- Drag and drop on the Context panel to attach and detach contexts and to add files.
- Hybrid retrieval: local BM25 always, plus optional semantic search with EmbeddingGemma 2. BM25 alone answers when the embedding server is slow or stopped.
- Semantic search runs on the device: a managed llama.cpp server on the desktop, or the writer's own server. Downloads are pinned and SHA-256 verified, and start only after a deliberate action.
- Optional image, audio and video references through the media encoder. TypeNext keeps the vector, a small thumbnail and the caption, not the file.

### Web facts

- Optional cited web facts through the OpenAI Responses API and its web search tool. A search runs only on request (Ctrl/⌘ Shift K or the insert menu). The accepted fact inserts Markdown links to its sources.

### Privacy and credentials

- Native credentials stay in the operating system credential vault. Browser credentials last for the session only.
- No model or server is bundled or downloaded without a deliberate action.

## Experience constraints

An elegant, sober, soft interface inspired by Arc and Zen, with familiar shadcn/Radix interaction patterns. A narrow note sidebar and a generous editor carry the main experience. Context and settings appear on demand. No default chat, AI-generated starter paragraphs, unrequested rewrites or decorative dashboard widgets. The user has authorized implementation and subagent work from this brief.
