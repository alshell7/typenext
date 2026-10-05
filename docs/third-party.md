# Third-party components

TypeNext is AGPL-3.0-or-later. Its dependencies keep their own licenses and notices in their packages. Models and inference servers are optional user-managed software, not bundled with the app.

| Component           | Purpose                           | License          |
| ------------------- | --------------------------------- | ---------------- |
| Tauri               | Native desktop application        | MIT / Apache-2.0 |
| React               | Interface                         | MIT              |
| CodeMirror 6        | Markdown editing                  | MIT              |
| Radix Dialog        | Accessible dialogs                | MIT              |
| Lucide              | Interface icons                   | ISC              |
| PDF.js              | Local PDF text extraction         | Apache-2.0       |
| Mammoth             | Local DOCX text extraction        | BSD-2-Clause     |
| fflate              | Bounded DOCX decompression checks | MIT              |
| Mozilla Readability | Website article extraction        | Apache-2.0       |

Source Sans Pro, Merriweather, Alegreya, EB Garamond, JetBrains Mono, and IBM Plex Mono are self-hosted through their Fontsource packages under the SIL Open Font License. Fontsource packages include their license files. Miracode v1.0 is bundled from the [author's official release](https://github.com/IdreesInc/Miracode/releases/tag/v1.0); its license is at `public/fonts/Miracode-LICENSE.txt`.

The licenses of the bundled Fontsource fonts are copied to `public/fonts/licenses` and included in the app build. The app icon uses the same Lucide Square Pen glyph as the notebook wordmark; its notice is bundled at `public/notices/Lucide-LICENSE.txt`.

Segoe UI, Tahoma, and Times New Roman use the operating system's installed fonts and a fallback stack. They are not redistributed. Choosing Times New Roman defaults to 16 CSS pixels, equivalent to 12 points at standard CSS scale.

The GitHub Pages build copies Source Sans Pro font files and its license into the published assets. It contains no analytics, external font requests, API keys, or user note data. Its screenshots were captured from synthetic example writing.
