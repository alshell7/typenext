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
| Mod-ArrowRight | Accept one word of the inline suggestion.                                                          |
| Mod-Space      | Request suggestion choices.                                                                        |
| Alt-Enter      | Open the link at the cursor (`link-tools.ts`).                                                     |

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

## Hover cards

`linkHover` uses `hoverTooltip` with a 320 ms delay. `settings.editor.linkPreviews` controls it:

| Value   | UI label        | Behaviour                                                                 |
| ------- | --------------- | ------------------------------------------------------------------------- |
| `off`   | **Off**         | No hover cards.                                                           |
| `notes` | **Notes**       | Cards for `[[links]]` only. The card shows the opening lines of the note. |
| `all`   | **Notes & web** | Also cards for web links. The default.                                    |

For `all`, `fetchLinkPreview` requests the page with `publicOnly: true`. It reads `og:title`, `twitter:title` or `<title>`, and a description, from at most 400,000 characters of HTML. It runs no page code and sends no note text. Results stay in memory for 30 minutes, with at most 128 entries.

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
