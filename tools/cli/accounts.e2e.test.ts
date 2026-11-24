import { Array, Effect, FileSystem, Path, Schema, String as Str, pipe } from "effect";
import { ConfigFile, claudeCredentials, leaks, phiRouter, prepared, tokens } from "./accounts-run.ts";
import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import type { Prepared } from "./accounts-run.ts";

const earlier = 1_577_836_800_000;

const startingAccounts = 2;

const succeeded = 0;

const restart = "A running router serves it from its next request.";

const patient = { timeout: 60_000 };

const printedBy = (runs: readonly { readonly stdout: string; readonly stderr: string }[]): readonly string[] =>
	pipe(
		runs,
		Array.flatMap(({ stderr, stdout }) => [stdout, stderr]),
	);

const rootsOf = (run: Prepared): readonly string[] => [run.env.XDG_CONFIG_HOME, run.env.XDG_STATE_HOME];

const textOf = Effect.fnUntraced(function* textOf(file: string) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.readFileString(file);
});

const addsOf = (run: Prepared): readonly (readonly string[])[] => [
	["accounts", "add", run.folders.claude],
	["accounts", "add", run.folders.codex],
	["accounts", "add", "--command", run.commands.token],
	["accounts", "add", "--sealed", "--command", run.commands.key],
];

interface AddedAll {
	readonly added: readonly string[];
	readonly clean: readonly Readonly<Record<string, string>>[];
	readonly leaked: readonly string[];
	readonly listed: string;
	readonly note: string;
	readonly sealed: readonly Readonly<Record<string, string>>[];
	readonly stderr: readonly string[];
}

const addedAll = (run: Prepared): AddedAll => ({
	added: [
		`Added claude-2 to the clean lane, after claude-1.\n  Claude login folder. Its login ends 2100-01-01. claude refreshes it.\n${restart}\n`,
		`Added codex-2 to the clean lane, after codex.\n  Codex home folder. codex refreshes it.\n${restart}\n`,
		`Added claude-3 to the clean lane, after claude-2.\n  Claude token, ${String(tokens.command.length)} characters. Lasts 1 year. Needs no refresh.\n${restart}\n`,
		`Added openai-2 to the sealed lane, after openai.\n  OpenAI key, ${String(tokens.key.length)} characters.\n${restart}\n`,
	],
	clean: [
		{ loginFolder: run.folders.claude, name: "claude-2", vendor: "anthropic" },
		{ loginFolder: run.folders.codex, name: "codex-2", vendor: "openai" },
		{ keyCommand: run.commands.token, name: "claude-3", scheme: "oauth", vendor: "anthropic" },
	],
	leaked: [],
	listed: Array.join(
		[
			"Clean lane",
			"  claude-1    Claude  forwarded     ok.",
			"  codex       Codex   forwarded     ok.",
			"  claude-2    Claude  login folder  ok. Login ends 2100-01-01.",
			"  codex-2     Codex   home folder   ok.",
			"  claude-3    Claude  token         ok.",
			"Sealed lane",
			"  enterprise  Claude  forwarded     ok.",
			"  openai      OpenAI  key env       ok.",
			"  openai-2    OpenAI  key command   ok.",
			"",
		],
		"\n",
	),
	note: "kept as it was",
	sealed: [{ keyCommand: run.commands.key, name: "openai-2", scheme: "apiKey", vendor: "openai" }],
	stderr: ["", "", "", "", ""],
});

const addsEach = Effect.gen(function* addsEach() {
	const run = yield* prepared("both");
	const added = yield* Effect.forEach(addsOf(run), (args) => phiRouter(run.env, args), { concurrency: 1 });
	const listed = yield* phiRouter(run.env, ["accounts"]);
	const written = yield* Effect.flatMap(textOf(run.configFile), Schema.decodeEffect(ConfigFile));
	const leaked = yield* leaks(rootsOf(run), printedBy([...added, listed]));

	assert.deepStrictEqual<unknown>(
		{
			added: pipe(
				added,
				Array.map(({ stdout }) => stdout),
			),
			clean: Array.drop(written.clean, startingAccounts),
			leaked,
			listed: listed.stdout,
			note: written["note"],
			sealed: Array.drop(written.sealed, startingAccounts),
			stderr: Array.map([...added, listed], ({ stderr }) => stderr),
		},
		addedAll(run),
	);
});

const bothLogins = Effect.gen(function* bothLogins() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const run = yield* prepared("both");
	const codexLogin = yield* textOf(path.join(run.folders.codex, "auth.json"));

	yield* fs.writeFileString(path.join(run.folders.claude, "auth.json"), codexLogin);

	const added = yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);

	assert.deepStrictEqual(added, {
		exitCode: succeeded,
		stderr: "",
		stdout: `Added claude-2 to the clean lane, after claude-1.\n  Claude login folder. Its login ends 2100-01-01. claude refreshes it.\n${restart}\n`,
	});
});

const already = {
	exitCode: succeeded,
	stderr: "",
	stdout: "claude-2 is already on the clean lane. Nothing changed.\n",
};

/**
 * A run with the config `both`, a symlink beside its Claude login folder that points at it, and `hop`, a symlink in
 * another folder that points at the Codex folder, so `hop/../claude` is the Claude folder only as the operating system
 * resolves it.
 */
const linked = Effect.gen(function* linked() {
	const fs = yield* FileSystem.FileSystem;
	const run = yield* prepared("both");
	const link = `${run.folders.claude}-link`;
	const hop = `${run.folders.none}/hop`;

	yield* fs.symlink(run.folders.claude, link);
	yield* fs.symlink(run.folders.codex, hop);

	return { hop, link, run };
});

const sealedAdd = (run: Prepared, folder: string): ReturnType<typeof phiRouter> =>
	phiRouter(run.env, ["accounts", "add", "--sealed", folder]);

const addsOnce = Effect.gen(function* addsOnce() {
	const { hop, link, run } = yield* linked;
	const first = yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);
	const before = yield* textOf(run.configFile);
	const spellings = [`${run.folders.claude}/../claude/`, link, `${hop}/../claude`];
	const again = yield* Effect.forEach(spellings, (folder) => sealedAdd(run, folder), { concurrency: 1 });
	const after = yield* textOf(run.configFile);
	const leaked = yield* leaks(rootsOf(run), printedBy([first, ...again]));

	assert.deepStrictEqual({ after, again, leaked }, { after: before, again: [already, already, already], leaked: [] });
});

const namedThroughLink = Effect.gen(function* namedThroughLink() {
	const fs = yield* FileSystem.FileSystem;
	const { link, run } = yield* linked;

	yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);

	const written = yield* textOf(run.configFile);
	const byHand = Str.replaceAll(`"${run.folders.claude}"`, `"${link}"`)(written);

	yield* fs.writeFileString(run.configFile, byHand);

	const again = yield* sealedAdd(run, run.folders.claude);
	const after = yield* textOf(run.configFile);

	assert.deepStrictEqual(
		{ after, again, linked: Str.includes(link)(byHand) },
		{ after: byHand, again: already, linked: true },
	);
});

const refusedWith = Effect.fnUntraced(function* refusedWith(
	config: "both" | "claudeOnly",
	args: (run: Prepared) => readonly string[],
	named: (run: Prepared) => readonly string[],
) {
	const run = yield* prepared(config);
	const before = yield* textOf(run.configFile);
	const refused = yield* phiRouter(run.env, args(run));
	const after = yield* textOf(run.configFile);
	const leaked = yield* leaks(rootsOf(run), printedBy([refused]));

	const missing = pipe(
		named(run),
		Array.filter((text) => !Str.includes(text)(refused.stderr)),
	);

	assert.deepStrictEqual(
		{ after, failed: refused.exitCode !== succeeded, leaked, missing },
		{ after: before, failed: true, leaked: [], missing: [] },
		refused.stderr,
	);
});

const noLogin = refusedWith(
	"both",
	(run) => ["accounts", "add", run.folders.none],
	(run) => [
		".credentials.json",
		"auth.json",
		`CLAUDE_CONFIG_DIR=${run.folders.none} claude auth login`,
		`CODEX_HOME=${run.folders.none} codex login`,
		"Nothing changed.",
	],
);

const noSealedAccount = refusedWith(
	"claudeOnly",
	(run) => ["accounts", "add", run.folders.codex],
	() => ["vendor openai needs an account in clean and an account in sealed", "Nothing changed."],
);

const troubled = Effect.fnUntraced(function* troubled(run: Prepared) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.writeFileString(path.join(run.folders.claude, ".credentials.json"), claudeCredentials(earlier));
	yield* fs.makeDirectory(run.state, { recursive: true });
	yield* fs.writeFileString(
		path.join(run.state, "accounts.json"),
		'{"rateLimited":{"claude-1":"2099-01-01T14:52:00.000Z"}}',
	);
});

const listsTrouble = Effect.gen(function* listsTrouble() {
	const run = yield* prepared("claudeOnly");
	const added = yield* phiRouter(run.env, ["accounts", "add", run.folders.claude]);

	yield* troubled(run);

	const listed = yield* phiRouter(run.env, ["accounts"]);
	const leaked = yield* leaks(rootsOf(run), printedBy([added, listed]));
	const fix = `CLAUDE_CONFIG_DIR=${run.folders.claude} claude auth login`;

	assert.deepStrictEqual(
		{ leaked, listed },
		{
			leaked: [],
			listed: {
				exitCode: succeeded,
				stderr: "",
				stdout: Array.join(
					[
						"Clean lane",
						"  claude-1    Claude  forwarded     rate-limited. Back at 14:52.",
						`  claude-2    Claude  login folder  login ended 2020-01-01. Fix: ${fix}`,
						"Sealed lane",
						"  enterprise  Claude  forwarded     ok.",
						"",
					],
					"\n",
				),
			},
		},
	);
});

it.layer(NodeServices.layer)("phi-router accounts", (test) => {
	test.effect(
		"add names a Claude config folder, a Codex home folder, a token command and a sealed key after their vendors, and the list shows them",
		() => addsEach,
		patient,
	);
	test.effect("add names a folder that holds both a Claude and a Codex login after Claude", () => bothLogins, patient);
	test.effect(
		"add of a folder already on a lane, spelled with .., through a symlink or with .. after a symlink, and asked for the other lane, changes nothing",
		() => addsOnce,
		patient,
	);
	test.effect(
		"add of a folder that config.json names through a symlink, asked for the other lane, changes nothing",
		() => namedThroughLink,
		patient,
	);
	test.effect(
		"add refuses a folder that holds no login, names both credential files and both login commands, and writes nothing",
		() => noLogin,
		patient,
	);
	test.effect(
		"add refuses an account that leaves its vendor with no sealed account, and writes nothing",
		() => noSealedAccount,
		patient,
	);
	test.effect(
		"the list shows a stamped account rate-limited and an ended login with its fix",
		() => listsTrouble,
		patient,
	);
});
