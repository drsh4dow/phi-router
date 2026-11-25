import { Array, Effect, FileSystem, Option, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import {
	callsOf,
	enterpriseStatus,
	keyFiles,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	loginFolders,
	ok,
	patient,
	withEnv,
	writtenConfigOf,
} from "./set-up.ts";
import { keys, world } from "./world.ts";
import { phiRouter } from "#tools/cli/accounts-run.ts";
import { ran } from "#tools/lifecycle/launched.ts";

const applyWith = (answers: string): readonly string[] => ["setup", "claude", "--apply", "--answers", answers];

const pasteBoth =
	"I need two keys covered by your BAA: Anthropic for patient data, OpenAI for the PHI check. Paste them in `/plugin configure phi-router`. I can't see that field. Say done when saved.";

const pastedInOptions = Effect.gen(function* pastedInOptions() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;
	const asked = yield* phiRouter(of.env, applyWith('{"baa":"key"}'));
	const configAfterAsk = yield* fs.exists(`${of.xdg.XDG_CONFIG_HOME}/phi-router/config.json`);
	const calls = yield* callsOf(of, "claude");

	assert.notStrictEqual(asked.exitCode, ok);
	assert.strictEqual(lastLine(asked.stderr), pasteBoth);
	assert.deepStrictEqual(calls, ["install"], "the plugin is installed so its options can be set");
	assert.isFalse(configAfterAsk, "no account before the keys are in");

	const options = withEnv({
		CLAUDE_PLUGIN_OPTION_ANTHROPIC_KEY: keys.anthropic,
		CLAUDE_PLUGIN_OPTION_OPENAI_KEY: keys.openai,
	})(of);

	const hook = yield* phiRouter(options.env, ["session-start", "--claude", "--pid", "1", "--address", ""]);
	const applied = yield* phiRouter(of.env, applyWith('{"baa":"key"}'));

	assert.strictEqual(hook.exitCode, ok, hook.stderr);
	assert.strictEqual(applied.exitCode, ok, applied.stderr);

	const config = yield* writtenConfigOf(of);
	const { anthropic, openai } = keyFiles(of);
	const outside = yield* keysOutsideKeyFiles(of, [asked.stdout, asked.stderr, applied.stdout, applied.stderr]);

	assert.include(applied.stdout, "✓ Anthropic key works\n✓ OpenAI key works\n");
	assert.strictEqual(lastLine(applied.stdout), "Done. This window is protected.");
	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
		sealed: [{ keyFile: anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
	});
	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

const quoted = 1;

const commandIn = (line: string): string =>
	pipe(
		Str.split(line, "`"),
		Array.get(quoted),
		Option.getOrElse(() => ""),
	);

const signedInElsewhere = Effect.gen(function* signedInElsewhere() {
	const fs = yield* FileSystem.FileSystem;
	const base = yield* world;
	const of = withEnv({ PHI_ROUTER_OPENAI_KEY: keys.openai })(base);

	yield* fs.writeFileString(`${of.fakeHarnessFolder}/next-sign-in.json`, enterpriseStatus);

	const stoppedRun = yield* phiRouter(of.env, applyWith('{"baa":"signIn"}'));
	const loginsBefore = yield* fs.exists(`${of.fakeHarnessFolder}/logins`);
	const line = lastLine(stoppedRun.stderr);
	const command = commandIn(line);

	assert.notStrictEqual(stoppedRun.exitCode, ok);
	assert.strictEqual(
		line,
		`This machine has no browser. In any terminal, run \`CLAUDE_CONFIG_DIR='${loginFolders(of).baa}' claude auth login\` and follow the steps. Say done when it says you're signed in.`,
	);
	assert.isFalse(loginsBefore, "setup started no login it could not finish");

	const terminal = yield* ran(["sh", "-c", `printf 'CODE-123\\n' | ${command}`], of.env);
	const applied = yield* phiRouter(of.env, applyWith('{"baa":"signIn"}'));

	assert.strictEqual(terminal.exitCode, ok, terminal.printed);
	assert.strictEqual(applied.exitCode, ok, applied.stderr);

	const config = yield* writtenConfigOf(of);
	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: keyFiles(of).openai },
		sealed: [{ loginFolder: loginFolders(of).baa, name: "claude-2", vendor: "anthropic" }],
	});
}).pipe(Effect.scoped);

it.layer(layer)("setup inside Claude Code", (test) => {
	test.effect(
		"with no key, setup installs the plugin and asks for both keys in its options, then reads what its hook saved",
		() => pastedInOptions,
		patient,
	);
	test.effect(
		"with no browser and no terminal, setup names the one command that signs in, and finishes after it",
		() => signedInElsewhere,
		patient,
	);
});
