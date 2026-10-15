import { App, TFile, normalizePath } from "obsidian";

/**
 * PDFs under `folder` that no note claims as its source.
 *
 * The vault is its own record of what has been transcribed: writeNotes stamps
 * `source: "<vault path>"` into every note's frontmatter, so a PDF is done
 * exactly when some note names it. Nothing else is stored, which means deleting
 * a transcription is how you ask for it to be redone, and a file that failed
 * mid-run is simply still untranscribed next time.
 *
 * The trade is that renaming or moving a PDF makes it look new. A ledger in
 * data.json would survive that but would drift out of sync with the vault in
 * every other respect.
 */
export function findUntranscribed(app: App, folder: string): TFile[] {
	const root = normalizePath(folder);
	const transcribed = transcribedSources(app);

	return app.vault
		.getFiles()
		.filter((file) => file.extension.toLowerCase() === "pdf")
		.filter((file) => isUnder(file.path, root))
		.filter((file) => !transcribed.has(file.path))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Read from the metadata cache rather than the files themselves — this runs over
 * every note in the vault, and reading them all from disk to check one
 * frontmatter field would make the command feel broken on a large vault.
 */
function transcribedSources(app: App): Set<string> {
	const sources = new Set<string>();

	for (const note of app.vault.getMarkdownFiles()) {
		const source = app.metadataCache.getFileCache(note)?.frontmatter?.source;
		if (typeof source === "string" && source.trim()) {
			sources.add(normalizePath(source.trim()));
		}
	}

	return sources;
}

/** Matches on a path boundary so "Scans 2025" is not treated as inside "Scans". */
export function isUnder(filePath: string, folder: string): boolean {
	if (folder === "" || folder === "/") return true;
	return filePath === folder || filePath.startsWith(`${folder}/`);
}
