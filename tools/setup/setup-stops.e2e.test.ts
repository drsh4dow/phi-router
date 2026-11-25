import { Array, Effect, FileSystem, Formatter, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import {
	callsOf,
	lastLine,
	layer,
	maxAnswers,
	ok,
	ownSettings,
	patient,
	setUp,
	tracked,
	withEnv,
	withStatus,
	writeOwnSettings,
} from "./set-up.ts";
import type { PlatformError } from "effect";
import type { World } from "./world.ts";
import { world } from "./world.ts";

interface Stop {
	readonly kind: string;
	readonly given: (of: World) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
	readonly line: string;
	readonly env?: Readonly<Record<string, string>>;
}

const signedInVia = (of: World, apiProvider: string): ReturnType<Stop["given"]> =>
	withStatus(of, Formatter.formatJson({ apiProvider, authMethod: "third_party", loggedIn: true }));

const managed = Effect.fnUntraced(function* managed(of: World, env: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(`${of.root}/managed-settings.json`, Formatter.formatJson({ env }));
});

const userEnv = Effect.fnUntraced(function* userEnv(of: World, env: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.writeFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`, Formatter.formatJson({ env }));
});

const signedOut = Effect.fnUntraced(function* signedOut(of: World) {
	const fs = yield* FileSystem.FileSystem;

	yield* fs.remove(`${of.folders.CLAUDE_CONFIG_DIR}/phi-fake-status.json`);
});

const stops: readonly Stop[] = [
	{
		given: signedOut,
		kind: "Claude Code is not signed in",
		line: "Sign in to Claude Code first with /login. Nothing changed.",
	},
	{
		given: (of) => signedInVia(of, "bedrock"),
		kind: "Claude Code signs in through Bedrock",
		line: "phi-router doesn't support Bedrock yet. Nothing changed.",
	},
	{
		given: (of) => signedInVia(of, "vertex"),
		kind: "Claude Code signs in through Vertex AI",
		line: "phi-router doesn't support Vertex AI yet. Nothing changed.",
	},
	{
		given: (of) => signedInVia(of, "foundry"),
		kind: "Claude Code signs in through Foundry",
		line: "phi-router doesn't support Foundry yet. Nothing changed.",
	},
	{
		given: (of) => userEnv(of, { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" }),
		kind: "Claude Code's settings.json sends it to another gateway",
		line: "phi-router doesn't work with your gateway (llm-gateway.example.com) yet. Nothing changed.",
	},
	{
		env: { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" },
		given: () => Effect.void,
		kind: "the shell that runs setup sends Claude Code to another gateway",
		line: "phi-router doesn't work with your gateway (llm-gateway.example.com) yet. Nothing changed.",
	},
	{
		given: (of) =>
			managed(of, { ANTHROPIC_BASE_URL: "https://phi-test-user:phi-test-secret@llm-gateway.example.com:8443/v1" }),
		kind: "managed settings send Claude Code to a gateway whose address holds a login",
		line: "phi-router doesn't work with your company's gateway (llm-gateway.example.com) yet. Nothing changed.",
	},
	{
		given: (of) => managed(of, { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com/v1" }),
		kind: "managed settings send Claude Code to a gateway",
		line: "phi-router doesn't work with your company's gateway (llm-gateway.example.com) yet. Nothing changed.",
	},
	{
		given: (of) => managed(of, { CLAUDE_CODE_USE_VERTEX: "1" }),
		kind: "managed settings switch Claude Code to Vertex AI",
		line: "phi-router doesn't support Vertex AI yet. Nothing changed.",
	},
	{
		given: (of) => managed(of, { CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" }),
		kind: "managed settings switch Claude Code to CLAUDE_CODE_USE_ANTHROPIC_AWS",
		line: "phi-router doesn't support CLAUDE_CODE_USE_ANTHROPIC_AWS yet. Nothing changed.",
	},
	{
		given: (of) => userEnv(of, { CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "true" }),
		kind: "Claude Code's settings.json switches it to CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
		line: "phi-router doesn't support CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD yet. Nothing changed.",
	},
	{
		env: { CLAUDE_CODE_USE_MANTLE: "1" },
		given: () => Effect.void,
		kind: "the shell that runs setup switches Claude Code to CLAUDE_CODE_USE_MANTLE",
		line: "phi-router doesn't support CLAUDE_CODE_USE_MANTLE yet. Nothing changed.",
	},
	{
		given: (of) => userEnv(of, { CLAUDE_CODE_USE_GATEWAY: "1" }),
		kind: "Claude Code's settings.json switches it to CLAUDE_CODE_USE_GATEWAY",
		line: "phi-router doesn't support CLAUDE_CODE_USE_GATEWAY yet. Nothing changed.",
	},
	{
		given: (of) =>
			withStatus(of, Formatter.formatJson({ apiProvider: "firstParty", authMethod: "api_key", loggedIn: true })),
		kind: "Claude Code signs in with an API key",
		line: "You don't need phi-router. It keeps patient data off a subscription with no BAA, and you're on an API key. Nothing changed.",
	},
];

const stopped = Effect.fnUntraced(function* stopped({ env = {}, given, line }: Stop) {
	const made = yield* world;
	const of = withEnv(env)(made);

	yield* given(of);

	const { after, before, run } = yield* tracked(of, ["setup", "claude"], []);

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.strictEqual(lastLine(run.shown), line, run.shown);
	assert.notInclude(run.shown, "❯", "no question");
	assert.notInclude(run.shown, "key (", "no key prompt");
	assert.notInclude(run.shown, "phi-test-secret", "no part of the gateway's login");
	assert.deepStrictEqual(after, before, "every file setup may change is byte for byte the same");
}, Effect.scoped);

const projectSettings = Effect.fnUntraced(function* projectSettings(of: World) {
	const fs = yield* FileSystem.FileSystem;
	const settings = Formatter.formatJson({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } });

	yield* fs.makeDirectory(`${of.project}/.claude`);
	yield* fs.writeFileString(`${of.project}/.claude/settings.json`, settings);
});

const failedLines = (shown: string): readonly string[] =>
	pipe(Str.split("\n")(shown), Array.filter(Str.startsWith("✗ ")), Array.filter(Str.includes("ANTHROPIC_BASE_URL")));

const projectMovedOff = Effect.gen(function* projectMovedOff() {
	const fs = yield* FileSystem.FileSystem;
	const of = yield* world;

	yield* writeOwnSettings(of);
	yield* projectSettings(of);

	const run = yield* setUp(of, "claude", maxAnswers);
	const settings = yield* fs.readFileString(`${of.folders.CLAUDE_CONFIG_DIR}/settings.json`);
	const calls = yield* callsOf(of, "claude");

	assert.notStrictEqual(run.exitCode, ok, run.shown);
	assert.isNotEmpty(failedLines(run.shown), run.shown);
	assert.strictEqual(
		lastLine(run.shown),
		"The test failed, so Claude Code was left as it was. Your key is saved. For details, run: npx phi-router doctor claude",
	);
	assert.strictEqual(settings, ownSettings, "Claude Code's settings.json as it was");
	assert.deepStrictEqual(calls, ["test"], "nothing installed");
}).pipe(Effect.scoped);

it.layer(layer)("setup stops", (test) => {
	test.effect.each(stops)("setup stops before any change when $kind, and its last line says so", stopped, patient);
	test.effect(
		"a project's .claude/settings.json that sets ANTHROPIC_BASE_URL fails the test with a line naming it, and nothing is installed or switched on",
		() => projectMovedOff,
		patient,
	);
});
