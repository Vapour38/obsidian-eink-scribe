import { spawn } from "child_process";
import { accessSync, constants } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { TranscribedNote, TranscriptionResult } from "./claude";
import {
	CLI_TOOL_INSTRUCTION,
	FORMATTING_REMINDER,
	JSON_SHAPE_INSTRUCTION,
	SYSTEM_PROMPT,
	extractJson,
	renderOcrHint,
	renderPreferences,
	renderSourcePath,
	renderSubjectFolders,
	renderVaultTitles,
} from "./prompt";

/** A long scan can legitimately take minutes; past this something is wrong. */
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A GUI-launched Electron app inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:
 * /sbin), so `claude` is usually not on it even when it works in your terminal.
 * These are the standard install locations, checked in order.
 */
const CANDIDATE_PATHS = [
	`${homedir()}/.local/bin/claude`,
	`${homedir()}/.claude/local/claude`,
	"/opt/homebrew/bin/claude",
	"/usr/local/bin/claude",
];

export function resolveClaudeBinary(configured: string): string {
	if (configured.trim()) return configured.trim();

	for (const candidate of CANDIDATE_PATHS) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here; try the next.
		}
	}

	// Last resort: hope it is on PATH.
	return "claude";
}

/**
 * The CLI's Read tool rasterises PDFs with pdftoppm before the model ever sees
 * them, so without poppler a PDF cannot be read at all. Left to itself the model
 * does not give up on the failed Read — it retries and guesses at the file for
 * around a minute and a half before returning something largely invented. This
 * check turns that into an immediate, actionable failure. Images are unaffected.
 */
function assertCanReadPdfs(relativePath: string): void {
	if (!relativePath.toLowerCase().endsWith(".pdf") || canReadPdfs()) return;

	throw new Error(
		"Claude Code cannot read PDFs without poppler installed — it rasterises them " +
			"with pdftoppm. Run `brew install poppler` in a terminal and restart Obsidian, " +
			"or switch to the API backend, which sends the PDF directly.",
	);
}

/** True when pdftoppm (poppler) is installed, so the CLI's Read tool can open PDFs. */
export function canReadPdfs(): boolean {
	return PDFTOPPM_DIRS.some((dir) => {
		try {
			accessSync(join(dir, "pdftoppm"), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/** Same reasoning as CANDIDATE_PATHS: a GUI-launched app has almost no PATH. */
const PDFTOPPM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/**
 * Two adjustments to the inherited environment.
 *
 * PATH: finding pdftoppm ourselves is not enough — the CLI child is the process
 * that has to exec it, and it inherits Obsidian's minimal PATH. Without this an
 * installed poppler is still invisible to Read.
 *
 * MAX_THINKING_TOKENS: --effort low does NOT stop the model thinking. Measured
 * on a two-page PDF, it spent 131s and ~13.7k output tokens thinking to produce
 * 1.8k characters of answer; with thinking off the same file took 12.5s for the
 * same answer. Transcription is perception, so the thinking buys nothing. Note
 * the variable is effectively a switch, not a budget — setting it to 1024 was
 * slower still (208s), so only 0 is useful here.
 */
function buildEnv(env: NodeJS.ProcessEnv, effort: string): NodeJS.ProcessEnv {
	const existing = env.PATH ? env.PATH.split(":") : [];
	const merged = [...PDFTOPPM_DIRS.filter((d) => !existing.includes(d)), ...existing];
	const next: NodeJS.ProcessEnv = { ...env, PATH: merged.join(":") };

	// The escape hatch: raising Effort above low is what turns thinking back on.
	if (effort === "low") next.MAX_THINKING_TOKENS = "0";
	return next;
}

export interface ClaudeCodeOptions {
	binaryPath: string;
	model: string;
	/**
	 * Reasoning effort. Low is the default: measured against the same page, low
	 * finishes in two turns where medium and high take three, for no gain in a
	 * task that is perception rather than reasoning.
	 */
	effort?: string;
	/** Absolute path to the vault root; becomes the process working directory. */
	vaultRoot: string;
	/** Path of the file to transcribe, relative to the vault root. */
	relativePath: string;
	vaultTitles: string[];
	subjectFolders: string[];
	preferences: string;
	ocrHint?: string | null;
	extraInstruction?: string;
}

export async function transcribeWithClaudeCode(
	options: ClaudeCodeOptions,
): Promise<TranscriptionResult> {
	assertCanReadPdfs(options.relativePath);

	const prompt = buildPrompt(options);
	const binary = resolveClaudeBinary(options.binaryPath);
	const effort = options.effort ?? "low";

	const { stdout, stderr, code } = await run(
		binary,
		[
			"--print",
			"--output-format",
			"json",
			"--model",
			options.model,
			"--effort",
			effort,
			// Replaces the CLI's coding-agent system prompt, which is the bulk of the
			// ~25k-token per-invocation overhead. Measured 18,127 -> 1,286 input tokens.
			// SYSTEM_PROMPT is shared with the API backend; only the transport differs.
			"--system-prompt",
			`${SYSTEM_PROMPT}\n\n${CLI_TOOL_INSTRUCTION}`,
			// Send only Read's schema instead of Bash/Edit/Glob/Grep/Task/WebFetch/etc.
			"--tools",
			"Read",
			// Read is all it needs. Anything else is a bug or a prompt injection.
			// This flag is variadic, so it must not be followed by a positional
			// argument — the prompt goes in on stdin, which also keeps us clear of
			// the OS argument-length limit once vault titles are embedded.
			"--allowedTools",
			"Read",
			// Drops CLAUDE.md, skills, plugins, hooks and MCP servers from the user's
			// global config. Documented to keep auth and built-in tools working — it
			// is NOT --bare, which would break OAuth.
			"--safe-mode",
			"--no-session-persistence",
			"--disable-slash-commands",
		],
		options.vaultRoot,
		prompt,
		effort,
	);

	if (code !== 0) {
		// The whole of both streams, untruncated, because the thrown message is
		// capped and a Notice is not where you read 2 kB of CLI output.
		console.error(
			`[handwriting-transcribe] ${binary} exited ${code} on ${options.relativePath}\n` +
				`--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
		);
		throw new Error(describeSpawnFailure(code, stderr, stdout, binary));
	}

	let envelope: CliEnvelope;
	try {
		envelope = JSON.parse(stdout) as CliEnvelope;
	} catch {
		throw new Error(
			`Could not parse the Claude Code response. Output began: ${stdout.slice(0, 200)}`,
		);
	}

	if (envelope.is_error) {
		throw new Error(
			`Claude Code reported an error (${envelope.subtype ?? "unknown"}): ` +
				`${envelope.result ?? "no detail"}`,
		);
	}

	if (!envelope.result) {
		throw new Error("Claude Code returned an empty result.");
	}

	let parsed: { notes?: TranscribedNote[] };
	try {
		parsed = extractJson(envelope.result) as { notes?: TranscribedNote[] };
	} catch {
		throw new Error(
			"Claude Code did not return usable JSON. The CLI backend cannot enforce an " +
				"output schema, so this can happen; retrying often works. Response began: " +
				envelope.result.slice(0, 200),
		);
	}

	const notes = normalizeNotes(parsed.notes ?? [], options.subjectFolders);
	if (notes.length === 0) {
		throw new Error(`No readable handwriting was found in ${options.relativePath}.`);
	}

	const usage = envelope.usage ?? {};
	return {
		notes,
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		costUsd: envelope.total_cost_usd,
		inputTokens:
			(usage.input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0),
	};
}

/**
 * Goes in on stdin. Everything here is per-file or large: the vault titles alone
 * can exceed the OS argument-length limit.
 */
function buildPrompt(options: ClaudeCodeOptions): string {
	const parts = [
		renderVaultTitles(options.vaultTitles),
		"",
		renderSubjectFolders(options.subjectFolders),
		"",
		renderPreferences(options.preferences),
		"",
		renderSourcePath(options.relativePath),
		"",
		// Absolute, even though cwd is the vault root: given a relative path the
		// model frequently spends a whole turn replying that it needs the full
		// path instead of calling Read at all.
		`Read the file "${join(options.vaultRoot, options.relativePath)}" and transcribe ` +
			"it into one or more notes following the rules in your instructions.",
	];

	if (options.ocrHint) {
		parts.push("", renderOcrHint(options.ocrHint));
	}
	if (options.extraInstruction?.trim()) {
		parts.push(
			"",
			`Additional instruction for this transcription: ${options.extraInstruction.trim()}`,
		);
	}

	parts.push("", FORMATTING_REMINDER, "", JSON_SHAPE_INSTRUCTION);
	return parts.join("\n");
}

/** The model is not schema-constrained here, so coerce what it gives us. */
function normalizeNotes(raw: unknown[], allowedFolders: string[]): TranscribedNote[] {
	const allowed = new Set(allowedFolders);

	return raw
		.filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null)
		.map((n) => ({
			filename: String(n.filename ?? n.title ?? "Untitled transcription"),
			title: String(n.title ?? n.filename ?? "Untitled transcription"),
			date: typeof n.date === "string" && n.date.trim() ? n.date : null,
			tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
			// An unrecognised folder becomes null rather than a new vault folder:
			// null surfaces in the preview for the user to fix, a stray folder does not.
			folder: typeof n.folder === "string" && allowed.has(n.folder) ? n.folder : null,
			body: typeof n.body === "string" ? n.body : "",
		}))
		.filter((n) => n.body.trim().length > 0);
}

interface CliEnvelope {
	is_error?: boolean;
	subtype?: string;
	result?: string;
	total_cost_usd?: number;
	usage?: {
		input_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

function run(
	binary: string,
	args: string[],
	cwd: string,
	stdin: string,
	effort: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, args, {
			cwd,
			// Inherit the environment so OAuth/subscription credentials resolve.
			// Do NOT add --bare: it forces API-key auth and defeats the whole point.
			env: buildEnv(process.env, effort),
		});

		// The CLI warns if stdin is idle for 3s, so write immediately.
		child.stdin.write(stdin);
		child.stdin.end();

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			reject(
				new Error(
					`Claude Code did not finish within ${TIMEOUT_MS / 60000} minutes and was ` +
						"stopped. Try a smaller file.",
				),
			);
		}, TIMEOUT_MS);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(
				new Error(
					`Could not start Claude Code at "${binary}": ${err.message}. Set the ` +
						"correct path in settings.",
				),
			);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 0 });
		});
	});
}

/** The `result` field of a JSON envelope, which carries the reason on a failure. */
function resultMessage(stdout: string): string {
	try {
		const parsed = JSON.parse(stdout) as { result?: unknown };
		return typeof parsed.result === "string" ? parsed.result : "";
	} catch {
		// Not JSON: the caller falls back to the raw text.
		return "";
	}
}

function describeSpawnFailure(
	code: number,
	stderr: string,
	stdout: string,
	binary: string,
): string {
	// Failures arrive on stdout as often as on stderr: with --output-format json
	// the CLI reports the reason in the envelope's `result` and exits non-zero,
	// leaving stderr empty. Match on both or every such failure reads as a bare
	// exit code.
	const reported = `${stderr}\n${resultMessage(stdout)}`;
	const detail = (stderr.trim() || resultMessage(stdout) || stdout.trim()).slice(0, 300);

	if (
		/not logged in|authentication|unauthorized|please run.*login|oauth|could not be refreshed|failed to authenticate/i.test(
			reported,
		)
	) {
		return (
			"Claude Code could not authenticate — most often an expired login, which it " +
			"cannot renew on its own. Run `claude` in a terminal, sign in with /login, " +
			`then try again. It reported: ${detail}`
		);
	}
	if (/usage limit|rate limit/i.test(reported)) {
		return "Your Claude subscription usage limit was reached. Try again later.";
	}

	return (
		`Claude Code exited with code ${code} (${binary})` +
		(detail ? `: ${detail}` : ". It printed nothing; see the developer console.")
	);
}
