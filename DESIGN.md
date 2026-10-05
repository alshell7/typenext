---
name: TypeNext
description: A calm local-first Markdown notebook with paper surfaces and contextual continuations.
colors:
  paper: '#ffffff'
  sidebar: '#f3f4f1'
  surface: '#f6f6f6'
  hover: '#ededed'
  ink: '#242424'
  secondary: '#545454'
  muted: '#636363'
  ghost: '#636363'
  line: '#dbdbdb'
  accent: '#42644d'
  accent-fill: '#42644d'
  accent-hover: '#4f6f59'
  accent-soft: '#e6ebe8'
  on-accent: '#ffffff'
  error: '#a13d37'
  editor-caret: '#42644d'
  editor-selection: '#dbe2dd'
  sidebar-ink: '#222222'
  sidebar-secondary: '#505150'
  sidebar-muted: '#5e5e5d'
  sidebar-surface: '#eaebe9'
  sidebar-hover: '#e2e3e0'
  sidebar-line: '#d1d2cf'
  sidebar-accent: '#42644d'
  sidebar-accent-soft: '#dce1dc'
  sidebar-error: '#9b3b35'
  dark-paper: '#212121'
  dark-sidebar: '#17191c'
  dark-surface: '#292929'
  dark-hover: '#313131'
  dark-ink: '#e0e0e0'
  dark-secondary: '#b6b6b6'
  dark-muted: '#a9a9a9'
  dark-ghost: '#a9a9a9'
  dark-line: '#404040'
  dark-accent: '#a6b6c8'
  dark-accent-fill: '#a6b6c8'
  dark-accent-hover: '#9aa9ba'
  dark-accent-soft: '#323437'
  dark-on-accent: '#000000'
  dark-error: '#eea29a'
  dark-editor-caret: '#a6b6c8'
  dark-editor-selection: '#3a3d41'
  dark-sidebar-ink: '#dfdfdf'
  dark-sidebar-secondary: '#b2b3b4'
  dark-sidebar-muted: '#a1a2a3'
  dark-sidebar-surface: '#1f2124'
  dark-sidebar-hover: '#27292c'
  dark-sidebar-line: '#37393c'
  dark-sidebar-accent: '#a6b6c8'
  dark-sidebar-accent-soft: '#2a2d32'
  dark-sidebar-error: '#eea29a'
typography:
  headline:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '22px'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.025em'
  title:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '32px'
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.028em'
  panel-title:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '17px'
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.02em'
  body:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '15px'
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '15px'
    fontWeight: 600
    lineHeight: 1.5
  writing:
    fontFamily: 'Merriweather, Georgia, serif'
    fontSize: '17px'
    fontWeight: 400
    lineHeight: 1.9
  note-list-title:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '14px'
    fontWeight: 600
    lineHeight: 1.4
  field-label:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '13px'
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '12px'
    fontWeight: 400
    lineHeight: 1.5
  metadata:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '11px'
    fontWeight: 400
    lineHeight: 1.5
  hex-value:
    fontFamily: 'IBM Plex Mono, monospace'
    fontSize: '12px'
    fontWeight: 400
    lineHeight: 1.5
  palette-label:
    fontFamily: 'Source Sans Pro, Segoe UI, -apple-system, sans-serif'
    fontSize: '12px'
    fontWeight: 400
    lineHeight: 1.3
rounded:
  swatch: '3px'
  micro: '4px'
  compact: '5px'
  control: '6px'
  tab: '7px 7px 0 0'
  standard: '8px'
  palette-card: '9px'
  dialog: '14px'
spacing:
  '4': '4px'
  '6': '6px'
  '8': '8px'
  '10': '10px'
  '12': '12px'
  '18': '18px'
  '24': '24px'
  '28': '28px'
components:
  button-primary:
    backgroundColor: '{colors.accent-fill}'
    textColor: '{colors.on-accent}'
    typography: '{typography.control}'
    rounded: '{rounded.standard}'
    padding: '8px 15px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    typography: '{typography.control}'
    rounded: '{rounded.standard}'
    padding: '8px 15px'
  button-secondary-hover:
    backgroundColor: '{colors.hover}'
  button-subtle:
    backgroundColor: 'transparent'
    textColor: '{colors.secondary}'
    typography: '{typography.control}'
    rounded: '{rounded.standard}'
    padding: '8px 15px'
  button-subtle-hover:
    backgroundColor: '{colors.hover}'
  button-destructive:
    backgroundColor: '#a13d37'
    textColor: '#ffffff'
    typography: '{typography.control}'
    rounded: '{rounded.standard}'
    padding: '8px 15px'
  button-destructive-hover:
    backgroundColor: '#8a302b'
  input-field:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.standard}'
    padding: '10px 12px'
  nav-note:
    backgroundColor: 'transparent'
    textColor: '{colors.sidebar-ink}'
    typography: '{typography.note-list-title}'
    rounded: '{rounded.standard}'
    padding: '10px 12px'
  nav-note-active:
    backgroundColor: '{colors.sidebar-accent-soft}'
  nav-note-hover:
    backgroundColor: '{colors.sidebar-hover}'
  chip-preset:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.secondary}'
    typography: '{typography.metadata}'
    rounded: '{rounded.compact}'
    padding: '5px 10px'
  chip-preset-selected:
    backgroundColor: '{colors.accent-soft}'
    textColor: '{colors.accent}'
  card-preview:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.secondary}'
    rounded: '{rounded.standard}'
    padding: '18px'
  dialog:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.dialog}'
    padding: '26px 28px 23px'
    width: 'min(510px, calc(100vw - 32px))'
  inline-suggestion:
    textColor: '{colors.ghost}'
    typography: '{typography.writing}'
  inline-accept:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.secondary}'
    typography: '{typography.metadata}'
    rounded: '{rounded.micro}'
    padding: '2px 7px'
  palette-option:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    typography: '{typography.palette-label}'
    rounded: '{rounded.palette-card}'
    padding: '5px'
  palette-option-selected:
    backgroundColor: '{colors.accent-soft}'
  palette-hex-field:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.hex-value}'
    rounded: '{rounded.standard}'
    padding: '9px 8px 9px 29px'
---

# Design System: TypeNext

## Overview

**Creative North Star: "The Porcelain Notebook"**

The writing page leads; a short continuation appears only at its cursor. TypeNext feels like a quiet desktop notebook: a broad writing surface, a darker or softer notebook rail, clear text, and a restrained accent. Graphite gives dark mode neutral charcoal paper and a slate accent; Paper gives light mode porcelain paper, a pebble sidebar, and sage controls. The writer's prose has the largest uninterrupted area, while navigation, references, and model controls stay compact and practical.

The interface is sober, soft, and local-first. Light and dark appearances preserve the relationship between the page and its supporting surfaces, with a small set of optional palettes and custom colors. Familiar Radix dialogs and simple stroke icons make supporting actions predictable. A continuation remains visibly provisional until the writer accepts it.

This record describes the shipped notebook application in `src/notebook/palette.ts`, `src/App.css`, and its React/CodeMirror components. The promotional website is a separate surface; its marketing headings do not define the application's type ramp. Saved light, dark, preview, focus, and narrow screenshots establish the core hierarchy. The current palettes, scoped sidebar colors, and live-note context picker are recorded from their implementation; older screenshots do not define their current color values.

**Key Characteristics:**

- Generous paper for writing; compact supporting controls.
- One palette accent for action, selection, and keyboard focus.
- Sans-serif interface around a writer-selected prose face.
- Tonal separation and fine borders at rest; diffuse shadows for overlays.
- Inline continuations with explicit acceptance and quiet local status.

## Colors

Graphite is the default dark palette, using neutral charcoal and a restrained slate accent. Paper is the default light palette, using white paper, a pale notebook rail, and sage. Appearance initially follows the operating system; the writer can choose Light, Dark, or System. The frontmatter records the live values generated by `paletteTokens()` for Paper and Graphite, including their separate sidebar roles. Static CSS values provide a bootstrap fallback; the palette helper supplies the active values.

### Primary

- **Paper Sage / Graphite Slate** (`accent`, `dark-accent`): readable action text, links, field focus, and selected toolbar controls. The text accent may be adjusted for contrast independently of the selected fill.
- **Action Fill** (`accent-fill`, `accent-hover`, `on-accent`, and their dark counterparts): the selected accent fills primary actions; the helper derives a hover tone and a black or white label. Keep the fill and its label together.
- **Selection Wash** (`accent-soft`, `sidebar-accent-soft`, and their dark counterparts): subdued selected backgrounds derived for the page and notebook rail independently.
- **Writing State** (`editor-caret`, `editor-selection`, `ghost`, and their dark counterparts): an accent caret, a soft text-selection wash, and readable provisional continuation text.

### Neutral

- **Porcelain Paper** (`paper`): the light writing surface, active note tab, page form fields, and dialogs.
- **Pebble** (`sidebar`): the notebook rail and its local-status area.
- **Supporting Paper** (`surface`): inactive tab strip, context panel, secondary buttons, preview text, and font previews.
- **Hover Wash** (`hover`): transient feedback on ordinary controls and unselected note rows.
- **Charcoal** (`ink`): authored prose, note titles, and primary interface text.
- **Secondary Ink** (`secondary`): descriptions and supporting actions.
- **Quiet Ink** (`muted`, `ghost`): dates, counts, shortcuts, source metadata, and the provisional continuation. Quiet text keeps its derived color without an additional opacity reduction.
- **Paper Seam** (`line`): fine separators and field outlines.
- **Graphite Neutrals** (`dark-paper`, `dark-sidebar`, `dark-surface`, `dark-hover`, `dark-ink`, `dark-secondary`, `dark-muted`, `dark-line`): neutral charcoal layers, light ink, and the same spatial hierarchy in dark mode.
- **Notebook Ink and Surfaces** (`sidebar-ink`, `sidebar-secondary`, `sidebar-muted`, `sidebar-surface`, `sidebar-hover`, `sidebar-line`, `sidebar-accent`, `sidebar-accent-soft`, `sidebar-error`, and their dark counterparts): text and controls calculated against the rail's own background. Note rows, search, local status, and notebook utilities inherit these scoped roles.

Brick `error` and pale coral `dark-error` communicate failures in the default palettes. Error text is also adjusted against its own page or sidebar background. Destructive action fills use fixed brick with white text in both themes; they are a semantic exception to the selected action palette.

The chooser offers Paper, Linen, and Mist for light appearance; Graphite, Midnight, and Forest for dark appearance; and one Custom option in each group. Light and dark choices are stored independently. Choosing a card also activates that appearance so its effect is visible immediately. Custom palettes expose only Page, Sidebar, and Accent, using complete `#RRGGBB` values. The helper derives the remaining roles and aims for at least (4.5:1) text contrast against the relevant resting, hover, selected, and supporting backgrounds. The selected accent fill retains the writer's value while its label and text counterparts adapt.

### Named Rules

**The Accent State Rule.** Use the selected accent to explain action, selection, focus, or writing state. Keep ordinary paper and prose in the palette's surface and ink roles.

**The Paired Theme Rule.** Apply each theme's paper, ink, line, and action roles together. Preserve the relationship between writing paper and supporting surfaces when changing themes.

**The Sidebar Scope Rule.** Use the sidebar's derived ink, surfaces, seams, and states inside the notebook rail. Keep page and dialog roles outside that scope, and retain accent-fill with its on-accent label for filled actions.

## Typography

**Interface Font:** Source Sans Pro, with Segoe UI, -apple-system, and sans-serif fallbacks. Regular and semibold interface weights are bundled.

**Writing Font:** Merriweather with Georgia and serif fallbacks by default. Writing preferences also offer Source Sans Pro, Alegreya, EB Garamond, JetBrains Mono, IBM Plex Mono, Miracode, Segoe UI, Tahoma, and Times New Roman. The first six named open-source families and Miracode are loaded by the application; the remaining choices rely on the device and their configured fallbacks.

**Character:** Compact, unembellished interface text frames an open, book-like writing surface. The contrast comes from the role and reading rhythm of the prose, rather than decorative display typography.

### Hierarchy

- **Headline:** semibold dialog headings with tight tracking. Narrow dialogs reduce them to (20px).
- **Title:** semibold editable note titles with tight tracking. At the narrow breakpoint they reduce to (27px).
- **Panel title:** smaller semibold headings for supporting context.
- **Body and control:** the interface's regular text and semibold action labels. Dialog buttons use (13px); source and connection controls use (12px).
- **Writing:** the default prose role in the frontmatter is a starting preference. The writer can choose sizes from (12px–32px); the editor keeps its generous line height as those preferences change.
- **Note list title and field label:** semibold names and labels with a compact hierarchy.
- **Label and metadata:** small regular text for navigation, descriptions, dates, source counts, and status. Shortcuts inherit the interface face; they do not introduce a separate monospace hierarchy.
- **HEX value:** IBM Plex Mono keeps custom color codes easy to scan at (12px). This small field treatment does not change the surrounding interface face.

Markdown remains editable source. Heading marks stay visible while heading text receives semibold weight and modest relative sizing: level one at (1.3em), level two at (1.15em), and level three at the current writing size. Strong, italic, strikethrough, and link treatments provide reading cues without a separate preview pane.

### Named Rules

**The Writer's Face Rule.** Apply writing preferences to the prose and font preview. Keep navigation, dialogs, labels, and note titles in the interface face.

**The Source Remains Rule.** Give Markdown quiet typographic hierarchy while preserving the source characters and direct editing surface.

## Layout

The application fills the viewport and scrolls within its writing, note-list, context, and dialog regions. Its desktop form is a vertical notebook rail (244px), a quiet toolbar (54px), a horizontal note-tab strip, and a flexible paper workspace. Context appears on demand as a supporting right-hand column (292px).

The document wrapper is centered with a maximum width of (760px) and desktop inline padding of (40px), producing the established writing measure of (680px). Desktop top padding is (54px); focus mode raises it to (75px). The title, intention, and prose share the same leading edge. Suggestion controls and local save status occupy compact bars below the scrollable page.

Spacing is intentionally denser in supporting controls than in the writing area. The frontmatter lists recurring observed steps, rather than imposing a uniform grid on every inset. Small gaps connect an icon and label; field and row insets group controls; larger gaps separate note intention, references, and writing.

At (1100px) and below, context narrows to (265px), document padding becomes (44px 30px 50px), and secondary suggestion text is reduced. At (760px) and below, the notebook rail uses absolute positioning and offsets the workspace while visible; hiding it returns the full writing width. Context becomes a right-side overlay up to (315px) or (92vw). The page uses (32px 24px 50px) padding, toolbar actions keep their icons while hiding most text, dialog footers wrap, and keyboard references become a single column. At (480px) and below, each palette group changes from four columns to two; custom color fields keep three compact columns. The application supports a minimum viewport width of (360px).

Focus mode hides the notebook, note tabs, and context panel while keeping the toolbar, prose, continuation controls, and save status accessible. Preserve independent scroll regions so a long note or reference does not push core controls out of the viewport.

## Elevation & Depth

TypeNext uses tonal layering and fine seams for everyday depth. The writing page and desktop sidebar are flat; active tabs use border-like shadows to reconnect with the paper. Diffuse lift is reserved for dialogs, transient notices, and supporting panels that overlay the writing area at narrow widths.

### Shadow Vocabulary

- **Dialog lift:** `0 20px 80px rgb(31 40 30 / 16%)` for Paper and `0 24px 90px rgb(0 0 0 / 36%)` for Graphite. The helper selects the source `--shadow` from page luminance, so custom surfaces receive the appropriate overlay depth.
- **Notice lift:** `0 8px 24px rgb(0 0 0 / 14%)` separates a transient status notice from the page.
- **Narrow notebook lift:** `8px 0 24px rgb(0 0 0 / 10%)` explains the rail's overlay relationship.
- **Narrow context lift:** `-10px 0 25px rgb(0 0 0 / 8%)` explains the panel's overlay relationship.
- **Active tab seam:** `0 -1px 0 var(--line), 1px 0 0 var(--line), -1px 0 0 var(--line)` outlines the active tab without creating a lifted card.
- **Field focus wash:** `0 0 0 2px var(--accent-soft)` accompanies the accent field border.

The dialog scrim is neutral translucent black (`rgb(0 0 0 / 28%)`). It reduces surrounding contrast without tinting the notebook's colours.

### Named Rules

**The Flat Paper Rule.** Use paper, supporting tones, and seams for the resting workspace. Reserve diffuse lift for an actual overlay or transient notice.

## Shapes

Controls use gentle corners: standard fields, buttons, note rows, and preview containers share the standard radius. Smaller icon and toolbar controls use the control radius, compact presets use the compact radius, and the continuation's acceptance badge uses the micro radius. Tabs round only their top corners so the active tab joins the paper. Dialogs use the broader dialog radius. Palette cards use a slightly broader (9px) corner, with (5px) miniature previews and (3px) color swatches.

Borders are fine (1px) and functional. A dashed reference target explains file dropping; it is part of the notebook's material vocabulary. The editable note title is borderless and square against the page. Stroke icons accompany or identify actions, with compact sizes tailored to their control rather than oversized decorative marks.

The notebook, browser, executable and installer share the TypeNext `|>` mark: two white symbols of equal height on a black square. `public/brand/logo-master.png` is the imagegen-created master; `public/Icon.png` is its small UI derivative, and platform sizes and Windows/macOS icon containers are generated from that same image. The fixed brand colours remain black and white in either appearance. Interface action icons still use Lucide and retain its ISC notice in `public/notices/Lucide-LICENSE.txt`.

## Components

### Buttons

Quiet, legible actions with a clear emphasis hierarchy.

- **Shape:** the standard radius, inline icon-and-label alignment, and a minimum height of (38px).
- **Primary:** accent-fill with its on-accent label, semibold text, and the frontmatter's shared action padding. Readable accent text and filled accent actions use their respective roles.
- **Secondary:** supporting-paper fill, a fine seam border, and ink text.
- **Subtle:** transparent with secondary text until a hover wash appears.
- **Destructive:** fixed brick fill, white label, and a darker brick hover.
- **Hover / Focus:** fills change without shifting geometry. Keyboard focus uses an accent outline (2px) offset by (3px). Disabled buttons keep their shape, use a default cursor, and reduce opacity to (0.45).
- **Icon controls:** usually (30px) square with the control radius; hover adds a wash and promotes secondary ink to ink. Keep their accessible action names when the narrow toolbar hides text.

### Chips

Compact presets rather than decorative tags.

- **Style:** model-server presets use the compact radius, metadata-sized labels, supporting-paper fill, and secondary text.
- **State:** selected and hovered presets use the soft accent fill and readable accent text. The compact selected treatment matches the wider action-state vocabulary.

### Cards / Containers

Supporting paper that carries content without competing with the document.

- **Preview container:** a standard-radius tonal surface with secondary text and a comfortable block inset. Source text preserves whitespace, wraps long content, permits selection, and scrolls when long.
- **Context panel:** a supporting-paper column with a seam against the editor. It presents intention first, followed by reference rows and actions.
- **Dialogs:** a paper surface with the dialog radius, a title and description, a close control, and a grouped footer. Ordinary dialogs use the frontmatter's width; preferences allow (610px), source previews allow (680px), and the live-note picker caps at (480px). Radix owns the modal interaction; closing restores focus to the remembered control when appropriate.
- **Depth:** use the overlay lift from Elevation & Depth for dialogs and narrow overlay panels.

### Inputs / Fields

Familiar paper fields with an accent focus cue.

- **Style:** standard radius, paper fill, ink text, a fine seam border, and the frontmatter's field padding. Context fields tighten to (9px 10px) with (13px) text.
- **Focus:** accent border plus the soft accent wash. Field border color transitions over (120ms).
- **Supporting copy:** labels are semibold; optional markers, helper text, and placeholders use quieter ink. Keep a visible label associated with each field.
- **Native state controls:** checkboxes and range sliders use the accent. Reference inclusion remains a separate checkbox from the preview action and removal button.

### Navigation

The notebook rail provides recent-note navigation through compact rows with an icon, semibold truncated title, and a quieter metadata line. Titles use sidebar ink, metadata uses sidebar muted ink, and icons use sidebar secondary ink. Active rows use the sidebar's soft accent; other rows use its hover wash. Search and the New note control use the derived sidebar surface, and the rail's borders and focus indicators use its own seam and accent roles. The active page is identified with `aria-current`. Note deletion appears on row hover or keyboard focus.

Open notes use paper-joined tabs with a separate close action. Preferences use a compact tab list with an accent underline and keyboard navigation. The live-note picker reuses the row vocabulary: a (6px) radius, an icon, a truncated title, quieter word/date metadata, and a trailing action icon. Its search, empty states, and unavailable references remain explicit.

### Palette Chooser

Small visual choices within Appearance preferences keep color customization close to the notebook.

- **Grouping:** separate labeled Light palette and Dark palette fieldsets, each with three presets and Custom. Keep native radio inputs keyboard-accessible while their cards provide the visible control.
- **Card:** a fine seam, a (9px) radius, and (5px) padding surround a miniature page-and-sidebar preview (54px high). The selected card uses the soft accent background, accent border, and a check beside its readable name. Keyboard focus uses the shared accent outline; hover promotes the border to muted ink without moving the card.
- **Custom fields:** Page, Sidebar, and Accent have visible labels, a small swatch, and a monospace HEX field. Complete valid values apply immediately in lowercase; an incomplete draft stays in the field without replacing the saved color. Blur reveals an associated error for invalid input; Escape restores the previous valid value for an invalid draft.
- **Feedback:** explain that text adjusts for readability. Keep errors as text as well as color, and preserve independent values when switching away from a custom palette.

### Inline Continuation

The signature is a small continuation located at the current cursor, rendered in the current writing face and the derived ghost ink. It is a decoration until accepted, with a compact `Tab` badge adjacent to the text. Tab or the badge accepts the whole continuation; Control/Command plus Right Arrow accepts a word; Escape dismisses it. Acceptance briefly washes the inserted range in the soft accent over (240ms). A fresh continuation is announced with acceptance instructions.

Appearances stay brief and functional: continuations fade in over (150ms), dialogs enter over (180ms), and context reveals over (200ms). Controls transition in roughly (120ms–140ms). The existing reduced-motion rule reduces animation and transition durations to (0.01ms), one iteration, and automatic scrolling.

## Do's and Don'ts

### Do:

- **Do** give writing the generous paper area and keep supporting controls compact.
- **Do** use the paired theme roles for paper, text, borders, selections, and focus.
- **Do** keep the selected accent attached to an action or a meaningful state.
- **Do** use scoped sidebar roles inside the notebook rail and page roles in dialogs and the writing surface.
- **Do** offer labeled preset cards and three complete HEX values for custom colors while deriving readable supporting roles.
- **Do** preserve the writer's selected prose face and size while keeping interface typography consistent.
- **Do** keep Markdown source visible and continuations provisional until explicitly accepted.
- **Do** retain visible keyboard focus, accessible icon-control names, labeled fields, and reduced-motion behavior.
- **Do** use the established row, field, dialog, and preview patterns when adding supporting notebook flows.

### Don't:

- **Don't** introduce a chat layout, generated starter paragraphs, or decorative dashboard widgets into the writing workspace.
- **Don't** borrow the promotional site's display headings for application navigation or controls.
- **Don't** add decorative lift to resting writing surfaces or ordinary note rows.
- **Don't** turn reference inclusion, preview, and removal into one ambiguous action.
- **Don't** make a model continuation part of the document before acceptance.
- **Don't** reduce the opacity of already-derived quiet text or apply a custom field's incomplete value to the palette.
