import type { AccountScript, Scripts } from "./harnesses.ts";
import { Effect, FileSystem, Layer, Stream, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { clean, holdsCanary, leased, linesIn, modelsIn, phi, posted, sentModels } from "./target-models.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { SessionRequests } from "#router/client/router-port/index.ts";
import type { Turn } from "./mocked-router.ts";
import { fakes } from "./harnesses.ts";
import { routed } from "./mocked-router.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const substitute = "sealed-under-test";

const failing: AccountScript = () => ({ body: "{}", kind: "status", status: 500 });

const answering: AccountScript = () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const session = "order-1";

const lacksFirst = [[sentModels.claudeHaiku], []];

const statusOn = Effect.fnUntraced(function* statusOn(url: string) {
	const requests = yield* SessionRequests;

	return yield* requests.status(Number(new URL(url).port), session);
});

const walkedOver = Effect.fnUntraced(function* walkedOver(of: {
	readonly scripts: Omit<Scripts, "holdsPhi" | "configExtras">;
	readonly turn: Turn;
	readonly leasedInRepo: boolean;
	readonly model?: string;
	readonly pinnedByLine?: true;
}) {
	const fs = yield* FileSystem.FileSystem;
	const repo = yield* Effect.flatMap(fs.makeTempDirectoryScoped({ prefix: "phi-router-repo-" }), fs.realPath);

	const configExtras = { baaRepos: [repo], sealedModel: { anthropic: substitute } };
	const run = yield* routed(Struct.assign(of.scripts, { configExtras, holdsPhi: holdsCanary }));

	yield* Effect.when(leased(run.state, session, repo), Effect.succeed(of.leasedInRepo));

	yield* posted(
		run.post,
		{ harness: "claude", model: of.model ?? sentModels.claudeHaiku, pinnedByLine: of.pinnedByLine === true, session },
		[of.turn],
	);

	const models = yield* Effect.andThen(run.mocks.accounts, (received) =>
		Effect.forEach(received, modelsIn, { concurrency: 1 }),
	);

	const lines = yield* linesIn(run.state);
	const { last } = yield* statusOn(run.url);

	return { last, lines, models };
});

const atCarrier = [[], [], [sentModels.claudeHaiku]];

const heldCarryingFirst = Effect.gen(function* heldCarryingFirst() {
	const pinned = yield* walkedOver({
		leasedInRepo: false,
		pinnedByLine: true,
		scripts: { baas: [answering, answering], lacks: lacksFirst },
		turn: clean,
	});

	const inRepo = yield* walkedOver({
		leasedInRepo: true,
		scripts: { baas: [answering, answering], lacks: lacksFirst },
		turn: clean,
	});

	assert.deepStrictEqual<unknown>(
		{ inRepo, pinned },
		{
			inRepo: {
				last: { account: "baa-2", model: sentModels.claudeHaiku, overflow: false, substitute: false },
				lines: [["baa-2", "sealed", sentModels.claudeHaiku, false, "BAA repo"]],
				models: atCarrier,
			},
			pinned: {
				last: { account: "baa-2", model: sentModels.claudeHaiku, overflow: false, substitute: false },
				lines: [["baa-2", "sealed", sentModels.claudeHaiku, false, "pinned"]],
				models: atCarrier,
			},
		},
	);
});

const carryingFirst = Effect.gen(function* carryingFirst() {
	const auto = yield* walkedOver({
		leasedInRepo: false,
		model: "phi/auto",
		pinnedByLine: true,
		scripts: { baas: [answering, answering], lacks: [[fakes.targetModel], []] },
		turn: phi,
	});

	const lacksAnother = yield* walkedOver({
		leasedInRepo: false,
		pinnedByLine: true,
		scripts: { baas: [answering, answering], lacks: [[sentModels.claudeSonnet], []] },
		turn: phi,
	});

	assert.deepStrictEqual<unknown>(
		{ auto, lacksAnother },
		{
			auto: {
				last: { account: "baa-2", model: fakes.targetModel, overflow: false, substitute: false },
				lines: [["baa-2", "sealed", fakes.targetModel, false, "pinned"]],
				models: [[], [], [fakes.targetModel]],
			},
			lacksAnother: {
				last: { account: "baa", model: sentModels.claudeHaiku, overflow: false, substitute: false },
				lines: [["baa", "sealed", sentModels.claudeHaiku, false, "pinned"]],
				models: [[], [sentModels.claudeHaiku], []],
			},
		},
	);
});

const lackingLast = Effect.gen(function* lackingLast() {
	const listedFirst = yield* walkedOver({
		leasedInRepo: false,
		pinnedByLine: true,
		scripts: { baas: [answering, failing], lacks: lacksFirst },
		turn: phi,
	});

	const listedLast = yield* walkedOver({
		leasedInRepo: false,
		pinnedByLine: true,
		scripts: { baas: [failing, answering], lacks: [[], [sentModels.claudeHaiku]] },
		turn: phi,
	});

	const fell = yield* walkedOver({
		leasedInRepo: false,
		scripts: { lacks: [[sentModels.claudeHaiku]], open: failing },
		turn: clean,
	});

	assert.deepStrictEqual<unknown>(
		{ fell, listedFirst, listedLast },
		{
			fell: {
				last: { account: "baa", model: substitute, overflow: true, substitute: true },
				lines: [["baa", "sealed", substitute, true, "overflow"]],
				models: [[sentModels.claudeHaiku], [substitute]],
			},
			listedFirst: {
				last: { account: "baa", model: substitute, overflow: false, substitute: true },
				lines: [["baa", "sealed", substitute, true, "failover"]],
				models: [[], [substitute], [sentModels.claudeHaiku]],
			},
			listedLast: {
				last: { account: "baa-2", model: substitute, overflow: false, substitute: true },
				lines: [["baa-2", "sealed", substitute, true, "failover"]],
				models: [[], [sentModels.claudeHaiku], [substitute]],
			},
		},
	);
});

it.layer(Layer.provideMerge(Layer.mergeAll(SessionRequests.layer, FetchHttpClient.layer), NodeServices.layer))(
	"the sealed walk",
	(test) => {
		test.effect(
			"tries the BAA accounts that carry the target model first in the file's order, for a pinned phi/auto request, keeps an account that lacks only other models in its place, and status names the model with no substitute",
			() => carryingFirst,
		);
		test.effect(
			"tries the BAA accounts that carry the target model first for a pinned and a BAA-repo request, past a healthy one that lacks it",
			() => heldCarryingFirst,
		);
		test.effect(
			"reaches a BAA account that lacks the model only once the carrying ones fail, wherever the file lists it for a pinned request and from a failed open account, runs the substitute there, and status says so",
			() => lackingLast,
		);
	},
);
