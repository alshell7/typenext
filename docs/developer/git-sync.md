# Git sync

Git sync mirrors every note as a Markdown file in a Git repository that the writer chooses. It uses the system `git` command. It works only in the desktop app.

## Components

| Part | File | Task |
| --- | --- | --- |
| Rust commands | `src-tauri/src/git_sync.rs` | Check Git and the repository, set up a repository, write files, commit, fetch, rebase or merge, push. |
| Service | `src/services/git-sync.ts` | Command wrappers, change tracking, commit messages, the merge of remote changes into the notebook. |
| Scheduler | `src/notebook/useGitSync.ts` | When to sync, back-off after errors, the shared status. |
| Interface | `src/notebook/preferences/SyncPane.tsx`, `src/notebook/GitSyncStatus.tsx` | Settings, setup, **Sync now**, the sidebar status line. |

## Commands

| Command | Request | Result |
| --- | --- | --- |
| `git_sync_check` | `{ folder }` | `GitRepoStatus`: Git installed and version, repository, branch, remote without credentials, upstream, ahead, behind, last commit. |
| `git_sync_init` | `{ folder, remote?, branch? }` | Creates the folder, runs `git init`, writes `.gitattributes`, adds `origin`. It never replaces a different existing remote. |
| `git_sync_run` | `{ folder, notes, deletedIds, knownIds, message, pull, push }` | `GitSyncResult`: status, committed, pulled, pushed, `remoteChanges`, `remoteDeletedIds`, `conflicts`. |

## File format

Each note is `notes/<slug>--<first 8 characters of the id>.md`:

```
---
typenext-id: <id>
title: "<title>"
updated: <RFC 3339 UTC>
---
<Markdown, LF line endings>
```

A state file in `.git/typenext-sync.json` records the path and content hash of each note. It is not committed. A file in `notes/` without front matter becomes a note with an identifier from the hash of its path.

## One sync

1. The scheduler sends only notes whose `updatedAt` differs from the last synced value. Synced values are kept per folder in memory and in `localStorage`.
2. Rust writes a file only when its hash changed. A changed title moves the file.
3. Rust commits when there are staged changes.
4. When `pull` is true and an upstream exists, Rust fetches and rebases. When the rebase conflicts, it aborts the rebase and merges with `-X ours`. Local text wins in the repository. The remote version of each conflicting note returns in `conflicts`.
5. Rust compares the commit before and after the pull. It returns new and changed notes and deleted note ids.
6. When `push` is true, Rust pushes.
7. `applyRemoteChanges` merges the result into the notebook. It never loses writing:
   - A note not edited here since its last sync takes the remote text.
   - A note edited here keeps its text. The remote text becomes a new note "Title (from Git)".
   - Each conflict becomes a new note "Title (other version)".
   - A remote deletion removes a note only if it was not edited here.

## Scheduling and load

- A sync runs on start, after writing pauses (**Wait after writing**), on the pull interval when the window is visible, and on **Sync now**.
- One sync runs at a time. A request during a sync runs after it.
- After an error, the next automatic attempt waits 30 seconds, then twice as long each time, up to 10 minutes.
- Git processes run off the async runtime with a lower process priority, `GIT_TERMINAL_PROMPT=0` and a time limit. Git never asks for a password in a hidden terminal.

## Tests

- `src/services/git-sync.test.ts`: change tracking, commit messages and every merge rule.
- `src/notebook/useGitSync.test.tsx`: the scheduler with a mocked Rust command.
- `src-tauri/src/git_sync.rs`: tests with temporary repositories and a bare remote, which act as two computers.
