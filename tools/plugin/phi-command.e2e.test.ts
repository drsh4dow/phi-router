import { Array, Effect, Fiber, FileSystem, Layer, Schema, String as Str, Struct, pipe } from "effect";
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
	typed: { readonly harness: Harness; readonly prompt: string; readonly address?: string },
) {
	const input = yield* inputOf(typed.prompt);
	const run = Struct.assign(Struct.omit(typed, ["prompt"]), { event: "UserPromptSubmit" as const, input });

	return yield* hook(world, run);
});

const blockedWith = Effect.fnUntraced(function* blockedWith(
	world: World,
	typed: { readonly harness: Harness; readonly prompt: string; readonly address?: string },
) {
	const hooked = yield* submitted(world, typed);

	const { reason } = yield* Schema.decodeEffect(Blocked)(hooked.stdout);

	assert.deepStrictEqual(
		{ exitCode: hooked.exitCode, stderr: hooked.stderr },
		{ exitCode: 0, stderr: "" },
		typed.prompt,
	);

	return Str.split(reason, "\n");
});

const usage =
	"/phi shows this session's routing. To run work on the BAA account, hand it to the phi-sealed subagent or switch the model to phi/sealed.";

const statusLines = [
	`phi-router, session ${session}`,
	"Last request: none yet",
	"Messages: 0 sealed, 0 cleared",
	"Clean lane: open",
	"Sealed lane: baa",
];

const addressOf = (port: number): string => `http://127.0.0.1:${String(port)}`;

interface Spelling {
	readonly harness: Harness;
	readonly prompt: string;
}

const statusSpellings: readonly Spelling[] = [
	{ harness: "claude", prompt: "/phi" },
	{ harness: "claude", prompt: "/phi-router:phi" },
	{ harness: "codex", prompt: "phi" },
	{ harness: "codex", prompt: "/phi" },
];

const usageSpellings: readonly Spelling[] = [
	{ harness: "claude", prompt: "/phi pin" },
	{ harness: "claude", prompt: "/phi-router:phi pin" },
	{ harness: "claude", prompt: "/phi  unpin " },
	{ harness: "claude", prompt: "/phi pinned" },
	{ harness: "codex", prompt: "phi pin" },
	{ harness: "codex", prompt: "/phi unpin" },
];

const answered = Effect.fnUntraced(function* answered(world: World, address: string, spellings: readonly Spelling[]) {
	return yield* Effect.forEach(
		spellings,
		(spelling) =>
			Effect.map(blockedWith(world, Struct.assign(spelling, { address })), (lines) =>
				Struct.assign(spelling, { lines }),
			),
		{ concurrency: 1 },
	);
});

const answers = Effect.gen(function* answers() {
	const world = yield* setUp;
	const deadPort = yield* freePort;
	const statuses = yield* answered(world, world.routerUrl, statusSpellings);
	const usages = yield* answered(world, addressOf(deadPort), usageSpellings);

	assert.deepStrictEqual(
		{ statuses, usages },
		{
			statuses: pipe(
				statusSpellings,
				Array.map((spelling) => Struct.assign(spelling, { lines: statusLines })),
			),
			usages: pipe(
				usageSpellings,
				Array.map((spelling) => Struct.assign(spelling, { lines: [usage] })),
			),
		},
	);
}).pipe(Effect.scoped);

const otherPrompts = [
	"say hi",
	"phi is short for protected health information",
	"phi unpin",
	"phi pinned",
	"/phinx",
	"Explain /phi pin to me.",
	"pin",
];

const passes = Effect.fnUntraced(function* passes(harness: Harness) {
	const world = yield* setUp;

	const hooked = yield* Effect.forEach(
		otherPrompts,
		(prompt) => submitted(world, { address: world.routerUrl, harness, prompt }),
		{
			concurrency: 1,
		},
	);

	assert.deepStrictEqual(
		hooked,
		pipe(
			otherPrompts,
			Array.map(() => ({ exitCode: 0, stderr: "", stdout: "" })),
		),
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

const down = Effect.gen(function* down() {
	const world = yield* setUp;
	const port = yield* freePort;
	const quiet = yield* silent;
	const stalledPort = Number(new URL(quiet.endpoint).port);
	const status = yield* blockedWith(world, { address: addressOf(port), harness: "claude", prompt: "/phi" });
	const bare = yield* blockedWith(world, { address: addressOf(port), harness: "codex", prompt: "phi" });
	const stalled = yield* blockedWith(world, { address: addressOf(stalledPort), harness: "claude", prompt: "/phi" });
	const unrouted = yield* blockedWith(world, { harness: "claude", prompt: "/phi" });

	assert.deepStrictEqual(
		{ bare, stalled, status, unrouted },
		{
			bare: unanswered({ command: "status", port, why: noRouter }),
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
			"answers /phi with the status and /phi with words with the usage, in each spelling either harness passes, blocks the prompt, and asks no router for the usage",
			() => answers,
			patient,
		);
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
