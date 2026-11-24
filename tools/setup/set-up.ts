import { Array, Effect, FileSystem, Layer, Schema, String as Str, pipe } from "effect";
import type { Typed, World } from "./world.ts";
import { filesUnder, keys, typedRun } from "./world.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import manifest from "#package.json" with { type: "json" };

const { version } = manifest;

const patient = { timeout: 120_000 };

const ok = 0;

const enter: Typed = { after: "Press Enter", typed: "" };

const keyAnswer: Typed = { after: "Key: ", typed: keys.anthropic };

const claudeAnswers: readonly Typed[] = [keyAnswer, enter];

const ownSettings = '{\n  "model": "opus"\n}\n';

const Json = Schema.fromJsonString(Schema.Json);

const layer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

const setUp = Effect.fnUntraced(function* setUp(
	of: World,
	harness: "claude" | "codex" | "pi",
	answers: readonly Typed[],
) {
	return yield* typedRun(of, ["setup", harness], answers);
});

const writeOwnSettings = Effect.fnUntraced(function* writeOwnSettings(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`, ownSettings);
});

const argsOf = Effect.fnUntraced(function* argsOf(of: World, harness: string) {
	const fs = yield* FileSystem.FileSystem;
	const argsFile = `${of.fakeHarnessFolder}/${harness}-args`;
	const text = yield* fs.readFileString(argsFile).pipe(Effect.orElseSucceed(() => ""));

	return Array.initNonEmpty(Str.split(text, "\n"));
});

type HarnessCall = "install" | "list" | "start" | "test";

const callOf = (line: string): HarnessCall => {
	if (Str.startsWith("plugin ")(line) || Str.startsWith("install ")(line)) {
		return "install";
	}

	if (line === "" || line === "--model phi/auto") {
		return "start";
	}

	if (line === "list") {
		return "list";
	}

	return "test";
};

const callsOf = Effect.fnUntraced(function* callsOf(of: World, harness: string) {
	const lines = yield* argsOf(of, harness);

	return pipe(
		lines,
		Array.map(callOf),
		Array.filter((call) => call !== "list"),
		Array.dedupeAdjacent,
	);
});

const writtenConfigOf = Effect.fnUntraced(function* writtenConfigOf(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`);

	return yield* Schema.decodeEffect(Json)(text);
});

const keyFiles = (of: World): Readonly<Record<"anthropic" | "openai", string>> => ({
	anthropic: `${of.xdg.XDG_CONFIG_HOME}/phi-router/keys/anthropic`,
	openai: `${of.xdg.XDG_CONFIG_HOME}/phi-router/keys/openai`,
});

const filesSetupMayChange = Effect.fnUntraced(function* filesSetupMayChange(of: World) {
	const folders = [
		of.xdg.XDG_CONFIG_HOME,
		of.folders.CLAUDE_CONFIG_DIR,
		of.folders.CODEX_HOME,
		of.folders.PI_CODING_AGENT_DIR,
	];

	const files = yield* Effect.forEach(folders, filesUnder, { concurrency: 1 });

	return Array.flatten(files);
});

const pasted = [keys.anthropic, keys.openai, keys.refused, "phi-test-baa", "phi-test-openai", "phi-test-refused"];

const holdsKeyPiece = (text: string): boolean =>
	pipe(
		pasted,
		Array.some((key) => Str.includes(key)(text)),
	);

const piAuthOf = (of: World): string => `${of.folders.PI_CODING_AGENT_DIR}/auth.json`;

const keysOutsideKeyFiles = Effect.fnUntraced(function* keysOutsideKeyFiles(of: World, printed: readonly string[]) {
	const files = yield* filesUnder(of.root);

	const outsideKeys = pipe(
		files,
		Array.filter(([name]) => !Str.includes("phi-router/keys/")(name) && name !== piAuthOf(of)),
		Array.map(([name, text]) => `${name}\n${text}`),
	);

	return pipe([...printed, ...outsideKeys], Array.filter(holdsKeyPiece));
});

const permissionBits = 0o1000;

const permissionBitsOf = Effect.fnUntraced(function* permissionBitsOf(file: string) {
	const fs = yield* FileSystem.FileSystem;
	const { mode } = yield* fs.stat(file);

	return mode % permissionBits;
});

export {
	argsOf,
	callsOf,
	claudeAnswers,
	enter,
	filesSetupMayChange,
	keyAnswer,
	keyFiles,
	layer,
	keysOutsideKeyFiles,
	ok,
	ownSettings,
	patient,
	permissionBitsOf,
	piAuthOf,
	setUp,
	version,
	writeOwnSettings,
	writtenConfigOf,
};
