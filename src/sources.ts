import { App, TFile, normalizePath } from "obsidian";
import { renderOcrHint } from "./prompt";

/** Content blocks we send to the Messages API. */
export type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
	  }
	| {
			type: "document";
			source: { type: "base64"; media_type: "application/pdf"; data: string };
	  };

export interface Source {
	blocks: ContentBlock[];
	/** Vault-relative path of the file being transcribed. */
	sourcePath: string;
	/** Supernote recognition sidecar text, when one was found. */
	ocrHint?: string | null;
}

/** The API accepts only these image types. HEIC in particular is not one. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** Request body cap is 32 MB; base64 inflates bytes by 4/3. */
const MAX_ENCODED_BYTES = 32 * 1024 * 1024;
const MAX_RAW_BYTES = Math.floor((MAX_ENCODED_BYTES * 3) / 4);

export function isSupported(file: TFile): boolean {
	const ext = file.extension.toLowerCase();
	return ext === "pdf" || ext in IMAGE_MEDIA_TYPES;
}

function assertSupportedFormat(file: TFile): void {
	if (isSupported(file)) return;
	throw new Error(
		`Cannot transcribe .${file.extension} files. Supported formats are PDF, PNG, ` +
			`JPEG, GIF, and WebP. Convert this file to JPEG or PNG first — HEIC and other ` +
			`formats are not accepted.`,
	);
}

/**
 * Validates the format and reads any sidecar, without encoding the file. The CLI
 * backend reads the file itself, so it needs neither the base64 payload nor the
 * API's 32 MB request limit applied to it.
 */
export async function buildSourceRef(app: App, file: TFile): Promise<Source> {
	assertSupportedFormat(file);
	const hint = file.extension.toLowerCase() === "pdf" ? await readSidecar(app, file) : null;
	return { blocks: [], sourcePath: file.path, ocrHint: hint };
}

/** The API backend's source: the file itself, base64-encoded into content blocks. */
export async function buildSource(app: App, file: TFile): Promise<Source> {
	assertSupportedFormat(file);

	const bytes = await app.vault.readBinary(file);
	assertUnderSizeLimit(bytes.byteLength, file.name);

	const ext = file.extension.toLowerCase();
	if (ext === "pdf") return buildPdfSource(app, file, bytes);

	return {
		sourcePath: file.path,
		blocks: [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: IMAGE_MEDIA_TYPES[ext],
					data: toBase64(bytes),
				},
			},
		],
	};
}

async function buildPdfSource(app: App, file: TFile, bytes: ArrayBuffer): Promise<Source> {
	const blocks: ContentBlock[] = [
		{
			type: "document",
			source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) },
		},
	];

	const hint = await readSidecar(app, file);
	if (hint) {
		blocks.push({ type: "text", text: renderOcrHint(hint) });
	}

	return { sourcePath: file.path, blocks, ocrHint: hint };
}

/**
 * Supernote exports a recognition sidecar alongside the PDF. We look for a .txt
 * with the same basename in the same folder.
 */
async function readSidecar(app: App, file: TFile): Promise<string | null> {
	const sidecarPath = normalizePath(
		`${file.parent?.path ? `${file.parent.path}/` : ""}${file.basename}.txt`,
	);
	const sidecar = app.vault.getAbstractFileByPath(sidecarPath);
	if (!(sidecar instanceof TFile)) return null;

	const text = (await app.vault.cachedRead(sidecar)).trim();
	return text.length > 0 ? text : null;
}

function assertUnderSizeLimit(byteLength: number, name: string): void {
	if (byteLength > MAX_RAW_BYTES) {
		const mb = (byteLength / (1024 * 1024)).toFixed(1);
		throw new Error(
			`${name} is ${mb} MB. After base64 encoding it exceeds the 32 MB request limit. ` +
				`Compress or split the file.`,
		);
	}
}

/** Desktop-only plugin, so Node's Buffer is available in the renderer. */
function toBase64(bytes: ArrayBuffer): string {
	return Buffer.from(bytes).toString("base64");
}

export async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (app.vault.getAbstractFileByPath(normalized)) return;
	await app.vault.createFolder(normalized).catch((err) => {
		// A concurrent create is fine; anything else is not.
		if (!String(err?.message ?? err).includes("already exists")) throw err;
	});
}

export async function uniquePath(app: App, path: string): Promise<string> {
	if (!app.vault.getAbstractFileByPath(path)) return path;

	const dot = path.lastIndexOf(".");
	const stem = dot === -1 ? path : path.slice(0, dot);
	const ext = dot === -1 ? "" : path.slice(dot);

	for (let n = 2; ; n++) {
		const candidate = `${stem} ${n}${ext}`;
		if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	}
}
