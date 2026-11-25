import { Effect, FileSystem, Formatter } from "effect";
import type { Typed, World } from "./world.ts";
import { asDarwin, down, lastLine, layer, ok, patient, withEnv, writtenConfigOf } from "./set-up.ts";
import { assert, it } from "@effect/vitest";
import { claudeCredentials, phiRouter } from "#tools/cli/accounts-run.ts";
import { claudeStatus, keys, typedRun, world } from "./world.ts";

const claudeLanes = {
	clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
	sealed: [{ keyEnv: "PHI_TEST_BAA", name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
} as const;

const bothLanes = {
	clean: [...claudeLanes.clean, { forwarded: true, name: "codex", vendor: "openai" }],
	sealed: [...claudeLanes.sealed, { keyEnv: "PHI_TEST_OPENAI", name: "openai", scheme: "apiKey", vendor: "openai" }],
} as const;

type Lanes = typeof claudeLanes | typeof bothLanes;

const configured = Effect.fnUntraced(function* configured(lanes: Lanes) {
	const fs = yield* FileSystem.FileSystem;
	const made = yield* world;
	const of = withEnv({ TZ: "UTC" })(made);
	const folder = `${of.xdg.XDG_CONFIG_HOME}/phi-router`;

	yield* fs.makeDirectory(folder, { recursive: true });
	yield* fs.writeFileString(`${folder}/config.json`, Formatter.formatJson(lanes));

	return of;
});

const slot = (of: World, name: string): string => `${of.xdg.XDG_CONFIG_HOME}/phi-router/logins/${name}`;

const loginCode: Typed = { after: "Paste code here", typed: "CODE-123" };

const added = (name: string, after: string, summary: string): string =>
	`Added ${name} to the clean lane, after ${after}.\n  ${summary}\nA running router serves it from its next request.\n`;

const claudeFolder = "Claude login folder. Its login ends 2100-01-01. claude refreshes it.";

const loginEnds = 4_102_444_800_000;

const loginsOf = Effect.fnUntraced(function* loginsOf(of: World) {
	const fs = yield* FileSystem.FileSystem;

	return yield* fs.readFileString(`${of.fakeHarnessFolder}/logins`).pipe(Effect.orElseSucceed(() => ""));
});

const claudeAdded = Effect.gen(function* claudeAdded() {
	const of = yield* configured(claudeLanes);
	const first = yield* typedRun(of, ["accounts", "add"], [loginCode]);
	const config = yield* writtenConfigOf(of);

	assert.strictEqual(first.exitCode, ok, first.shown);
	assert.include(first.shown, added("claude-3", "claude-1", claudeFolder));
	assert.deepStrictEqual(config, {
		clean: [...claudeLanes.clean, { loginFolder: slot(of, "claude-open-2"), name: "claude-3", vendor: "anthropic" }],
		sealed: claudeLanes.sealed,
	});

	const again = yield* typedRun(of, ["accounts", "add"], [loginCode]);
	const after = yield* writtenConfigOf(of);
	const logins = yield* loginsOf(of);

	assert.notStrictEqual(again.exitCode, ok, again.shown);
	assert.strictEqual(
		lastLine(again.shown),
		"phi-router: You logged in to roe@example.com, which phi-router already uses. Nothing changed.",
	);
	assert.deepStrictEqual(after, config, "a second login to the same account adds nothing");
	assert.strictEqual(logins, `${slot(of, "claude-open-2")}\n${slot(of, "claude-open-3")}\n`);
}).pipe(Effect.scoped);

const noTerminalThenLeftBehind = Effect.gen(function* noTerminalThenLeftBehind() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* configured(claudeLanes);
	const refused = yield* phiRouter(of.env, ["accounts", "add"]);
	const unchanged = yield* writtenConfigOf(of);

	assert.notStrictEqual(refused.exitCode, ok, refused.stdout);
	assert.include(
		refused.stderr,
		"phi-router: Logging in to another subscription needs a terminal or a browser. Run `npx phi-router accounts add` in a terminal. Nothing changed.",
	);
	assert.deepStrictEqual(unchanged, claudeLanes);

	yield* fs.writeFileString(
		`${slot(of, "claude-open-2")}/phi-fake-status.json`,
		claudeStatus({ email: "roe@example.com", plan: "pro" }),
	);
	yield* fs.writeFileString(`${slot(of, "claude-open-2")}/.credentials.json`, claudeCredentials(loginEnds));

	const reused = yield* phiRouter(of.env, ["accounts", "add"]);
	const logins = yield* loginsOf(of);

	assert.deepStrictEqual(
		{ exitCode: reused.exitCode, logins, stdout: reused.stdout },
		{ exitCode: ok, logins: "", stdout: added("claude-3", "claude-1", claudeFolder) },
		reused.stderr,
	);
}).pipe(Effect.scoped);

const codexPicked: Typed = { after: "Which subscription do you want to add?", typed: down };

const codexAdded = Effect.gen(function* codexAdded() {
	const of = yield* configured(bothLanes);
	const run = yield* typedRun(of, ["accounts", "add"], [codexPicked]);
	const config = yield* writtenConfigOf(of);
	const logins = yield* loginsOf(of);

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, added("codex-2", "codex", "Codex home folder. codex refreshes it."));
	assert.deepStrictEqual(config, {
		clean: [...bothLanes.clean, { loginFolder: slot(of, "codex-open-2"), name: "codex-2", vendor: "openai" }],
		sealed: bothLanes.sealed,
	});
	assert.strictEqual(logins, `${slot(of, "codex-open-2")}\n`);
}).pipe(Effect.scoped);

const tokenPasted: Typed = { after: "Paste the token it printed", typed: keys.subscription };

const macToken = Effect.gen(function* macToken() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* configured(claudeLanes);

	yield* asDarwin(of);

	const run = yield* typedRun(of, ["accounts", "add"], [tokenPasted]);
	const config = yield* writtenConfigOf(of);
	const keyFile = `${slot(of, "claude-open-2")}/token`;
	const saved = yield* fs.readFileString(keyFile);
	const summary = `Claude token, ${String(keys.subscription.length)} characters. Lasts 1 year. Needs no refresh.`;

	assert.strictEqual(run.exitCode, ok, run.shown);
	assert.include(run.shown, added("claude-3", "claude-1", summary));
	assert.deepStrictEqual(config, {
		clean: [...claudeLanes.clean, { keyFile, name: "claude-3", scheme: "oauth", vendor: "anthropic" }],
		sealed: claudeLanes.sealed,
	});
	assert.strictEqual(saved, `${keys.subscription}\n`);
}).pipe(Effect.scoped);

it.layer(layer)("phi-router accounts add with no argument", (test) => {
	test.effect(
		"logs in to another Claude subscription in a login folder of its own and adds it to the clean lane, and a login to an account phi-router already uses adds nothing",
		() => claudeAdded,
		patient,
	);
	test.effect(
		"with no terminal and no browser stops with the command to run in a terminal, and adds a login an earlier run left in the next folder without logging in again",
		() => noTerminalThenLeftBehind,
		patient,
	);
	test.effect(
		"asks which subscription when the clean lane holds Claude and ChatGPT, and logs in to Codex in a home folder of its own",
		() => codexAdded,
		patient,
	);
	test.effect(
		"on macOS runs claude setup-token, reads the token at a hidden prompt and keeps it in a file of its own",
		() => macToken,
		patient,
	);
});
