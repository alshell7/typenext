# TypeNext website

The project site at <https://alshell7.github.io/typenext/>. It is a small Vite + React 18 + TypeScript app with its own `package.json` and lockfile, separate from the desktop app.

## Commands

From the repository root:

```sh
npm run site:dev     # install site dependencies once, then start the dev server
npm run site:build   # npm ci in site/, then build into ../site-dist
```

Inside `site/`: `npm run dev`, `npm run build`, `npm run preview` and `npm run typecheck`. The Pages workflow (`.github/workflows/pages.yml`) runs `npm run site:build` with Node 22 and publishes `site-dist`.

## Structure

- `index.html` – meta tags (SEO, Open Graph, Twitter), structured data, the no-script fallback and the pre-paint theme script.
- `src/content.ts` – every product fact on the page: links, screenshots, engines, shortcuts and FAQ. Keep it in step with `README.md` and `docs/userguide/userguide.md`.
- `src/sections/` – the page sections, in page order in `src/App.tsx`.
- `src/demo/` – the interactive editor demo. `model.ts` is a pure reducer; `LiveDemo.tsx` renders it.
- `src/components/reactbits/` – React Bits components (see below).
- `src/styles/` – design tokens (`global.css`, paper and ink from `DESIGN.md`) and section styles.
- `scripts/sync-assets.mjs` – copies the screenshots from `docs/screenshots/`, the film from `docs/media/`, the icon and the licence texts into `public/assets/` (ignored by Git) before `dev` and `build`.
- `src/sections/Film.tsx` – the 30-second film. It plays without sound while it is on screen. To make the film again, see `docs/developer/film.md`.

## Screenshots

The page uses these files from `docs/screenshots/`: `writing-light.png`, `writing-dark.png`, `insert-menu.png`, `link-preview.png`, `context-board.png`, `note-graph.png`, `zen-levels.png`, `preferences-models.png` and `preferences-knowledge.png` (1440 × 960). Replace them under the same names. To give another gallery entry a dark capture, add a `dark` file name to its entry in `src/content.ts`. Feature cards crop with the `focus` and `zoom` props in `src/sections/Features.tsx`.

## React Bits

Interface effects come from [React Bits](https://reactbits.dev) by David Haz ([GitHub](https://github.com/DavidHDev/react-bits)), under the MIT + Commons Clause licence in `src/components/reactbits/LICENSE.md`. Each file carries the notice. The footer credits React Bits and links the licence.

| Component     | Where                                   |
| ------------- | --------------------------------------- |
| Aurora        | Hero background (lazy, WebGL 2)         |
| BlurText      | Hero headline                           |
| ShinyText     | Hero badge                              |
| Magnet        | Download button in the hero             |
| ClickSpark    | Download buttons                        |
| SpotlightCard | Feature cards                           |
| LogoLoop      | Engines strip (text badges, no logos)   |

The files are the TypeScript + CSS registry variants (the same source as `npx shadcn@latest add https://reactbits.dev/r/<Name>-TS-CSS`). To update one, run `npm run reactbits -- <Name>` in `site/`. That overwrites the folder, so re-apply this local change afterwards:

- `BlurText.tsx`: added the `as` prop (render as `span` inside the `h1`) and the `initialDelay` prop (start the second line later).

## Motion and accessibility

- With `prefers-reduced-motion: reduce`, the aurora is not loaded (a static gradient stays), the headline renders as plain text, the demo shows its finished text, the engines strip is a static list, and CSS transitions are cut to a minimum.
- The aurora loads after the page is idle and only with WebGL 2.
- The theme follows the system; the toggle stores an explicit choice in `localStorage` (`typenext-site-theme`).
- The demo editor is a focusable `textbox` with an `aria-live` region; every keyboard action also has a button under it.
- The GitHub star count is fetched at runtime from the GitHub API and cached for 30 minutes in `sessionStorage`. Without a count (or with zero), the button reads "Star".
