import { Array, Effect, Fiber, FileSystem, Layer, Schema, String as Str, pipe } from "effect";
import type { Harness, World } from "./hooked.ts";
import { assert, it } from "@effect/vitest";
import { hook, session, setUp } from "./hooked.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { TestClock } from "effect/testing";
import { freePort } from "#tools/lifecycle/launched.ts";
import { pluginCopy } from "./copied.ts";
import { silent } from "#tools/route/resetting.ts";

const patient = { timeout: 120_000 };

const Blocked = Schema.fromJsonString(Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }));

const PromptInput = Schema.fromJsonString(
	Schema.Struct({
		cwd: Schema.String,
		hook_event_name: Schema.String,
		prompt: Schema.String,
		session_id: Schema.String,
	}),
);

const inputOf = (prompt: string): Effect.Effect<string, Schema.SchemaError> =>
	Schema.encodeEffect(PromptInput)({ cwd: "/work", hook_event_name: "UserPromptSubmit", prompt, session_id: session });

const submitted = Effect.fnUntraced(function* submitted(
	world: World,
	typed: { readonly harness: Harness; readonly prompt: string; readonly address: string },
) {
	const input = yield* inputOf(typed.prompt);

	return yield* hook(world, { address: typed.address, event: "UserPromptSubmit", harness: typed.harness, input });
});

const blockedWith = Effect.fnUntraced(function* blockedWith(
	world: World,
	typed: { readonly harness: Harness; readonly prompt: string; readonly address?: string },
) {
	const hooked = yield* submitted(world, {
		address: typed.address ?? world.url,
		harness: typed.harness,
		prompt: typed.prompt,
	});

	const { reason } = yield* Schema.decodeEffect(Blocked)(hooked.stdout);

	assert.deepStrictEqual(
		{ exitCode: hooked.exitCode, stderr: hooked.stderr },
		{ exitCode: 0, stderr: "" },
		typed.prompt,
	);

	return Str.split(reason, "\n");
});

const usage = "/phi shows this session's routing, /phi pin pins it to the sealed lane, /phi unpin clears the pin.";

const statusLines = (pin: string): readonly string[] => [
	`phi-router, session ${session}`,
	`Pin: ${pin}`,
	"Last request: none yet",
	"Messages: 0 sealed, 0 cleared",
	"Clean lane: open",
	"Sealed lane: baa",
];

const pinnedAt = Effect.fnUntraced(function* pinnedAt(url: string) {
	const requests = yield* SessionRequests;
	const status = yield* requests.status(Number(new URL(url).port), session);

	return status.pinned;
});

interface Spelling {
	readonly harness: Harness;
	readonly prompt: string;
	readonly lines: readonly string[];
	readonly pinned: boolean;
}

const pins = { off: "off", on: "on, every request runs on the sealed lane" } as const;

const spelled = (harness: Harness, prompt: string, pin: keyof typeof pins): Spelling => ({
	harness,
	lines: statusLines(pins[pin]),
	pinned: pin === "on",
	prompt,
});

const spellings: readonly Spelling[] = [
	spelled("claude", "/phi", "off"),
	spelled("claude", "/phi pin", "on"),
	spelled("claude", "/phi-router:phi unpin", "off"),
	spelled("claude", "/phi-router:phi pin", "on"),
	spelled("claude", "/phi  unpin ", "off"),
	spelled("codex", "phi pin", "on"),
	spelled("codex", "phi", "on"),
	spelled("codex", "/phi unpin", "off"),
];

const answers = Effect.gen(function* answers() {
	const world = yield* setUp;

	const answered = yield* Effect.forEach(
		spellings,
		({ harness, prompt }) =>
			Effect.map(Effect.zip(blockedWith(world, { harness, prompt }), pinnedAt(world.url)), ([lines, pinned]) => ({
				harness,
				lines,
				pinned,
				prompt,
			})),
		{ concurrency: 1 },
	);

	assert.deepStrictEqual(answered, spellings);
}).pipe(Effect.scoped);

const unknownWords = Effect.gen(function* unknownWords() {
	const world = yield* setUp;
	const lines = yield* blockedWith(world, { harness: "claude", prompt: "/phi pinned" });
	const pinned = yield* pinnedAt(world.url);

	assert.deepStrictEqual({ lines, pinned }, { lines: [usage], pinned: false });
}).pipe(Effect.scoped);

const otherPrompts = [
	"say hi",
	"phi is short for protected health information",
	"phi pinned",
	"/phinx",
	"Explain /phi pin to me.",
	"pin",
];

const passes = Effect.fnUntraced(function* passes(harness: Harness) {
	const world = yield* setUp;

	const hooked = yield* Effect.forEach(
		otherPrompts,
		(prompt) => submitted(world, { address: world.url, harness, prompt }),
		{
			concurrency: 1,
		},
	);

	const pinned = yield* pinnedAt(world.url);

	assert.deepStrictEqual(
		{ hooked, pinned },
		{
			hooked: pipe(
				otherPrompts,
				Array.map(() => ({ exitCode: 0, stderr: "", stdout: "" })),
			),
			pinned: false,
		},
	);
}, Effect.scoped);

const unanswered = (asked: {
	readonly command: string;
	readonly port: number;
	readonly why: string;
}): readonly string[] => [
	`phi-router ${asked.command} --port ${String(asked.port)}: ${asked.why}. A protected session starts the router.`,
];

const noRouter = "no router answers there";

const addressOf = (port: number): string => `http://127.0.0.1:${String(port)}`;

const down = Effect.gen(function* down() {
	const world = yield* setUp;
	const port = yield* freePort;
	const quiet = yield* silent;
	const stalledPort = Number(new URL(quiet.endpoint).port);
	const status = yield* blockedWith(world, { address: addressOf(port), harness: "claude", prompt: "/phi" });
	const pinned = yield* blockedWith(world, { address: addressOf(port), harness: "codex", prompt: "phi pin" });
	const stalled = yield* blockedWith(world, { address: addressOf(stalledPort), harness: "claude", prompt: "/phi" });
	const unrouted = yield* blockedWith(world, { address: "", harness: "claude", prompt: "/phi" });

	assert.deepStrictEqual(
		{ pinned, stalled, status, unrouted },
		{
			pinned: unanswered({ command: "pin", port, why: noRouter }),
			stalled: unanswered({
				command: "status",
				port: stalledPort,
				why: "it took a request and gave no answer within 5 seconds",
			}),
			status: unanswered({ command: "status", port, why: noRouter }),
			unrouted: ["phi-router: this instance's model address names no router, so phi-router does not route it."],
		},
	);
}).pipe(Effect.scoped);

const stalledAfterPatience = Effect.gen(function* stalledAfterPatience() {
	const requests = yield* SessionRequests;
	const quiet = yield* silent;
	const port = Number(new URL(quiet.endpoint).port);
	const asking = yield* Effect.forkChild(Effect.flip(requests.status(port, session)));

	yield* quiet.arrived.await;
	yield* TestClock.adjust("5 seconds");

	const failed = yield* Fiber.join(asking);

	assert.deepStrictEqual(failed, { reason: "it took a request and gave no answer within 5 seconds" });
}).pipe(Effect.scoped);

const Blocking = Schema.Struct({ onFailure: Schema.Literal("block") });

const BlockingHook = Schema.Struct({ hooks: Schema.NonEmptyArray(Blocking) });

const PromptHooks = Schema.Struct({ UserPromptSubmit: Schema.Tuple([BlockingHook]) });

/** Claude Code lets a prompt through to the model when its hook fails, unless the hook's entry says to block. */
const FailsClosed = Schema.fromJsonString(Schema.Struct({ hooks: PromptHooks }));

const failsClosed = Effect.gen(function* failsClosed() {
	const fs = yield* FileSystem.FileSystem;
	const copy = yield* pluginCopy;
	const hooks = yield* fs.readFileString(`${copy}/hooks/hooks.json`);
	const command = yield* fs.readFileString(`${copy}/commands/phi.md`);
	const decoded = yield* Schema.decodeEffect(FailsClosed)(hooks).pipe(Effect.isSuccess);

	assert.deepStrictEqual(
		{ decoded, offTheModel: Str.includes("\ndisable-model-invocation: true\n")(command) },
		{ decoded: true, offTheModel: true },
	);
}).pipe(Effect.scoped);

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, SessionRequests.layer))(
	"the plugin's /phi hook",
	(test) => {
		test.effect(
			"answers /phi, /phi pin and /phi unpin in each spelling either harness passes, blocks the prompt, and sets the pin",
			() => answers,
			patient,
		);
		test.effect("answers unknown words with the usage and changes no pin", () => unknownWords, patient);
		test.effect.each(["claude", "codex"] as const)(
			"for %s, lets every other prompt pass and prints nothing",
			passes,
			patient,
		);
		test.effect(
			"blocks /phi with RouterUnanswered's line when no router answers or one never answers, and says so when the address names none",
			() => down,
			patient,
		);
		test.effect(
			"gives up on a router that took the request and never answers after 5 seconds, inside the 10 a hook gets",
			() => stalledAfterPatience,
		);
		test.effect(
			"in Claude Code, blocks the prompt when the hook fails, and keeps /phi out of the model's skills",
			() => failsClosed,
		);
	},
);
