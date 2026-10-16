# Semantic search

Semantic search finds reference passages by meaning. It works beside the BM25 index, which finds matching words. The embedding model is Google EmbeddingGemma 2 in GGUF format, served by llama.cpp `llama-server` on the loopback interface. Semantic search is off by default (`settings.semantic.enabled = false`).

## Components

```
Preferences → Knowledge (KnowledgePane.tsx)
        │
embedding-runtime.ts ── invoke / listen ──► src-tauri/src/embedding.rs  (managed mode)
        │                                         │ spawns
        ▼                                         ▼
embedding-client.ts ── HTTP, Bearer key ──► llama-server on 127.0.0.1:<random port>
        ▲
semantic-retrieval.ts ── vector-store.ts (IndexedDB "typenext-vectors")
        ▲
completion.ts · AttachedSearch.tsx · media-sources.ts
```

| File                                 | Responsibility                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `src-tauri/src/embedding.rs`         | Downloads, verifies, starts, watches and stops the managed `llama-server`.       |
| `src/services/embedding-runtime.ts`  | Pinned names and sizes for the UI, mode selection, endpoint resolution.          |
| `src/services/embedding-client.ts`   | The request queue, prompts, Matryoshka truncation and the HTTP calls.            |
| `src/services/semantic-retrieval.ts` | Per-note index, background indexing, ranking, fusion, budgets, next-line recall. |
| `src/services/vector-store.ts`       | Vector cache in memory and IndexedDB.                                            |
| `src/services/media-sources.ts`      | Image, audio and video references.                                               |

## Runtime manager (Rust)

`EmbeddingState` in `embedding.rs` owns the managed server. The install root is `app_data_dir()/embedding`:

```
embedding/
├── runtime-b11696/      llama.cpp files and .typenext-runtime.json
├── models/              GGUF files
├── downloads/           temporary .part files
└── llama-server.pid     pid file for orphan cleanup
```

Tauri commands: `embedding_runtime_status`, `embedding_runtime_install`, `embedding_runtime_cancel`, `embedding_runtime_start`, `embedding_runtime_stop`, `embedding_runtime_remove`. The manager emits `embedding-runtime-status` with an `EmbeddingRuntimeStatus` payload. The states are `unsupported`, `idle`, `downloading`, `starting`, `running` and `error`.

### Downloads and verification

- All SHA-256 values are pinned in Rust only, in the `Asset` constants. The TypeScript side has names and sizes for display.
- A download streams into `<file>.part` and hashes the bytes while it writes. An interrupted download resumes with a `Range` request.
- The `.part` file gets its final name only when the size and the SHA-256 agree with the pinned values.
- The client uses HTTPS only, no compression, no credentials and the user agent `TypeNext/<version>`.
- The llama.cpp archive extracts to a temporary folder. Paths with `..`, absolute paths, drive letters, `:` or NUL are refused. A symlink can point only to a sibling file.
- The marker `.typenext-runtime.json` records the release, the archive hash and the hash of each extracted file. The runtime counts as installed only when all of these verify again.

Pinned assets:

| Asset                    | File                                   | Bytes       |
| ------------------------ | -------------------------------------- | ----------- |
| llama.cpp, macOS arm64   | `llama-b11696-bin-macos-arm64.tar.gz`  | 12,222,784  |
| llama.cpp, macOS x64     | `llama-b11696-bin-macos-x64.tar.gz`    | 11,704,689  |
| llama.cpp, Linux x64     | `llama-b11696-bin-ubuntu-x64.tar.gz`   | 17,883,307  |
| llama.cpp, Linux arm64   | `llama-b11696-bin-ubuntu-arm64.tar.gz` | 13,935,439  |
| llama.cpp, Windows x64   | `llama-b11696-bin-win-cpu-x64.zip`     | 19,575,690  |
| llama.cpp, Windows arm64 | `llama-b11696-bin-win-cpu-arm64.zip`   | 12,469,399  |
| Model, Balanced (Q4)     | `embeddinggemma-2-UD-Q4_K_XL.gguf`     | 175,673,856 |
| Model, Precise (Q8)      | `embeddinggemma-2-Q8_0.gguf`           | 309,855,520 |
| Media encoder            | `mmproj-Q8_0.gguf`                     | 554,821,120 |

The models come from `unsloth/embeddinggemma-2-GGUF` at revision `031f0d4b35536f69ab3509d4893c923264fcf253`. Other platforms get the state `unsupported`.

### Server start

`server_args` builds this command line:

```
llama-server --model <model> [--mmproj <mmproj>] --alias embeddinggemma2 \
  --embeddings --pooling mean --ctx-size N --batch-size N --ubatch-size N \
  --parallel 1 --host 127.0.0.1 --port <port> --no-webui --offline --log-colors off
```

- `N` is clamped to 512–8192. The frontend requests 8192 with media and 2048 for text only. One input must fit in one micro-batch, so the three size flags use the same value.
- The port comes from a bind to `127.0.0.1:0`. When the log reports that the address is in use, the manager tries again, up to three attempts.
- The API key is 32 random bytes in hex, new for each start. It goes into the `LLAMA_API_KEY` environment variable, never into an argument. The manager removes inherited `LLAMA_*` variables, and it redacts the key in captured logs.
- The manager polls `GET /health` every 250 ms with the key. The server is ready at HTTP 200 with `status: "ok"`. The deadline is 90 seconds.
- A running server with the same quantization, and media when media is needed, is reused.

### Shutdown and orphan cleanup

- `Server::drop` kills the child process and waits for it. `EmbeddingState::shutdown` runs on `RunEvent::Exit`, because Tauri does not drop managed state at exit.
- A watch loop checks the server every 2 seconds. A stopped server sets the error `The embedding server stopped unexpectedly (…)` with the most relevant log line.
- Each start writes `llama-server.pid` with the server pid, the TypeNext pid and the canonical binary path.
- At startup and before each start, `reap_orphan` reads the pid file. It ends the process only when the owner is gone, the recorded path is inside the current `runtime-b11696` folder, and the live executable path is equal to the recorded path. In all other cases it discards the pid file.

## Client queue

`embedding-client.ts` has one global queue. It sends one request at a time, because `llama-server` runs with one slot.

| Priority      | Used by                                    | Rule                                                                                       |
| ------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `interactive` | Queries, media embedding, connection check | Goes before the first queued background job.                                               |
| `background`  | Index batches                              | At most 64 queued jobs. More jobs fail with `The embedding queue is full. Try again soon.` |

- Text: `POST /v1/embeddings` with `model: "embeddinggemma2"`, up to 16 inputs, 6,000 characters each, 30-second timeout.
- Media: `POST /embeddings` with the `media_marker` from `/props` and base64 data, 180-second timeout.
- Capabilities: `GET /props` (`media_marker`, `modalities`, `build_info`), cached for each endpoint and key.
- Query prompt: `task: search result | query: <query>`. Document prompt: `title: <name> | text: <text>`.
- The server must return 768 finite values (mean pooling). `truncateVector` keeps the first 128, 256, 512 or 768 values and normalises them to unit length. Media vectors are stored at 768 and truncated at query time.

## Index

`semantic-retrieval.ts` keeps one index for each note, in an LRU of 8 indexes.

- Only enabled sources are indexed. Text is cut to 300,000 characters for each source and split into chunks of 900 characters with 140 overlap, at most 3,000 chunks. BM25 uses its own chunks of 1,400 characters.
- A chunk key is `<modelIdentity>:<dimensions>:<textHash(name + "\0" + text)>`. `modelIdentity` is `google/embeddinggemma-2:<quantization>` in managed mode and `google/embeddinggemma-2:server:<endpoint>` for an own server.
- `App.tsx` starts indexing 1,200 ms after the note or the semantic settings stop changing. A search also starts it.
- Indexing reads cached vectors first, then embeds the rest in batches of 16 at `background` priority. It publishes progress after each batch. An abort stops it.
- Query vectors are cached in an LRU of 256 entries. There is no time limit.

## Ranking and fusion

1. `rankSemantic` computes cosine similarity as a dot product of unit vectors.
2. The similarity floor is `max(0.58, best − 0.12)`. At most 64 candidates above the floor continue.
3. Maximal marginal relevance with λ = 0.75 selects diverse passages (default limit 6).
4. `retrieveHybrid` always runs BM25 (top 8). It races semantic search against a latency budget.
5. `fuseRetrieval` applies reciprocal rank fusion: `weight / (60 + rank + 1)`, with weight 1 for BM25 and 1.1 for semantic hits.
6. A BM25 chunk and a semantic chunk from the same source merge when one contains a distinctive window of the other. A merged passage has the kind `hybrid`.
7. The result has at most two passages for each source and at most 6,000 characters.

| Caller                                    | Budget           |
| ----------------------------------------- | ---------------- |
| Automatic suggestions (`completion.ts`)   | 700 ms           |
| Manual choices, `purpose: 'alternatives'` | 1,800 ms         |
| **Find in attached context**              | 900 ms (default) |
| Next-line recall                          | 700 ms           |

BM25 results are used alone when the budget ends, when semantic search fails, or when it returns nothing. A slow or stopped server never blocks a suggestion.

### Next-line recall

`semanticNextLines` adds candidates to the local recall engine. It runs only when all of these conditions are true:

- Semantic search is on, and the suggestion budget allows at least 12 words.
- The provider is local, and the engine is **Writing starters & recall** (or a local server with no model).
- The selection is empty, the cursor is not in code, and the text before the cursor ends at a sentence start or a line start.

It searches with the objective and the current paragraph (at least 8 characters, limit 3). It splits the hits into sentences of 12–280 characters and skips sentences that are already in the note. It returns at most two lines. Exact recall stays first. Meaning-based lines come before writing starters.

## Vector cache

`vector-store.ts` keeps vectors in IndexedDB database `typenext-vectors`, object store `chunks`, keyed by the chunk key. `textHash` is the 53-bit cyrb53 hash in base 36. A memory LRU holds at most 12,000 vectors. When IndexedDB is not available, the store works in memory only. IndexedDB has no size limit or eviction in this code. `clearVectors()` exists but has no caller outside tests.

## Media pipeline

`media-sources.ts` imports image, audio and video files as references. It needs semantic search and **Images, audio and video** on, and a server whose `/props` reports the modality.

| Kind  | Limit                | Accepted extensions               |
| ----- | -------------------- | --------------------------------- |
| Image | 20 MB                | `.png .jpg .jpeg .webp .gif .bmp` |
| Audio | 30 MB and 3 minutes  | `.wav .mp3 .m4a .aac .ogg .flac`  |
| Video | 50 MB and 45 seconds | `.mp4 .m4v .webm .mov`            |

1. The file type is checked by MIME type, then by extension. The size limit is checked before the file is read.
2. A browser media element reads the duration. For images and videos it draws a thumbnail: 320 px longest edge, JPEG, at most 64,000 characters. The video thumbnail comes from `min(1 s, duration / 2)`.
3. The whole file goes to `/embeddings` as base64. The client does not transcode or sample frames.
4. The source keeps `media.vector` (768 values, base64 Float32), `media.vectorModel`, the thumbnail, the size, the duration and a caption. The file itself is not stored.
5. The index adds a chunk `media:<id>` with the stored vector. A media hit reaches the prompt as `Image “<name>”: <caption>` (or `Audio`, `Video`).

The limits follow the 8,192-token context: an image is about 280 tokens, a video frame about 140 tokens at 1 frame per second, and audio about 25 tokens per second. The code comment in `embedding-client.ts` names PNG/JPEG, WAV/MP3 and MP4 as the server formats. The other accepted formats depend on the llama.cpp build.

## Change the pinned versions

CAUTION: A wrong size or hash makes every install fail for that platform. Download each file and compute its SHA-256 yourself. Do not copy hashes from a web page.

### New llama.cpp release

1. In `embedding.rs`, change `LLAMA_RELEASE`, the tag inside `RUNTIME_BASE_URL` (a separate literal) and `RUNTIME_DIR`.
2. Change all six `file`, `bytes` and `sha256` rows in `runtime_asset_for`.
3. In `embedding-runtime.ts`, change `EMBEDDING_RUNTIME.llamaCppRelease`. Update `runtimeBytes` (an approximate display size) if necessary.
4. Update the pinned values in the Rust tests `manifest_selects_the_pinned_archive_for_each_desktop_target` and `install_plan_downloads_only_missing_files_from_pinned_urls`, and the `b11696` fixtures.
5. Check `server_args` against the `llama-server` README of the new release. Update `server_arguments_bound_the_batch_and_keep_the_key_off_the_command_line` and the own-server command in `KnowledgePane.tsx` (`serverCommand`) and `Preferences.test.tsx`.
6. Run `cargo test --manifest-path src-tauri/Cargo.toml` and the ignored `managed_server` test (see [testing](testing.md)).
7. Update `docs/third-party.md`, `docs/licensing.md` and the user guide.

After an upgrade, the old marker fails its check and the runtime downloads again. The old `runtime-<tag>` folder stays on disk until the writer selects **Remove**. Orphan cleanup ends only servers inside the current runtime folder.

### New model revision or files

1. In `embedding.rs`, change the revision in `MODEL_BASE_URL`, the file, bytes and SHA-256 in `Quantization::asset()`, and `MEDIA`.
2. In `embedding-runtime.ts`, change `modelRevision` and the `file` and `bytes` values.
3. For new quantization names, also change the serde names, `EmbeddingQuantization` in `src/types/notebook.ts` and the default in `src/notebook/model.ts`.
4. Update `Preferences.test.tsx` and `features.test.ts`.

CAUTION: `modelIdentity` does not contain the model revision. New weights with the same quantization name reuse old cached vectors and old media vectors. Change `EMBEDDING_MODEL` or the identity format when the weights change, so that every vector is computed again.
