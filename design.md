# Design

Why this plugin is shaped the way it is. `CLAUDE.md` covers how to work on it; this file
covers the decisions, what they cost, and what is deliberately missing.

## Goal

Turn handwritten input — phone photos, flatbed scans, and Supernote PDF exports — into
Markdown notes that are usable Obsidian citizens: real headings and lists, YAML
frontmatter, topical tags, and `[[wikilinks]]` that prefer notes already in the vault.

Explicitly **not** a summarizer. The instruction set in `prompt.ts` is written to forbid
rewriting, and to mark illegible words `[?]` rather than guess. A transcription you cannot
trust word-for-word is worse than none, because you stop checking it against the page.

## Why no separate OCR stage

Classic OCR engines (Tesseract and friends) are trained on print and fail badly on cursive.
A vision model reads the handwriting *and* infers document structure in one pass, so there
is no separate recognition step to tune, and no lossy text hand-off between stages.

The Supernote `.txt` sidecar is the one place OCR output enters the system, and it is
passed as an explicitly untrusted hint — "use only to disambiguate a word you cannot
otherwise read". It never becomes the source of truth.

## Two backends

Handwriting transcription is a personal, bursty workload. Paying API credits for it is
reasonable but not obviously right when a Claude subscription is already being paid for, so
both paths exist behind one interface.

| | API (`claude.ts`) | Claude Code CLI (`claudeCode.ts`) |
|---|---|---|
| Billing | API credits | Claude subscription |
| Auth | API key in `data.json`, plaintext | Existing CLI OAuth login |
| Output shape | Enforced by JSON schema | Requested in prompt, parsed defensively |
| File access | Base64 into the request | CLI reads it off disk |
| Size ceiling | 32 MB request, ~100 PDF pages | No request limit |
| Overhead | Cached system prefix, ~0.1× on repeat | ~1.3k tokens per invocation (trimmed; ~18k before) |
| Speed | One HTTP round trip | Process spawn + agent loop |

### Measured, not estimated

From a real run against `2025/Screenshot 2025-03-22 at 9.44.45 pm.png` (hand-drawn circuit
diagrams) on `claude-sonnet-5`:

The original measurement on `claude-sonnet-5`: a trivial `-p "Reply with exactly: OK"` call
reported **25,636 cache-creation tokens** and **$0.154** equivalent, and the real
transcription **$0.093**. The fixed cost dominated the marginal cost, and nothing is cached
between invocations, so a large batch burned subscription rate limits far faster than the
token count of the actual notes suggested.

That overhead is now trimmed away. Re-measured 2026-08-10 on `claude-haiku-4-5`, holding the
model and file fixed so only the flags differ:

| Invocation | Input tokens | Cost |
|---|---|---|
| Trivial prompt, untrimmed | 18,127 | $0.0149 |
| Trivial prompt, trimmed | 1,286 | $0.0021 |
| Real scan, untrimmed | — | $0.0217 |
| Real scan, trimmed | ~4,200 | $0.0065 |

Overhead drops **93%**. The saving on a real scan is smaller (~3.3×) than on a trivial
prompt (~7×) because the page's image tokens are irreducible — trimming removes context,
not the picture. Costs vary a few tenths of a cent run to run; treat these as
order-of-magnitude.

Note the untrimmed figures differ from the original Sonnet ones above: overhead varies by
model, which is why the comparison holds the model fixed.

**Recommendation:** either backend is now reasonable for batches. The CLI backend's fixed
cost no longer dominates, so the choice is mostly whether you would rather spend API credits
or subscription rate limits. Haiku is the default model — transcription is perception and
formatting, not reasoning, and it read hand-drawn circuit diagrams correctly in testing.

### The unresolved question

The CLI backend repurposes a coding tool as a document-transcription service. It works and
was built at the user's explicit request, but whether that fits the subscription's usage
terms is a judgement the user has made, not a settled fact. If it ever needs to go, it is
one `Backend` union member and one file.

## Prompt sharing

`prompt.ts` exists because the two backends would otherwise drift: the API path enforces a
schema, the CLI path begs for one in prose, and it would be easy to fix a transcription bug
in one and not the other. Shared system prompt, shared vault-title rendering, shared OCR
hint framing. The only backend-specific piece is `JSON_SHAPE_INSTRUCTION`, needed solely
because the CLI cannot be schema-constrained.

## Deliberate scope cuts

Each of these was in the approved plan and cut before implementation, on the grounds that
it was a branch to maintain for a problem not yet observed:

- **PDF page-splitting via pdf-lib.** Claude takes 100-page PDFs directly, and an
  over-long one is reported by the API. This removed the only runtime dependency — the
  plugin now ships with zero.
- **A folder-batch command.** Multi-select in the file menu already walks a list of files.
- **Settings for effort, attachment-link style, max pages.** Hardcoded. Every setting is a
  branch and a support question.

The preview modal also diverged from plan: instead of separate Accept-all / Accept-this /
Edit buttons, each note has an include toggle and an editable body with one "Create notes"
button. Same capability, one code path.

## Known-soft areas

**PDF page limits are not pre-checked.** A page counter that scanned raw bytes for
`/Type /Page` was removed: it found nothing whenever a PDF compressed its structure into
object streams, so it already fell through to letting the API report the real limit. Now it
always does.

**The Supernote sidecar convention is a guess** — `<basename>.txt` beside the PDF. Unverified
against a real export. If it is wrong, it is a one-line fix in `readSidecar`.

**Overlapping selections are de-duplicated by target path, not by source.** Choosing a
folder and its parent converts each file once. Two different device folders holding a
same-named note still produce two PDFs, because their paths differ.

**Routing rests entirely on the model.** The device's folder name reaches it only as a
prompt hint, so nothing guarantees a note lands in the matching vault folder — a subject
whose device and vault names differ is the likely failure. The preview is where that is
caught, and it blocks creation until every note has a destination.

**Every folder in the vault is offered as a destination.** On a large vault that is a long
list in the cached prefix. Filtering it down is the upgrade if it starts to matter.

**An unrouted note lands in the vault root.** With mappings covering every subject this
should not happen; when it does, the note is visible at the top of the vault rather than
filed somewhere plausible-looking. The preview blocks creation until every note has a
destination, so this only fires with the preview off.

**Re-syncing a changed note leaves its old transcription in place.** Adding pages to a
note overwrites its PDF, but the existing transcription still names that path in its
`source` frontmatter, so `findUntranscribed` keeps skipping it. Deleting the note is how
you ask for it to be redone — the same contract `autoImport.ts` already documents.

**Sync converts one file at a time**, with `-j 4` parallelising pages within a file. A
first sync of a few hundred notes takes minutes. Several child processes at once is the
upgrade, and is marked in `supernote.ts`.

**Every path in the sync path is macOS-shaped** — the mirror root, the Python candidates
and the `supernote-tool` candidates — matching the existing `CANDIDATE_PATHS`.

**The API backend has never been run.** No key was available during development, so the
request shape — `output_config`, the schema, the content blocks — is compile-verified only.
The CLI backend, by contrast, is verified end to end. The most likely first failure is a
400 on request shape.

## Possible next steps

Not committed to, in rough order of value:

- Run the API backend once and fix whatever the first 400 says.
- Constrain tags to those already in the vault, passed in the cached prefix, rather than
  free-form. Reduces tag sprawl.
- Move processed scans to `attachments/transcribed/` instead of leaving them in place.
- Reconsider overlap with the vault's existing `text-extractor` and `latex-ocr` plugins.
