import { strict as assert } from "assert";
import { statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
	convertNote,
	findMirrorRoot,
	listSupernoteFolders,
	planSync,
	ROOT_FOLDER,
	resolveSupernoteTool,
	supernoteToolInstalled,
} from "/Users/lachlan/Desktop/obsidian/src/supernote";

/** Counted independently of planSync, so the walk cannot silently lose files. */
function noteCount(root: string): number {
	const out = execFileSync("/usr/bin/find", [`${root}/Note`, "-name", "*.note"], {
		encoding: "utf8",
	});
	return out.trim().split("\n").filter(Boolean).length;
}

// Whatever the plugin itself would use, so this checks the real resolution path.
const TOOL = resolveSupernoteTool("");

async function main() {
	const root = findMirrorRoot("");
	assert.ok(root, "mirror root not found");
	assert.ok(root!.includes("634497799872040960"), `picked wrong account dir: ${root}`);
	assert.ok(!root!.includes("/default/"), "picked the default dir");
	console.log("root:", root);

	const SUBJECT = "2026/Mathematical Physics";
	const plan = (folders: { folder: string; recursive: boolean }[], current = () => false) =>
		planSync(root!, "Supernote PDFs", folders, current);

	const folders = listSupernoteFolders(root!);
	assert.ok(folders.includes(SUBJECT), "missing known folder");
	assert.ok(folders.includes(`${SUBJECT}/Problem Sets`), "nested folder not offered");
	console.log("folders offered:", folders.length);

	// Switch off: the folder's own notes, and nothing from its subfolders.
	const shallow = plan([{ folder: SUBJECT, recursive: false }]);
	const shallowPaths = shallow.map((i) => i.vaultPath);
	assert.ok(
		shallowPaths.includes(`Supernote PDFs/${SUBJECT}/Week 1.pdf`),
		`unexpected targets: ${shallowPaths.slice(0, 3)}`,
	);
	assert.ok(
		shallowPaths.every((p) => !p.includes("/Problem Sets/")),
		`a subfolder leaked in with the switch off: ${shallowPaths}`,
	);
	console.log("switch off:", shallow.length, shallowPaths.map((p) => p.split("/").pop()));

	// Switch on: the subfolder notes appear, and the shallow ones are still there.
	const deep = plan([{ folder: SUBJECT, recursive: true }]);
	const deepPaths = deep.map((i) => i.vaultPath);
	assert.ok(
		deepPaths.includes(`Supernote PDFs/${SUBJECT}/Problem Sets/Set 1.pdf`),
		"subfolder note missing with the switch on",
	);
	assert.ok(deep.length > shallow.length, "the switch changed nothing");
	assert.ok(
		shallowPaths.every((p) => deepPaths.includes(p)),
		"the switch lost a file the shallow walk found",
	);
	console.log("switch on:", deep.length);

	// Unchosen folders stay out entirely.
	assert.ok(
		!deepPaths.some((p) => p.includes("2024/")),
		"a folder nobody chose was imported",
	);

	// A folder and its parent both chosen: each file planned once.
	const overlap = plan([
		{ folder: SUBJECT, recursive: true },
		{ folder: `${SUBJECT}/Problem Sets`, recursive: false },
	]);
	assert.equal(overlap.length, deep.length, "overlapping folders duplicated a file");
	assert.equal(
		new Set(overlap.map((i) => i.vaultPath)).size,
		overlap.length,
		"duplicate target path",
	);

	// The top level holds the notes that were never filed on the device, and its
	// targets sit directly under the import folder rather than in a subfolder.
	const unfiled = plan([{ folder: ROOT_FOLDER, recursive: false }]);
	assert.ok(unfiled.length > 0, "no unfiled notes found at the device top level");
	assert.ok(
		unfiled.every((i) => !i.vaultPath.slice("Supernote PDFs/".length).includes("/")),
		`a top-level note got a nested target: ${unfiled.map((i) => i.vaultPath)}`,
	);
	console.log("top level:", unfiled.length, unfiled.map((i) => i.vaultPath));

	// Selecting every folder, plus the top level, reaches every .note on disk.
	const everything = plan([
		{ folder: ROOT_FOLDER, recursive: false },
		...folders.map((folder) => ({ folder, recursive: true })),
	]);
	assert.equal(everything.length, noteCount(root!), "planSync missed .note files on disk");
	console.log("all folders:", everything.length, "of", noteCount(root!), "on disk");

	// Everything current, so nothing is planned.
	assert.equal(plan([{ folder: SUBJECT, recursive: true }], () => true).length, 0,
		"isCurrent did not skip");

	// A folder that no longer exists must not throw.
	assert.equal(plan([{ folder: "No/Such/Folder", recursive: true }]).length, 0);
	assert.equal(plan([]).length, 0, "an empty selection should plan nothing");

	const all = deep;
	const paths = deepPaths;

	assert.ok(supernoteToolInstalled(""), `supernote-tool not installed (resolved ${TOOL})`);

	const out = join(tmpdir(), "handwriting-harness.pdf");
	await convertNote(TOOL, all[0].notePath, out);
	assert.ok(statSync(out).size > 10000, "PDF too small");
	console.log("converted:", all[0].notePath, "->", statSync(out).size, "bytes");

	await assert.rejects(
		convertNote(TOOL, "/no/such/file.note", out),
		/exited/,
		"a missing input should reject",
	);

	console.log("\nALL PASS");
}

main().catch((e) => {
	console.error("FAILED:", e.message);
	process.exit(1);
});
