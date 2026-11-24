import { Array, Effect, Layer, Option, String as Str, pipe } from "effect";
import type { Blocking, ModelAddress } from "./session-hook.ts";
import { assert, it } from "@effect/vitest";
import { blockedBy, hookInputs, hooked, loopback, unset } from "./session-hook.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { answers } from "#tools/lifecycle/launched.ts";
import { squatter } from "#tools/lifecycle/squatter.ts";

const patient = { timeout: 60_000 };

const credential = "phi-38-fake-login";

const movedOff = (setting: string): ((stderr: string) => boolean) =>
	Str.includes(`${setting} moves this Claude Code session off the router`);

const moved = Effect.fnUntraced(function* moved([event, path]: readonly [Blocking, string]) {
	const other = yield* squatter;

	const hook = yield* hooked({
		addressed: () => Option.some(`http://127.0.0.1:${String(other.port)}${path}`),
		env: { ANTHROPIC_AUTH_TOKEN: credential },
		event,
		harness: "claude",
		installed: loopback,
		stdin: hookInputs[event],
	});

	const [, stderr] = hook.printed;
	const printedCredential = pipe(hook.printed, Array.some(Str.includes(credential)));
	const received = yield* other.received;
	const listening = yield* answers(hook.port);

	assert.deepStrictEqual(
		{
			blocked: blockedBy({ event, harness: "claude", hook: hook.hook, printed: hook.printed }),
			listening,
			named: movedOff("ANTHROPIC_BASE_URL")(stderr),
			printedCredential,
			received,
		},
		{ blocked: true, listening: false, named: true, printedCredential: false, received: [] },
		"Claude Code holds the prompt or compaction back, the developer reads which setting moved it without the login, and neither the other listener nor a router got a request",
	);
}, Effect.scoped);

interface Switched {
	readonly event: Blocking;
	readonly installed: (port: number) => ModelAddress;
	readonly name: string;
	readonly value: string;
}

const switches: readonly Switched[] = [
	{ event: "UserPromptSubmit", installed: loopback, name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
	{ event: "UserPromptSubmit", installed: loopback, name: "CLAUDE_CODE_USE_VERTEX", value: "true" },
	{ event: "PreCompact", installed: unset, name: "CLAUDE_CODE_USE_VERTEX", value: " On " },
];

const switched = Effect.fnUntraced(function* switched(on: Switched) {
	const hook = yield* hooked({
		addressed: loopback,
		env: { [on.name]: on.value },
		event: on.event,
		harness: "claude",
		installed: on.installed,
		stdin: hookInputs[on.event],
	});

	const [, stderr] = hook.printed;
	const listening = yield* answers(hook.port);

	assert.deepStrictEqual(
		{
			blocked: blockedBy({ event: on.event, harness: "claude", hook: hook.hook, printed: hook.printed }),
			listening,
			named: movedOff(on.name)(stderr),
		},
		{ blocked: true, listening: false, named: true },
		"Claude Code holds the prompt or compaction back, the developer reads which switch moved it, and no router started",
	);
}, Effect.scoped);

it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))("a repository's Claude Code settings", (test) => {
	test.effect.each([
		["UserPromptSubmit", ""],
		["UserPromptSubmit", "/project"],
		["PreCompact", "/project"],
	] as const)(
		"for claude, the %s hook blocks when the session's model address is another listener's, with path %j, and not the one Claude Code's user settings hold",
		moved,
		patient,
	);
	test.effect.each(switches)("for claude, the $event hook blocks when $name is $value", switched, patient);
});
