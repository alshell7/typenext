# Try the Bramble House sample

Bramble House is fictional. The four source files are small enough to inspect and edit yourself.

In TypeNext, choose **Try a sample** on the welcome screen or in **Contexts**. It creates a sample note and attaches two reusable contexts: **Bramble House · details** and **Bramble House · voice**. Your other notes and model settings stay as they are.

Place the cursor after `Guests arrive at Bramble House`, then press **Ctrl/Command + Space** and **Tab** to accept a suggestion. The default local recall engine can finish this directly from `house.md`, without a download or API key. With automatic suggestions enabled, typing the same fragment and pausing also works.

To try importing the files yourself, create two contexts. Put the three files in `details/` into one, and `voice/welcome-voice.md` into the other. Attach both to a new note. Use `welcome-note.md` as a starting point, with the objective: “Write a warm, factual welcome note for the fictional Bramble House writing retreat.”

## A few things to try

| Type this fragment | Check against the source |
| --- | --- |
| `Guests arrive at Bramble House` | Friday at 16:00 — `house.md` |
| `The Saturday writing session begins` | 09:30 in the shared writing room — `weekend-plan.txt` |
| `The coastal walk starts` | The blue orchard gate — `coastal-walk.md` |

Open **Context** beside the note to inspect or detach its packages. Detaching “details” should remove its facts from retrieved references. Changing a source changes what the next retrieval can find.

You can choose a downloaded SmolLM model, a local model server, or deliberately enable an external model to try the same note with generated wording. Retrieval still runs locally; enabling external inference sends selected excerpts and nearby writing to that provider. The small built-in model can miss details even when they are supplied. Source labels identify relevant retrieved material; they do not mean the resulting sentence has been fact-checked. The built-in model uses shorter excerpts than server models.

You can edit or delete the sample like any other note. **Open sample** reopens your edits without resetting them. Files and sample content are part of the TypeNext project under its repository license.
