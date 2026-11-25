import { Effect, Schema, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import {
	filesSetupMayChange,
	holdsKeyPiece,
	keyFiles,
	keysOutsideKeyFiles,
	lastLine,
	layer,
	ok,
	patient,
	withEnv,
	writtenConfigOf,
} from "./set-up.ts";
import { keys, world } from "./world.ts";
import { phiRouter } from "#tools/cli/accounts-run.ts";

const answeredKey = ["--answers", '{"baa":"key"}'];

const reported = Effect.gen(function* reported() {
	const base = yield* world;
	const of = withEnv({ ANTHROPIC_API_KEY: keys.anthropic })(base);
	const run = yield* phiRouter(of.env, ["setup", "claude", "--json", ...answeredKey]);
	const step = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(Str.trim(run.stdout));

	assert.strictEqual(run.exitCode, ok, run.stderr);
	assert.isFalse(holdsKeyPiece(run.stdout), "no key in the JSON");
	assert.deepStrictEqual(step, {
		found: [
			"phi-router found",
			"  Claude Code     Claude Max · you@example.com",
			"  Also found      Anthropic key from ANTHROPIC_API_KEY",
			"",
			"  Everyday work   Claude Max · you@example.com   ✓",
			"  Patient data    pick below",
			"  PHI check       needs an OpenAI key",
		],
		keys: [
			{ prompt: "Anthropic key (BAA):", vendor: "anthropic" },
			{ prompt: "OpenAI key (PHI check):", vendor: "openai" },
		],
		kind: "ready",
	});
}).pipe(Effect.scoped);

const applied = Effect.gen(function* applied() {
	const base = yield* world;
	const of = withEnv({ PHI_ROUTER_ANTHROPIC_KEY: keys.anthropic, PHI_ROUTER_OPENAI_KEY: keys.openai })(base);
	const run = yield* phiRouter(of.env, ["setup", "claude", "--apply", ...answeredKey]);
	const config = yield* writtenConfigOf(of);
	const { anthropic, openai } = keyFiles(of);
	const outside = yield* keysOutsideKeyFiles(of, [run.stdout, run.stderr]);

	assert.strictEqual(run.exitCode, ok, run.stderr);
	assert.strictEqual(lastLine(run.stdout), "Done. Type `/reload-plugins` to turn it on.");
	assert.deepStrictEqual(config, {
		clean: [{ forwarded: true, name: "claude-1", vendor: "anthropic" }],
		judge: { endpoint: "https://api.openai.com/v1", keyFile: openai },
		sealed: [{ keyFile: anthropic, name: "claude-2", scheme: "apiKey", vendor: "anthropic" }],
	});
	assert.deepStrictEqual(outside, [], "no key outside its key file");
}).pipe(Effect.scoped);

const noTerminal = Effect.gen(function* noTerminal() {
	const of = yield* world;
	const before = yield* filesSetupMayChange(of);
	const run = yield* phiRouter(of.env, ["setup", "claude"]);
	const after = yield* filesSetupMayChange(of);

	assert.notStrictEqual(run.exitCode, ok);
	assert.include(
		run.stderr,
		"phi-router setup asks for a key, so it needs your own terminal. Run it yourself, outside your coding agent. Nothing was changed.",
	);
	assert.deepStrictEqual(after, before);
}).pipe(Effect.scoped);

it.layer(layer)("setup with no terminal", (test) => {
	test.effect(
		"setup claude --json prints the next step with the key prompts it needs and no key",
		() => reported,
		patient,
	);
	test.effect(
		"setup claude --apply takes the keys from the environment and writes config.json",
		() => applied,
		patient,
	);
	test.effect(
		"setup with no terminal and no --json or --apply says so and changes nothing",
		() => noTerminal,
		patient,
	);
});
