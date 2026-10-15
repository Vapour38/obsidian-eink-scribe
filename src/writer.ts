import { App, TFile, normalizePath } from "obsidian";
import type { TranscribedNote } from "./claude";
import { ensureFolder, uniquePath } from "./sources";

export interface WriteReport {
	created: string[];
	stubs: string[];
	failed: { filename: string; reason: string }[];
}

export interface WriteOptions {
	createStubs: boolean;
	/** Vault path of the scan, embedded at the foot of each note. */
	sourcePath: string;
}

export async function writeNotes(
	app: App,
	notes: TranscribedNote[],
	options: WriteOptions,
): Promise<WriteReport> {
	const report: WriteReport = { created: [], stubs: [], failed: [] };

	// Create each distinct destination once rather than per note. The vault root
	// is the fallback for a note nothing could route, and it always exists.
	const destinations = new Set(notes.map((note) => note.folder).filter(isFolder));
	for (const destination of destinations) {
		await ensureFolder(app, destination);
	}

	for (const note of notes) {
		try {
			const name = sanitizeFilename(note.filename || note.title);
			const path = await uniquePath(app, notePath(note.folder, name));
			await app.vault.create(path, renderNote(note, options.sourcePath));
			report.created.push(path);
		} catch (err) {
			// One bad note must not abandon the rest of the batch.
			report.failed.push({
				filename: note.filename || note.title,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	if (options.createStubs) {
		report.stubs = await createStubs(app, notes);
	}

	return report;
}

/** Null and the vault root both mean "no folder", and neither is created. */
function isFolder(folder: string | null): folder is string {
	return folder !== null && folder !== "" && folder !== "/";
}

function notePath(folder: string | null, name: string): string {
	return isFolder(folder)
		? normalizePath(`${folder}/${name}.md`)
		: normalizePath(`${name}.md`);
}

export function renderNote(note: TranscribedNote, sourcePath: string): string {
	const frontmatter = [
		"---",
		`title: ${yamlScalar(note.title)}`,
		`date: ${note.date ? yamlScalar(note.date) : "null"}`,
		`tags: [${note.tags.map((t) => yamlScalar(t)).join(", ")}]`,
		`source: ${yamlScalar(sourcePath)}`,
		"---",
		"",
	].join("\n");

	const sourceName = sourcePath.split("/").pop() ?? sourcePath;
	const footer = `\n\n---\n\nSource: ![[${sourceName}]]\n`;

	return frontmatter + note.body.trim() + footer;
}

/**
 * Obsidian rejects these in filenames. Also strips leading dots so notes cannot
 * become hidden files.
 */
export function sanitizeFilename(raw: string): string {
	const cleaned = raw
		.replace(/[/\\:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "")
		.slice(0, 180);

	return cleaned.length > 0 ? cleaned : "Untitled transcription";
}

/** Wikilink targets, ignoring embeds and stripping any |alias or #heading. */
export function extractLinks(markdown: string): string[] {
	const links = new Set<string>();
	const pattern = /(!)?\[\[([^\]]+)\]\]/g;

	for (const match of markdown.matchAll(pattern)) {
		if (match[1]) continue; // embed, not a link
		const target = match[2].split("|")[0].split("#")[0].trim();
		if (target) links.add(target);
	}

	return [...links];
}

/** Stubs go to the vault root, where a wikilink resolves from anywhere. */
async function createStubs(app: App, notes: TranscribedNote[]): Promise<string[]> {
	const existing = new Set(
		app.vault.getMarkdownFiles().map((f: TFile) => f.basename.toLowerCase()),
	);
	// Notes written in this batch are resolvable too.
	for (const note of notes) {
		existing.add(sanitizeFilename(note.filename || note.title).toLowerCase());
	}

	const created: string[] = [];
	for (const note of notes) {
		for (const link of extractLinks(note.body)) {
			const name = sanitizeFilename(link);
			if (existing.has(name.toLowerCase())) continue;
			existing.add(name.toLowerCase());

			const path = normalizePath(`${name}.md`);
			if (app.vault.getAbstractFileByPath(path)) continue;

			await app.vault.create(path, "");
			created.push(path);
		}
	}
	return created;
}

function yamlScalar(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
