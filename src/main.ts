import {
	FileSystemAdapter,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import {
	transcribe,
	type TranscribedNote,
	type TranscriptionResult,
} from "./claude";
import { findUntranscribed, isUnder } from "./autoImport";
import { transcribeWithClaudeCode } from "./claudeCode";
import { PreviewModal, type PreviewContext, type PreviewResult } from "./preview";
import { ProgressReporter } from "./progress";
import { syncSupernote } from "./sync";
import { buildSource, buildSourceRef, isSupported, type Source } from "./sources";
import {
	DEFAULT_SETTINGS,
	EinkScribeSettingTab,
	IMPORT_FOLDER,
	type EinkScribeSettings,
	type LastRun,
} from "./settings";
import { writeNotes, type WriteReport } from "./writer";

/**
 * How many files may be in flight at once. Each CLI-backend file is its own
 * child process, so this is a memory and rate-limit bound rather than a
 * throughput one.
 */
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

export default class EinkScribePlugin extends Plugin {
	settings: EinkScribeSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new EinkScribeSettingTab(this.app, this));

		this.addCommand({
			id: "transcribe-active-file",
			name: "Transcribe active file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isSupported(file)) return false;
				if (!checking) void this.run([file]);
				return true;
			},
		});

		this.addCommand({
			id: "sync-supernote",
			name: "Sync Supernote notes",
			callback: () => void syncSupernote(this),
		});

		this.addCommand({
			id: "transcribe-new-pdfs",
			name: "Transcribe new PDFs in import folder",
			callback: () => void this.runAutoImport(true),
		});

		this.addCommand({
			id: "transcribe-new-pdfs-no-review",
			name: "Transcribe new PDFs without review",
			callback: () => void this.runAutoImport(false),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFolder) {
					this.addFolderMenuItem(menu, file);
					return;
				}
				if (!(file instanceof TFile) || !isSupported(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Transcribe handwriting")
						.setIcon("scan-text")
						.onClick(() => void this.run([file])),
				);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
				const supported = files.filter(
					(f): f is TFile => f instanceof TFile && isSupported(f),
				);
				if (supported.length === 0) return;
				menu.addItem((item) =>
					item
						.setTitle(`Transcribe ${supported.length} files`)
						.setIcon("scan-text")
						.onClick(() => void this.run(supported)),
				);
			}),
		);
	}

	/**
	 * Right-clicking a folder transcribes everything under it, subfolders
	 * included. Unlike the import sweep this does not skip files already
	 * transcribed: asking for a folder explicitly is asking for all of it, and the
	 * count in the menu says how many that is.
	 */
	private addFolderMenuItem(menu: Menu, folder: TFolder): void {
		const files = this.app.vault
			.getFiles()
			.filter((file) => isUnder(file.path, folder.path) && isSupported(file))
			.sort((a, b) => a.path.localeCompare(b.path));
		if (files.length === 0) return;

		menu.addItem((item) =>
			item
				.setTitle(`Transcribe ${files.length} file${files.length === 1 ? "" : "s"} in folder`)
				.setIcon("scan-text")
				.onClick(() => void this.run(files)),
		);
	}

	/**
	 * Sweeps the import folder for PDFs no note claims as its source. With
	 * `review` false the run writes without previewing, which is the point of the
	 * second command — so the file count goes in the opening notice, there being
	 * no per-file cancel once it is going.
	 */
	private async runAutoImport(review: boolean): Promise<void> {
		const folder = IMPORT_FOLDER;

		if (!this.app.vault.getAbstractFileByPath(folder)) {
			new Notice(`Import folder "${folder}" does not exist.`, 8000);
			return;
		}

		const files = findUntranscribed(this.app, folder);
		if (files.length === 0) {
			new Notice(`No new PDFs to transcribe in "${folder}".`, 5000);
			return;
		}

		const plural = files.length === 1 ? "" : "s";
		if (!review) {
			new Notice(
				`Transcribing ${files.length} new PDF${plural} without review…`,
				8000,
			);
		}

		// Overridden for this run only, and restored in a finally so a failure
		// cannot leave the user's saved preference flipped. Never saved to disk.
		const previous = this.settings.previewBeforeWrite;
		this.settings.previewBeforeWrite = review && previous;
		try {
			await this.run(files);
		} finally {
			this.settings.previewBeforeWrite = previous;
		}
	}

	/**
	 * Results are consumed in order so the preview stays predictable, but the
	 * backend calls are started ahead of time: the slow part is one network round
	 * trip per file, so a batch that waits for each before starting the next is
	 * idle for almost all of its wall clock. The cap keeps a large batch from
	 * opening dozens of concurrent CLI processes or tripping rate limits.
	 */
	private async run(files: TFile[]): Promise<void> {
		const batch = files.length > 1;
		const totals: WriteReport = { created: [], stubs: [], failed: [] };
		const progress = new ProgressReporter(this);
		progress.start();

		const pending = new Map<number, Promise<TranscriptionResult>>();
		const titles = this.app.vault.getMarkdownFiles().map((f) => f.basename);
		const start = (index: number): void => {
			const file = files[index];
			if (!file || pending.has(index)) return;
			// Attach a catch immediately: the rejection is re-read at the await
			// below, but an in-flight promise nobody is awaiting yet would
			// otherwise surface as an unhandled rejection.
			const promise = this.startTranscription(file, titles);
			promise.catch(() => undefined);
			pending.set(index, promise);
		};
		for (let i = 0; i < MAX_CONCURRENT_TRANSCRIPTIONS; i++) start(i);

		try {
			for (const [index, file] of files.entries()) {
				const counter = batch ? `${index + 1}/${files.length} · ` : "";
				progress.update(`${counter}${file.name}`);
				const suffix = batch ? ` (${index + 1}/${files.length})` : "";
				const notice = new Notice(`Transcribing ${file.name}${suffix}…`, 0);

				try {
					start(index);
					const first = pending.get(index) as Promise<TranscriptionResult>;
					pending.delete(index);
					const notes = await this.transcribeFile(file, titles, first);
					// Only once this file's result is in hand: starting the next
					// transcription any earlier would run ahead of the preview the
					// user is still working through and waste calls if they cancel.
					start(index + MAX_CONCURRENT_TRANSCRIPTIONS);
					notice.hide();
					if (!notes) continue;

					const report = await writeNotes(this.app, notes, {
						createStubs: this.settings.createStubs,
						sourcePath: file.path,
					});
					totals.created.push(...report.created);
					totals.stubs.push(...report.stubs);
					totals.failed.push(...report.failed);
				} catch (err) {
					notice.hide();
					new Notice(`${file.name}: ${message(err)}`, 10000);
				}
			}
		} finally {
			progress.stop();
		}

		this.reportResults(totals);
	}

	/** Kicks off the first backend call for a file without awaiting its result. */
	private async startTranscription(
		file: TFile,
		titles: string[],
	): Promise<TranscriptionResult> {
		const source = await this.buildSourceFor(file);
		return this.callBackend(source, titles, undefined, this.settings.preferences);
	}

	/** The API backend needs the file encoded; the CLI backend reads it itself. */
	private buildSourceFor(file: TFile): Promise<Source> {
		return this.settings.backend === "api"
			? buildSource(this.app, file)
			: buildSourceRef(this.app, file);
	}

	/**
	 * Returns the notes to write, or null when the user cancelled. `first` is the
	 * already-running call from startTranscription; retries after it re-enter the
	 * backend here, since they depend on what the user typed in the preview.
	 */
	private async transcribeFile(
		file: TFile,
		titles: string[],
		first: Promise<TranscriptionResult>,
	): Promise<TranscribedNote[] | null> {
		let pending: Promise<TranscriptionResult> | null = first;
		let source: Source | null = null;

		let instruction: string | undefined;
		let preferences = this.settings.preferences;
		for (;;) {
			// Built lazily and only on a retry: the first call already has its own
			// copy, and for the API backend building it means base64-encoding the
			// whole file again.
			if (!pending && !source) source = await this.buildSourceFor(file);
			const result = await (pending ??
				this.callBackend(
					source as Source,
					titles,
					instruction,
					preferences,
				));
			pending = null;
			console.debug(
				`[eink-scribe] ${file.name}: ${result.notes.length} notes, ` +
					`${result.cacheReadTokens} cached input tokens` +
					(result.costUsd !== undefined
						? `, $${result.costUsd.toFixed(4)} equivalent`
						: ""),
			);

			// Recorded before the preview: the cost was incurred whether or not the
			// user accepts the result.
			const lastRun: LastRun = {
				model: this.settings.model,
				backend: this.settings.backend,
				costUsd: result.costUsd ?? null,
				inputTokens: result.inputTokens ?? null,
				noteCount: result.notes.length,
				at: new Date().toISOString(),
			};
			this.settings.lastRun = lastRun;
			void this.saveSettings();

			if (!this.settings.previewBeforeWrite) return result.notes;

			const choice = await this.preview(file, result.notes, {
				subjectFolders: this.vaultFolders(),
				preferences,
			});
			if (choice.action === "accept") {
				return choice.notes.length > 0 ? choice.notes : null;
			}
			if (choice.action === "cancel") return null;
			instruction = choice.instruction;
			preferences = choice.preferences;
		}
	}

	/**
	 * Every folder the model may route a note into: the vault's own folders, minus
	 * the import folder, whose subtree only mirrors the device and holds no notes.
	 * Derived rather than configured, so a folder added in Obsidian is available
	 * immediately and can never be a typo.
	 */
	private vaultFolders(): string[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder)
			.map((folder) => folder.path)
			.filter((path) => path !== "/" && !isUnder(path, IMPORT_FOLDER))
			.sort((a, b) => a.localeCompare(b));
	}

	private callBackend(
		source: Source,
		titles: string[],
		instruction: string | undefined,
		preferences: string,
	): Promise<TranscriptionResult> {
		const folders = this.vaultFolders();

		if (this.settings.backend === "api") {
			return transcribe({
				apiKey: this.settings.apiKey,
				model: this.settings.model,
				effort: this.settings.effort,
				source,
				vaultTitles: titles,
				subjectFolders: folders,
				preferences,
				extraInstruction: instruction,
			});
		}

		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error(
				"The Claude Code backend needs a vault stored on disk. Use the API backend.",
			);
		}

		return transcribeWithClaudeCode({
			binaryPath: this.settings.claudeCodePath,
			model: this.settings.model,
			effort: this.settings.effort,
			vaultRoot: adapter.getBasePath(),
			relativePath: source.sourcePath,
			vaultTitles: titles,
			subjectFolders: folders,
			preferences,
			ocrHint: source.ocrHint,
			extraInstruction: instruction,
		});
	}

	private preview(
		file: TFile,
		notes: TranscribedNote[],
		context: PreviewContext,
	): Promise<PreviewResult> {
		return new Promise((resolve) => {
			new PreviewModal(this.app, file, notes, context, resolve).open();
		});
	}

	private reportResults(report: WriteReport): void {
		if (report.created.length === 0 && report.failed.length === 0) return;

		const parts = [`Created ${report.created.length} note(s)`];
		if (report.stubs.length > 0) parts.push(`${report.stubs.length} stub(s)`);
		if (report.failed.length > 0) parts.push(`${report.failed.length} failed`);
		new Notice(parts.join(", "), 8000);

		for (const failure of report.failed) {
			console.error(
				`[eink-scribe] could not write "${failure.filename}": ${failure.reason}`,
			);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Routing and the two folders are no longer configured. Left in place these
		// would be copied forward on every save, outliving the code that read them.
		// data.json is rewritten only if one was actually present.
		let migrated = false;
		const stored = this.settings as unknown as Record<string, unknown>;
		for (const dead of [
			"importFolder",
			"outputFolder",
			"subjectFolders",
			"folderMappings",
		]) {
			if (dead in stored) {
				delete stored[dead];
				migrated = true;
			}
		}

		if (migrated) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
