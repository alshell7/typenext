# Workspaces, folders, tags and history

## Workspaces

Workspaces (`NoteSpace`) live in `workspace.spaces`, with `activeSpaceId`. Notes, folders and tags carry an optional `spaceId`; an item without one, or with an unknown one, belongs to the first workspace (`spaceOf`). So a notebook from before workspaces is one workspace, **Personal** (`HOME_SPACE`), with no migration. Context packages carry optional `spaceIds`; no list means every workspace.

`src/notebook/spaces/spaces.ts` holds the operations: `spaceView` (what the open workspace sees: its own items plus those of shared workspaces; with one workspace it returns the stored arrays unchanged), `switchSpace` (remembers the tabs of the workspace left and restores the target's, or opens its latest note), `moveToSpace` (a folder brings its subfolders and notes; a single note leaves its folder), `deleteSpace` (move or delete what it holds; the last workspace stays) and `setContextSpaces`.

`App.tsx` passes `view.notes`, `view.folders`, `view.tags` and `view.packages` to the sidebar, the editor (link completion and hover cards), the command palette, the graph and the context views. The sidebar shows the open workspace's tree, then one section per shared workspace. `WorkspaceSwitcher.tsx` replaces the old privacy line at the foot of the sidebar and carries it in its subtitle; `WorkspaceManager.tsx` edits names, colours, icons (`IconPicker.tsx`, ids from `space-icons.ts`; `suggestIcon` picks one from a new workspace's name), sharing, Git folders and removal. An icon id this release does not know falls back to the initial.

Git: `syncTargets` in `useGitSync.ts` lists each workspace with a repository folder (`spaceGitFolder`: the first workspace uses `settings.git.folder`). Each target syncs only its own notes, in turn, and notes new to a repository join that workspace (`applyRemoteChanges(…, spaceId)`). Two workspaces never share one folder.

## Folders and tags

The workspace keeps `folders` (`NoteFolder`: id, name, optional `parentId`, colour, `collapsed`) and `tags` (`NoteTag`: id, name, colour). A note has an optional `folderId` and `tags` (tag ids), and optional `contextFolderIds` for folders used as context. All changes go through pure functions in `src/notebook/organize/organize.ts`, which return a new workspace and never change `updatedAt`, so organising does not reorder the note list or count as an edit.

- Folders form a tree. `canMoveFolder` refuses a move into the folder itself or a folder inside it. `deleteFolder` moves its notes and folders up one level and drops the folder from `contextFolderIds`.
- Tags are found by name without case (`findTag`). `ensureTag` creates a tag only once. Renaming a tag to an existing name merges the two (`mergeTags`).
- Colours are names (`OrganizeColor`), not values. `organize.css` defines `--org-*` for light and dark, and `.org-<name>` sets `--org`.

`validateWorkspace` in `src/services/storage.ts` keeps these fields and repairs rather than rejects: a folder whose parent is missing or would make a cycle moves to the top level, and a note's unknown folder, tags or context folders fall away. The desktop `workspace.rs` keeps them through its `#[serde(flatten)] extra` fields.

The sidebar is `NoteTree.tsx`. It builds one flat row list (folders, their notes, then top-level notes; or matches for a search or a tag filter) and keeps the same rows while their JSON is unchanged, so typing does not re-render the list. Rows support drag and drop (`application/x-typenext-item`), context menus and inline rename. `Menu.tsx`, `TagPicker.tsx`, `TagStrip.tsx` and `TagManager.tsx` are the menus and pickers. They use `Popover.tsx`, which renders inside a dialog when it opens from one (so focus stays in the dialog and a click in it does not close the dialog), stays inside the dialog's edges and focuses its first control before the first paint.

Folder context: `resolveNoteContext(note, notes, library, packages, folders)` links each note from `folderContextNotes` (the folder and its subfolders, newest first, at most 64) as a live note reference.

## History (revisions)

Revisions are snapshots of a note's Markdown in IndexedDB (`typenext-revisions`), deflated with fflate. They are not in the notebook file, Git sync or exported Markdown. `src/notebook/revisions/store.ts` has the API (`addRevision`, `listRevisions`, `revisionText`, `updateRevision`, `deleteRevision`, `deleteNoteRevisions`, `clearRevisions`, `revisionUsage`) and a memory store for tests and browsers without IndexedDB.

- `addRevision` skips text equal to the newest revision; a manual save or a name on unchanged text names the newest revision instead.
- `revisionsToPrune` keeps every revision from the last day, one an hour after that, one a day after a week, then removes the oldest unprotected ones above the limit or 48 MB per note. Named and pinned revisions and the newest revision always stay.
- `useRevisions` (in `App.tsx`) takes automatic revisions after a 4 s pause when `shouldCapture` agrees (`minChanges` characters changed and `minMinutes` since the last one), when the writer leaves a note or the window, and a safety copy before a large deletion (`largeDeletion`). `safetyCopy` is called before AI replacements, restores and merges.

`RevisionHistory.tsx` compares with `lineDiff` and shows each hunk with `wordDiff`. **Bring back** uses `revertHunks(current, hunks, chosen)`, which puts the older lines of the chosen hunks back into the current text. A restore or merge goes through `MarkdownEditor.replaceDocument`, one undoable change, and adds a `restore` or `merge` revision.

## Tests

- Unit: `organize/organize.test.ts`, `revisions/diff.test.ts`, `revisions/store.test.ts`, `note-context.test.ts`.
- End to end: `tests/e2e/organize-history.spec.ts` (folders, drag and drop, tags, folder context, revisions, the Updates pane spacing) and `tests/e2e/writing-ai.spec.ts` (selection colours, link folding, AI actions, the pulse, shortcuts, word limit, colour picker).
