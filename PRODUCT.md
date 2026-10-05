# TypeNext

TypeNext is an open-source, local-first Markdown notepad for writers. The writer owns the words. AI offers a short continuation at the cursor, accepted explicitly, to help through a block while staying within the note's objective and attached context.

## Platform

Desktop on Windows and macOS through Tauri 2, with Linux support and a browser development mode. React and TypeScript render the interface; Rust handles native storage, credentials, and HTTP.

## People and purpose

Writers, researchers, and people recording thoughts need a calm place to write without a chat interface or a busy document toolbar. Success means writing, finding recent notes, and accepting or dismissing a useful contextual suggestion without leaving the page.

## Product requirements

- Plain Markdown, multiple note tabs, title and context collected when creating a note.
- An optional objective, with the first nonempty line used as fallback context.
- Local autosave, recent notes, native file open and Markdown export.
- Light/dark/system themes with pure black and contrast presets, custom colours, font and size preferences.
- Short inline suggestions with Tab to accept, Escape to dismiss, and a Ctrl/Command + Space menu with arrow-key preview and explicit acceptance.
- Suggestions without attached references, using the note's own context. Offline writing starters are distinguished from recalled phrases and local model output.
- Optional OpenRouter, OpenAI, Anthropic, local, and custom compatible endpoints with temperature control, saved models, custom suggestion instructions and deliberate continuous external mode.
- Local retrieval from enabled text, Markdown, PDF, DOCX, and website context sources.
- A reusable library of folder snapshots, files, websites and live notes, with multiple references per note. Only a linked note's own writing is used; links never recursively expand its context.
- Native credentials stored in the operating system credential vault; browser credentials are session only.
- Optional in-app SmolLM2 text inference and Whistle dictation with verified downloads, cancellable worker jobs, idle unloading and explicit transcript review. No hosted fallback.
- Local model servers connect through their HTTP API. Models are not bundled or downloaded without a deliberate user action.

## Experience constraints

An elegant, sober, soft interface inspired by Arc and Zen, using familiar shadcn/Radix interaction patterns. A narrow note sidebar and a generous editor carry the main experience. Context and settings are revealed on demand. No default chat, AI-generated starter paragraphs, unrequested rewrites, or decorative dashboard widgets. The user has authorized implementation and subagent work from this brief.
