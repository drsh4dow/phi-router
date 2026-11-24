import { Array, Effect, Option, Redacted, String as Str } from "effect";
import { assert, it } from "@effect/vitest";
import { baaAsk, isYes, misfitOf, refusalOf } from "./keys.ts";
import { KeyChecks } from "#router/client/keys/index.ts";

const answers = [
	{ answer: "accepted", refused: false },
	{ answer: "refused", refused: true },
	{ answer: "unanswered", refused: true },
] as const;

it.effect.each(answers)(
	"a key check that is $answer refuses the key: $refused, in copy that never shows it",
	({ answer, refused }) =>
		Effect.gen(function* checked() {
			const key = "sk-ant-api03-phi-test-key";
			const refusal = yield* refusalOf("anthropic", Redacted.make(key));

			assert.deepStrictEqual(
				{ refused: Option.isSome(refusal), shown: Option.exists(refusal, Str.includes(key)) },
				{ refused, shown: false },
			);
		}).pipe(Effect.provideService(KeyChecks, KeyChecks.of({ check: () => Effect.succeed(answer) }))),
);

const pasted = [
	{ key: "sk-ant-api03-phi-test-key", refused: false, what: "an Anthropic API key" },
	{ key: "sk-ant-oat01-phi-test-token", refused: true, what: "a subscription token" },
	{ key: "sk-proj-phi-test-key", refused: true, what: "an OpenAI key" },
	{ key: "sk-ant-phi-test-new-kind", refused: false, what: "an Anthropic key of no known kind" },
	{ key: "phi-test-no-known-prefix", refused: false, what: "a key of no known prefix" },
];

it.effect.each(pasted)(
	"setup refuses $what by its prefix before the vendor sees it: $refused, in copy that never shows it",
	({ key, refused }) =>
		Effect.sync(() => {
			const misfit = misfitOf({ ask: baaAsk({ harnessTitle: "Claude Code", vendor: "anthropic" }), key });

			assert.deepStrictEqual(
				{ refused: Option.isSome(misfit), shown: Option.exists(misfit, Str.includes(key)) },
				{ refused, shown: false },
			);
		}),
);

it.effect("only a typed yes takes pi's key, so the input's end is No", () =>
	Effect.sync(() => {
		assert.deepStrictEqual(Array.map([Option.some(" Yes "), Option.none()], isYes), [true, false]);
	}),
);
