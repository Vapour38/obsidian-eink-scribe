import { App, Modal, Setting, TFile } from "obsidian";
import type { TranscribedNote } from "./claude";

export type PreviewResult =
	| { action: "accept"; notes: TranscribedNote[] }
	| { action: "retry"; instruction: string; preferences: string }
	| { action: "cancel" };

export interface PreviewContext {
	/** Folders the model was allowed to route into. Empty disables routing UI. */
	subjectFolders: string[];
	/** Current saved preferences, used to seed the per-run override field. */
	preferences: string;
}

/** A preview row: either a single transcribed note, or several merged into one. */
interface NoteGroup {
	/** The note as it will be written. */
	note: TranscribedNote;
	/** The originals, retained so a merge can be undone. Length 1 when unmerged. */
	parts: TranscribedNote[];
	include: boolean;
	selected: boolean;
}

function toGroups(notes: TranscribedNote[]): NoteGroup[] {
	return notes.map((note) => ({
		note: { ...note },
		parts: [{ ...note }],
		include: true,
		selected: false,
	}));
}

/**
 * Collapses the given rows into one, positioned where the earliest of them was.
 * Fewer than two valid indices is a no-op, so the caller can wire this straight
 * to a button without guarding.
 */
function mergeGroups(groups: NoteGroup[], indices: number[]): NoteGroup[] {
	const chosen = [...new Set(indices)]
		.filter((i) => i >= 0 && i < groups.length)
		.sort((a, b) => a - b);

	if (chosen.length < 2) return groups;

	const target = chosen[0];
	const merged = combine(chosen.map((i) => groups[i]));
	const chosenSet = new Set(chosen);

	const result: NoteGroup[] = [];
	groups.forEach((group, index) => {
		if (index === target) result.push(merged);
		else if (!chosenSet.has(index)) result.push(group);
	});

	return result;
}

/**
 * Restores a merged row to its original notes. A row that was never merged is
 * returned unchanged, so this is safe to call on anything.
 */
function splitGroup(groups: NoteGroup[], index: number): NoteGroup[] {
	const group = groups[index];
	if (!group || group.parts.length < 2) return groups;

	const restored: NoteGroup[] = group.parts.map((part) => ({
		note: { ...part },
		parts: [{ ...part }],
		include: group.include,
		selected: false,
	}));

	return [...groups.slice(0, index), ...restored, ...groups.slice(index + 1)];
}

function combine(groups: NoteGroup[]): NoteGroup {
	const first = groups[0];

	const tags: string[] = [];
	for (const group of groups) {
		for (const tag of group.note.tags) {
			if (!tags.includes(tag)) tags.push(tag);
		}
	}

	return {
		note: {
			filename: first.note.filename,
			title: first.note.title,
			date: first.note.date,
			folder: first.note.folder,
			tags,
			body: groups
				.map((group) => group.note.body.trim())
				.filter(Boolean)
				.join("\n\n"),
		},
		// Flattened, so merging an already-merged row keeps the full history and
		// a later split still returns the original individual notes.
		parts: groups.flatMap((group) => group.parts),
		include: first.include,
		selected: false,
	};
}

/**
 * Two panes: the scan on the left, the proposed notes on the right. Each note is
 * editable in place, can be excluded from the batch, can be routed to a folder,
 * and can be merged with its neighbours when the model split it wrongly.
 */
export class PreviewModal extends Modal {
	private result: PreviewResult = { action: "cancel" };
	private groups: NoteGroup[];
	private retryInstruction = "";
	private preferences: string;

	private notesPane: HTMLElement | null = null;
	private mergeButton: HTMLButtonElement | null = null;
	private splitButton: HTMLButtonElement | null = null;
	private createButton: HTMLButtonElement | null = null;
	private gateHint: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly sourceFile: TFile,
		notes: TranscribedNote[],
		private readonly context: PreviewContext,
		private readonly onDone: (result: PreviewResult) => void,
	) {
		super(app);
		this.groups = toGroups(notes);
		this.preferences = context.preferences;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("handwriting-preview-modal");
		contentEl.empty();

		contentEl.createEl("h2", {
			text: `Transcription of ${this.sourceFile.name}`,
		});

		const panes = contentEl.createDiv({ cls: "handwriting-panes" });
		this.renderSourcePane(panes.createDiv({ cls: "handwriting-source-pane" }));
		this.notesPane = panes.createDiv({ cls: "handwriting-notes-pane" });
		this.renderNotes();

		this.renderControls(contentEl);
		this.refreshControls();
	}

	private renderSourcePane(pane: HTMLElement): void {
		const url = this.app.vault.getResourcePath(this.sourceFile);

		if (this.sourceFile.extension.toLowerCase() === "pdf") {
			const frame = pane.createEl("iframe", { cls: "handwriting-source-frame" });
			frame.src = url;
		} else {
			const img = pane.createEl("img", { cls: "handwriting-source-image" });
			img.src = url;
		}
	}

	/** Full redraw: merging and splitting change the number of rows. */
	private renderNotes(): void {
		const pane = this.notesPane;
		if (!pane) return;
		pane.empty();

		this.groups.forEach((group, index) => {
			const card = pane.createDiv({ cls: "handwriting-note-card" });
			card.toggleClass("is-excluded", !group.include);
			card.toggleClass("is-unrouted", this.isUnrouted(group));

			const header = card.createDiv({ cls: "handwriting-card-header" });

			const select = header.createEl("input", { type: "checkbox" });
			select.checked = group.selected;
			select.title = "Select for merging";
			select.addEventListener("change", () => {
				group.selected = select.checked;
				this.refreshControls();
			});

			const include = header.createEl("input", { type: "checkbox" });
			include.checked = group.include;
			include.title = "Include this note";
			include.addEventListener("change", () => {
				group.include = include.checked;
				card.toggleClass("is-excluded", !group.include);
				card.toggleClass("is-unrouted", this.isUnrouted(group));
				this.refreshControls();
			});

			const heading = header.createDiv({ cls: "handwriting-card-heading" });
			heading.createDiv({
				cls: "handwriting-card-title",
				text: group.note.title || `Note ${index + 1}`,
			});
			heading.createDiv({
				cls: "handwriting-card-filename",
				text:
					`${group.note.filename}.md` +
					(group.parts.length > 1 ? ` · merged from ${group.parts.length}` : ""),
			});

			if (this.context.subjectFolders.length > 0) {
				this.renderDestination(header, group);
			}

			const textarea = card.createEl("textarea", {
				cls: "handwriting-note-body",
			});
			textarea.value = group.note.body;
			textarea.rows = 14;
			textarea.addEventListener("input", () => {
				group.note.body = textarea.value;
			});
		});
	}

	private renderDestination(header: HTMLElement, group: NoteGroup): void {
		const select = header.createEl("select", {
			cls: "dropdown handwriting-destination",
		});

		// Placeholder only exists while the note is unrouted, so a resolved note
		// cannot be put back into the unresolved state by accident.
		if (group.note.folder === null) {
			const placeholder = select.createEl("option", {
				text: "(choose a folder…)",
				value: "",
			});
			placeholder.disabled = true;
			placeholder.selected = true;
		}

		for (const folder of this.context.subjectFolders) {
			select.createEl("option", { text: folder, value: folder });
		}
		// The escape hatch for a note that fits none of the folders. The gate below
		// blocks creation until every note has one or the other.
		select.createEl("option", { text: "(vault root)", value: "/" });

		if (group.note.folder !== null) select.value = group.note.folder;

		select.addEventListener("change", () => {
			group.note.folder = select.value;
			this.renderNotes();
			this.refreshControls();
		});
	}

	private renderControls(container: HTMLElement): void {
		new Setting(container)
			.setName("Combine notes")
			.setDesc("Tick two or more notes to join them into one, in the order shown.")
			.addButton((button) => {
				this.mergeButton = button.buttonEl;
				button.setButtonText("Merge selected").onClick(() => {
					const indices = this.groups
						.map((group, index) => (group.selected ? index : -1))
						.filter((index) => index >= 0);
					this.groups = mergeGroups(this.groups, indices);
					this.renderNotes();
					this.refreshControls();
				});
			})
			.addButton((button) => {
				this.splitButton = button.buttonEl;
				button.setButtonText("Split back").onClick(() => {
					// Right to left, so earlier indices stay valid as rows are inserted.
					for (let index = this.groups.length - 1; index >= 0; index--) {
						if (this.groups[index].selected) {
							this.groups = splitGroup(this.groups, index);
						}
					}
					this.renderNotes();
					this.refreshControls();
				});
			});

		new Setting(container)
			.setName("Preferences for this retry")
			.setDesc("Overrides the saved preferences for the retry below only.")
			.addTextArea((text) => {
				text.inputEl.rows = 2;
				text.inputEl.style.width = "100%";
				text.setValue(this.preferences).onChange((value) => {
					this.preferences = value;
				});
			});

		new Setting(container)
			.setName("Retry instead")
			.setDesc("Transcribe again with an extra instruction, discarding the above.")
			.addText((text) =>
				text
					.setPlaceholder("e.g. the dates are in the left margin")
					.onChange((value) => {
						this.retryInstruction = value;
					}),
			)
			.addButton((button) =>
				button.setButtonText("Retry").onClick(() => {
					if (!this.retryInstruction.trim()) return;
					this.result = {
						action: "retry",
						instruction: this.retryInstruction,
						preferences: this.preferences,
					};
					this.close();
				}),
			);

		const footer = new Setting(container)
			.addButton((button) => {
				this.createButton = button.buttonEl;
				button
					.setButtonText("Create notes")
					.setCta()
					.onClick(() => {
						if (this.unroutedCount() > 0) return;
						this.result = {
							action: "accept",
							notes: this.groups.filter((g) => g.include).map((g) => g.note),
						};
						this.close();
					});
			})
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.result = { action: "cancel" };
					this.close();
				}),
			);

		this.gateHint = footer.descEl;
		this.gateHint.addClass("handwriting-gate-hint");
	}

	/** Only meaningful when routing is configured; otherwise nothing is unrouted. */
	private isUnrouted(group: NoteGroup): boolean {
		return (
			this.context.subjectFolders.length > 0 &&
			group.include &&
			group.note.folder === null
		);
	}

	private unroutedCount(): number {
		return this.groups.filter((group) => this.isUnrouted(group)).length;
	}

	private refreshControls(): void {
		const selected = this.groups.filter((group) => group.selected);

		if (this.mergeButton) {
			this.mergeButton.disabled = selected.length < 2;
			this.mergeButton.setText(
				selected.length >= 2 ? `Merge selected (${selected.length})` : "Merge selected",
			);
		}

		if (this.splitButton) {
			this.splitButton.disabled = !selected.some((group) => group.parts.length > 1);
		}

		const blocked = this.unroutedCount();
		if (this.createButton) this.createButton.disabled = blocked > 0;
		if (this.gateHint) {
			this.gateHint.setText(
				blocked > 0
					? `${blocked} note${blocked === 1 ? "" : "s"} need a destination.`
					: "",
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
		// Fires for the X button and Escape too, where result is still 'cancel'.
		this.onDone(this.result);
	}
}
