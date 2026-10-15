import { spawn } from "child_process";
import { accessSync, constants, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Reading .note files and converting them to PDF, with no dependency on
 * `obsidian`. Everything here runs under plain Node, which is what makes the
 * sync path testable outside the app — see the harness recipe in CLAUDE.md.
 * Vault writes deliberately live in sync.ts instead.
 */

/** Converting one file takes about a second; past this something is wrong. */
const CONVERT_TIMEOUT_MS = 60 * 1000;

/** Creating a venv and downloading a wheel is slow on a cold cache. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Where installSupernoteTool puts its venv. */
const VENV_DIR = join(homedir(), ".eink-scribe", "venv");

/**
 * The macOS Partner app keeps a full local mirror of the device here. The
 * account ID is a per-user directory name, so the parent is scanned rather than
 * hardcoded.
 */
const MIRROR_PARENT = join(
	homedir(),
	"Library/Containers/com.ratta.supernote/Data/Library",
	"Application Support/com.ratta.supernote",
);

/**
 * A GUI-launched Electron app inherits a minimal PATH, so a tool that works in
 * your terminal is usually not on it. Same reason as CANDIDATE_PATHS in
 * claudeCode.ts.
 */
const TOOL_CANDIDATES = [
	join(VENV_DIR, "bin/supernote-tool"),
	`${homedir()}/.local/bin/supernote-tool`,
	"/opt/homebrew/bin/supernote-tool",
	"/usr/local/bin/supernote-tool",
];

const PYTHON_CANDIDATES = [
	"/opt/homebrew/bin/python3",
	"/usr/local/bin/python3",
	"/usr/bin/python3",
];

/** A Supernote folder chosen for import, and how deep to walk it. */
export interface SyncFolder {
	/** Path relative to the mirror's `Note/` directory. ROOT_FOLDER means Note/ itself. */
	folder: string;
	/** Include the folder's subfolders. */
	recursive: boolean;
}

/**
 * The `Note/` directory itself. Notes saved on the device without being filed
 * land here, so it has to be selectable or those files can never be imported.
 */
export const ROOT_FOLDER = "/";

/** One .note file to convert, and where its PDF belongs in the vault. */
export interface SyncItem {
	/** Absolute path of the source .note file. */
	notePath: string;
	/** Vault-relative path of the PDF to write. */
	vaultPath: string;
	/** Modification time of the .note file. */
	mtimeMs: number;
}

/**
 * The mirror root — the directory holding `Supernote/Note`. Returns null when
 * the Partner app has never synced on this machine.
 *
 * The parent also holds `default`, `log` and `myscript` directories. They are
 * rejected by testing for the Note folder rather than by name, so a future
 * sibling does not need a new exclusion.
 */
export function findMirrorRoot(configured: string): string | null {
	const explicit = configured.trim();
	if (explicit) return isDirectory(join(explicit, "Note")) ? explicit : null;

	for (const entry of listDirectories(MIRROR_PARENT)) {
		const root = join(MIRROR_PARENT, entry, "Supernote");
		if (isDirectory(join(root, "Note"))) return root;
	}

	return null;
}

/** The container exists once the Partner app has run, even when it cannot be read. */
export function partnerAppInstalled(): boolean {
	return isDirectory(join(homedir(), "Library/Containers/com.ratta.supernote"));
}

/**
 * True when the Partner app's data exists but macOS denies reading it. The
 * container is protected app data, so Obsidian needs Full Disk Access.
 */
export function mirrorBlocked(): boolean {
	try {
		readdirSync(MIRROR_PARENT);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export const BLOCKED_MESSAGE =
	"macOS blocks access to the Supernote Partner data. Give Obsidian Full Disk Access " +
	"(System Settings → Privacy & Security), then restart Obsidian.";

/** Every folder under `Note/`, relative to it, sorted. Feeds the settings dropdown. */
export function listSupernoteFolders(root: string): string[] {
	const folders: string[] = [];

	const walk = (relative: string): void => {
		for (const entry of listDirectories(join(root, "Note", relative))) {
			const path = relative ? `${relative}/${entry}` : entry;
			folders.push(path);
			walk(path);
		}
	};
	walk("");

	return folders.sort((a, b) => a.localeCompare(b));
}

export function resolveSupernoteTool(configured: string): string {
	const explicit = configured.trim();
	if (explicit) return explicit;

	for (const candidate of TOOL_CANDIDATES) {
		if (isExecutable(candidate)) return candidate;
	}

	// Last resort: hope it is on PATH.
	return "supernote-tool";
}

/** True when the resolved tool is a file we can run, rather than a PATH guess. */
export function supernoteToolInstalled(configured: string): boolean {
	return isExecutable(resolveSupernoteTool(configured));
}

/**
 * Installs supernotelib into a private venv and returns the tool path. The venv
 * lives in the home directory, not the plugin folder: the plugin folder is a
 * symlink to the source checkout, and the install should survive a reinstall.
 */
export async function installSupernoteTool(): Promise<string> {
	const python = resolvePython();
	if (!python) {
		throw new Error(
			"No python3 found. Install Python 3 from python.org or Homebrew, then try again.",
		);
	}

	await run(python, ["-m", "venv", VENV_DIR], INSTALL_TIMEOUT_MS);
	await run(
		join(VENV_DIR, "bin/pip"),
		["install", "--disable-pip-version-check", "supernotelib"],
		INSTALL_TIMEOUT_MS,
	);

	const tool = join(VENV_DIR, "bin/supernote-tool");
	if (!isExecutable(tool)) {
		throw new Error(`Install finished but ${tool} is missing.`);
	}
	return tool;
}

function resolvePython(): string | null {
	for (const candidate of PYTHON_CANDIDATES) {
		if (isExecutable(candidate)) return candidate;
	}

	// The python.org installer versions its directory, so the name is not known.
	const versions = "/Library/Frameworks/Python.framework/Versions";
	for (const entry of listDirectories(versions).sort().reverse()) {
		const candidate = join(versions, entry, "bin/python3");
		if (isExecutable(candidate)) return candidate;
	}

	return null;
}

/**
 * The .note files in the chosen folders whose PDF is missing or older than the
 * source. Subfolders are visited only for a folder marked recursive.
 *
 * Which vault folder the transcription later lands in is not decided here — the
 * model does that. This only chooses what to import. `isCurrent` is the caller's
 * staleness test, so this function needs to know nothing about the vault.
 */
export function planSync(
	root: string,
	importFolder: string,
	folders: SyncFolder[],
	isCurrent: (vaultPath: string, mtimeMs: number) => boolean,
): SyncItem[] {
	const items: SyncItem[] = [];
	const seen = new Set<string>();

	for (const { folder, recursive } of folders) {
		const isRoot = folder === ROOT_FOLDER || folder === "";
		const base = isRoot ? join(root, "Note") : join(root, "Note", folder);
		const prefix = isRoot ? importFolder : `${importFolder}/${folder}`;

		const walk = (relative: string): void => {
			for (const entry of readEntries(relative ? join(base, relative) : base)) {
				const path = relative ? `${relative}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					if (recursive) walk(path);
					continue;
				}
				if (!entry.name.toLowerCase().endsWith(".note")) continue;

				const notePath = join(base, path);
				const vaultPath = `${prefix}/${path.slice(0, -".note".length)}.pdf`;
				// A folder and its parent can both be chosen, so the same file can be
				// reached twice. Convert it once.
				if (seen.has(vaultPath)) continue;
				seen.add(vaultPath);

				const mtimeMs = statSync(notePath).mtimeMs;
				if (isCurrent(vaultPath, mtimeMs)) continue;

				items.push({ notePath, vaultPath, mtimeMs });
			}
		};
		walk("");
	}

	return items.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
}

/**
 * Renders one .note into a single multi-page PDF.
 *
 * ponytail: files convert one at a time, with -j parallelising pages within a
 * file. A first sync of a few hundred notes takes minutes. Run several child
 * processes at once if that becomes a problem.
 */
export async function convertNote(
	tool: string,
	notePath: string,
	outPath: string,
): Promise<void> {
	await run(
		tool,
		["convert", "-t", "pdf", "-a", "-j", "4", notePath, outPath],
		CONVERT_TIMEOUT_MS,
	);
}

function run(binary: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args);

		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			reject(new Error(`${binary} did not finish within ${timeoutMs / 1000}s.`));
		}, timeoutMs);

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Could not start "${binary}": ${err.message}`));
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			const detail = stderr.trim().split("\n").slice(-3).join(" ");
			reject(new Error(`${binary} exited ${code}${detail ? `: ${detail}` : ""}`));
		});
	});
}

function readEntries(path: string) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		// A folder listed in settings can be renamed or removed on the device.
		return [];
	}
}

function listDirectories(path: string): string[] {
	return readEntries(path)
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
