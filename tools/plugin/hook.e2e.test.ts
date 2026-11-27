import { Array, Effect, FileSystem, Layer, Option, String as Str, pipe } from "effect";
import type { Blocking, Event, Harness, ModelAddress } from "./session-hook.ts";
import { answers, leasesIn, refusedWithin } from "#tools/lifecycle/launched.ts";
import { assert, it } from "@effect/vitest";
import { blockedBy, hookInputs, hooked, loopback, unset } from "./session-hook.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import { squatter } from "#tools/lifecycle/squatter.ts";
import { stopped } from "#tools/route/stopped.ts";

const patient = { timeout: 60_000 };

const fifteenSeconds = 15_000;

const hookInput = hookInputs.SessionStart;

const quiet = ["", "", "0\n"];

const leased = Effect.fnUntraced(function* leased(
	harness: Harness,
	event: Event,
	installed: (port: number) => ModelAddress = unset,
) {
	const hook = yield* hooked({
		event,
		harness,
		instanceAddress: loopback,
		stdin: hookInputs[event],
		userSettingsAddress: installed,
	});

	assert.deepStrictEqual(hook.printed, quiet);

	const leases = yield* leasesIn(hook.state);
	const listening = yield* answers(hook.port);

	assert.deepStrictEqual(
		{ leases, listening },
		{ leases: [{ folder: "/work", pid: hook.pid, session: "s-hook" }], listening: true },
		"the router at the hook's address holds the lease",
	);

	yield* hook.end;
	yield* TestClock.withLive(refusedWithin(hook.port, fifteenSeconds));
}, Effect.scoped);

interface Unaddressed {
	readonly addressed: (port: number) => ModelAddress;
	readonly installed?: (port: number) => ModelAddress;
	readonly env?: Readonly<Record<string, string>>;
	readonly what: string;
}

const unaddressed: readonly Unaddressed[] = [
	{ addressed: unset, what: "no model address" },
	{
		addressed: (port: number): ModelAddress => Option.some(`http://localhost:${String(port)}`),
		what: "a localhost model address",
	},
	{ addressed: unset, env: { CLAUDE_CODE_USE_BEDROCK: "1" }, what: "no model address and a provider switch on" },
	{
		addressed: (): ModelAddress => Option.some("https://gateway.example"),
		installed: (): ModelAddress => Option.some("https://own-gateway.example"),
		what: "user settings and a model address that name other gateways than a router",
	},
];

const unprotected = Effect.fnUntraced(function* unprotected(unrouted: Unaddressed) {
	const fs = yield* FileSystem.FileSystem;

	const hook = yield* hooked({
		event: "SessionStart",
		harness: "claude",
		instanceAddress: unrouted.addressed,
		instanceEnv: unrouted.env ?? {},
		stdin: hookInput,
		userSettingsAddress: unrouted.installed ?? unset,
	});

	const listening = yield* answers(hook.port);
	const registered = yield* fs.exists(`${hook.state}/leases.json`);

	assert.deepStrictEqual(
		{ listening, printed: hook.printed, registered },
		{ listening: false, printed: quiet, registered: false },
	);
}, Effect.scoped);

const squatted = Effect.fnUntraced(function* squatted([harness, event]: readonly [Harness, Blocking]) {
	const other = yield* squatter;

	const hook = yield* hooked({
		event,
		harness,
		instanceAddress: () => loopback(other.port),
		stdin: hookInputs[event],
	});

	const [, stderr] = hook.printed;
	const received = yield* other.received;

	assert.deepStrictEqual(
		{
			blocked: blockedBy({ event, harness, hook: hook.hook, printed: hook.printed }),
			received,
			refused: Str.includes("the port does not hold your router")(stderr),
		},
		{ blocked: true, received: ["GET /phi-router/proof"], refused: true },
		"the harness blocks the prompt or compaction, the developer reads why, and the listener got the nonce request alone",
	);
}, Effect.scoped);

const keyless = Effect.fnUntraced(function* keyless(harness: Harness) {
	const fs = yield* FileSystem.FileSystem;
	const config = yield* fs.makeTempDirectoryScoped({ prefix: "phi-hook-config-" });
	const event = "UserPromptSubmit";

	const hook = yield* hooked({
		event,
		harness,
		instanceAddress: loopback,
		instanceEnv: { XDG_CONFIG_HOME: config },
		stdin: hookInputs[event],
	});

	const [, stderr] = hook.printed;

	assert.deepStrictEqual(
		{ blocked: blockedBy({ event, harness, hook: hook.hook, printed: hook.printed }), stderr },
		{ blocked: true, stderr: `${stopped.noBaaKey(harness)}\n` },
		"the harness blocks the prompt, and its block reason is the line alone",
	);
}, Effect.scoped);

const unreadable = Effect.gen(function* unreadable() {
	const hook = yield* hooked({
		event: "SessionStart",
		harness: "claude",
		instanceAddress: loopback,
		stdin: "not json",
	});

	const [stdout, , exitCode] = hook.printed;

	assert.deepStrictEqual({ failed: exitCode !== "0\n", stdout }, { failed: true, stdout: "" });
}).pipe(Effect.scoped);

const everyLeasing = [
	["claude", "SessionStart"],
	["claude", "UserPromptSubmit"],
	["codex", "SessionStart"],
	["codex", "UserPromptSubmit"],
	["claude", "PreCompact"],
	["codex", "PreCompact"],
] as const;

const leasing = pipe(
	everyLeasing,
	Array.filter(([harness]) => harness === "claude" || process.platform !== "win32"),
);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("the plugin's hooks", (test) => {
	test.effect.each(leasing)(
		"for %s's %s hook, with a router's model address, and proxies set that the router's address is not an exception of, proves the router, leases the instance with its session and folder, prints nothing, and the router ends with it",
		([harness, event]) => leased(harness, event),
		patient,
	);
	test.effect.each([
		["claude", "UserPromptSubmit"],
		["codex", "UserPromptSubmit"],
		["claude", "PreCompact"],
		["codex", "PreCompact"],
	] as const)("for %s, the %s hook blocks when another user's listener holds the port", squatted, patient);
	test.effect.each(["claude", "codex"] as const)(
		"for %s, the UserPromptSubmit hook blocks with the line that names its setup command when config.json does not exist",
		keyless,
		patient,
	);
	test.effect(
		"for claude's UserPromptSubmit hook, with the model address Claude Code's user settings hold, leases the instance",
		() => leased("claude", "UserPromptSubmit", loopback),
		patient,
	);
	test.effect.each(unaddressed)("with $what, exits 0, prints nothing and starts no router", unprotected, patient);
	test.effect(
		"with stdin that is not a hook's JSON, exits non-zero with nothing on stdout",
		() => unreadable,
		patient,
	);
});
