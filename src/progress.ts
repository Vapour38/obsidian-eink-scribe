import type { Plugin } from "obsidian";

function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Progress in the status bar rather than a Notice: a long batch must stay
 * visible after the user dismisses the notice, or a slow run is
 * indistinguishable from a hung one. Lives for the whole run, not per file.
 */
export class ProgressReporter {
	private el: HTMLElement | null = null;
	private timer: number | null = null;
	private startedAt = 0;
	private label = "";

	constructor(private plugin: Plugin) {}

	start(): void {
		this.el = this.plugin.addStatusBarItem();
		this.startedAt = Date.now();
		this.timer = window.setInterval(() => this.render(), 1000);
		// Registered so Obsidian clears the interval if the plugin unloads mid-run.
		this.plugin.registerInterval(this.timer);
		this.render();
	}

	update(label: string): void {
		this.label = label;
		this.render();
	}

	stop(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		this.el?.remove();
		this.el = null;
	}

	private render(): void {
		if (!this.el) return;
		const elapsed = formatElapsed(Date.now() - this.startedAt);
		this.el.setText(`⏳ ${this.label} · ${elapsed}`);
	}
}
