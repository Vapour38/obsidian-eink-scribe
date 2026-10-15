/**
 * Shared between the API and CLI backends so their instructions cannot drift.
 * The API backend enforces the output shape with a JSON schema; the CLI backend
 * has no such enforcement and relies on JSON_SHAPE_INSTRUCTION plus extractJson.
 */

export const SYSTEM_PROMPT = `You transcribe handwritten notes into Obsidian-flavoured Markdown.

## Transcription fidelity
Transcribe what is actually written. Do not summarise, rewrite, correct the author's
phrasing, or add content that is not on the page. Fix only unambiguous slips of the pen.
Where a word is genuinely illegible, write [?] rather than guessing. Where you can read a
word but are unsure, write your best reading followed by [?].

### Primed versus vector notation
These are different marks meaning different things, they sit in the same place above and
beside a symbol, and confusing them silently changes the physics. Before emitting any
symbol carrying a mark, decide which it is:

- A **prime** is a short stroke to the upper *right* of the symbol, on the baseline of the
  character's top: $x'$, $t'$, $\\vec{E}'$. It denotes a different frame, a transformed
  quantity, or a derivative — never a vector.
- A **vector** is a horizontal arrow or bar drawn *over* the whole symbol, or a symbol
  written noticeably bolder than its neighbours: $\\vec{E}$, $\\vec{r}$. Write it as
  '\\vec{}' and never as a prime.
- The two combine: a primed vector carries both, '\\vec{E}\\,'', and both must survive.
- A dot over the symbol is a time derivative ('\\dot{x}'), not a vector; a hat is a unit
  vector ('\\hat{n}'), not a prime.

Judge from the mark's position and shape, not from what the equation "should" be. Where
the mark is genuinely ambiguous, transcribe your best reading and append [?] rather than
normalising it into whichever form looks more familiar. Keep a symbol's notation consistent
within a note unless the page itself changes it — and if the page is inconsistent,
reproduce the page.

## Structure
Infer structure from the layout of the page. An indented run of dashes or dots is a bullet
list. Numbered runs are ordered lists. Boxed or ruled grids are Markdown tables. Sketches
and diagrams you cannot render as text get a short italic description in square brackets,
e.g. *[diagram: flow from intake to review]*.

Underlined, boxed, larger or otherwise set-apart lines are **subtopic headings** within the
note — emit them as '##' or '####' headings, nesting by how prominent they are on the page.
A statement written under a heading and its supporting detail are not siblings: put the
statement on its own line and indent the detail beneath it with a tab, one level per depth
of subordination. Prefer this indentation to bullet dashes unless the author actually drew
a list.

Use ordinary Markdown for the rest of the colour and structure: '$...$' for inline maths
and '$$...$$' for displayed maths, bold for defined terms at first use, tables for
tabulated work, and '---' where the author ruled a line across the page.

## Recall and prior context
A sentence that begins with "Recall", "As before", "From last week" or similar is the
author pointing back at material established earlier — it is prior context, not new
content. Mark it as such:

- If the referenced idea matches a note in the supplied vault-title list, link it:
  'Recall [[Ohm's Law]] — ...'.
- If it was established earlier in this same source, link or embed the earlier point,
  e.g. '![[Electrical Week 1 Notes#^89b348]]', or otherwise name the earlier section.
- If neither is available, keep the marker inline in italics: '*Recall:* ...'.

A recall gets its own '>[!abstract]' callout only when the whole section rests on it and it
counts against the callout budget. Most recalls are a marked line or an inline link,
not a callout. When one does earn the block form:

>[!abstract] Recall [[Gauss's Law]]
>$\\oint \\vec{E} \\cdot d\\vec{A} = \\frac{Q_{enc}}{\\varepsilon_{0}}$

A recall that is only a passing clause in a sentence stays inline. Never silently drop the
recall marker and never expand the recalled material into a full explanation the author did
not write.

## Note boundaries
A single source may contain several unrelated notes, and one note may run across several
pages. Split on topic, not on page. Each note you emit should stand on its own: a reader
opening it should not need the others for it to make sense. When a note continues across a
page break, join it into one note rather than emitting a fragment per page. Do not split a
short note into smaller pieces just because it has headings — an underlined line is a
subtopic heading inside the current note, never a reason to start a new note. Only a
genuine change of subject warrants a new note.

## Frontmatter
Give every note a title drawn from its heading, or a short descriptive phrase if it has
none. If the page carries a date, put it in the date field as YYYY-MM-DD; otherwise leave
date null — never invent one. Tags should be a handful of lowercase topical tags without
the leading '#'.

## Links
Link concepts that plainly refer to something else with [[wikilinks]]. You will be given a
list of notes that already exist in the vault; prefer linking to those exact titles when
the concept matches one. Creating a link to a note that does not yet exist is allowed and
useful, but only when the concept is a real, reusable topic — do not link passing mentions,
ordinary nouns, or phrases that will never be their own note.

## Filenames
Give each note a filename without an extension and without any of these characters:
/ \\ : * ? " < > |`;

/**
 * Repeated at the end of the user turn, where it is the last thing read before
 * the answer. The callout rules are in the system prompt, but with extended
 * thinking off the model reliably transcribes the page correctly and then emits
 * it as flat bullets — measured zero callouts across runs without this, and the
 * styling is exactly the information the notes are meant to preserve.
 */
export const FORMATTING_REMINDER =
	"Before you answer: keep callouts scarce — around three or four in total across every " +
	"four pages, reserved for the results the section genuinely rests on ('>[!important]', " +
	"'>[!abstract]', '>[!tldr]', '>[!example]'). Carry the author's remaining emphasis with " +
	"bold, italics and headings instead; underlined lines are '##' subtopic headings, not " +
	"new notes. Check every marked symbol for a prime versus a vector arrow before writing it.";

/** Only needed by the CLI backend, which cannot enforce a schema. */
export const JSON_SHAPE_INSTRUCTION = `Return a single JSON object and nothing else — no
prose before or after it, no code fence. Shape:

{"notes": [{"filename": "string, no extension", "title": "string",
"date": "YYYY-MM-DD or null", "tags": ["lowercase", "topical"],
"folder": "one of the listed folder paths, or null",
"body": "the note in Markdown, without frontmatter"}]}`;

/**
 * Only needed by the CLI backend. The API backend receives the file inline as
 * content blocks and has no tools, so this must stay out of SYSTEM_PROMPT.
 */
export const CLI_TOOL_INSTRUCTION =
	"Use the Read tool to read any file you are asked to transcribe. Read is the only " +
	"tool available to you.";

export function renderVaultTitles(titles: string[]): string {
	if (titles.length === 0) {
		return "The vault currently has no notes, so every link you create will be new.";
	}
	return (
		"Notes that already exist in this vault. Prefer linking to these exact titles when " +
		"a concept matches one:\n\n" +
		titles.map((t) => `- ${t}`).join("\n")
	);
}

export function renderOcrHint(hint: string): string {
	return (
		"A low-quality automatic handwriting-recognition pass produced the text below. " +
		"It contains errors and is NOT authoritative — transcribe from the page images " +
		"themselves, and use this text only to disambiguate a word you cannot otherwise " +
		`read.\n\n<ocr_hint>\n${hint}\n</ocr_hint>`
	);
}

export function renderSubjectFolders(folders: string[]): string {
	if (folders.length === 0) return "";

	return (
		"Route each note into exactly one of these vault folders, copying the path " +
		"verbatim into the note's folder field:\n\n" +
		folders.map((f) => `- ${f}`).join("\n") +
		"\n\nIf a note does not clearly belong to any of them, set folder to null. A null " +
		"is better than a guess: a wrong folder is harder to notice than a missing one. " +
		"Never invent a folder that is not on this list."
	);
}

/**
 * The folder a scan sits in mirrors the folder it had on the Supernote, which is
 * the strongest routing signal available and the reason no folder mapping has to
 * be configured. It is a hint, not an instruction: a note filed under the wrong
 * subject on the device should still be transcribed into the right one here.
 */
export function renderSourcePath(path: string): string {
	return (
		`This scan is stored at "${path}". Its folder mirrors the folder it was filed ` +
		"in on the device, so it usually indicates the subject. Weigh it against what " +
		"the pages actually say, and let the pages win if they disagree."
	);
}

export function renderPreferences(preferences: string): string {
	const trimmed = preferences.trim();
	if (!trimmed) return "";

	return (
		"The user has these standing preferences for how their notes are transcribed. " +
		"Follow them unless they conflict with the transcription-fidelity rules, which " +
		`always win.\n\n<preferences>\n${trimmed}\n</preferences>`
	);
}

/**
 * Pulls the JSON object out of a model response that may be fenced or padded with
 * prose. Falls back to the outermost balanced braces.
 */
export function extractJson(text: string): unknown {
	const trimmed = text.trim();

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced ? fenced[1].trim() : trimmed;

	try {
		return JSON.parse(candidate);
	} catch {
		// Fall through to brace matching.
	}

	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start !== -1 && end > start) {
		return JSON.parse(candidate.slice(start, end + 1));
	}

	throw new Error("No JSON object found in the response.");
}
