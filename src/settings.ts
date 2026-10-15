import { App, PluginSettingTab, Setting } from "obsidian";
import { resolveClaudeBinary } from "./claudeCode";
import { renderSetup } from "./onboarding";
import { renderSupernoteSection } from "./supernoteSettings";
import type { SyncFolder } from "./supernote";
import type HandwritingPlugin from "./main";

export type Backend = "api" | "claude-code";

/** Reasoning effort. Lower is faster; transcription rarely needs more than "low". */
export type Effort = "low" | "medium" | "high";

/** Measured figures from the most recent successful transcription. */
export interface LastRun {
	model: string;
	backend: Backend;
	/** Null when the backend does not report cost (the API backend). */
	costUsd: number | null;
	inputTokens: number | null;
	noteCount: number;
	/** ISO 8601. */
	at: string;
}

export interface HandwritingSettings {
	backend: Backend;
	apiKey: string;
	claudeCodePath: string;
	model: string;
	effort: Effort;
	previewBeforeWrite: boolean;
	createStubs: boolean;
	/** Supernote folders to import, and whether to descend into each. */
	importFolders: SyncFolder[];
	/** Partner-app mirror directory. Blank auto-detects. */
	supernoteRoot: string;
	/** supernote-tool binary. Blank auto-detects. */
	supernoteToolPath: string;
	/** Free-text preferences appended to every transcription prompt. */
	preferences: string;
	lastRun: LastRun | null;
}

export const DEFAULT_SETTINGS: HandwritingSettings = {
	backend: "api",
	apiKey: "",
	claudeCodePath: "",
	model: "claude-haiku-5-5",
	effort: "low",
	previewBeforeWrite: true,
	createStubs: false,
	importFolders: [],
	supernoteRoot: "",
	supernoteToolPath: "",
	preferences: "",
	lastRun: null,
};

/**
 * Where sync writes PDFs and where the auto-import commands sweep. Fixed rather
 * than configurable: the folder only ever holds this plugin's own imports, and
 * its subfolders mirror the Supernote device.
 */
export const IMPORT_FOLDER = "Supernote PDFs";

/** Offered in the model dropdown. Anything else is entered as a custom ID. */
const PRESET_MODELS = [
	{ id: "claude-haiku-5-5", label: "Haiku 5.5 (fastest, cheapest)" },
	{ id: "claude-sonnet-5-5", label: "Sonnet 5.5 (balanced)" },
	{ id: "claude-opus-5-5", label: "Opus 5.5 (most capable)" },
];

/** Sentinel dropdown value; never stored as a model ID. */
const CUSTOM_MODEL = "custom";

export class HandwritingSettingTab extends PluginSettingTab {
	plugin: HandwritingPlugin;

	/** UI-only, so it is deliberately not persisted to data.json. */
	private customModel = false;

	constructor(app: App, plugin: HandwritingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		if (renderSetup(containerEl, this.plugin, () => this.display())) {
			new Setting(containerEl).setName("Transcription").setHeading();
		}

		new Setting(containerEl)
			.setName("Backend")
			.setDesc("The API bills Anthropic credits. Claude Code uses your Claude subscription.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("api", "Anthropic API (API key)")
					.addOption("claude-code", "Claude Code CLI (subscription)")
					.setValue(this.plugin.settings.backend)
					.onChange(async (value) => {
						this.plugin.settings.backend = value as Backend;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.backend === "api") {
			new Setting(containerEl)
				.setName("Anthropic API key")
				.setDesc("Stored in plaintext in this plugin's data.json.")
				.addText((text) =>
					text
						.setPlaceholder("sk-ant-...")
						.setValue(this.plugin.settings.apiKey)
						.onChange(async (value) => {
							this.plugin.settings.apiKey = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		} else if (
			this.plugin.settings.claudeCodePath ||
			// The resolver falls back to the bare name when no install location matches.
			resolveClaudeBinary("") === "claude"
		) {
			new Setting(containerEl)
				.setName("Claude Code binary")
				.setDesc("Not found in the usual install locations. Enter its path.")
				.addText((text) =>
					text
						.setPlaceholder("auto-detect")
						.setValue(this.plugin.settings.claudeCodePath)
						.onChange(async (value) => {
							this.plugin.settings.claudeCodePath = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		// "custom" is a UI state, not a setting: any ID outside the list is custom by
		// definition. The flag only covers the moment between choosing custom and
		// typing an ID, when the saved model is still a listed one.
		const custom =
			this.customModel ||
			!PRESET_MODELS.some((preset) => preset.id === this.plugin.settings.model);

		new Setting(containerEl)
			.setName("Model")
			.setDesc(formatLastRun(this.plugin.settings.lastRun))
			.addDropdown((dropdown) => {
				for (const model of PRESET_MODELS) dropdown.addOption(model.id, model.label);
				dropdown.addOption(CUSTOM_MODEL, "Custom model ID…");
				dropdown
					.setValue(custom ? CUSTOM_MODEL : this.plugin.settings.model)
					.onChange(async (value) => {
						this.customModel = value === CUSTOM_MODEL;
						// Choosing custom leaves the current ID in place for the text
						// field below to edit, so the setting is never briefly invalid.
						if (!this.customModel) {
							this.plugin.settings.model = value;
							await this.plugin.saveSettings();
						}
						this.display();
					});
			});

		// Kept so a model released after this build is never locked out.
		if (custom) {
			new Setting(containerEl)
				.setName("Custom model ID")
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.model)
						.setValue(this.plugin.settings.model)
						.onChange(async (value) => {
							this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Effort")
			.setDesc("Raise it only if the layout is misread.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("low", "Low (fastest)")
					.addOption("medium", "Medium")
					.addOption("high", "High")
					.setValue(this.plugin.settings.effort)
					.onChange(async (value) => {
						this.plugin.settings.effort = value as Effort;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Preview before writing")
			.setDesc("Off: notes the model could not file go to the vault root.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.previewBeforeWrite)
					.onChange(async (value) => {
						this.plugin.settings.previewBeforeWrite = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Create stubs for unresolved links")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.createStubs).onChange(async (value) => {
					this.plugin.settings.createStubs = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Transcription preferences")
			.setDesc("Sent to the model with every transcription.")
			.setClass("handwriting-stacked")
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text
					.setPlaceholder("e.g. keep a full derivation in one note, never split it")
					.setValue(this.plugin.settings.preferences)
					.onChange(async (value) => {
						this.plugin.settings.preferences = value;
						await this.plugin.saveSettings();
					});
			});

		renderSupernoteSection(containerEl, this.plugin, () => this.display());
	}
}

/**
 * One line describing the most recent run. Cost and token count are omitted
 * rather than faked when a backend does not report them.
 */
export function formatLastRun(run: LastRun | null): string {
	if (!run) return "No transcription yet.";

	const backend = run.backend === "api" ? "Anthropic API" : "Claude Code CLI";

	const parts: string[] = [];
	if (run.costUsd !== null) parts.push(`$${run.costUsd.toFixed(4)}`);
	if (run.inputTokens !== null) {
		parts.push(`${run.inputTokens.toLocaleString()} input tokens`);
	}
	parts.push(`${run.noteCount} note${run.noteCount === 1 ? "" : "s"}`);

	const when = new Date(run.at).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});

	return `Last run: ${run.model} via ${backend} — ${parts.join(", ")} (${when}).`;
}
