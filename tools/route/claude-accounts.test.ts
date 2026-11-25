import { Array, Effect, Option, Record } from "effect";
import { assert, it } from "@effect/vitest";
import { clean, holdsCanary, phi, posted } from "./target-models.ts";
import { NodeServices } from "@effect/platform-node";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { routed } from "./mocked-router.ts";

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
	test.effect("receives the anthropic-version Claude Code sends", () => versioned);
});
