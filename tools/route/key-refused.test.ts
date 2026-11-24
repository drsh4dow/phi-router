import { Effect, Schema, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { bodyOf, routed } from "./mocked-router.ts";
import { codexBodyOf, userMessage } from "./harnesses.ts";
import { NodeServices } from "@effect/platform-node";
import { stopped } from "./stopped.ts";

const canary = "PATIENT-CANARY-7Q4K";

const prompt = `Member ${canary} called.`;

const status = { unauthorized: 401, unreadable: 400 } as const;

const unauthorized = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

const ErrorMessage = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }));

type Harness = "claude" | "codex" | "pi";

const canaryBody = (harness: Harness): Effect.Effect<string> => {
	if (harness === "codex") {
		return codexBodyOf([userMessage(prompt)]);
	}

	return bodyOf([{ role: "user", text: prompt }]);
};

const keyRefused = Effect.fnUntraced(function* keyRefused(harness: Harness) {
	const { mocks, post } = yield* routed({
		baa: () => ({ body: unauthorized, kind: "status", status: status.unauthorized }),
		harness,
		holdsPhi: Str.includes(canary),
	});

	const body = yield* canaryBody(harness);
	const response = yield* post({ body, session: "key-refused" });
	const { error } = yield* response.text.pipe(Effect.flatMap(Schema.decodeEffect(ErrorMessage)));
	const baa = yield* mocks.baa.received;
	const open = yield* mocks.open.received;

	assert.deepStrictEqual(
		{ asked: baa.length, message: error.message, open, status: response.status },
		{ asked: 1, message: stopped.baaKeyRefused(harness), open: [], status: status.unreadable },
		"the harness reads the line in its vendor's error shape, and no open account receives the request",
	);
});

it.layer(NodeServices.layer)("a BAA account that refuses its key", (test) => {
	test.effect.each(["claude", "codex", "pi"] as const)(
		"for %s, a BAA account's 401 stops the message with the line that names its setup command",
		keyRefused,
	);
});
