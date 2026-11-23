import { Array, Effect, FileSystem, Layer, Schema, String as Str, pipe } from "effect";
import type { Typed, World } from "./world.ts";
import { keys, snapshot, typedRun } from "./world.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";

const patient = { timeout: 120_000 };

const ok = 0;

const enter: Typed = { after: "Press Enter", typed: "" };

/** The one key `setup claude` asks for, pasted at its hidden question. */
const keyAnswer: Typed = { after: "Key: ", typed: keys.anthropic };

const claudeAnswers: readonly Typed[] = [keyAnswer, enter];

/** Claude Code's settings before setup, which a failed or stopped setup must leave byte for byte. */
const ownSettings = '{\n  "model": "opus"\n}\n';

const Json = Schema.fromJsonString(Schema.Json);

const layer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

/** Runs `phi-router setup <harness>` from the world's copy, typing `answers`. */
const setUp = Effect.fnUntraced(function* setUp(
	of: World,
	harness: "claude" | "codex" | "pi",
	answers: readonly Typed[],
) {
	const source = { claude: of.copies.plugin, codex: of.copies.plugin, pi: of.copies.pkg }[harness];

	return yield* typedRun(of, ["setup", harness, "--source", source], answers);
});

/** Claude Code's folder with its own settings. */
const settled = Effect.fnUntraced(function* settled(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`, ownSettings);
});

/** Each line of arguments the fake `harness` was run with, oldest first. */
const argsOf = Effect.fnUntraced(function* argsOf(of: World, harness: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${of.bin}/${harness}-args`).pipe(Effect.orElseSucceed(() => ""));

	return Array.initNonEmpty(Str.split(text, "\n"));
});

/**
 * What each call of a fake harness was: `install` for an installer command, `start` for setup's last call, `test`
 * for the canary turn, and `look` for `pi list`, which reads what pi installed.
 *
 * @param {string} line The arguments of one call.
 * @returns {string} What the call was.
 */
const callOf = (line: string): string => {
	if (Str.startsWith("plugin ")(line) || Str.startsWith("install ")(line)) {
		return "install";
	}

	if (line === "" || line === "--model phi/auto") {
		return "start";
	}

	if (line === "list") {
		return "look";
	}

	return "test";
};

/** The order of the fake `harness`'s calls by kind, each run of one kind once, `pi list` left out. */
const callsOf = Effect.fnUntraced(function* callsOf(of: World, harness: string) {
	const lines = yield* argsOf(of, harness);

	return pipe(
		lines,
		Array.map(callOf),
		Array.filter((call) => call !== "look"),
		Array.dedupeAdjacent,
	);
});

/** The `config.json` setup wrote, decoded. */
const configOf = Effect.fnUntraced(function* configOf(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`);

	return yield* Schema.decodeEffect(Json)(text);
});

/**
 * The files setup saves each vendor's key in.
 *
 * @param {World} of The world.
 * @returns {Readonly<Record<"anthropic" | "openai", string>>} Each key file's path, by vendor.
 */
const keyFiles = (of: World): Readonly<Record<"anthropic" | "openai", string>> => ({
	anthropic: `${of.xdg.XDG_CONFIG_HOME}/phi-router/keys/anthropic`,
	openai: `${of.xdg.XDG_CONFIG_HOME}/phi-router/keys/openai`,
});

/** The files setup may change: phi-router's config folder and each harness's own folder. */
const owned = Effect.fnUntraced(function* owned(of: World) {
	const folders = [
		of.xdg.XDG_CONFIG_HOME,
		of.folders.CLAUDE_CONFIG_DIR,
		of.folders.CODEX_HOME,
		of.folders.PI_CODING_AGENT_DIR,
	];

	const snapshots = yield* Effect.forEach(folders, snapshot, { concurrency: 1 });

	return Array.flatten(snapshots);
});

const pasted = [keys.anthropic, keys.openai, keys.refused, "phi-test-baa", "phi-test-openai", "phi-test-refused"];

/**
 * Whether `text` holds a pasted key or a piece of one.
 *
 * @param {string} text The text.
 * @returns {boolean} Whether it holds one.
 */
const holdsKey = (text: string): boolean =>
	pipe(
		pasted,
		Array.some((key) => Str.includes(key)(text)),
	);

/**
 * The file pi stores its logins and keys in.
 *
 * @param {World} of The world.
 * @returns {string} Its path.
 */
const piAuthOf = (of: World): string => `${of.folders.PI_CODING_AGENT_DIR}/auth.json`;

/**
 * Every file under the world's root and what setup printed, none of which may hold a key outside its key file and the
 * `auth.json` a test gives pi.
 */
const leaks = Effect.fnUntraced(function* leaks(of: World, printed: readonly string[]) {
	const files = yield* snapshot(of.root);

	const outsideKeys = pipe(
		files,
		Array.filter(([name]) => !Str.includes("phi-router/keys/")(name) && name !== piAuthOf(of)),
		Array.map(([name, text]) => `${name}\n${text}`),
	);

	return pipe([...printed, ...outsideKeys], Array.filter(holdsKey));
});

const permissionBits = 0o1000;

/** The permission bits of `file`. */
const modeOf = Effect.fnUntraced(function* modeOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const { mode } = yield* fs.stat(file);

	return mode % permissionBits;
});

export {
	argsOf,
	callsOf,
	claudeAnswers,
	configOf,
	enter,
	keyAnswer,
	keyFiles,
	layer,
	leaks,
	modeOf,
	ok,
	ownSettings,
	owned,
	patient,
	piAuthOf,
	setUp,
	settled,
};
