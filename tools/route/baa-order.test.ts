import { Effect, FileSystem, Layer, Stream, Struct } from "effect";
import type { Script, Scripts } from "./harnesses.ts";
import { assert, it } from "@effect/vitest";
import { clean, holdsCanary, leased, linesIn, modelsIn, named, phi, posted } from "./target-models.ts";
import { FetchHttpClient } from "effect/http";
import { NodeServices } from "@effect/platform-node";
import { SessionRequests } from "#router/client/session-request.ts";
import type { Turn } from "./mocked-router.ts";
import type { VerdictStore } from "#router/client/verdict-store.ts";
import { fakes } from "./harnesses.ts";
import { routed } from "./mocked-router.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const substitute = "sealed-under-test";

const failing: Script = () => ({ body: "{}", kind: "status", status: 500 });

const answering: Script = () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const session = "order-1";

const lacksFirst = [[named.subagent], []];

/**
 * The router's verdict store, with every session pinned.
 *
 * @param {VerdictStore} real The router's own store.
 * @returns {VerdictStore} The store, pinned.
 */
const pinnedStore = (real: VerdictStore["Service"]): VerdictStore["Service"] =>
	Struct.assign(real, {
		read: (pinned: string, policy: string) =>
			Effect.andThen(real.pin(pinned, policy, true), real.read(pinned, policy)),
	});

/** The status of the session the router at `url` reports, as `status` prints it. */
const statusOn = Effect.fnUntraced(function* statusOn(url: string) {
	const requests = yield* SessionRequests;

	return yield* requests.status(Number(new URL(url).port), session);
});

/**
 * What each account received, open first, the lane log line of one request for `model`, else the subagent's, and the
 * last request `status` reports. The configuration lists a BAA repo, and `leasedInRepo` leases the session inside it.
 */
const walkedOver = Effect.fnUntraced(function* walkedOver(of: {
	readonly scripts: Omit<Scripts, "holdsPhi" | "configured"> & {
		readonly store?: (real: VerdictStore["Service"]) => VerdictStore["Service"];
	};
	readonly turn: Turn;
	readonly leasedInRepo: boolean;
	readonly model?: string;
}) {
	const fs = yield* FileSystem.FileSystem;
	const repo = yield* Effect.flatMap(fs.makeTempDirectoryScoped({ prefix: "phi-router-repo-" }), fs.realPath);

	const configured = { baaRepos: [repo], sealedModel: { anthropic: substitute } };
	const run = yield* routed(Struct.assign(of.scripts, { configured, holdsPhi: holdsCanary }));

	yield* Effect.when(leased(run.state, session, repo), Effect.succeed(of.leasedInRepo));
	yield* posted(run.post, { harness: "claude", model: of.model ?? named.subagent, session }, [of.turn]);

	const models = yield* Effect.andThen(run.mocks.accounts, (received) =>
		Effect.forEach(received, modelsIn, { concurrency: 1 }),
	);

	const lines = yield* linesIn(run.state);
	const { last } = yield* statusOn(run.url);

	return { last, lines, models };
});

const atCarrier = [[], [], [named.subagent]];

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
				last: { account: "baa-2", model: named.subagent, substitute: false },
				lines: [["baa-2", "sealed", named.subagent, false, "BAA repo"]],
				models: atCarrier,
			},
			pinned: {
				last: { account: "baa-2", model: named.subagent, substitute: false },
				lines: [["baa-2", "sealed", named.subagent, false, "pinned"]],
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
		scripts: { baas: [answering, answering], lacks: [[named.sonnet], []] },
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
				last: { account: "baa", model: named.subagent, substitute: false },
				lines: [["baa", "sealed", named.subagent, false, "sealed new content"]],
				models: [[], [named.subagent], []],
			},
			sealed: {
				last: { account: "baa-2", model: named.subagent, substitute: false },
				lines: [["baa-2", "sealed", named.subagent, false, "sealed new content"]],
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
		scripts: { baas: [failing, answering], lacks: [[], [named.subagent]] },
		turn: phi,
	});

	const fell = yield* walkedOver({
		leasedInRepo: false,
		scripts: { lacks: [[named.subagent]], open: failing },
		turn: clean,
	});

	assert.deepStrictEqual<unknown>(
		{ fell, listedFirst, listedLast },
		{
			fell: {
				last: { account: "baa", model: substitute, substitute: true },
				lines: [["baa", "sealed", substitute, true, "failover"]],
				models: [[named.subagent], [substitute]],
			},
			listedFirst: {
				last: { account: "baa", model: substitute, substitute: true },
				lines: [["baa", "sealed", substitute, true, "failover"]],
				models: [[], [substitute], [named.subagent]],
			},
			listedLast: {
				last: { account: "baa-2", model: substitute, substitute: true },
				lines: [["baa-2", "sealed", substitute, true, "failover"]],
				models: [[], [named.subagent], [substitute]],
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
