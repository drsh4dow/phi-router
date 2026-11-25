import { Effect, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyFor, clean, pinnedModelOf } from "./target-models.ts";
import type { AccountScript } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { harnesses } from "./harnesses.ts";
import { routed } from "./mocked-router.ts";
import { stopped } from "./stopped.ts";

const status = { unauthorized: 401, unreadable: 400 } as const;

const unauthorized = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

const refusesKey: AccountScript = () => ({ body: unauthorized, kind: "status", status: status.unauthorized });

const ErrorMessage = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }));

type Harness = "claude" | "codex" | "pi";

const keyRefused = Effect.fnUntraced(function* keyRefused(harness: Harness) {
	const { mocks, post } = yield* routed({
		baas: [refusesKey, harnesses[harness].answersOk.baa],
		harness,
		holdsPhi: () => false,
	});

	const body = yield* bodyFor({ harness, model: pinnedModelOf[harness] }, [clean]);
	const response = yield* post({ body, session: "key-refused" });
	const { error } = yield* response.text.pipe(Effect.flatMap(Schema.decodeEffect(ErrorMessage)));
	const [open = [], baa = [], nextBaa = []] = yield* mocks.accounts;

	assert.deepStrictEqual(
		{ asked: baa.length, message: error.message, nextBaa, open, status: response.status },
		{ asked: 1, message: stopped.baaKeyRefused(harness), nextBaa: [], open: [], status: status.unreadable },
		"the harness reads the line in its vendor's error shape, and neither the next BAA account nor an open account receives the request",
	);
});

it.layer(NodeServices.layer)("a BAA account that refuses its key", (test) => {
	test.effect.each(["claude", "codex", "pi"] as const)(
		"for %s, a BAA account's 401 to a pinned request stops the message with the line that names its setup command",
		keyRefused,
	);
});
