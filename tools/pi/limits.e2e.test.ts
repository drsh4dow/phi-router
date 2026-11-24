import { Array, Effect, Formatter, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { packageCopy, piCli } from "#tools/plugin/copied.ts";
import { NodeServices } from "@effect/platform-node";
import { folder } from "#tools/claude/configured.ts";
import { ran } from "#tools/lifecycle/launched.ts";
import { writePrivately } from "#router/client/private-file.ts";

const patient = { timeout: 120_000 };

interface Shown {
	readonly context: string;
	readonly output: string;
}

const piDefault: Shown = { context: "200K", output: "32K" };

const opus: Shown = { context: "1M", output: "128K" };

interface Named {
	readonly targetModel: { readonly anthropic: string };
	readonly sealedModel?: { readonly anthropic: string };
}

const listedIn = Effect.fnUntraced(function* listedIn(xdg: string) {
	const home = yield* folder("phi-pi-home-");
	const agent = yield* folder("phi-pi-");
	const installed = yield* packageCopy;
	const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", XDG_CONFIG_HOME: xdg };
	const { printed } = yield* ran(["bun", piCli, "--list-models", "--no-extensions", "-e", installed], env);

	const rows = pipe(
		Str.split(printed, "\n"),
		Array.map((line) => Str.split(Str.trim(line), /\s+/u)),
		Array.filter(([provider]) => provider === "phi"),
		Array.map(([, id = "", context = "", output = ""]) => [id, { context, output }] as const),
	);

	return new Map(rows);
});

const configWith = (named: Named): string =>
	Formatter.formatJson({
		clean: [{ keyEnv: "PHI_FAKE_OPEN", name: "open", scheme: "apiKey", vendor: "anthropic" }],
		judge: { endpoint: "http://127.0.0.1:9/v1", keyEnv: "PHI_FAKE_JUDGE" },
		sealed: [{ keyEnv: "PHI_FAKE_BAA", name: "baa", scheme: "apiKey", vendor: "anthropic" }],
		sealedModel: named.sealedModel,
		targetModel: named.targetModel,
	});

const listed = Effect.fnUntraced(function* listed(config: string) {
	const xdg = yield* folder("phi-pi-config-");

	yield* writePrivately(`${xdg}/phi-router/config.json`, config);

	return yield* listedIn(xdg);
}, Effect.scoped);

const unconfigured = folder("phi-pi-config-").pipe(Effect.flatMap(listedIn), Effect.scoped);

const targetOnly = Effect.gen(function* targetOnly() {
	const shown = yield* listed(configWith({ targetModel: { anthropic: "claude-opus-5-5" } }));

	assert.deepStrictEqual(shown.get("claude-opus-5-5"), opus);
	assert.deepStrictEqual(shown.get("auto"), opus);
	assert.deepStrictEqual(shown.get("sealed"), opus);
});

const sealedModel = Effect.gen(function* sealedModel() {
	const shown = yield* listed(
		configWith({ sealedModel: { anthropic: "claude-haiku-4-5" }, targetModel: { anthropic: "claude-opus-5-5" } }),
	);

	assert.deepStrictEqual(shown.get("auto"), opus);
	assert.deepStrictEqual(shown.get("sealed"), shown.get("claude-haiku-4-5"));
	assert.notDeepEqual(shown.get("sealed"), opus);
});

const unknown = Effect.gen(function* unknown() {
	const unlisted = yield* listed(configWith({ targetModel: { anthropic: "claude-unlisted-9" } }));
	const bare = yield* unconfigured;
	const refused = yield* listed(Formatter.formatJson({ targetModel: { anthropic: "claude-opus-5-5" } }));

	assert.deepStrictEqual(unlisted.get("auto"), piDefault);
	assert.deepStrictEqual(unlisted.get("sealed"), piDefault);
	assert.deepStrictEqual(bare.get("auto"), piDefault);
	assert.deepStrictEqual(bare.get("sealed"), piDefault);
	assert.deepStrictEqual(refused.get("auto"), piDefault);
	assert.deepStrictEqual(refused.get("sealed"), piDefault);
});

it.layer(NodeServices.layer)("pi --list-models with the pi package", (test) => {
	test.effect(
		"shows phi/auto and phi/sealed at the target model's limits when config.json names no sealed model",
		() => targetOnly,
		patient,
	);
	test.effect("shows phi/sealed at the sealed model's limits", () => sealedModel, patient);
	test.effect(
		"keeps 200K and 32K for a target model pi's catalog lacks, with no config.json, and with one the router refuses",
		() => unknown,
		patient,
	);
});
