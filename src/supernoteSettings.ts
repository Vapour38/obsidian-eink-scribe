import {
	DropdownComponent,
	ExtraButtonComponent,
	Notice,
	Setting,
	ToggleComponent,
} from "obsidian";
import {
	findMirrorRoot,
	mirrorBlocked,
	installSupernoteTool,
	listSupernoteFolders,
	resolveSupernoteTool,
	ROOT_FOLDER,
	supernoteToolInstalled,
} from "./supernote";
import { IMPORT_FOLDER } from "./settings";
import { syncSupernote } from "./sync";
import type HandwritingPlugin from "./main";

/**
 * The Supernote half of the settings tab. Split out of settings.ts to keep that
 * file within its size limit; `redraw` is the tab's own display(), called when a
 * path changes, since what the section shows depends on what resolves.
 */

export function renderSupernoteSection(
	containerEl: HTMLElement,
	plugin: HandwritingPlugin,
	redraw: () => void,
): void {
	new Setting(containerEl).setName("Supernote").setHeading();

	// Shown only when auto-detect fails or a path was entered by hand.
	const root = findMirrorRoot(plugin.settings.supernoteRoot);
	if (!root || plugin.settings.supernoteRoot) {
		new Setting(containerEl)
			.setName("Partner app mirror")
			.setDesc(
				root
					? `Found: ${root}`
					: mirrorBlocked()
						? "Blocked by macOS. See Setup at the top of this tab."
						: "Not found. Let Supernote Partner sync once, or enter the folder that contains Note/.",
			)
			.addText((text) =>
				text
					.setPlaceholder("auto-detect")
					.setValue(plugin.settings.supernoteRoot)
					.onChange(async (value) => {
						plugin.settings.supernoteRoot = value.trim();
						await plugin.saveSettings();
						redraw();
					}),
			);
	}

	renderConverter(containerEl, plugin, redraw);

	const heading = new Setting(containerEl)
		.setName("Folders to import")
		.setDesc("The model chooses where each transcription goes in the vault.");
	// The rows below belong to this heading, so it must not close itself off.
	heading.settingEl.addClass("handwriting-list-heading");
	renderFolderList(containerEl, plugin, redraw);

	new Setting(containerEl)
		.setName("Sync now")
		.setDesc(`Render new or changed notes to PDFs under ${IMPORT_FOLDER}/.`)
		.addButton((button) =>
			button.setButtonText("Sync").onClick(() => void syncSupernote(plugin)),
		);
}

function renderConverter(
	containerEl: HTMLElement,
	plugin: HandwritingPlugin,
	redraw: () => void,
): void {
	// Installing is a Setup step, so this row is only for a path entered by hand.
	if (!plugin.settings.supernoteToolPath) return;
	const installed = supernoteToolInstalled(plugin.settings.supernoteToolPath);

	new Setting(containerEl)
		.setName("Converter")
		.setDesc(
			installed
				? `Found: ${resolveSupernoteTool(plugin.settings.supernoteToolPath)}`
				: "Nothing runnable at this path. Clear it to auto-detect.",
		)
		.addText((text) =>
			text
				.setPlaceholder("auto-detect")
				.setValue(plugin.settings.supernoteToolPath)
				.onChange(async (value) => {
					plugin.settings.supernoteToolPath = value.trim();
					await plugin.saveSettings();
					redraw();
				}),
		);
}

export function addInstallButton(setting: Setting, redraw: () => void): void {
	setting.addButton((button) =>
		button
			.setButtonText("Install")
			.setCta()
			.onClick(async () => {
				button.setDisabled(true).setButtonText("Installing…");
				try {
					// Auto-detect checks the install location, so no path is saved.
					await installSupernoteTool();
					new Notice("supernote-tool installed.", 5000);
				} catch (err) {
					new Notice(`Install failed: ${message(err)}`, 10000);
				}
				redraw();
			}),
	);
}

/**
 * One row per chosen folder. A folder is picked from what the mirror actually
 * holds rather than typed, so a row can never name a folder that is not there.
 *
 * Built from the components directly rather than from `Setting`, which lays out
 * a labelled row and pushes unlabelled controls to the far right, away from the
 * heading they belong to.
 */
function renderFolderList(
	containerEl: HTMLElement,
	plugin: HandwritingPlugin,
	redraw: () => void,
): void {
	const chosen = plugin.settings.importFolders;
	const root = findMirrorRoot(plugin.settings.supernoteRoot);
	const available = root ? listSupernoteFolders(root) : [];

	const list = containerEl.createDiv({ cls: "handwriting-folder-list" });

	if (chosen.length === 0) {
		list.createDiv({
			cls: "handwriting-folder-empty",
			text: root
				? "No folders chosen. Nothing will sync."
				: "No mirror found, so there are no folders to choose from.",
		});
	}

	for (const [index, entry] of chosen.entries()) {
		const row = list.createDiv({ cls: "handwriting-folder-row" });

		const dropdown = new DropdownComponent(row);
		dropdown.addOption("", "(choose a folder…)");
		// Notes saved without being filed sit in Note/ itself.
		dropdown.addOption(ROOT_FOLDER, "Top level (unfiled notes)");
		// A folder renamed on the device would otherwise vanish from its row
		// without the user being told which one was lost.
		for (const option of withCurrent(available, entry.folder)) {
			dropdown.addOption(option, option);
		}
		dropdown.setValue(entry.folder).onChange(async (value) => {
			entry.folder = value;
			await plugin.saveSettings();
		});

		const subfolders = row.createDiv({ cls: "handwriting-folder-toggle" });
		subfolders.createSpan({ text: "Subfolders" });
		new ToggleComponent(subfolders)
			.setTooltip("Include this folder's subfolders")
			.setValue(entry.recursive)
			.onChange(async (value) => {
				entry.recursive = value;
				await plugin.saveSettings();
			});

		new ExtraButtonComponent(row)
			.setIcon("x")
			.setTooltip("Remove this folder")
			.onClick(async () => {
				chosen.splice(index, 1);
				await plugin.saveSettings();
				redraw();
			});
	}

	const footer = list.createDiv({ cls: "handwriting-folder-add" });
	new ExtraButtonComponent(footer).setIcon("plus").setTooltip("Add a folder");
	footer.createSpan({ text: "Add folder" });
	footer.addEventListener("click", async () => {
		chosen.push({ folder: "", recursive: false });
		await plugin.saveSettings();
		redraw();
	});
}

/** Keeps a stored value selectable even when it is no longer in the live list. */
function withCurrent(options: string[], current: string): string[] {
	if (!current || options.includes(current)) return options;
	return [current, ...options];
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
