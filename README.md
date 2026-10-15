<div align="center">

# Handwriting Transcribe

**Turn handwritten notes into structured, linked Obsidian notes with Claude.**

![Platform: Obsidian desktop](https://img.shields.io/badge/platform-Obsidian%20desktop-7c3aed?style=flat-square)
![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue?style=flat-square)

[Features](#features) · [Getting started](#getting-started) · [Usage](#usage) · [How it works](#how-it-works)

</div>

---

## Why Handwriting Transcribe?

Classic OCR is trained on print and fails on cursive. A vision model reads the handwriting and the structure of the page in one pass.

This plugin sends your photos, scans and Supernote notes to Claude. It writes back Markdown notes with real headings, lists, frontmatter, tags and `[[wikilinks]]` to notes that are already in your vault. It does not summarise. Words that it cannot read are marked `[?]`, so you can trust the text word for word.

## Features

### Transcription

- **Images and PDFs.** Supports `.png`, `.jpg`, `.gif`, `.webp` and scanned `.pdf` files.
- **Structured output.** Each note gets headings, lists, YAML frontmatter and topical tags.
- **Vault-aware links.** Wikilinks prefer the titles of notes that already exist.
- **Automatic filing.** The model puts each note in the most suitable folder of your vault.
- **Multiple notes per page.** One scan can become several notes if it holds several topics.
- **Preview before write.** Accept, retry with an extra instruction, or cancel.
- **Your preferences.** Free-text instructions are added to every transcription.

### Two backends

| | Anthropic API | Claude Code CLI |
| --- | --- | --- |
| Billing | API credits | Your Claude subscription |
| Auth | API key | Your existing `claude` login |
| Output shape | Enforced by a JSON schema | Requested in the prompt |

### Supernote import

- **Reads the Partner app mirror.** No device or cable is necessary.
- **Folder selection.** Choose which device folders to import, with or without subfolders.
- **Renders `.note` files to PDF** under `Supernote PDFs/`, with the device folder structure kept.
- **New files only.** The import sweep skips files that are already transcribed.

## Getting started

### Requirements

- Obsidian desktop 1.5.0 or later (the plugin is desktop-only)
- One of:
  - An [Anthropic API key](https://console.anthropic.com/)
  - [Claude Code](https://claude.com/claude-code), signed in with your subscription
- For Supernote import: the Supernote Partner app for macOS, and Python 3. The plugin can install `supernote-tool` for you.

### Install

The plugin is not in the community plugin list yet. Build it from source:

```bash
git clone https://github.com/Vapour38/obsidian-eink-scribe.git
cd obsidian-eink-scribe
npm install
npm run build
```

1. Copy `main.js`, `manifest.json` and `styles.css` to `<vault>/.obsidian/plugins/handwriting-transcribe/`.
2. In Obsidian, open **Settings → Community plugins** and enable **Handwriting Transcribe**.
3. Open the plugin settings and choose a backend.
4. For the API backend, enter your API key. For the CLI backend, the plugin finds `claude` automatically.

> [!NOTE]
> The API key is stored in plain text in the `data.json` file of the plugin, in your vault.

## Usage

| Action | Result |
| --- | --- |
| Command: **Transcribe active file** | Transcribe the open image or PDF |
| Right-click a file → **Transcribe handwriting** | Transcribe that file |
| Right-click a selection → **Transcribe N files** | Transcribe all selected files |
| Right-click a folder → **Transcribe N files in folder** | Transcribe every supported file in the folder and its subfolders |
| Command: **Sync Supernote notes** | Render new or changed `.note` files to PDF |
| Command: **Transcribe new PDFs in import folder** | Transcribe imported PDFs that do not have a note yet |
| Command: **Transcribe new PDFs without review** | The same, with the preview skipped |

## Configuration

| Setting | Purpose |
| --- | --- |
| Backend | Anthropic API or Claude Code CLI |
| Model | Haiku 5.5 (default), Sonnet 5.5, Opus 5.5, or a custom model ID |
| Effort | Reasoning effort. `low` is fastest and is enough for most pages |
| Preview before writing | Show each result before notes are created |
| Create stubs for unresolved links | Create empty notes for links that do not resolve |
| Transcription preferences | Extra instructions added to every prompt |
| Folders to import | Supernote device folders to sync |

## How it works

1. The plugin reads the input file. The API backend encodes it into the request. The CLI backend lets `claude` read it from disk.
2. Claude receives one shared system prompt, the titles of your notes, and your vault folders.
3. Claude returns one or more notes as JSON.
4. The plugin shows a preview, then creates the notes in the chosen folders.

The CLI backend runs `claude --print` with a replacement system prompt and safe mode. This keeps the cost of each call low and keeps your personal Claude Code config out of transcriptions.

See [design.md](design.md) for the design decisions and measured costs.

## Development

```bash
npm run dev    # rebuild main.js on change
npm run build  # type-check and build for production
```

Obsidian does not reload plugins on change. Run **Reload app without saving** after a rebuild.

## Licence

MIT. Copyright (c) 2026 Lachlan Dennis. See [LICENSE](LICENSE) for the full text.
