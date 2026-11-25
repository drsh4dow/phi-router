import { Array, Effect, FileSystem, Formatter, Layer, Option, Schema, String as Str, Struct, pipe } from "effect";
import type { Typed, World } from "./world.ts";
import { claudeStatus, filesUnder, idToken, keys, typedRun } from "./world.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import manifest from "#package.json" with { type: "json" };

const { version } = manifest;

const patient = { timeout: 120_000 };

const ok = 0;

const down = "\u001B[B";

const endOfInput = "\u0004";

const questions = {
	another: "Add another subscription?",
	baa: "Which account does your BAA cover?",
	everyday: "What do you use for everyday work?",
	openai: "Which OpenAI key does your BAA cover?",
} as const;

const enter: Typed = { after: "Press Enter", typed: "" };

const keyPicked: Typed = { after: questions.baa, typed: "" };

const baaKey: Typed = { after: "Anthropic key (BAA)", typed: keys.anthropic };

const judgeKey: Typed = { after: "OpenAI key (PHI check)", typed: keys.openai };

const noAnother: Typed = { after: questions.another, typed: down };

const maxAnswers: readonly Typed[] = [keyPicked, noAnother, baaKey, judgeKey, enter];

const ownSettings = '{\n  "model": "opus"\n}\n';

const enterpriseStatus = claudeStatus({ email: "dr.roe@clinic.example", plan: "enterprise" });

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

const withStatus = Effect.fnUntraced(function* withStatus(of: World, status: string) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(`${of.folders.CLAUDE_CONFIG_DIR}/phi-fake-status.json`, status);
});

const withEnv =
	(env: Readonly<Record<string, string>>) =>
	(of: World): World =>
		Struct.assign(of, { env: Struct.assign(of.env, env) });

const asDarwin = Effect.fnUntraced(function* asDarwin(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(`${of.project}/bunfig.toml`, 'preload = ["./darwin.ts"]\n');
	yield* fs.writeFileString(
		`${of.project}/darwin.ts`,
		'Object.defineProperty(process, "platform", { value: "darwin" });\n',
	);
});

type PiEntry =
	| { readonly type: "api_key"; readonly key: string }
	| { readonly type: "oauth"; readonly access: string; readonly refresh: string; readonly expires: number };

const piLogin: PiEntry = {
	access: keys.subscription,
	expires: 9_999_999_999_999,
	refresh: "phi-test-refresh",
	type: "oauth",
};

const piAuthOf = (of: World): string => `${of.folders.PI_CODING_AGENT_DIR}/auth.json`;

const piHolds = Effect.fnUntraced(function* piHolds(of: World, entries: Readonly<Record<string, PiEntry>>) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(piAuthOf(of), Formatter.formatJson(entries), { mode: 0o600 });
});

const codexSignedIn = Effect.fnUntraced(function* codexSignedIn(of: World) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.writeFileString(`${of.folders.CODEX_HOME}/phi-fake-login`, "Logged in using ChatGPT\n");
	yield* fs.writeFileString(
		`${of.folders.CODEX_HOME}/auth.json`,
		Formatter.formatJson({ tokens: { id_token: idToken({ email: "you@example.com", plan: "plus" }) } }),
	);
});

const argsOf = Effect.fnUntraced(function* argsOf(of: World, harness: string) {
	const fs = yield* FileSystem.FileSystem;
	const argsFile = `${of.fakeHarnessFolder}/${harness}-args`;
	const text = yield* fs.readFileString(argsFile).pipe(Effect.orElseSucceed(() => ""));

	return Array.initNonEmpty(Str.split(text, "\n"));
});

type HarnessCall = "auth" | "install" | "list" | "start" | "test";

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

	if (Str.startsWith("auth ")(line) || line === "login status") {
		return "auth";
	}

	return "test";
};

const callsOf = Effect.fnUntraced(function* callsOf(of: World, harness: string) {
	const lines = yield* argsOf(of, harness);

	return pipe(
		lines,
		Array.map(callOf),
		Array.filter((call) => call !== "list" && call !== "auth"),
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

const loginFolders = (of: World): Readonly<Record<"baa" | "open", string>> => ({
	baa: `${of.xdg.XDG_CONFIG_HOME}/phi-router/logins/claude-baa`,
	open: `${of.xdg.XDG_CONFIG_HOME}/phi-router/logins/claude-open`,
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

const tracked = Effect.fnUntraced(function* tracked(of: World, args: readonly string[], answers: readonly Typed[]) {
	const before = yield* filesSetupMayChange(of);
	const run = yield* typedRun(of, args, answers);
	const after = yield* filesSetupMayChange(of);

	return { after, before, run };
});

const pasted = [keys.anthropic, keys.openai, keys.refused, "phi-test-baa", "phi-test-openai", "phi-test-refused"];

const holdsKeyPiece = (text: string): boolean =>
	pipe(
		pasted,
		Array.some((key) => Str.includes(key)(text)),
	);

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

const afterQuestion = 1;

const markWidth = 2;

const firstPick = ({ question, shown }: { readonly shown: string; readonly question: string }): readonly string[] =>
	pipe(
		Str.split(`${question}\n`)(shown),
		Array.get(afterQuestion),
		Option.getOrElse(() => ""),
		Str.split("\n"),
		Array.map(Str.trimEnd),
		Array.takeWhile((line) => Str.startsWith("❯ ")(line) || Str.startsWith("  ")(line)),
		Array.dedupeWith((one, other) => Str.slice(markWidth)(one) === Str.slice(markWidth)(other)),
	);

const lastLine = (shown: string): string =>
	pipe(
		Str.split("\n")(shown),
		Array.map(Str.trim),
		Array.filter(Str.isNonEmpty),
		Array.last,
		Option.getOrElse(() => ""),
	);

export {
	argsOf,
	asDarwin,
	baaKey,
	callsOf,
	codexSignedIn,
	down,
	endOfInput,
	enter,
	enterpriseStatus,
	filesSetupMayChange,
	firstPick,
	holdsKeyPiece,
	judgeKey,
	keyFiles,
	keyPicked,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	loginFolders,
	maxAnswers,
	noAnother,
	ok,
	ownSettings,
	patient,
	permissionBitsOf,
	piHolds,
	piLogin,
	questions,
	setUp,
	tracked,
	version,
	withEnv,
	withStatus,
	writeOwnSettings,
	writtenConfigOf,
};

export type { PiEntry };
