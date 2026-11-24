import type { AccountScript, Scripts } from "./harnesses.ts";
import { Effect, FileSystem, Layer, Stream, Struct } from "effect";
import { assert, it } from "@effect/vitest";
import { clean, holdsCanary, leased, linesIn, modelsIn, phi, posted, sentModels } from "./target-models.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { SessionRequests } from "#router/client/router-port/index.ts";
import type { Turn } from "./mocked-router.ts";
import type { VerdictStore } from "#router/client/verdict-store.ts";
import { fakes } from "./harnesses.ts";
import { routed } from "./mocked-router.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const substitute = "sealed-under-test";

const failing: AccountScript = () => ({ body: "{}", kind: "status", status: 500 });

const answering: AccountScript = () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const session = "order-1";

const lacksFirst = [[sentModels.claudeHaiku], []];

const pinnedStore = (real: VerdictStore["Service"]): VerdictStore["Service"] =>
	Struct.assign(real, {
		read: (pinned: string, policy: string) =>
			Effect.andThen(real.pin(pinned, policy, true), real.read(pinned, policy)),
	});

const statusOn = Effect.fnUntraced(function* statusOn(url: string) {
	const requests = yield* SessionRequests;

	return yield* requests.status(Number(new URL(url).port), session);
});

const walkedOver = Effect.fnUntraced(function* walkedOver(of: {
	readonly scripts: Omit<Scripts, "holdsPhi" | "configExtras"> & {
		readonly store?: (real: VerdictStore["Service"]) => VerdictStore["Service"];
	};
	readonly turn: Turn;
	readonly leasedInRepo: boolean;
	readonly model?: string;
}) {
	const fs = yield* FileSystem.FileSystem;
	const repo = yield* Effect.flatMap(fs.makeTempDirectoryScoped({ prefix: "phi-router-repo-" }), fs.realPath);

	const configExtras = { baaRepos: [repo], sealedModel: { anthropic: substitute } };
	const run = yield* routed(Struct.assign(of.scripts, { configExtras, holdsPhi: holdsCanary }));

	yield* Effect.when(leased(run.state, session, repo), Effect.succeed(of.leasedInRepo));
	yield* posted(run.post, { harness: "claude", model: of.model ?? sentModels.claudeHaiku, session }, [of.turn]);

	const models = yield* Effect.andThen(run.mocks.accounts, (received) =>
		Effect.forEach(received, modelsIn, { concurrency: 1 }),
	);

	const lines = yield* linesIn(run.state);
	const { last } = yield* statusOn(run.url);

	return { last, lines, models };
});

const atCarrier = [[], [], [sentModels.claudeHaiku]];

/**
 * A pinned request and one of a BAA repo skip a healthy first BAA account that lacks the model for one that carries
 * it.
 */
const heldCarryingFirst = Effect.gen(function* heldCarryingFirst() {
	const pinned = yield* walkedOver({
		leasedInRepo: false,
		scripts: { baas: [answering, answering], lacks: lacksFirst, store: pinnedStore },
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
				last: { account: "baa-2", model: sentModels.claudeHaiku, substitute: false },
				lines: [["baa-2", "sealed", sentModels.claudeHaiku, false, "BAA repo"]],
				models: atCarrier,
			},
			pinned: {
				last: { account: "baa-2", model: sentModels.claudeHaiku, substitute: false },
				lines: [["baa-2", "sealed", sentModels.claudeHaiku, false, "pinned"]],
				models: atCarrier,
			},
		},
	);
});

/**
 * The sealed walk tries the BAA accounts that carry the target model first, in the file's order, before those that
 * lack it. A canary request skips a healthy first account that lacks the model, and so does `phi/auto` at one that
 * lacks the configured target model. An account that lacks only other models keeps its place.
 */
const carryingFirst = Effect.gen(function* carryingFirst() {
	const sealed = yield* walkedOver({
		leasedInRepo: false,
		scripts: { baas: [answering, answering], lacks: lacksFirst },
		turn: phi,
	});

	const auto = yield* walkedOver({
		leasedInRepo: false,
		model: "phi/auto",
		scripts: { baas: [answering, answering], lacks: [[fakes.targetModel], []] },
		turn: phi,
	});

	const lacksAnother = yield* walkedOver({
		leasedInRepo: false,
		scripts: { baas: [answering, answering], lacks: [[sentModels.claudeSonnet], []] },
		turn: phi,
	});

	assert.deepStrictEqual<unknown>(
		{ auto, lacksAnother, sealed },
		{
			auto: {
				last: { account: "baa-2", model: fakes.targetModel, substitute: false },
				lines: [["baa-2", "sealed", fakes.targetModel, false, "sealed new content"]],
				models: [[], [], [fakes.targetModel]],
			},
			lacksAnother: {
				last: { account: "baa", model: sentModels.claudeHaiku, substitute: false },
				lines: [["baa", "sealed", sentModels.claudeHaiku, false, "sealed new content"]],
				models: [[], [sentModels.claudeHaiku], []],
			},
			sealed: {
				last: { account: "baa-2", model: sentModels.claudeHaiku, substitute: false },
				lines: [["baa-2", "sealed", sentModels.claudeHaiku, false, "sealed new content"]],
				models: atCarrier,
			},
		},
	);
});

/**
 * Once every carrying BAA account fails, the walk reaches a lacking one with the substitute, whether the file lists it
 * first or last, and from a clean request whose open account failed.
 */
const lackingLast = Effect.gen(function* lackingLast() {
	const listedFirst = yield* walkedOver({
		leasedInRepo: false,
		scripts: { baas: [answering, failing], lacks: lacksFirst },
		turn: phi,
	});

	const listedLast = yield* walkedOver({
		leasedInRepo: false,
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
				last: { account: "baa", model: substitute, substitute: true },
				lines: [["baa", "sealed", substitute, true, "failover"]],
				models: [[sentModels.claudeHaiku], [substitute]],
			},
			listedFirst: {
				last: { account: "baa", model: substitute, substitute: true },
				lines: [["baa", "sealed", substitute, true, "failover"]],
				models: [[], [substitute], [sentModels.claudeHaiku]],
			},
			listedLast: {
				last: { account: "baa-2", model: substitute, substitute: true },
				lines: [["baa-2", "sealed", substitute, true, "failover"]],
				models: [[], [sentModels.claudeHaiku], [substitute]],
			},
		},
	);
});

it.layer(Layer.mergeAll(NodeServices.layer, SessionRequests.layer, FetchHttpClient.layer))(
	"the sealed walk",
	(test) => {
		test.effect(
			"tries the BAA accounts that carry the target model first, for a canary and a phi/auto request, and status names the model with no substitute",
			() => carryingFirst,
		);
		test.effect(
			"tries the BAA accounts that carry the target model first for a pinned and a BAA-repo request",
			() => heldCarryingFirst,
		);
		test.effect(
			"reaches a BAA account that lacks the model only once the carrying ones fail, runs the substitute there, and status says so",
			() => lackingLast,
		);
	},
);
