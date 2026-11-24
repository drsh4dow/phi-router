import { Array, Effect, Option, Predicate, Record, pipe } from "effect";
import { assert, it } from "@effect/vitest";
import { clean, holdsCanary, phi, posted } from "./target-models.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { isClaudeJudgeCall } from "#router/client/mock-upstreams/index.ts";
import { routed } from "./mocked-router.ts";

const none = 0;

const once = 1;

const judgedOnBaa = Effect.gen(function* judgedOnBaa() {
	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary, judgeName: "claude" });

	yield* posted(post, { harness: "claude", model: "phi/auto", session: "claude-judge-1" }, [clean]);
	yield* posted(post, { harness: "claude", model: "phi/auto", session: "claude-judge-2" }, [phi]);

	const opened = yield* mocks.open.received;
	const received = yield* mocks.baa.received;
	const judgeCalls = pipe(received, Array.filter(isClaudeJudgeCall));
	const sealed = pipe(received, Array.filter(Predicate.not(isClaudeJudgeCall)));
	const judged = yield* mocks.judge.received;

	assert.deepStrictEqual(
		{
			judgeCalls: Array.isReadonlyArrayNonEmpty(judgeCalls),
			judged: judged.length,
			opened: opened.length,
			sealed: sealed.length,
		},
		{ judgeCalls: true, judged: none, opened: once, sealed: once },
	);
});

const versionOf = Array.map(({ headers }: Sent) => Record.get(headers, "anthropic-version"));

const versioned = Effect.gen(function* versioned() {
	const { mocks, post } = yield* routed({ holdsPhi: holdsCanary });

	yield* posted(post, { harness: "claude", model: "phi/auto", session: "versioned-1" }, [clean]);
	yield* posted(post, { harness: "claude", model: "phi/auto", session: "versioned-2" }, [phi]);

	const opened = yield* mocks.open.received;
	const sealed = yield* mocks.baa.received;

	assert.deepStrictEqual(
		{ opened: versionOf(opened), sealed: versionOf(sealed) },
		{ opened: [Option.some("2023-06-01")], sealed: [Option.some("2023-06-01")] },
	);
});

it.layer(NodeServices.layer)("an Anthropic account", (test) => {
	test.effect(
		"that is the first BAA account answers the Claude judge's calls by holdsPhi, and the judge mock gets none",
		() => judgedOnBaa,
	);

	test.effect("receives the anthropic-version Claude Code sends", () => versioned);
});
