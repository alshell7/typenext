# TypeNext user guide

TypeNext is a local-first Markdown notepad. You write. TypeNext can offer a short suggestion at the cursor, and you decide whether to accept it. Your notes stay on your device unless you turn on an external service.

This guide tells you how to use each feature. It applies to the desktop app on macOS, Windows and Linux.

## Conventions in this guide

- **Bold text** is a label in the app, for example **Preferences → Knowledge**.
- "Ctrl/⌘" means Ctrl on Windows and Linux, and ⌘ (Command) on macOS. "Alt" is the Option key (⌥) on macOS.
- A **note** is one Markdown document.
- A **reference** is a file, a website, a media file or another note that gives information to suggestions. The **Contexts** dialog calls references "sources".
- A **context** is a named, reusable group of references. You can attach a context to many notes.
- A **suggestion** is text that TypeNext offers at the cursor. It does not enter the note until you accept it.

## Contents

1. [Get started](#get-started)
2. [Notes](#notes)
3. [Write in the editor](#write-in-the-editor)
4. [The insert menu](#the-insert-menu)
5. [Links and the note graph](#links-and-the-note-graph)
6. [Context](#context)
7. [Suggestions](#suggestions)
8. [Semantic search](#semantic-search)
9. [Web facts](#web-facts)
10. [Dictation](#dictation)
11. [Zen mode](#zen-mode)
12. [Preferences](#preferences)
13. [Keyboard shortcuts](#keyboard-shortcuts)
14. [Privacy summary](#privacy-summary)
15. [Troubleshooting](#troubleshooting)

## Get started

### Install TypeNext

1. Go to the [latest release](https://github.com/alshell7/typenext/releases/latest).
2. Download the file for your system: a setup EXE, MSI or ZIP for Windows, or a DMG or ZIP for your Mac type (Apple Silicon or Intel).
3. Install and open TypeNext.

The release binaries are not signed by a certificate authority. macOS and Windows can show a security prompt at the first start. The portable Windows ZIP needs the Microsoft WebView2 Runtime.

### The first start

The welcome screen shows **A little room to think.** and three buttons:

- **Start a note** opens a new, empty note.
- **Try a sample** opens a fictional sample note, "A morning at Bramble House", with two attached contexts. After you open it once, the button is **Open sample**.
- **Open Markdown** opens a Markdown file from your disk.

The sample does not change your notes or your model settings. To see a suggestion from the sample, put the cursor after "Guests arrive at Bramble House", press Ctrl/⌘ Space, then press Tab.

### The window

| Area          | Contents                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- |
| Notes sidebar | **New note**, **Contexts**, **Find a note**, **Your notes**, **Preferences**.               |
| Toolbar       | Notes toggle, **Context**, dictation, note graph, **Save Markdown**, zen mode.              |
| Tabs          | The open notes. The **+** button creates another note.                                      |
| Editor        | The note title, the objective (when set) and the note text.                                 |
| Status bar    | The suggestion status and the engine chooser (**Choose suggestion engine**).                |
| Context panel | The intent, the contexts and the references of the current note. It opens from **Context**. |

On macOS, the native window buttons (close, minimize, zoom) are at the top left. On Windows and Linux, TypeNext shows its own buttons at the top right: **Minimize window**, **Maximize window** and **Close window**.

## Notes

### Create a note

1. Press Ctrl/⌘ N, or select **New note** in the sidebar.
2. Type.

The note opens at once. TypeNext does not ask for a title. Until you type a title, the note takes its title from its first line of text:

- Markdown markers are removed, for example `#`, `>`, `-`, `1.` and `[ ]`.
- A link shows its text. A `[[Note|Label]]` link shows its label.
- Empty lines and table separator lines are skipped.
- A title longer than 80 characters is cut at a word and ends with "…".
- A note without text shows **Untitled**.

To set a title, type it in the title field above the text (at most 160 characters). After that, the title does not change with the text. To return to the automatic title, delete the title.

To set an objective or background for the note, use the **Intent** section of the Context panel. See [Intent](#intent).

### Find and open notes

- Press Ctrl/⌘ P to show the sidebar and go to **Find a note**. Type part of a title.
- Select a note in **Your notes** to open it in a tab.
- Press Ctrl/⌘ B to show or hide the notes sidebar.

### Delete a note

1. In **Your notes**, select the delete button of the note.
2. In **Delete this note?**, select **Delete note**. To keep the note, select **Keep note**.

A Markdown file that you saved before stays on the disk.

### Open and save Markdown files

| Action                      | Keys           |
| --------------------------- | -------------- |
| Open a Markdown file        | Ctrl/⌘ O       |
| Save the note as Markdown   | Ctrl/⌘ S       |
| Save the note to a new file | Ctrl/⌘ Shift S |

### Autosave

With **Autosave** on (the default), TypeNext saves a local copy while you write. It keeps a recoverable previous version. A note can hold up to 8 MiB of text. When a note is full, TypeNext shows a message and keeps your text unchanged.

## Write in the editor

The editor uses GitHub Flavored Markdown. The text is always plain Markdown, also when live preview shows formatted elements.

### Live preview

When the cursor is not on an element, live preview shows:

- bullets in place of `-`, `*` and `+`,
- check boxes in place of `[ ]` and `[x]`,
- horizontal rules, quotes and code blocks,
- tables as formatted grids.

Move the cursor onto the element to see and edit its Markdown. Click a rendered check box to change the task. To turn live preview off, go to **Preferences → Editor** and turn off **Live preview**.

### Lists

| Action                            | Keys      |
| --------------------------------- | --------- |
| Continue the list on a new line   | Enter     |
| Indent the list item              | Tab       |
| Outdent the list item             | Shift+Tab |
| Leave the list (on an empty item) | Enter     |

A numbered list renumbers when you indent or outdent items. Enter on an empty nested item moves the item out one level.

### Tasks

- Press Ctrl/⌘ Enter to change `[ ]` to `[x]`, or `[x]` to `[ ]`.
- On a list item without a box, Ctrl/⌘ Enter adds a box. On a plain line, it makes a task item.
- With live preview on, click the box.

### Tables

1. Type `/table` and press Enter. TypeNext inserts a table with three columns and two empty rows. The first header cell is selected.
2. Type the header text.
3. Press Tab to go to the next cell. Press Shift+Tab to go to the previous cell.
4. Press Tab in the last cell to add a row.
5. Press Enter in a row to add a row below it.
6. Press Enter on an empty last row to leave the table.

TypeNext aligns the columns each time you move between cells.

### Format text

| Action                               | Keys     |
| ------------------------------------ | -------- |
| Italic: put `*` around the selection | Ctrl/⌘ I |
| Link: make the selection a link      | Ctrl/⌘ K |

With Ctrl/⌘ K and selected text, TypeNext writes `[text](https://)` and selects the address. When the selection is an address, it writes `[](address)` and puts the cursor in the brackets.

## The insert menu

The insert menu adds headings, lists, tables, snippets and actions.

1. Type `/` at the start of a word. A start of a word is the start of a line, or a position after a space or one of `( [ { >`.
2. Type part of a name, for example `/h2` or `/task`.
3. Use the Up and Down arrows to select an entry.
4. Press Enter or Tab to apply it.

To type a slash without the menu, press Escape after the slash. A second slash also closes the menu. The menu does not open in code.

### Built-in entries

| Section | Entry                                               | Result                                                                 |
| ------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| Text    | **Heading 1**, **Heading 2**, **Heading 3**         | Makes the line a heading.                                              |
| Text    | **Plain text**                                      | Removes a heading, list or quote marker.                               |
| Text    | **Bold**, **Italic**                                | Inserts markers with selected placeholder text.                        |
| Lists   | **Bulleted list**, **Numbered list**, **Task list** | Makes the line a list item.                                            |
| Blocks  | **Quote**                                           | Makes the line a quote.                                                |
| Blocks  | **Table**                                           | Inserts a table with three columns.                                    |
| Blocks  | **Code block**                                      | Inserts a fenced code block.                                           |
| Blocks  | **Divider**                                         | Inserts a horizontal rule.                                             |
| Insert  | **Link**                                            | Inserts `[](https://)`.                                                |
| Insert  | **Link to a note**                                  | Inserts `[[ ]]` and opens the note list.                               |
| Insert  | **Today’s date**, **Current time**                  | Inserts the local date or time.                                        |
| Actions | **Suggest a continuation**                          | Asks for suggestions, as Ctrl/⌘ Space does.                            |
| Actions | **Dictate**                                         | Starts dictation.                                                      |
| Actions | **Open the note graph**                             | Opens the graph.                                                       |
| Actions | **Search the web for facts**                        | Starts a web fact search. This entry shows only when web facts are on. |

### Add a custom command

A custom command inserts your own text, for example a meeting header.

1. Go to **Preferences → Editor**.
2. Under **Custom commands**, select **Add command**.
3. In **Command name**, type a name, for example "Meeting notes".
4. In **Text to insert**, type the Markdown text.
5. Optional: select a token button to insert `{cursor}`, `{date}` or `{time}`.
6. Select **Save command**.

The command shows under **Your commands** in the insert menu.

| Token      | Result                                                 |
| ---------- | ------------------------------------------------------ |
| `{cursor}` | The position of the cursor after insertion.            |
| `{date}`   | The local date, in the format of your system language. |
| `{time}`   | The local time.                                        |

Example text: `## Meeting · {date}` on the first line, an empty line, then `- {cursor}`.

A custom command with the same name as a built-in entry (for example "Table") replaces the built-in entry. You can have up to 64 custom commands. To change or delete a command, select its edit or delete button.

### Change the trigger character

1. Go to **Preferences → Editor**.
2. In **Trigger character**, type one symbol, for example `;`.

Letters, numbers and spaces are not permitted. To turn the menu off, turn off **Insert menu**.

## Links and the note graph

### Web links

Write a Markdown link (`[text](https://example.com)`) or an address. To open a link, Ctrl/⌘-click it, or put the cursor on it and press Alt+Enter.

### Note links

A note link connects two notes.

1. Type `[[`. A list of your other notes opens.
2. Type part of a title.
3. Select a note and press Enter.

Other forms:

- `[[Garden plan|the plan]]` shows "the plan" and links to "Garden plan".
- `[[Garden plan#Roses]]` links to "Garden plan" with a heading.

Case and spaces do not change the target. When two notes have the same title, the link goes to the note that you edited last. Links in code are not links.

### Open or create a linked note

- Ctrl/⌘-click the link, or put the cursor on it and press Alt+Enter.
- A link to a note that does not exist has a dashed underline. Ctrl/⌘-click or Alt+Enter creates the note with that title.
- In the `[[` list, the entry **New link · create the note later** writes a link to a note that does not exist yet.

### Hover cards

Put the pointer on a link to see a card:

- A note card shows the opening lines of the note, the last edit and the number of notes that link to it. Select **Open note**.
- A card for a missing note shows **Not written yet**. Select **Create “Title”**.
- A website card shows the address. With **Notes & web**, it also shows the page title and description. Select **Open link**.

To choose the cards, go to **Preferences → Editor → Link previews**:

| Option          | Result                                                  |
| --------------- | ------------------------------------------------------- |
| **Off**         | No cards.                                               |
| **Notes**       | Cards for note links only.                              |
| **Notes & web** | Cards for note links and websites. This is the default. |

NOTE: With **Notes & web**, TypeNext contacts the website to read its title. It sends no note text. To contact no website, choose **Notes** or **Off**.

### The note graph

The graph shows your notes and their connections.

1. Press Ctrl/⌘ Shift G, or select the note graph button in the toolbar.
2. Click a note to open it.
3. Press Escape or Ctrl/⌘ Shift G to close the graph.

| Mark         | Meaning                                   |
| ------------ | ----------------------------------------- |
| Solid line   | A `[[link]]` in a note.                   |
| Dashed line  | One note is used as context by the other. |
| Hollow point | A link to a note that is not written yet. |

Larger points have more connections or more text. The current note has the accent colour.

Controls:

- **Find a note**: type a title. Press Enter to open the best match.
- **All notes** or **Around this note**. With **Around this note**, set **Steps** to 1 or 2 with **Fewer steps** and **More steps**.
- **Context links**, **Unlinked notes**, **Unresolved links**: show or hide these parts.
- **List**: show the graph as a list.
- **Fit to view**: show all points.

Click a hollow point to see **Create note** and **Not now**. Scroll to zoom. Drag the background to move the view. Double-click empty space to fit the view.

| Key (in the graph) | Action                                                       |
| ------------------ | ------------------------------------------------------------ |
| Arrow keys         | Go to the nearest note in that direction.                    |
| Enter or Space     | Open the selected note, or create a hollow note.             |
| `/`                | Go to **Find a note**.                                       |
| F                  | Fit to view.                                                 |
| `+` and `-`        | Zoom in and out.                                             |
| Escape             | Close the create card, clear the search, or close the graph. |

The graph keeps its settings until you close TypeNext.

## Context

Context tells suggestions what the note is about and what facts to use. Select **Context** in the toolbar to open the Context panel. The panel has these sections:

1. **Intent**: the objective and the background of the note.
2. **Connections**: the contexts attached to the note.
3. **Direct references**: references for this note only.
4. **Find in attached context**: a search in the references.

### Intent

1. Open the Context panel.
2. Expand **Intent**.
3. In **Objective**, type what the note must achieve. If you leave it empty, suggestions use the first line of the note.
4. In **Background & voice**, type who reads the note, the tone, and other useful facts.

The objective also shows below the note title.

### Create a context

1. Select **Contexts** in the sidebar, or **Manage contexts** in the Context panel.
2. Select **New context**.
3. Type a **Context name**, for example "Field research".
4. Select **Create context**.
5. Add references with **Add files**, **Add folder**, **Add a website** or **Use a note**. You can also drop files on the dialog.

| Reference           | Behaviour                                                                    |
| ------------------- | ---------------------------------------------------------------------------- |
| File                | Text, Markdown, PDF with selectable text, Word (`.docx`).                    |
| Folder              | A snapshot of the supported files in the folder.                             |
| Website             | A snapshot of the article text of the page.                                  |
| Note                | Live. Changes in the other note show at once.                                |
| Image, audio, video | Needs semantic search with media. See [Media references](#media-references). |

Files, folders and websites are snapshots. TypeNext does not watch them for changes. To rename a context, select its pencil button. To delete it, select its delete button, then **Remove context**. References that other contexts use stay available.

### Attach a context to a note

Use one of these methods:

- Drag a context card from the tray onto the note card in **Connections**.
- Click a context card in the tray.
- Type in **Attach a context…** and press Enter. Enter attaches the first match. If no context matches, Enter creates a new context with that name and attaches it.
- In the **Contexts** dialog, turn on the switch of the context.

A note can have up to 64 contexts.

### Detach a context

- Drag the attached card back to the tray.
- Select the × button on the card.
- Select the card with the keyboard and press Delete or Backspace.

Use the Up and Down arrows to move between cards. Enter or Space on a card attaches it (in the tray) or opens it in the **Contexts** dialog (when attached).

### Add files by drag and drop

- Drop files on the Context panel to add them as direct references of this note.
- Drop files on a context card to add them to that context.

### Direct references

A direct reference belongs to one note only. Under **Direct references**, select **Attach files**, **Add a website** or **Use a note**.

- Click a reference to preview the text that suggestions can use.
- Turn off its switch to leave it out of suggestions.
- Select its remove button to remove it.

Images and videos show a thumbnail. Videos also show their length.

### Find in attached context

1. Expand **Find in attached context**.
2. Type a detail, a phrase or a topic.
3. Select **Find passages**.

TypeNext shows up to four passages. With semantic search on, each passage has a badge:

| Badge       | Meaning                                   |
| ----------- | ----------------------------------------- |
| **words**   | The passage has your words (BM25 search). |
| **meaning** | The passage has a similar meaning.        |
| **both**    | The passage matches both ways.            |

## Suggestions

A suggestion is a short continuation at the cursor. It shows as grey text and is not part of the note.

| Action                 | Keys         |
| ---------------------- | ------------ |
| Accept the suggestion  | Tab          |
| Accept one word        | Ctrl/⌘ →     |
| Dismiss the suggestion | Escape       |
| Ask for suggestions    | Ctrl/⌘ Space |

Undo removes accepted text in the usual way.

### The suggestion menu

1. Press Ctrl/⌘ Space. A menu opens at the cursor.
2. Use the Up and Down arrows to preview each choice.
3. Press Enter or Tab to accept a choice. Press Escape to close the menu.

A preview does not change the note. A hosted chat model returns up to three new choices for each request. A move between choices makes no new request.

### Choose the suggestion engine

1. Select the engine button in the status bar (**Choose suggestion engine**).
2. Type in **Search engines and models** to filter the list.
3. Use the Up and Down arrows to select an engine. Press Enter.

**On this device** engines:

| Engine                        | Description                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| **Writing starters & recall** | The default. No setup. Recalls phrases from your note and references, and offers short starters. |
| **Built-in SmolLM2**          | A small English model in TypeNext. A one-time download of about 139 MB. Works offline.           |
| **Local server**              | A model in LM Studio, Jan, Lemonade or llama.cpp on your computer.                               |

External providers are OpenRouter, OpenAI, Anthropic and a custom endpoint. Set them up in **Preferences → Models**.

### Set up a local server

1. Start your server app and load a model.
2. Go to **Preferences → Models**. Under **On this device**, select **Local server**.
3. Select a preset: **LM Studio**, **Jan**, **Lemonade** or **llama.cpp**. Or type the **Server address**.
4. Select **Detect models**.
5. Choose a model in **Model**.

### Set up an external provider

CAUTION: While an external provider is active, TypeNext sends nearby writing, the objective, your instructions and relevant attached context to that provider. The privacy and billing terms of the provider apply.

1. Go to **Preferences → Models → External providers**.
2. Select **OpenRouter**, **OpenAI**, **Anthropic** or **Custom**.
3. Paste your key in **API key**.
4. Optional, on the desktop: select **Remember in the device credential vault** to keep the key after a restart.
5. Select **Save key**.
6. Select **Load models**, then choose a model. For OpenRouter, **Free only** shows free models.
7. Optional: select **Save this model** to add it to the engine chooser.
8. Select **Use {provider} continuously**, for example **Use OpenRouter continuously**.

To return to local suggestions, select **Switch to this device**. A local error never sends a request to an external provider.

### Suggestion settings

Go to **Preferences → Suggestions**:

- **Inline suggestions**: turn suggestions on or off.
- **Suggest after a pause**: when off, suggestions come only from Ctrl/⌘ Space.
- **Suggestion length**: **Adapt to the sentence**, **Just a few words** or **Up to one sentence**.
- **Pause before suggesting**: **Quick (0.65s)**, **Natural (1.1s)** or **Unhurried (1.8s)**.
- **Creativity**: from **Stay close** to **Explore a little**.
- **Suggestion instructions**: your own instructions for all models, up to 2,000 characters.

To pause suggestions for a short time, select the suggestion status in the status bar.

## Semantic search

Semantic search finds passages in your references by meaning, also when the words are different. TypeNext always uses BM25 search, which finds matching words. Semantic search adds results that BM25 cannot find. TypeNext uses both to choose the references for a suggestion.

Semantic search uses the Google EmbeddingGemma 2 embedding model in a llama.cpp server on your device. Your notes and references do not leave the device. Semantic search is off by default.

### Set up semantic search in the desktop app

1. Go to **Preferences → Knowledge**.
2. Turn on **Semantic search**.
3. In **Run with**, select **Inside TypeNext**.
4. In **Quality**, select **Balanced (Q4)** or **Precise (Q8)**.
5. Optional: turn on **Images, audio and video** to add the media encoder.
6. Select **Download** with the size.
7. Wait until the status shows **Installed**. To stop the download, select **Cancel download**. A later download continues from the same point.

TypeNext starts the server when semantic search is necessary. You can also select **Start** and **Stop**. The status shows **Running** when the server is ready.

| Download                    | Size (approximate)             |
| --------------------------- | ------------------------------ |
| llama.cpp server (`b11696`) | 12 to 20 MB, for each platform |
| **Balanced (Q4)** model     | 175.7 MB                       |
| **Precise (Q8)** model      | 309.9 MB                       |
| Media encoder               | 554.8 MB                       |

The app shows the sizes rounded, for example "176 MB". TypeNext downloads the files from GitHub and Hugging Face. It checks the SHA-256 of each file and discards a file that does not agree. The server listens only on your computer (`127.0.0.1`), on a random port, with a new key for each start. TypeNext stops the server when you close the app. After a crash, TypeNext stops the old server at the next start.

To remove all files, select **Remove**, then **Remove** again. Select **Keep** to stop.

### Set up semantic search with your own server

Use this mode in the browser preview, or to control llama.cpp yourself.

1. Download a llama.cpp build and a model file from [unsloth/embeddinggemma-2-GGUF](https://huggingface.co/unsloth/embeddinggemma-2-GGUF).
2. Go to **Preferences → Knowledge**.
3. Turn on **Semantic search**.
4. In **Run with**, select **My own server**.
5. In **Model file**, select the file that you downloaded.
6. Copy the command under **Server command** and run it in a terminal.
7. In **Embedding server**, type the server address. The default is `http://127.0.0.1:8080`.
8. Select **Check connection**.

The command has this form:

```sh
llama-server -m embeddinggemma-2-UD-Q4_K_XL.gguf --embeddings --pooling mean --ctx-size 8192 --batch-size 8192 --ubatch-size 8192 --host 127.0.0.1 --port 8080
```

With **Images, audio and video** on, the command also contains `--mmproj mmproj-Q8_0.gguf`. The server address must be `localhost`, `127.0.0.1` or `[::1]`. A successful check shows, for example, "Connected in 40 ms. Reads text, images and audio."

### Vector size

**Vector size** sets how much detail each vector keeps.

| Size | Use                                                   |
| ---- | ----------------------------------------------------- |
| 128  | Smallest index and fastest search. For text only.     |
| 256  | Nearly the quality of 512 for text, at half the size. |
| 512  | The default balance of accuracy and index size.       |
| 768  | The largest index. Best with images and audio.        |

A change of vector size indexes your references again.

### Indexing

TypeNext indexes the references of the current note in the background, after you stop typing. **This note** in **Preferences → Knowledge** shows the progress, for example "Indexed 40 of 120 passages". The vectors are kept on your device, so TypeNext does not compute the same text twice.

If the embedding server is slow or stopped, TypeNext uses BM25 search alone. Suggestions continue without delay.

With **Writing starters & recall**, semantic search can also offer a next line from a related passage. This occurs only at the start of a sentence or a line.

### Media references

With **Images, audio and video** on, you can add media files as references. TypeNext keeps only the vector, a small thumbnail and a caption. It does not keep the file.

| Kind  | Limit                | File types                    |
| ----- | -------------------- | ----------------------------- |
| Image | 20 MB                | PNG, JPEG, WebP, GIF, BMP     |
| Audio | 30 MB and 3 minutes  | WAV, MP3, M4A, AAC, OGG, FLAC |
| Video | 50 MB and 45 seconds | MP4, M4V, WebM, MOV           |

The model finds a media reference by meaning, for example a photo of a garden for the query "roses". A suggestion model does not see the picture or hear the sound. It receives the name and the caption. To improve the caption, open the preview of the reference and edit **Caption used for search and suggestions**.

PNG, JPEG, WAV, MP3 and MP4 are the most reliable formats. Other formats depend on the llama.cpp build.

## Web facts

Web facts find current facts on the web and insert them with their sources. Web facts are off by default.

CAUTION: When you search, TypeNext sends the selected text, nearby writing, the note title and the objective to OpenAI. OpenAI charges for each web search in addition to tokens.

### Set up web facts

1. Add an OpenAI key in **Preferences → Models → External providers → OpenAI**. Web facts use this key.
2. Go to **Preferences → Web facts**.
3. Turn on **Web facts**.
4. In **Search model**, keep `gpt-5.4-mini` or choose another model. Smaller models are faster and cost less.

### Search for a fact

1. Select a phrase in the note. Without a selection, TypeNext uses the sentence before the cursor.
2. Press Ctrl/⌘ Shift K, or choose **Search the web for facts** in the insert menu.
3. Wait for the choice menu. It shows up to three facts with their sources.
4. Use the arrows to preview a fact. Press Enter or Tab to insert it.

The fact goes after the selection. TypeNext adds Markdown links to up to two sources in parentheses. TypeNext keeps search results for 10 minutes, so the same search again makes no new request.

### Facts in the suggestion menu

Turn on **Also ground Ctrl / ⌘ Space choices with web facts** to add cited facts to the Ctrl/⌘ Space menu. Each Ctrl/⌘ Space request then runs a web search. If the search fails, the ordinary choices stay.

## Dictation

TypeNext can transcribe speech on your device with the optional Whistle model, a one-time download of about 17 MB.

1. Put the cursor where the text must go.
2. Press Ctrl/⌘ Shift D, or select the dictation button in the toolbar.
3. At the first use, download the model and choose a microphone.
4. Speak. You can continue to type.
5. Press Ctrl/⌘ Shift D again to stop. Press Escape to cancel.

A recording stops after 30 seconds. The transcript enters the note at the recording position. TypeNext sends no audio to a service.

## Zen mode

Zen mode removes parts of the window so that you see only the page.

| Level                | Result                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Hide side panels** | The notes sidebar and the Context panel close. The toolbars stay.                                                    |
| **Hide toolbars**    | Also the toolbar, tabs and status bar. Move the pointer to the top or bottom edge to show them. This is the default. |
| **Full screen**      | Only the page, in full screen.                                                                                       |

### Choose a level

1. Select the arrow beside the zen button in the toolbar (**Choose zen mode level**).
2. Select a level. Zen mode starts at once.

You can also set the level in **Preferences → Writing → Zen mode → Hide**. There, the levels are **Sidebars**, **Chrome** and **Full**.

### Start and leave zen mode

- Press Ctrl/⌘ Shift F to start or leave zen mode at the saved level.
- Press Escape to leave zen mode.
- Select **Leave zen**. This button shows when the toolbars show, at the levels **Hide toolbars** and **Full screen**.

The toolbars hide again 0.7 seconds after the pointer leaves the edge. TypeNext always starts with zen mode off.

## Preferences

Press Ctrl/⌘ , or select **Preferences** in the sidebar.

| Pane            | Settings                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Writing**     | **Typeface**, **Size (px)**, **Theme** (System, Light, Dark), colour palettes, **Zen mode**, **Autosave**.                                          |
| **Editor**      | **Insert menu**, **Trigger character**, **Custom commands**, **Live preview**, **Link previews**.                                                   |
| **Suggestions** | **Inline suggestions**, **Suggest after a pause**, **Suggestion length**, **Pause before suggesting**, **Creativity**, **Suggestion instructions**. |
| **Models**      | The active engine, **On this device**, **External providers**, keys and saved models.                                                               |
| **Knowledge**   | **Semantic search**, **Run with**, **Vector size**, **Images, audio and video**, **Website importer**.                                              |
| **Web facts**   | **Web facts**, **Also ground Ctrl / ⌘ Space choices with web facts**, **Search model**.                                                             |
| **Shortcuts**   | A list of keyboard shortcuts.                                                                                                                       |

**Models** starts with the active engine card. It shows **Suggestions come from**, the engine and **On this device** or **External**.

**Website importer** has two options. **Direct import** reads ordinary websites. **Firecrawl (external service)** can read websites that need JavaScript. Firecrawl receives the website address and needs a **Firecrawl API key**.

## Keyboard shortcuts

Global shortcuts do nothing while a dialog is open.

### Notes and window

| Action                      | macOS     | Windows and Linux |
| --------------------------- | --------- | ----------------- |
| New note                    | ⌘ N       | Ctrl+N            |
| Open a Markdown file        | ⌘ O       | Ctrl+O            |
| Save                        | ⌘ S       | Ctrl+S            |
| Save as                     | ⌘ Shift S | Ctrl+Shift+S      |
| Search notes                | ⌘ P       | Ctrl+P            |
| Show or hide notes          | ⌘ B       | Ctrl+B            |
| Show or hide notes (menu)   | ⌘ 1       | Ctrl+1            |
| Show or hide context (menu) | ⌘ 2       | Ctrl+2            |
| Preferences                 | ⌘ ,       | Ctrl+,            |
| Zen mode on or off          | ⌘ Shift F | Ctrl+Shift+F      |
| Leave zen mode              | Escape    | Escape            |
| Note graph                  | ⌘ Shift G | Ctrl+Shift+G      |
| Dictation start or stop     | ⌘ Shift D | Ctrl+Shift+D      |

### Editor

| Action                                 | macOS     | Windows and Linux |
| -------------------------------------- | --------- | ----------------- |
| Insert menu                            | `/`       | `/`               |
| Note link                              | `[[`      | `[[`              |
| Italic                                 | ⌘ I       | Ctrl+I            |
| Link                                   | ⌘ K       | Ctrl+K            |
| Toggle a task                          | ⌘ Enter   | Ctrl+Enter        |
| Open the link at the cursor            | ⌥ Enter   | Alt+Enter         |
| Open a link with the pointer           | ⌘-click   | Ctrl+click        |
| Search the web for facts               | ⌘ Shift K | Ctrl+Shift+K      |
| Next table cell, indent list item      | Tab       | Tab               |
| Previous table cell, outdent list item | Shift Tab | Shift+Tab         |

### Suggestions

| Action                 | macOS   | Windows and Linux |
| ---------------------- | ------- | ----------------- |
| Ask for suggestions    | ⌘ Space | Ctrl+Space        |
| Accept                 | Tab     | Tab               |
| Accept one word        | ⌘ →     | Ctrl+→            |
| Choose another choice  | ↑ ↓     | ↑ ↓               |
| Accept the menu choice | Enter   | Enter             |
| Dismiss                | Escape  | Escape            |

## Privacy summary

| Feature                                                     | What leaves your device                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Notes and references                                        | Nothing. They are stored locally.                                              |
| **Writing starters & recall**, built-in model, local server | Nothing.                                                                       |
| Semantic search                                             | Nothing. The embedding server runs on your computer. The model downloads once. |
| Dictation                                                   | Nothing. The model downloads once.                                             |
| External provider (active)                                  | Nearby writing, objective, instructions and relevant attached context.         |
| Web facts (on request)                                      | Selected text, nearby writing, note title and objective, to OpenAI.            |
| Link previews (**Notes & web**)                             | A request to the linked website. No note text.                                 |
| Website import                                              | A request to the website. With Firecrawl, the address goes to Firecrawl.       |

On the desktop, keys stay in memory unless you select **Remember in the device credential vault**. In the browser preview, keys last for the session only.

## Troubleshooting

| Problem                                                              | Cause and remedy                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No suggestions appear.                                               | Make sure that **Inline suggestions** is on and the status bar does not show **Suggestions paused**. Press Ctrl/⌘ Space.                                   |
| ⌘ Space opens Spotlight on macOS.                                    | macOS uses ⌘ Space for Spotlight by default. Change the Spotlight shortcut in macOS System Settings, or use **Suggest a continuation** in the insert menu. |
| The insert menu does not open.                                       | Type the trigger at the start of a word, not in code. Make sure that **Insert menu** is on in **Preferences → Editor**.                                    |
| The insert menu opens when I want a slash.                           | Press Escape after the slash. Or change the **Trigger character**.                                                                                         |
| A suggestion uses wrong facts.                                       | Check the **Intent** and the attached references. Turn off references that are not related. A model can be wrong also with the correct passage.            |
| **Inside TypeNext** is not available.                                | The managed server needs the desktop app on a supported platform. Use **My own server**.                                                                   |
| The download stops with an error.                                    | Check the network connection and select **Download** again. The download continues from the same point. A file with a wrong SHA-256 is discarded.          |
| "The embedding server did not become ready within 90 seconds"        | The computer is slow or busy. Select **Start** again. Try **Balanced (Q4)**.                                                                               |
| "TypeNext could not reach the embedding server."                     | Start your own server with the command in **Preferences → Knowledge**. Check the address and the port. Select **Check connection**.                        |
| "The embedding server returned an unexpected vector."                | Use EmbeddingGemma 2 with `--embeddings --pooling mean`.                                                                                                   |
| A media file is refused.                                             | Turn on **Semantic search** and **Images, audio and video**. Check the size and length limits in [Media references](#media-references).                    |
| "Meaning search is unavailable. Matching words only."                | The embedding server is not ready. BM25 search continues. Start the server in **Preferences → Knowledge**.                                                 |
| "Add your OpenAI API key in Preferences → Models to search the web." | Add and save an OpenAI key in **Preferences → Models**.                                                                                                    |
| "The web search found no cited facts. Try other words."              | Select a more specific phrase.                                                                                                                             |
| A website card shows only the address.                               | The website did not give a title, or **Link previews** is not **Notes & web**.                                                                             |
| A scanned PDF gives no text.                                         | TypeNext reads only selectable text. Use OCR first. Convert `.doc` files to `.docx` or text.                                                               |
| "This note can hold up to 8 MiB."                                    | Put the extra text in another note. Your text is unchanged.                                                                                                |
