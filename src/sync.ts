import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Notice, TFile } from "obsidian";
import { IMPORT_FOLDER } from "./settings";
import { ProgressReporter } from "./progress";
import { ensureFolder } from "./sources";
import {
	convertNote,
	BLOCKED_MESSAGE,
	findMirrorRoot,
	mirrorBlocked,
	planSync,
	resolveSupernoteTool,
	supernoteToolInstalled,
} from "./supernote";
import type EinkScribePlugin from "./main";

/**
 * Renders every new or changed .note in the mapped Supernote folders into a
 * PDF under the import folder, mirroring the device's folder structure.
 *
 * A file is new when no PDF is at its target path, and changed when the .note
 * is newer than that PDF. Nothing else is recorded: the vault is the ledger,
 * the same contract findUntranscribed uses.
 */
export async function syncSupernote(plugin: EinkScribePlugin): Promise<void> {
	const root = findMirrorRoot(plugin.settings.supernoteRoot);
	if (!root) {
		new Notice(
			mirrorBlocked()
				? BLOCKED_MESSAGE
				: "No Supernote mirror found. Open Supernote Partner and let it sync once.",
			10000,
		);
		return;
	}
	if (!supernoteToolInstalled(plugin.settings.supernoteToolPath)) {
		new Notice(
			"supernote-tool is not installed. Install it from this plugin's settings.",
			10000,
		);
		return;
	}

	const folders = plugin.settings.importFolders.filter((entry) => entry.folder.trim());
	if (folders.length === 0) {
		new Notice(
			"No Supernote folders chosen. Pick one in this plugin's settings.",
			8000,
		);
		return;
	}

	const items = planSync(root, IMPORT_FOLDER, folders, (path, mtimeMs) => {
		const existing = plugin.app.vault.getAbstractFileByPath(path);
		return existing instanceof TFile && existing.stat.mtime >= mtimeMs;
	});
	if (items.length === 0) {
		new Notice("Every note in the chosen folders is already imported.", 5000);
		return;
	}

	const tool = resolveSupernoteTool(plugin.settings.supernoteToolPath);
	const progress = new ProgressReporter(plugin);
	progress.start();

	let imported = 0;
	const failed: string[] = [];
	try {
		for (const [index, item] of items.entries()) {
			const name = item.vaultPath.split("/").pop() ?? item.vaultPath;
			progress.update(`${index + 1}/${items.length} · ${name}`);
			try {
				await importNote(plugin, tool, item.notePath, item.vaultPath);
				imported++;
			} catch (err) {
				// One unreadable note must not abandon the rest of the sync.
				failed.push(name);
				console.error(`[eink-scribe] sync ${name}: ${message(err)}`);
			}
		}
	} finally {
		progress.stop();
	}

	const parts = [`Imported ${imported} PDF${imported === 1 ? "" : "s"}`];
	if (failed.length > 0) parts.push(`${failed.length} failed (see console)`);
	new Notice(parts.join(", "), 8000);
}

/**
 * Converts into the system temp directory and copies the result in through the
 * vault API. Writing to the vault path directly would leave Obsidian unaware
 * of the file until it happened to rescan, and the transcribe command that
 * follows reads the vault's own file list.
 */
async function importNote(
plugin: EinkScribePlugin,
tool: string,
notePath: string,
vaultPath: string,
): Promise<void> {
	const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const temp = join(tmpdir(), `eink-scribe-${unique}.pdf`);
	try {
		await convertNote(tool, notePath, temp);
		const parent = vaultPath.slice(0, vaultPath.lastIndexOf("/"));
		await ensureFolder(plugin.app, parent);
		// writeBinary rather than createBinary: a note that gained pages must
		// replace its PDF rather than fail.
		// A Buffer can be a view into Node's shared pool, so .buffer alone would
		// write whatever else the pool holds. Slice to the bytes actually read.
		const pdf = readFileSync(temp);
		await plugin.app.vault.adapter.writeBinary(
			vaultPath,
			pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer,
		);
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// Already gone, or never written because the conversion failed.
		}
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
