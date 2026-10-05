# Third-party components

TypeNext-owned code is MIT licensed. Its dependencies, fonts, model weights and runtimes retain their own licenses and copyright notices. Model weights are optional explicit downloads or user-managed server software. See [licensing](licensing.md) for the complete release inventory; bundled notices ship in `public/notices` and `public/fonts/licenses`.

| Component                   | Purpose                            | License          |
| --------------------------- | ---------------------------------- | ---------------- |
| Tauri                       | Native desktop application         | MIT / Apache-2.0 |
| React                       | Interface                          | MIT              |
| CodeMirror 6                | Markdown editing                   | MIT              |
| Radix Dialog                | Accessible dialogs                 | MIT              |
| Lucide                      | Interface icons                    | ISC              |
| PDF.js                      | Local PDF text extraction          | Apache-2.0       |
| Mammoth                     | Local DOCX text extraction         | BSD-2-Clause     |
| fflate                      | Bounded DOCX decompression checks  | MIT              |
| Transformers.js             | Optional worker inference          | Apache-2.0       |
| ONNX Runtime Web            | Self-hosted WebAssembly inference  | MIT              |
| SmolLM2-135M-Instruct       | Optional pinned model download     | Apache-2.0       |
| Cactus Whistle              | Optional pinned local speech model | Apache-2.0       |
| Cactus Needle3 WASM runtime | Bundled Whistle inference runtime  | Apache-2.0       |
| Mozilla Readability         | Website article extraction         | Apache-2.0       |

Source Sans Pro, Merriweather, Alegreya, EB Garamond, JetBrains Mono, and IBM Plex Mono are self-hosted through their Fontsource packages under the SIL Open Font License. Fontsource packages include their license files. Miracode v1.0 is bundled from the [author's official release](https://github.com/IdreesInc/Miracode/releases/tag/v1.0); its license is at `public/fonts/Miracode-LICENSE.txt`.

The licenses of the bundled Fontsource fonts are copied to `public/fonts/licenses` and included in the app build. The TypeNext app mark is a generated white `|>` on black, shared by the notebook, browser, executables and installers. Lucide remains the interface action-icon library; its ISC notice is bundled at `public/notices/Lucide-LICENSE.txt`.

Segoe UI, Tahoma, and Times New Roman use the operating system's installed fonts and a fallback stack. They are not redistributed. Choosing Times New Roman defaults to 16 CSS pixels, equivalent to 12 points at standard CSS scale.

The GitHub Pages build copies Source Sans Pro font files and its license into the published assets. It contains no analytics, external font requests, API keys, or user note data. Its screenshots were captured from synthetic example writing.

Whistle uses the upstream Needle3 WASM speech interface directly. Its pinned runtime, license and provenance notice are in `public/runtime/whistle`; `npm run prepare:runtime` verifies the committed assets before development and builds. Model files download separately only after an explicit click.
