# Editor

The note editor is a CodeMirror 6 view in `src/components/notebook/MarkdownEditor.tsx`. Markdown is always the source of truth. Every extension changes the Markdown text or draws decorations over it. No extension keeps a second document model.

## Files

| File                           | Responsibility                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `MarkdownEditor.tsx`           | Creates the view, the extension list and the keymap. Runs suggestions, web facts and dictation.          |
| `editor-completions.ts`        | The insert menu (`/` by default) and `[[` note-link completion. Uses `@codemirror/autocomplete`.         |
| `markdown-editing.ts`          | Pure editing commands: lists, tables, tasks, links and emphasis. Unit tests: `markdown-editing.test.ts`. |
| `live-preview.ts`              | Decorations that render bullets, task boxes, rules, quotes, code blocks and tables.                      |
| `link-tools.ts`                | Link styles, hover cards, Ctrl/⌘-click and Alt+Enter to open a link.                                     |
| `editor-extensions.ts`         | Inline suggestion field, acceptance, history bounds, the 8 MiB note limit and the writing theme.         |
| `suggestion-menu.ts`           | The Ctrl/⌘ Space choice menu (at most `MAX_MENU_CHOICES = 5` choices).                                   |
| `dictation-anchor.ts`          | The marker that follows the dictation position.                                                          |
| `ai-actions.ts`                | The AI panel for selected text, its word-level preview, and the pulse at the cursor while a model works. |
| `ai-pulse.ts`                  | The model-at-work animations as plain DOM (`src/notebook/ai-pulse.css`). React uses `AiPulse.tsx`.       |
| `src/services/text-actions.ts` | Polish, grammar, rewrite, paraphrase, shorter, longer and custom requests through `requestModelText`.   |
| `src/services/link-preview.ts` | Fetches website titles for hover cards.                                                                  |
| `src/notebook/note-links.ts`   | Parses `[[links]]`, resolves titles and builds the note graph data.                                      |

## Language and keymap

The editor uses `markdown({ base: markdownLanguage, addKeymap: false })`. `markdownLanguage` is the GitHub Flavored Markdown dialect: tables, task lists, strikethrough and autolinks parse. The default Markdown keymap is off. `MarkdownEditor.tsx` builds its own keymap so that suggestion keys and editing keys share one order of precedence.

| Key            | Order of commands                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Tab            | Accept the inline suggestion → next table cell → indent list item → indent unit.                   |
| Shift+Tab      | Previous table cell → outdent list item → remove one indent unit.                                  |
| Enter          | Accept the menu choice → add a table row → leave an empty list item → continue the Markdown block. |
| Mod-Enter      | `toggleTask`.                                                                                      |
| Mod-k          | `insertLink`.                                                                                      |
| Mod-i          | `wrapSelection(view, '*')`.                                                                        |
| Mod-Shift-k    | Web facts.                                                                                         |
| Mod-ArrowRight | Accept one word of the inline suggestion. Writer-chosen (`settings.shortcuts.acceptWord`).          |
| Mod-Space      | Request suggestion choices. Writer-chosen (`settings.shortcuts.suggest`).                           |
| Mod-j          | Open the AI actions for the selection. Writer-chosen (`settings.shortcuts.aiActions`).             |
| Alt-Enter      | Open the link at the cursor (`link-tools.ts`).                                                     |

The three writer-chosen keys live in `shortcutCompartment` and are rebuilt with `StateEffect.reconfigure` when `settings.shortcuts` changes, without a new editor. `src/notebook/shortcuts.ts` formats bindings for display (`shortcutText`, `shortcutSpeech`), turns a key press into a binding (`bindingFromEvent`) and refuses keys the app already uses (`shortcutProblem`, `RESERVED_SHORTCUTS`). When you add an app shortcut, add it to `RESERVED_SHORTCUTS` too. Shortcut field names must not end in "key" or "token": the desktop save removes such unmodelled fields as possible credentials.

The completion keymap in `editor-completions.ts` has `Prec.highest`. It acts only while the insert menu or the `[[` menu is open. When no menu is open, Tab stays available for ghost text.

## Insert menu

`slashSource(host)` returns a CodeMirror completion source. It opens the menu when all of these conditions are true:

- **Insert menu** is on (`settings.editor.slashMenu`).
- The trigger character (`settings.editor.slashTrigger`, default `/`) is at the start of a line, or after a space or one of `( [ { >`.
- The query after the trigger has 0 to 24 letters, digits or hyphens.
- The cursor is not in `FencedCode`, `CodeBlock`, `InlineCode` or `CodeText`.

A second trigger character, or any other character outside the query pattern, closes the menu. Escape closes it and keeps the typed character. `commandScore` ranks the entries: name prefix, word prefix, keyword prefix, substring, then subsequence. With an empty query, the menu shows sections in this order: **Text**, **Lists**, **Blocks**, **Insert**, **Your commands**, **Actions**.

Custom commands come from **Preferences → Editor → Custom commands** (`settings.editor.customCommands`, at most 64). A custom command with the same name as a built-in entry replaces it. `expandTemplate` replaces `{date}` and `{time}` with local date and time strings. It puts the cursor at the first `{cursor}` and removes the others. A template with a line break is inserted on its own lines (`insertBlock`).

### Add a built-in command

1. Open `src/components/notebook/editor-completions.ts`.
2. Add a `SlashCommand` object to the `commands` array in `builtinCommands`.
3. Give it a unique `id`, a `name` (the visible label), a short `detail`, a `section`, an `icon` and search `keywords`.
4. Write `apply(view, from, to)`. The range `[from, to)` contains the trigger and the query. Remove or replace this range.
5. Use the helpers: `setLinePrefix` for a line prefix, `insertAt` for inline text, `insertBlock` for lines, `wrapAt` for markers around a placeholder.
6. For an app action, add a value to `EditorAction`, delete the range, then call `host.runAction(...)`. Handle the action in `editorHost.runAction` in `MarkdownEditor.tsx` or in the `onAction` prop of the editor.
7. Add a unit test for the new text in `markdown-editing.test.ts` or `MarkdownEditor.test.tsx`.
8. Add the entry to the user guide table in `docs/userguide/userguide.md`.

Example:

```ts
{
  id: 'callout',
  name: 'Callout',
  detail: 'Quote with a bold label',
  section: 'Blocks',
  icon: '!',
  keywords: ['note', 'warning', 'tip'],
  apply: (view, from, to) => insertBlock(view, from, to, '> **Note:** {cursor}'),
},
```

Keep the `name` short and unique. The name is also the key for a custom-command override.

## Note links

`wikiLinkSource` opens after `[[`. It lists other notes by title (at most 40) and ranks exact, prefix, word-prefix and substring matches. When no title matches exactly, the last entry is a new link: **New link · create the note later**. `note-links.ts` normalises titles with `noteKey`, so case and spacing do not change the target. `[[Target|Label]]` shows the label.

`link-tools.ts` styles resolved links as `.cm-wikilink` and unresolved links as `.cm-wikilink-missing`. Ctrl/⌘-click and Alt+Enter call `followLink`. A resolved link opens its note. An unresolved link creates the note through the `createNote` host callback.

## Find and replace

`find.ts` keeps the query in `findField` and finds matches once per edit while the bar is open (at most `MAX_MATCHES`); `findDecorations` marks only the visible ones. `findNext`, `revealFirst`, `replaceNext` and `replaceAll` act on the view; `replaceAll` is one transaction with `isolateHistory`, so one undo restores everything. A pattern replacement expands `$1` and the like per match.

`FindBar.tsx` is the floating bar. `MarkdownEditor` renders it through a portal into a `.find-host` that it prepends to `.document-scroll`: a zero-height sticky row, so the bar floats over the page and takes no room. Opening uses `flushSync`, so the field has focus before the next key, never the note. The format bar stays hidden while a query is set. ⌘ F and ⌘ ⌥ F are in the editor keymap and in the app's global keys (for focus outside the editor), and in `RESERVED_SHORTCUTS`.

## Link folding

With **Show links as their text** (`settings.editor.foldLinks`, on by default) and live preview on, `linkDecorations` in `link-tools.ts` hides the Markdown around a link's text with `Decoration.replace`: `[` and `](url)` of a Markdown link, `[[target|` and `]]` of a note link. The text stays real document text, so selection, spellcheck and hover keep working. A bare address longer than 48 characters becomes a `ShortUrlWidget` (`host/…/last`); a click selects the whole address.

A link opens up when a selection reaches inside it; its ends do not count, so typing right after a link keeps it folded. While the pointer is down, decorations do not follow the selection, so a click or drag never makes the line jump; they update on release. Reference links (`[text][ref]`) and images keep their Markdown.

## Hover cards

`linkHover` uses `hoverTooltip` with a 320 ms delay. `settings.editor.linkPreviews` controls it:

| Value   | UI label        | Behaviour                                                                 |
| ------- | --------------- | ------------------------------------------------------------------------- |
| `off`   | **Off**         | No hover cards.                                                           |
| `notes` | **Notes**       | Cards for `[[links]]` only. The card shows the opening lines of the note. |
| `all`   | **Notes & web** | Also cards for web links. The default.                                    |

For `all`, `fetchLinkPreview` requests the page with `publicOnly: true`. It reads `og:title`, `twitter:title` or `<title>`, and a description, from at most 400,000 characters of HTML. It runs no page code and sends no note text. Results stay in memory for 30 minutes, with at most 128 entries.

Cards also offer **Unlink** (`unlink(view, link)` keeps the visible text), and website cards **Copy** and **Edit** (selects the address).

## Edit with AI

`aiTools(host)` adds the AI panel. `openAiActions(view, host, action?)` selects the edit range (the selection, or the paragraph at the cursor) and opens the panel as a CodeMirror tooltip below it. The panel has four phases in `aiSessionField`: `menu`, `running`, `result` and `error`. Any document change or selection change ends the session and aborts its request. Focus moves into the panel synchronously, never on the next frame, so a fast key never types over the selection.

The result phase shows `wordDiff(original, result)` from `src/notebook/revisions/diff.ts`. **Replace** dispatches one change with `userEvent: 'input.ai'` and `isolateHistory`, so one undo restores the original, and calls `host.beforeReplace(label)` first; the app keeps a safety revision there.

`aiEngine(settings)` decides whether the actions are offered: the activated provider must be a chat model (an external provider, or a local server with the chat protocol). `runTextAction` sends the passage, up to 600 characters before it, 300 after it and the note title as JSON data, and `cleanRewrite` removes labels, fences and wrapping quotes while keeping the selection's outer whitespace.

## The pulse while a model works

`aiPendingField` holds a position; `pendingDecorations` draws `PulseWidget` there. `MarkdownEditor` sets it when a suggestion or a web search starts and clears it when the request ends. It also clears on any edit or cursor move. The style comes from `settings.ai.indicator` (`orb`, the default, `spark`, `bloom`, `firefly`, `ink`, `scribble`, `orbit`, `dots` or `off`). Orb, Spark and Bloom use fixed saturated colours with a light rim, so they read on any palette; the others use `--accent`, which the palette keeps readable. In the Preferences gallery only the host span becomes a block: an animation's own `display` must stay, or flex-based styles such as Dots collapse. Each style fades in after 140 ms so a fast answer never flickers, uses the accent colour, and stays still with reduced motion. To add a style, add it to `PULSE_STYLES` and `pulseElement`, add its CSS to `ai-pulse.css`, and add the id to `AiIndicatorStyle` and `parseAi`.

## Selection colours

CodeMirror's base theme styles the focused selection with `.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground` (five classes). `writingSurface` matches that selector exactly so `--editor-selection` wins. The format bar is itself the tooltip element, so its styles in `app-shell.css` need `.markdown-editor .cm-editor .cm-tooltip.cm-format-bar` to beat the base `.cm-tooltip` background. Editor tooltips are hidden while a dialog is open (`body:has(.dialog-content)`).

## Live preview

`livePreview()` returns two parts: a view plugin for inline widgets and a state field for tables. A widget appears only where no selection range touches the Markdown. When the cursor enters the range, the raw Markdown shows again. A rendered task box is a real checkbox. A click calls `toggleTaskAt`, which edits the Markdown. **Live preview** off removes the extension through a `Compartment` without a new editor.

## Performance

The e2e test `typing stays responsive in a long note with lists and tables` pastes 400 blocks of headings, nested lists, tables and links. It then types 60 characters. The median frame time must be below 40 ms and the 95th percentile below 120 ms. Run this test after a change to live preview, link styles or completion sources. Keep decorations limited to the visible ranges where possible.

A keystroke has two costs: the CodeMirror update and the React update of the app shell after `onChange`. Measured in development mode with 400 notes and a 13,500-line note, the CodeMirror update takes about 0.2 ms. Keep the React part small:

- The sidebar note list is `NoteList` → `NoteListBody` → `NoteListItem`, all memoized. Rows are rebuilt only when a visible row value changes (title, date text, source count). Text edits change no row.
- The word count follows a 400 ms pause, not each key.
- Rarely used dialogs (`Preferences`, `NoteGraph`) load with `React.lazy` on first use and stay mounted after that.
- The table preview field maps rendered tables through edits. It scans the document again only when an edit touches a line with a pipe, the edit is next to a table, a rendered table changes, or background parsing finishes more of the document.
- Background services read their state from memory, not from storage, on each edit (for example the Git sync versions).

With these rules, the 95th percentile frame stays at about one frame (13–15 ms at 60 Hz) in development mode. Measure with a CPU profile before you add work to the `onChange` path.

## Writing flow

`writing-flow.ts` holds the small aids around the text. Each aid reads its setting through the `FlowHost` callbacks, so a settings change needs no new editor. Call `refreshFlow(view)` after a change.

- **Format bar.** A tooltip on a non-empty selection outside code. It wraps the selection (bold, italic, strike, code, link, note link, quote) and can start web facts.
- **Focus.** Lines outside the current paragraph or sentence get `cm-flow-dim`. Only visible lines get decorations.
- **Typewriter.** When the cursor changes line, the view scrolls the line to the middle.
- **Smart typography.** `smartReplacement(before, typed)` returns the change for `--`, `...`, `->` and `<-`. It does nothing at the start of a line, in a table row, in code or after an open backtick.
- **Smart paste.** A pasted web address becomes `[host/path](url)`. When link previews may contact websites, the label changes to the page title when the preview arrives.

The outline, the "Linked from" list and the word goal are React components in `src/notebook/WritingAids.tsx`. They read the note text, not the editor state. `MarkdownEditor` has `jumpTo(pos)` for the outline and the command palette.

## Command palette

`CommandPalette.tsx` shows notes, headings and actions. `command-palette.ts` does the ranking with no React. The app passes `workspace.notes`, the headings and a memoized action list. The chosen command runs after the dialog closes and gives focus back, so a command can move focus itself. The query resets each time the palette opens, during render, not in an effect: a fast first key must not see the last query.

## Rules

- Do not store state outside the CodeMirror state. Use `StateField` and `StateEffect`.
- Give each programmatic change a `userEvent` (for example `input.complete`, `input.table`). Undo groups and tests depend on it.
- Do not open a menu or a hover card inside code.
- Keep suggestion text outside the document until the writer accepts it.
