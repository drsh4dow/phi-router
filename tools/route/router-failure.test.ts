import { Array, ConfigProvider, Context, Effect, FileSystem, Layer, Option, Path, String as Str, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, fakes, laneLines, routed } from "./mocked-router.ts";
import { LaneLog } from "#router/client/lane-log.ts";
import { NodeServices } from "@effect/platform-node";
import type { Reply } from "#router/client/mock-upstreams/index.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { jsonText } from "./harnesses.ts";

const canary = "PATIENT-CANARY-TOOL-3H8D";

const answered = (probability: number, choice: string): Reply => ({
	body: {
		answers: [
			{ name: "identifier", probability, type: "predicate" },
			{ choice, confidence: 1, name: "kind", probabilities: [], type: "choice" },
		],
		usage: { input_tokens: 1 },
	},
	kind: "body",
});

const score = { clears: 0, seals: 1 } as const;

const namesKind = (piece: string): Reply => {
	if (Str.includes(canary)(piece)) {
		return answered(score.seals, identifierKind.patientName);
	}

	return answered(score.clears, "none");
};

const tools = [{ description: `Looks up ${canary}.`, input_schema: { type: "object" }, name: "lookup" }];

const text = (said: string): readonly { readonly text: string; readonly type: "text" }[] => [
	{ text: said, type: "text" },
];

const asked = { content: text("Which tools do you have?"), role: "user" } as const;

const postedWithTools = Effect.fnUntraced(function* postedWithTools(
	post: Effect.Success<ReturnType<typeof routed>>["post"],
) {
	const body = yield* jsonText({ max_tokens: 1024, messages: [asked], model: "phi/auto", stream: true, tools });
	const response = yield* post({ body, session: "tools-1" });

	yield* response.text;
});

const unknownCacheControlKey = {
	max_tokens: 1024,
	messages: [
		{ content: [{ cache_control: { note: "x", type: "ephemeral" }, text: "Go on.", type: "text" }], role: "user" },
	],
	model: "phi/auto",
	stream: true,
};

const toolsSealed = Effect.gen(function* toolsSealed() {
	const { post, state } = yield* routed({ holdsPhi: Str.includes(canary), judge: namesKind });

	yield* postedWithTools(post);

	const stray = yield* post({ body: yield* jsonText(unknownCacheControlKey), session: "cache-1" });

	yield* stray.text;

	const lines = yield* laneLines(state);

	assert.deepStrictEqual(
		pipe(
			lines,
			Array.map(({ account, lane, model, reason }) => [account, lane, model, reason]),
		),
		[
			["baa", "sealed", fakes.targetModel, "router failure"],
			["baa", "sealed", fakes.targetModel, "router failure"],
		],
	);
});

const unwritable = Effect.gen(function* unwritable() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { mocks, post, state } = yield* routed({ holdsPhi: () => false });

	yield* fs.makeDirectory(path.join(state, "lanes.jsonl"), { recursive: true });

	const response = yield* post({ body: yield* bodyOf([{ role: "user", text: "Go on." }]), session: "unwritable-1" });

	yield* response.text;

	const [open, baa] = yield* Effect.all([mocks.open.received, mocks.baa.received], { concurrency: 1 });

	assert.deepStrictEqual({ reached: open.length + baa.length, status: response.status }, { reached: 0, status: 500 });
});

const cutShort = Effect.gen(function* cutShort() {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const state = yield* fs.makeTempDirectoryScoped({ prefix: "phi-router-lanes-" });
	const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { XDG_STATE_HOME: state } }));
	const built = yield* Layer.build(Layer.provide(LaneLog.layer, env));
	const log = Context.get(built, LaneLog);
	const append = yield* log.opened("cut-1");

	yield* append({
		account: "baa",
		judgeCost: 0,
		judgeFailures: 0,
		lane: "sealed",
		model: "target",
		reason: "pinned",
		substitute: false,
	});
	yield* fs.writeFileString(path.join(state, "phi-router", "lanes.jsonl"), '{"account":"open","judgeCost":0,"judg', {
		flag: "a",
	});

	const { last } = yield* log.summary("cut-1");

	assert.deepStrictEqual(last, Option.some({ account: "baa", model: "target", overflow: false, substitute: false }));
});

it.layer(NodeServices.layer)("a lane log the router cannot write", (test) => {
	test.effect("fails the request before any account sees it", () => unwritable);
});

it.layer(NodeServices.layer)("a clean body the router cannot build", (test) => {
	test.effect(
		"runs sealed and its line says router failure, for a request whose sealed tool list cannot be stubbed or a block with a cache_control key the codec does not know",
		() => toolsSealed,
	);
});

it.layer(NodeServices.layer)("a lane log a crash cut short", (test) => {
	test.effect("skips the cut line and gives the session's line before it", () => cutShort);
});
