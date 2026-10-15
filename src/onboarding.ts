import { execFile } from "child_process";
import { Notice, Setting } from "obsidian";
import { canReadPdfs, resolveClaudeBinary } from "./claudeCode";
import {
	BLOCKED_MESSAGE,
	findMirrorRoot,
	mirrorBlocked,
	partnerAppInstalled,
	supernoteToolInstalled,
} from "./supernote";
import { addInstallButton } from "./supernoteSettings";
import type EinkScribePlugin from "./main";

const POPPLER_COMMAND = "brew install poppler";

/** macOS offers to relaunch Obsidian once access is granted here. */
const FULL_DISK_ACCESS_PANE =
	"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/**
 * The unfinished setup steps, at the top of the settings tab. Each step shows
 * only while it is not done, and the section disappears when all are done.
 * Supernote steps appear only when the Partner app is installed. Returns true
 * when it rendered anything.
 */
export function renderSetup(
	containerEl: HTMLElement,
	plugin: EinkScribePlugin,
	redraw: () => void,
): boolean {
	const { settings } = plugin;
	const steps: ((el: HTMLElement) => Setting)[] = [];

	if (settings.backend === "api") {
		if (!settings.apiKey) {
			steps.push((el) =>
				new Setting(el)
					.setName("Add an API key")
					.setDesc("Enter it in the Anthropic API key field below.")
					.addButton((button) =>
						button
							.setButtonText("Get a key")
							.onClick(() => window.open("https://console.anthropic.com/settings/keys")),
					),
			);
		}
	} else {
		// The resolver falls back to the bare name when no install location matches.
		if (!settings.claudeCodePath && resolveClaudeBinary("") === "claude") {
			steps.push((el) =>
				new Setting(el)
					.setName("Install Claude Code")
					.setDesc("Install it, sign in once in a terminal, then reopen this tab.")
					.addButton((button) =>
						button
							.setButtonText("Install guide")
							.onClick(() => window.open("https://docs.claude.com/en/docs/claude-code/setup")),
					),
			);
		}
		if (!canReadPdfs()) {
			steps.push((el) =>
				new Setting(el)
					.setName("Install poppler for PDFs")
					.setDesc(`Claude Code needs it to read PDFs. Run ${POPPLER_COMMAND} in a terminal.`)
					.addButton((button) =>
						button.setButtonText("Copy command").onClick(async () => {
							await navigator.clipboard.writeText(POPPLER_COMMAND);
							new Notice("Copied.", 3000);
						}),
					),
			);
		}
	}

	if (partnerAppInstalled()) {
		const root = findMirrorRoot(settings.supernoteRoot);
		if (!root && mirrorBlocked()) {
			steps.push((el) =>
				new Setting(el)
					.setName("Allow access to Supernote data")
					.setDesc(BLOCKED_MESSAGE)
					.addButton((button) =>
						button
							.setButtonText("Open Full Disk Access")
							.setCta()
							.onClick(() => execFile("open", [FULL_DISK_ACCESS_PANE])),
					),
			);
		} else if (!root) {
			steps.push((el) =>
				new Setting(el)
					.setName("Sync Supernote Partner")
					.setDesc("Open Supernote Partner and let it sync once, then reopen this tab."),
			);
		}

		if (!supernoteToolInstalled(settings.supernoteToolPath)) {
			steps.push((el) => {
				const step = new Setting(el)
					.setName("Install the converter")
					.setDesc("supernote-tool renders .note files to PDF.");
				addInstallButton(step, redraw);
				return step;
			});
		}

		if (root && !settings.importFolders.some((entry) => entry.folder)) {
			steps.push((el) =>
				new Setting(el)
					.setName("Choose folders to import")
					.setDesc("Add them under Folders to import below."),
			);
		}
	}

	if (steps.length === 0) return false;

	new Setting(containerEl)
		.setName(`Setup: ${steps.length} step${steps.length === 1 ? "" : "s"} left`)
		.setHeading();
	for (const step of steps) step(containerEl);
	return true;
}
