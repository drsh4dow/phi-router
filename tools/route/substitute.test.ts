import { Array, Effect, Option, Schema, Stream, Struct, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import {
	autoOf,
	clean,
	harnessNames,
	holdsCanary,
	linesIn,
	modelsIn,
	phi,
	posted,
	sentModels,
} from "./target-models.ts";
import type { AccountScript } from "./harnesses.ts";
import type { HarnessName } from "./target-models.ts";
import { NodeServices } from "@effect/platform-node";
import type { Turn } from "./mocked-router.ts";
import type { VerdictStore } from "#router/client/verdict-store.ts";
import { fakes } from "./harnesses.ts";
import { routed } from "./mocked-router.ts";
import { textEvents } from "#router/client/mock-upstreams/index.ts";

const ok = 200;

const substitute = "sealed-under-test";

const answered: Turn = { role: "assistant", text: "ok" };

const failed = 500;

const limited: AccountScript = () => ({ body: "{}", kind: "status", status: 429 });

const answering: AccountScript = () => ({ events: Stream.fromIterable(textEvents(["ok"])), kind: "events" });

const vendorOf: Readonly<Record<HarnessName, "anthropic" | "openai">> = {
	claude: "anthropic",
	codex: "openai",
	pi: "anthropic",
};

const modelsOf = {
	anthropic: { carried: sentModels.claudeHaiku, lacked: sentModels.claudeSonnet },
	openai: { carried: sentModels.codexMemories, lacked: sentModels.codexReviewer },
} as const;

/**
 * A canary request keeps a model its BAA account carries and gets the substitute for one it lacks, which its lane log
 * line names, `phi/auto` too when the account lacks the target model. The next request of that session, clean, runs
 * the model it named on the open account.
 */
const sealedModels = Effect.fnUntraced(function* sealedModels(harness: HarnessName) {
	const vendor = vendorOf[harness];
	const { carried, lacked } = modelsOf[vendor];

	const { mocks, post, state } = yield* routed({
		configExtras: { sealedModel: { [vendor]: substitute } },
		harness,
		holdsPhi: holdsCanary,
		lacks: [[sentModels.gatewayWithSlash, lacked, fakes.targetModel]],
	});

	const statuses = [
		yield* posted(post, { harness, model: carried, session: "carried-1" }, [phi]),
		yield* posted(post, { harness, model: lacked, session: "lacked-1" }, [phi]),
		yield* posted(post, { harness, model: lacked, session: "lacked-1" }, [phi, answered, clean]),
		yield* posted(post, { harness, model: autoOf[harness], session: "auto-1" }, [phi]),
	];

	const sealed = yield* mocks.baa.received.pipe(Effect.flatMap(modelsIn));
	const openedSent = yield* mocks.open.received;
	const opened = yield* modelsIn(openedSent);
	const lines = yield* linesIn(state);

	assert.deepStrictEqual<unknown>(
		{
			lines,
			opened,
			openedCanary: pipe(
				openedSent,
				Array.some(({ body }) => holdsCanary(body)),
			),
			sealed,
			statuses,
		},
		{
			lines: [
				["baa", "sealed", carried, false, "sealed new content"],
				["baa", "sealed", substitute, true, "sealed new content"],
				["open", "clean", lacked, false, "clean"],
				["baa", "sealed", substitute, true, "sealed new content"],
			],
			opened: [lacked],
			openedCanary: false,
			sealed: [carried, substitute, substitute],
			statuses: [ok, ok, ok, ok],
		},
	);
});

/** With no `sealedModel` for the vendor, the substitute is its target model. */
const targetAsSubstitute = Effect.gen(function* targetAsSubstitute() {
	const { mocks, post, state } = yield* routed({ holdsPhi: holdsCanary, lacks: [[sentModels.claudeHaiku]] });

	yield* posted(post, { harness: "claude", model: sentModels.claudeHaiku, session: "default-1" }, [phi]);

	const sealed = yield* mocks.baa.received.pipe(Effect.flatMap(modelsIn));
	const lines = yield* linesIn(state);

	assert.deepStrictEqual<unknown>(
		{ lines, sealed },
		{ lines: [["baa", "sealed", fakes.targetModel, true, "sealed new content"]], sealed: [fakes.targetModel] },
	);
});

const unreadable = Effect.flatMap(Schema.decodeUnknownEffect(Schema.Finite)("unreadable"), () => Effect.die("read"));

const unsentSession = "unsent-1";

const onArrival = 1;

const readsFailing =
	(pinned: boolean) =>
	(real: VerdictStore["Service"]): VerdictStore["Service"] => {
		const reads = { unsent: 0 };

		return Struct.assign(real, {
			read: (session: string, policy: string) =>
				Effect.suspend(() => {
					const read = Effect.andThen(
						Effect.when(real.pin(session, policy, true), Effect.succeed(pinned)),
						real.read(session, policy),
					);

					if (session !== unsentSession) {
						return read;
					}

					reads.unsent += 1;

					if (reads.unsent > onArrival) {
						return unreadable;
					}

					return read;
				}),
		});
	};

interface Unsent {
	readonly line: Option.Option<readonly (string | boolean)[]>;
	readonly sent: number;
	readonly status: number;
}

const unsentAs = (line: readonly (string | boolean)[]): Unsent => ({
	line: Option.some(line),
	sent: 0,
	status: failed,
});

/**
 * The line of a request whose store read fails on its walk, so no account receives it: the model and substitute flag
 * of the account the walk starts at. A clean request starts at the open account, one whose open account an earlier
 * request stamped at the BAA account, and a pinned one at the BAA account, which lacks the model.
 */
const unsent = Effect.gen(function* unsent() {
	const lineOf = Effect.fnUntraced(function* lineOf(of: {
		readonly open: AccountScript;
		readonly pinned: boolean;
		readonly stamp: boolean;
	}) {
		const run = yield* routed({
			configExtras: { sealedModel: { anthropic: substitute } },
			holdsPhi: holdsCanary,
			lacks: [[sentModels.claudeHaiku]],
			open: of.open,
			store: readsFailing(of.pinned),
		});

		const stamping = posted(run.post, { harness: "claude", model: sentModels.claudeHaiku, session: "stamping-1" }, [
			clean,
		]);

		yield* Effect.when(stamping, Effect.succeed(of.stamp));

		const unsentPost = posted(
			run.post,
			{ harness: "claude", model: sentModels.claudeHaiku, session: unsentSession },
			[clean],
		);

		const before = yield* run.mocks.accounts;
		const status = yield* unsentPost;
		const after = yield* run.mocks.accounts;

		const lines = yield* linesIn(run.state);

		return { line: Array.last(lines), sent: Array.flatten(after).length - Array.flatten(before).length, status };
	});

	const fromOpen = yield* lineOf({ open: answering, pinned: false, stamp: false });
	const fromStamped = yield* lineOf({ open: limited, pinned: false, stamp: true });
	const fromPinned = yield* lineOf({ open: answering, pinned: true, stamp: false });

	assert.deepStrictEqual<unknown>(
		{ fromOpen, fromPinned, fromStamped },
		{
			fromOpen: unsentAs(["open", "clean", sentModels.claudeHaiku, false, "router failure"]),
			fromPinned: unsentAs(["baa", "sealed", substitute, true, "pinned"]),
			fromStamped: unsentAs(["baa", "sealed", substitute, true, "router failure"]),
		},
	);
});

it.layer(NodeServices.layer)("the substitute", (test) => {
	test.effect.each(harnessNames)(
		"%s: a canary request keeps a model the BAA account carries, gets the substitute for one it lacks, which its line names, and the next clean request runs the model it named",
		sealedModels,
	);
	test.effect(
		"is the target model when a BAA account lacks the model and no sealedModel is set",
		() => targetAsSubstitute,
	);
	test.effect(
		"is named on the line of a request no account received exactly when the account its walk starts at lacks the model",
		() => unsent,
	);
});
