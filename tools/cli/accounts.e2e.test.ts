import { Array, Config, Effect, FileSystem, Path, Schema, String as Str, Struct, pipe } from "effect";
import { ConfigFile, claudeCredentials, credentialHolders, phiRouter, prepared, tokens } from "./accounts-run.ts";
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
	readonly holders: readonly string[];
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
	holders: [],
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
	const holders = yield* credentialHolders(rootsOf(run), printedBy([...added, listed]));

	assert.deepStrictEqual<unknown>(
		{
			added: pipe(
				added,
				Array.map(({ stdout }) => stdout),
			),
			clean: Array.drop(written.clean, startingAccounts),
			holders,
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
	const holders = yield* credentialHolders(rootsOf(run), printedBy([first, ...again]));

	assert.deepStrictEqual(
		{ after, again, holders },
		{ after: before, again: [already, already, already], holders: [] },
	);
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
	const holders = yield* credentialHolders(rootsOf(run), printedBy([refused]));

	const missing = pipe(
		named(run),
		Array.filter((text) => !Str.includes(text)(refused.stderr)),
	);

	assert.deepStrictEqual(
		{ after, failed: refused.exitCode !== succeeded, holders, missing },
		{ after: before, failed: true, holders: [], missing: [] },
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

const unknownPrefix = refusedWith(
	"both",
	(run) => ["accounts", "add", "--command", run.commands.unknown],
	() => ["prefix is unknown", "Nothing changed."],
);

const noSealedAccount = refusedWith(
	"claudeOnly",
	(run) => ["accounts", "add", run.folders.codex],
	() => ["vendor openai needs an account in clean and an account in sealed", "Nothing changed."],
);

const stamped =
	'{"rateLimited":{"claude-1":"2099-01-01T14:52:00.000Z","claude-2":"2099-01-01T14:52:00.000Z","claude-3":"2099-01-01T14:52:00.000Z"}}';

const fixOf = (folder: string): string => `CLAUDE_CONFIG_DIR=${folder} claude auth login`;

const listsTrouble = Effect.gen(function* listsTrouble() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const run = yield* prepared("claudeOnly");
	const { claude, codex, none } = run.folders;
	const emptied = path.join(path.dirname(none), "emptied");
	const credentials = (folder: string): string => path.join(folder, ".credentials.json");

	yield* fs.makeDirectory(emptied);
	yield* Effect.forEach([none, codex, emptied], (folder) => fs.copyFile(credentials(claude), credentials(folder)), {
		concurrency: 1,
	});

	const added = yield* Effect.forEach(
		[claude, none, codex, emptied],
		(folder) => phiRouter(run.env, ["accounts", "add", folder]),
		{ concurrency: 1 },
	);

	yield* fs.writeFileString(credentials(claude), claudeCredentials(earlier));
	yield* Effect.forEach([codex, emptied], (folder) => fs.remove(credentials(folder)), { concurrency: 1 });
	yield* fs.makeDirectory(run.state, { recursive: true });
	yield* fs.writeFileString(path.join(run.state, "accounts.json"), stamped);

	const listed = yield* phiRouter(run.env, ["accounts"]);
	const holders = yield* credentialHolders(rootsOf(run), printedBy([...added, listed]));

	assert.deepStrictEqual(
		{ holders, listed },
		{
			holders: [],
			listed: {
				exitCode: succeeded,
				stderr: "",
				stdout: Array.join(
					[
						"Clean lane",
						"  claude-1    Claude  forwarded     rate-limited. Back at 14:52.",
						`  claude-2    Claude  login folder  login ended 2020-01-01. Fix: ${fixOf(claude)}`,
						"  claude-3    Claude  login folder  rate-limited. Back at 14:52.",
						`  claude-4    Claude  login folder  no login. Fix: ${fixOf(codex)}`,
						`  claude-5    Claude  login folder  no login. Fix: ${fixOf(emptied)}`,
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

const runnable = 0o755;

const recordsRuns = (log: string, name: string): string => `#!/bin/sh\necho ${name} >> '${log}'\n`;

const runsOnlyTheTokenCommand = Effect.gen(function* runsOnlyTheTokenCommand() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const run = yield* prepared("both");
	const bin = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-bin-" });
	const log = path.join(bin, "ran");
	const searchPath = yield* Config.String("PATH");
	const env = Struct.assign(run.env, { PATH: `${bin}:${searchPath}` });
	const counted = `echo command >> '${log}'; ${run.commands.token}`;

	yield* Effect.forEach(
		["claude", "codex"],
		(cli) => fs.writeFileString(path.join(bin, cli), recordsRuns(log, cli), { mode: runnable }),
		{ concurrency: 1 },
	);

	const runs = yield* Effect.forEach(
		[
			["accounts", "add", run.folders.claude],
			["accounts", "add", run.folders.codex],
			["accounts", "add", "--command", counted],
			["accounts"],
		],
		(args) => phiRouter(env, args),
		{ concurrency: 1 },
	);

	const ran = yield* textOf(log);

	assert.deepStrictEqual(
		{
			exitCodes: pipe(
				runs,
				Array.map(({ exitCode }) => exitCode),
			),
			ran,
		},
		{ exitCodes: [succeeded, succeeded, succeeded, succeeded], ran: "command\n" },
	);
});

const sameNameTwice =
	'{"clean":[{"forwarded":true,"name":"claude-1","vendor":"anthropic"}],"sealed":[{"forwarded":true,"name":"claude-1","vendor":"anthropic"}]}';

const readers: readonly (readonly string[])[] = [["accounts"], ["models"]];

const unconfigured = Effect.gen(function* unconfigured() {
	const fs = yield* FileSystem.FileSystem;
	const run = yield* prepared("both");

	yield* fs.remove(run.configFile);

	const missing = yield* Effect.forEach(readers, (args) => phiRouter(run.env, args), { concurrency: 1 });

	yield* fs.writeFileString(run.configFile, sameNameTwice);

	const refused = yield* Effect.forEach(readers, (args) => phiRouter(run.env, args), { concurrency: 1 });

	assert.deepStrictEqual(
		{
			missing,
			refused: pipe(
				refused,
				Array.map(({ exitCode, stdout }) => ({
					failed: exitCode !== succeeded,
					named: Str.includes("two accounts are named claude-1")(stdout),
				})),
			),
		},
		{
			missing: [
				{
					exitCode: succeeded,
					stderr: "",
					stdout:
						"No accounts yet. The install for your harness writes the first ones, and phi-router accounts add adds more.\n",
				},
				{ exitCode: succeeded, stderr: "", stdout: "{}\n" },
			],
			refused: [
				{ failed: true, named: true },
				{ failed: true, named: true },
			],
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
		"add refuses a token command that prints an unknown prefix without naming the token, and writes nothing",
		() => unknownPrefix,
		patient,
	);
	test.effect(
		"add of a login folder and the list run no vendor CLI, and add runs a token command once and the list never",
		() => runsOnlyTheTokenCommand,
		patient,
	);
	test.effect(
		"add refuses an account that leaves its vendor with no sealed account, and writes nothing",
		() => noSealedAccount,
		patient,
	);
	test.effect(
		"the list and models, with no config.json, show no accounts and no models, and fail on a file the router would refuse",
		() => unconfigured,
		patient,
	);
	test.effect(
		"the list shows an ended login before a stamp, a stamp before a login's end, and a folder with no login or only the other vendor's as no login, each with its fix",
		() => listsTrouble,
		patient,
	);
});
