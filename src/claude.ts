import { requestUrl } from "obsidian";
import {
	FORMATTING_REMINDER,
	SYSTEM_PROMPT,
	renderPreferences,
	renderSourcePath,
	renderSubjectFolders,
	renderVaultTitles,
} from "./prompt";
import type { ContentBlock, Source } from "./sources";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 16000;

/**
 * Models that accept server-side refusal fallback. A safety-classifier false
 * positive on a page of notes is then re-run on another model instead of
 * failing. Haiku has no fallback, and an older custom ID may reject the field.
 */
const FALLBACK_MODELS = new Set([
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
	"claude-fable-5-1",
	"claude-fable-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface TranscribedNote {
	filename: string;
	title: string;
	date: string | null;
	tags: string[];
	/** Destination folder chosen by the model, or null when it could not route. */
	folder: string | null;
	body: string;
}

export interface TranscriptionResult {
	notes: TranscribedNote[];
	cacheReadTokens: number;
	/** Only reported by the CLI backend. */
	costUsd?: number;
	/**
	 * Total input tokens billed for the call, including cache reads and writes.
	 * Reported by both backends, but optional because the shape of the usage
	 * block is not guaranteed.
	 */
	inputTokens?: number;
}

/**
 * Built per request because the folder enum depends on the user's configured
 * folders. The enum is what makes an invalid destination structurally impossible
 * on this backend; the CLI backend has to validate after the fact instead.
 */
function buildOutputSchema(folders: string[]) {
	const folderProperty =
		folders.length > 0
			? {
					anyOf: [{ type: "string", enum: folders }, { type: "null" }],
					description: "One of the allowed folder paths, or null if unsure.",
				}
			: { type: "null", description: "No folders configured; always null." };

	return {
		type: "object",
		properties: {
			notes: {
				type: "array",
				items: {
					type: "object",
					properties: {
						filename: {
							type: "string",
							description: "Filename without extension or path.",
						},
						title: { type: "string" },
						date: {
							// anyOf rather than a type array: the structured-output schema
							// subset documents anyOf, but not multi-type declarations.
							anyOf: [{ type: "string" }, { type: "null" }],
							description: "YYYY-MM-DD if the page shows a date, otherwise null.",
						},
						tags: { type: "array", items: { type: "string" } },
						folder: folderProperty,
						body: {
							type: "string",
							description: "The note body in Markdown, without frontmatter.",
						},
					},
					required: ["filename", "title", "date", "tags", "folder", "body"],
					additionalProperties: false,
				},
			},
		},
		required: ["notes"],
		additionalProperties: false,
	};
}

export interface TranscribeOptions {
	apiKey: string;
	model: string;
	/** Reasoning effort; "low" is the fastest and is enough for transcription. */
	effort: string;
	source: Source;
	vaultTitles: string[];
	subjectFolders: string[];
	preferences: string;
	extraInstruction?: string;
}

export async function transcribe(
	options: TranscribeOptions,
): Promise<TranscriptionResult> {
	const { apiKey, model, source, vaultTitles, subjectFolders, preferences } = options;

	if (!apiKey) {
		throw new Error("No API key set. Add one in the E-Ink Scribe settings.");
	}

	// Stable prefix first, cached; the per-file image or PDF goes after the breakpoint.
	const prefix = [
		renderVaultTitles(vaultTitles),
		renderSubjectFolders(subjectFolders),
		renderPreferences(preferences),
	]
		.filter(Boolean)
		.join("\n\n");

	const system = [
		{ type: "text", text: SYSTEM_PROMPT },
		{
			type: "text",
			text: prefix,
			cache_control: { type: "ephemeral" },
		},
	];

	const content: ContentBlock[] = [...source.blocks];
	// After the cached prefix, never in it: this changes with every file.
	content.push({ type: "text", text: renderSourcePath(source.sourcePath) });
	if (options.extraInstruction?.trim()) {
		content.push({
			type: "text",
			text:
				"Additional instruction for this transcription: " +
				options.extraInstruction.trim(),
		});
	}
	content.push({
		type: "text",
		text:
			"Transcribe this source into one or more notes following the rules above.\n\n" +
			FORMATTING_REMINDER,
	});

	const fallback = FALLBACK_MODELS.has(model);
	const response = await requestUrl({
		url: API_URL,
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": API_VERSION,
			...(fallback && { "anthropic-beta": FALLBACK_BETA }),
		},
		body: JSON.stringify({
			model,
			max_tokens: MAX_TOKENS,
			...(fallback && { fallbacks: "default" }),
			output_config: {
				effort: options.effort,
				format: { type: "json_schema", schema: buildOutputSchema(subjectFolders) },
			},
			system,
			messages: [{ role: "user", content }],
		}),
		throw: false,
	});

	if (response.status !== 200) {
		throw new Error(describeApiError(response.status, response.text));
	}

	const payload = response.json;

	// stop_reason must be checked before content is read: on a refusal content is
	// empty, and on max_tokens the JSON is truncated and will not parse.
	if (payload.stop_reason === "refusal") {
		const category = payload.stop_details?.category ?? "unspecified";
		throw new Error(
			`Claude declined to transcribe this source (${category}). Nothing was written.`,
		);
	}
	if (payload.stop_reason === "max_tokens") {
		throw new Error(
			"The transcription was cut off at the output limit, so the result is incomplete " +
				"and was discarded. Try transcribing fewer pages at a time.",
		);
	}

	const text = payload.content?.find((b: { type: string }) => b.type === "text")?.text;
	if (!text) {
		throw new Error("The API returned no text content.");
	}

	let parsed: { notes?: TranscribedNote[] };
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("The API returned malformed JSON; nothing was written.");
	}

	const notes = (parsed.notes ?? []).filter((n) => n?.body?.trim());
	if (notes.length === 0) {
		throw new Error(
			`No readable handwriting was found in ${source.sourcePath.split("/").pop()}.`,
		);
	}

	const usage = payload.usage ?? {};
	return {
		notes,
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		inputTokens:
			(usage.input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0),
	};
}

function describeApiError(status: number, body: string): string {
	let detail = body.slice(0, 200);
	try {
		const parsed = JSON.parse(body);
		detail = [parsed?.error?.message, parsed?.request_id && `request ${parsed.request_id}`]
			.filter(Boolean)
			.join(" — ");
	} catch {
		// Not JSON; the raw prefix above is the best detail available.
	}

	// 401 is the one status worth naming, because the fix is in settings rather
	// than in the request. Everything else is reported as the API described it.
	const hint = status === 401 ? " Check the API key in settings." : "";
	return `API error ${status}${detail ? `: ${detail}` : ""}.${hint}`;
}
