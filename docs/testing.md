# Testing TypeNext

## Sample context verification, 2026-10-06

The final suite passed **604 unit tests** across 27 files and **64 Edge browser tests**, with two live-provider tests intentionally skipped. TypeScript, zero-warning ESLint, the production frontend build and the normal Windows debug NSIS build passed. The browser run refreshed the sample screenshots at desktop and narrow dark sizes. Earlier Rust/native runtime checks below were not rerun for this frontend change. Git attributes preserve the sample's raw-import line endings so its byte checks also survive Windows checkouts.

**Try a sample** uses ordinary note creation, reusable packages, source resolution and local BM25. Tests cover two attached packages, four source files, exclusion of disabled or unattached material, live-note changes, detachment, cache invalidation and bounded prompts. Integration checks inspect real retrieval output before all seven inference routes: embedded SmolLM, local chat, local native FIM, OpenAI, OpenRouter, Anthropic and custom chat. Both automatic and manual requests use this retrieval path. Provider responses in these regressions are synthetic; they verify which passages are sent, rather than model accuracy.

The optional sample's browser tests cover welcome and existing-notebook entry points, automatic recall after typing all three fact fragments, manual choices, acceptance, undo, persistence, package detachment, reopening without resetting edits or settings, cursor restoration, real ZIP downloading, and narrow dark layouts. Offline sample flows assert zero external requests. The archive is checked byte-for-byte against the Markdown/text files imported by the app. The [real SmolLM sample run](builtin-models.md#shipped-context-sample-6-october) separately tested six fact/temperature combinations: three reproduced the requested fact, while three remained unhelpful despite receiving the right reference. Default no-model recall returned all three sample facts correctly.

Two deliberately enabled, real OpenRouter automatic-suggestion attempts used only the public fictional sample. Each run first verified zero prompt, completion and request prices in the current public catalog, permitted one inference POST, and disabled retries, traces, screenshots and video. Both outgoing requests included the exact Friday 16:00 fact from `house.md`.

| Model                                | HTTP result | Observed outcome                                                                                                                                                                                                       |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google/gemma-4-26b-a4b-it:free`     | 429         | Provider error; no generation.                                                                                                                                                                                         |
| `nvidia/nemotron-3.5-lightning:free` | 200         | Reported cost 0. A visible suggestion appeared in about 3.5 seconds including typing and the 1.8-second pause, but copied unrelated voice text and omitted the arrival fact. Transport passed; factual quality failed. |

The scenario is `tests/e2e/demo-openrouter-live.spec.ts` and skips by default. Set `TYPENEXT_DEMO_OPENROUTER=1` for a deliberate live run, or `TYPENEXT_DEMO_OPENROUTER_DRY_RUN=1` for a synthetic response without an inference request. The dry run still checks the unauthenticated public catalog. `TYPENEXT_DEMO_MODEL` can select a different eligible free model; there is no automatic provider fallback. Test keys are read from ignored `CREDENTIALS.txt` only in memory. Sanitized outcomes are retained separately under ignored `artifacts/demo-openrouter-live/`.

The captured NVIDIA response also exposed a missing separator after the complete word `House`. The shared prose sanitizer now handles capitalized multiword phrases at an end-of-note boundary, retaining partial-word and code behavior. Fourteen unit regressions and the offline `demo-provider-replay.spec.ts` browser test cover the recorded output, its BM25-built request, preview, Tab acceptance, exact undo and absence of real hosted requests. This repairs insertion mechanics without treating the response as factually correct.

## SmolLM prose regression, 2026-10-06

After replacing the built-in JSON prompt with literal prose and adding rejection of malformed model output, the full **512-unit-test suite**, TypeScript and zero-warning ESLint passed. Six additional Edge end-to-end cases exercise malformed raw worker output through the real engine transport and editor: automatic ghost text, fresh Ctrl+Space choices, Tab/Enter acceptance, undo, persistence, withholding a suggestion when no local fallback fits, and preserving an intentional fenced HTML completion. They assert no external requests. The model output is synthetic in these browser regressions; the separate [real pinned-model smoke](builtin-models.md#prose-regression-check-6-october) executes 20 local generations through the engine and completion service at temperatures 0 and 0.35, with zero external requests after cache loading. The production frontend and normal Windows debug installer were rebuilt. Earlier native/Rust results below were not rerun for this frontend-only fix.

## Verified on Windows, 2026-10-05

Verification includes **441 unit tests**, **53 browser end-to-end tests** in installed Microsoft Edge and **29 Rust tests**. The live-provider scenario is deliberately skipped in ordinary regression runs; its opt-in results, including the fresh-choice request and recorded-response repair, are recorded below. Two Rust helper/diagnostic entries are intentionally ignored as standalone tests. TypeScript, zero-warning ESLint, Rust formatting, strict Clippy, the production frontend build and Windows Tauri/NSIS builds passed. Four Python training-data tests also passed. `npm audit` reported zero known vulnerabilities at verification.

The browser scenarios cover an empty notebook, title/background creation, Markdown editing, independent tabs, recent-note search, reload persistence, autosave off, recovery from corruption, focus mode, keyboard focus, themes and fonts, and narrow layouts. Suggestions are checked at the cursor, including whole/word acceptance, undo, suffix preservation, cancellation, stale responses, adaptive budgets, local chat and FIM transport, provider errors, and repeated suggestions after deliberate external activation. Context scenarios exercise real text, PDF and DOCX fixtures, website and optional Firecrawl imports, inclusion/removal, and another note linked as live context across edits and reload. Privacy checks assert that merely configuring a provider leaves typing and shortcuts local. Activating continuous external mode deliberately routes subsequent suggestions to the chosen provider; switching back to local stops that routing.

`npm run test:native:windows` separately builds and launches the actual Windows WebView2 application with a fresh test identifier. It verifies real Rust HTTP to a synthetic loopback model server, inline preview and menu acceptance, native atomic autosave, file-scope and website-address denials, the operating system close event, cancelling close, saving and quitting, and recovery on restart. With autosave off, “Quit without saving” leaves the saved workspace byte-for-byte unchanged. The run reported no unhandled JavaScript errors. The basic native transport check uses a synthetic model response. The extended run with `TYPENEXT_NATIVE_AI_SMOKE=1` also passed real SmolLM2 download/inference/acceptance/unload and real Whistle download, synthetic microphone capture, local transcription, insertion, focus return and undo. See [built-in model evidence](builtin-models.md) and the earlier [local-server smoke](local-model-smoke.md).

The native smoke also saves while continuous typing is still in progress, forcibly terminates the app without its close handler, then restarts and verifies the exact last durable text. The Rust suite separately executes ten actual child-process kills at save checkpoints, including the first-ever save. Recovery leaves damaged originals intact. Scheduling deadlines govern requests rather than guaranteeing every keystroke is immediately durable; see [save and recovery behaviour](reliability.md).

Native tests use an isolated app-data directory and credential-vault namespace, synthetic writing, and a fresh WebView profile. They do not access the normal notebook or its saved provider keys. The script is Windows-only and requires the desktop development prerequisites and installed Edge.

The macOS and Linux build/test jobs are configured in `.github/workflows/check.yml`; they have not been executed on this Windows workstation. A Windows NSIS debug installer was built with the normal app identifier. Installation/uninstallation and code signing have not been tested locally. Browser checks here used Edge; they do not establish compatibility with every browser or every model.

Nineteen settled app screenshots were captured from synthetic writing for the README and project site, including the note picker, linked-note preview, desktop/narrow palette controls, and the new suggestion menu without attached references. Preset contrast tests cover page and sidebar roles; browser checks verify mixed white-page/black-sidebar custom colours, invalid input, Escape restoration, independent palette persistence, keyboard selection, and narrow layouts. No real writing or provider credentials are present in those screenshots.

The no-reference scenarios cover blank-note choices, automatic inline starters, arrow-key preview, Enter/Tab/pointer acceptance, undo, Escape, disabled automatic suggestions, typing cancellation, local-model requests without references, narrow dark layouts, and reduced motion. Offline scenarios make no network requests; navigating a model suggestion's alternatives makes no additional inference requests. Focused regressions also cover composition, stale detached options, alternative cache accounting, placeholder restoration, and a blank-focus timer that previously replaced an open manual menu. The visual review identified a narrow-footer overlap; the final fix passed a focused browser regression and the review's final verdict was **Pass**, with all reported criteria resolved.

The resource work has reproducible synthetic measurements and explicit cache/import bounds in the [service audit](services-resource-audit.md) and [editor audit](editor-resource-audit.md). It removes cursor-only document copies, halves typing conversions, replaces allocating word counts, bounds inactive editor/history state, and releases cancelled import resources. The final large-note sample observed a lower key median and similar p95; these short diagnostic samples are not total application RAM or model-inference benchmarks.

The built project site also passed a desktop/mobile browser smoke check served under `/typenext/`: its light/dark screenshot control worked, all requested assets loaded, the narrow page had no horizontal overflow, and no external requests or JavaScript errors occurred.

## Repeatable checks

```sh
npm ci
npm run typecheck
npm run lint
npm run test:run
npm run test:e2e
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
npm run tauri:build -- --debug --no-bundle
```

For the additional real Windows application check:

```sh
npm run test:native:windows
```

That command builds the test profile at the normal debug executable path. Rebuild with `npm run tauri:build -- --debug --no-bundle` before using that path as the regular notebook.

## Completion checks

The normal test suite uses synthetic writing and mocked provider responses. Run `npm run test:run` for service and editor tests, then `npm run test:e2e` for browser interaction checks. The live OpenRouter scenario is skipped unless explicitly enabled.

## Opt-in live OpenRouter check

`tests/e2e/openrouter-live.spec.ts` exercises the real browser application: configure an ephemeral session key, create a synthetic note, pause for ordinary suggestions, request a local suggestion, open and cancel the model chooser, explicitly activate continuous external mode, request one bounded set of three choices, preview them with arrow keys, accept one with Tab and undo it, then switch back to local. It checks that the document has not changed before acceptance, and that acceptance reconstructs the exact prefix + insertion + suffix. Merely configuring or viewing a provider must not activate it. Returning to local must stop hosted requests.

Put the test credential in the ignored root `CREDENTIALS.txt` file, then run this in PowerShell:

```powershell
$env:TYPENEXT_LIVE_OPENROUTER = '1'
npm run test:e2e -- tests/e2e/openrouter-live.spec.ts --reporter=list --output=test-results-live
```

The key is parsed from that file only in memory and entered in the application's password field. It is never included in source, logs, browser storage, screenshots, video or traces. The isolated browser context is destroyed at the end. The test disables retries and permits at most one model request per run. Its output contains only a redacted status, timing, fixed synthetic writing and insertion evidence.

To exercise the same UI flow with a synthetic key and a mocked response, set `TYPENEXT_LIVE_DRY_RUN=1` instead. Dry mode does not read the credential file and does not send an authenticated provider request. It still checks the public, unauthenticated catalog. Its evidence is explicitly labelled as a mock transport so it cannot be mistaken for live model verification.

The test checks the current public model catalog before sending writing. The selected model must exist, have zero prompt, completion and request pricing, and permit reasoning to be disabled. A paid or unavailable model causes the test to stop before any authenticated request. `TYPENEXT_LIVE_MODEL` can select another eligible fixed model for a deliberate separate run; there is no automatic model fallback. Free catalog entries have their own availability and rate limits. [OpenRouter free variants](https://openrouter.ai/docs/guides/routing/model-variants/free), [model catalog](https://openrouter.ai/api/v1/models).

OpenRouter requests use `/api/v1/chat/completions` with Bearer authentication. The completion engine asks for `reasoning.enabled: false` and `reasoning.exclude: true` because hidden reasoning can consume a tiny `max_tokens` budget before producing any visible insertion. Models with mandatory reasoning are unsuitable for this short-insertion test. [OpenRouter quickstart](https://openrouter.ai/docs/quickstart), [reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Live evidence, 2026-10-05

The credential file was confirmed ignored by Git. These first three provider attempts used synthetic text, catalog-verified zero input/output prices, a 64-token ceiling, one confirmed request per run, no paid fallback, and disabled traces, screenshots and video. There were **three authenticated provider POSTs** in this initial round; later checks are recorded separately below.

| Model                            | HTTP result | Observed request latency                      | Outcome                                                                                                  |
| -------------------------------- | ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `google/gemma-4-26b-a4b-it:free` | 429         | Not recorded separately; total scenario 5.1 s | Provider returned an error. No insertion was received.                                                   |
| `google/gemma-4-31b-it:free`     | 429         | 1,176 ms                                      | Provider reported that this free model was temporarily rate limited upstream. No insertion was received. |
| `qwen/qwen3.8-27b:free`          | 200         | 1,257 ms                                      | Passed. Returned a three-word insertion, `finish_reason: stop`, and reported cost 0.                     |

All three provider scenarios verified that ordinary typing and pause, Ctrl+Space, opening the external dialog and cancelling it produced **zero hosted requests**. Confirming the explicit request produced one POST containing the exact synthetic prefix `At dawn, the garden` and suffix ` while the city was still asleep.`. Each request respected the tiny adaptive output budget.

The successful Qwen response was ` held its breath`. Before acceptance, the document still contained only the original prefix and suffix; the suggestion was a separate ghost decoration. Pressing Tab reconstructed the exact text `At dawn, the garden held its breath while the city was still asleep.`. Both sides, including their spaces, were preserved byte for byte. A subsequent ordinary manual suggestion remained local and produced no extra hosted request. The session key was absent from browser localStorage. This is a successful compatibility and interaction smoke check on one synthetic sentence, not a benchmark of broader writing quality.

One additional UI run stopped before dispatching any provider request. It exposed a race between the consent dialog's focus restoration and the editor's blur cancellation. The external handoff now runs from the dialog's close-autofocus callback, suppressing trigger focus restoration. The fix passed a mocked version of this exact scenario and a separate ten-round consent stress test before the final real request was sent. No quota was used by that cancelled run or those mocked tests.

## PDF dependency compatibility

After upgrading to patched PDF.js 6.2.108, all 16 source-import tests passed under Vitest 4.1.11. Full TypeScript checking and source-import lint also passed. The PDF tests verify a matching packaged compatibility worker, local byte input, disabled worker fetching and image-decoding WASM, text extraction with page markers, scanned-PDF messaging and parser cleanup. Text/Markdown imports leave the PDF worker untouched. These focused tests mock the parser API; the real browser PDF/DOCX fixture checks remain a separate integration check.

## Continuous-mode live recheck

After implementing intentional persistent provider selection, the updated live browser scenario passed with `qwen/qwen3.8-27b:free`: one authenticated POST, HTTP 200, 1,125 ms observed latency, and reported cost 0. The public catalog was checked for zero prompt/completion/request prices before dispatch. Synthetic insertion ` breathed in the fresh morning air` preserved both sides of the cursor, remained ghost text until Tab, and no further hosted request occurred after returning to local. No keys were persisted; traces, video and screenshots were disabled. This adds one POST to the three historical attempts above. A separate mocked-transport run also passed without credentials or authenticated provider traffic.

The earlier one-request privacy policy in the historical evidence was replaced by deliberate continuous external activation; the default remains local. New browser regressions exercise repeat requests after one activation, all three hosted providers with independent ephemeral keys, saved model switching, custom system instructions, and theme changes that preserve the chosen provider.

## Previous revision checks

The previous Windows native run passed with both built-in models enabled, including reviewed dictation insertion and undo, continuous typing, atomic save, forced process termination and exact recovery of the last durable snapshot. A final normal-identifier NSIS debug installer was built at 17.03 MiB. It is unsigned; installation/uninstallation and macOS execution remain unverified. The Tauri bundler warned that its optional bundle-type marker could not be patched, although NSIS creation completed; automatic updating is not included in this build.

The 358 frontend tests include 37 speech regressions and 59 editor tests. The pointer fixture explicitly represents Chromium's DOM-selection preservation before CodeMirror loads, matching the tested WebView/Edge engine. It checks a visible menu, pointer acceptance, focus, exact cursor/suffix and undo. A real 8 MiB boundary fixture verifies that imperative insertion throws when the editor rejects the transaction, so dictation retains the reviewed transcript.

The final visual review passed after correcting the context library's desktop width. Nineteen screenshots use synthetic writing. The rebuilt `/typenext/` site passed desktop/narrow layout and theme-switch checks with no external requests or JavaScript errors. The source/build credential scan found no test credentials; `CREDENTIALS.txt`, test profiles and model caches remain ignored. GitHub publication was not run because GitHub CLI was still signed out.

## Context packages and inline dictation revision

The full final run passed 441 frontend unit tests, 53 browser scenarios (with the live provider test deliberately skipped), and 29 Rust tests (two helper entries deliberately ignored). TypeScript, zero-warning ESLint, Rust formatting and strict Clippy passed. The unit checks include package migration and membership, shared-source deduplication, live-note resolution, fresh hosted alternatives, cursor mapping during speech, microphone discovery, cancellation, and transcript recovery across note switches. The full suite was run with four workers; the deliberate 8 MiB DOM boundary fixture has a 30-second test deadline, without changing its size or assertions.

Named packages preserve old notes' direct attachments during migration. Multiple packages can be attached to one note; their shared sources are resolved once. Browser scenarios cover adding and removing packages independently, reuse across notes, shared-source retention, folder snapshots, website imports, live-note updates, narrow layouts, and safely reducing a context after linked writing grows above its attachment budget.

Inline dictation uses Ctrl/Command + Shift + D, an input-device choice, a mapped editor marker, automatic insertion and normal suggestion scheduling. Deleting the captured position still allows recognition to finish; failed insertion preserves the transcript for recovery. A bounded recovery field survives switching to another note. The level meter shares the recorder's five-hertz progress messages instead of creating another polling loop or audio buffer.

The desktop/narrow visual review passed after separating attached-package names from source counts and compacting the narrow context filters. Nineteen screenshots were refreshed with synthetic writing. The capture also identified a stale empty stylesheet served by the running Vite instance; re-invalidating the file restored its style, and the final screenshots show the styled inline controls. No style import or production source was missing. The project site passed its rebuilt desktop/narrow smoke, with working light/dark controls, no overflow, no external requests and no browser errors.

The packaged Windows application passed a fresh-profile run with both built-in models enabled. It downloaded and ran SmolLM2, accepted its real insertion and unloaded it. Whistle then used the selected synthetic microphone with keyboard start/stop/cancel, simultaneous typing, a mapped insertion, automatic suggestion scheduling and single-step speech undo. The native run sent two synthetic loopback model requests in total and reported no unhandled JavaScript errors. Two named packages, their source memberships and both note attachments survived native autosave and restart. Normal close/save, deliberate discard with autosave disabled, continuous-typing autosave and forced-process termination with recovery of the exact last durable text all passed.

The native test now uses a per-run WebView directory. A setup assertion was corrected to count the initial request before dictation; the final count includes the later speech-triggered request. The routine setup path handles a previously cached model, while the final run used a fresh profile. No application failure was hidden by either fixture correction.

A normal-identifier Windows NSIS debug installer was rebuilt at 17.04 MiB from the verified production frontend assets. It is unsigned; installation/uninstallation and macOS execution remain untested. The known optional bundle-type-marker warning remains, with NSIS creation successful and no updater included. The final credential scan covered 649 source/build/site files with zero matches; the credential file remains ignored. GitHub CLI was still signed out, so publication was not attempted.

### Fresh-choice live check

One further authenticated OpenRouter POST used the catalog-verified free `qwen/qwen3.8-27b:free` model. It returned HTTP 200 in 1,355 ms, `finish_reason: stop`, reported cost 0, and three distinct three-word options: `exhaled cool air`, `smelled of rain`, and `held its breath`. This brings the historical total in this document to five authenticated generation requests. The current check allows one bounded three-choice response (at most 384 output tokens), disables automatic requests, and makes no retry or paid fallback.

The real response exposed omitted leading whitespace at the complete-word cursor: the original mechanical acceptance check allowed `gardenheld`. The service now restores a separator when existing horizontal whitespace establishes the boundary. Focused tests preserve partial-word continuations, punctuation, existing whitespace, code/FIM output and scripts without spaces. A browser replay of the exact recorded response verifies `At dawn, the garden held its breath while the city was still asleep.`, acceptance, undo and exact suffix preservation. The strengthened live fixture also passes with mocked transport. No second live request was sent after this repair, so the repaired behavior is verified by replay rather than claimed as another live result.

The new provider scenarios verify fresh requests at an unchanged cursor, three options, keyboard/pointer acceptance, undo, stale-response cancellation, and all three hosted response formats. Merely configuring a key still makes no hosted request. Credentials remain memory-only in the live test, and traces, screenshots and video are disabled.
