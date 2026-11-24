import { Array, Effect, Option, pipe } from "effect";
import { Rules, firstHit, firstHitOf, identifierKind } from "#router/features/policy/index.ts";
import { assert, it } from "@effect/vitest";
import { DefaultCorpus } from "#tools/corpus/default-corpus.ts";
import { casesOfRun } from "./cases.ts";

it.layer(DefaultCorpus.layer)("the wire run's cases", (test) => {
	test.effect("its canary seals by the SSN rule and by nothing else, so a run without that rule leaks it", () =>
		Effect.gen(function* sealedBySsnRule() {
			const { judgeSeals, phi, tracked } = yield* casesOfRun;
			const hit = yield* Effect.fromOption(firstHit(phi.text));
			const rules = yield* Rules;

			const others = pipe(
				rules,
				Array.filter((rule) => rule.id !== hit.rule),
			);

			assert.strictEqual(hit.kind, identifierKind.socialSecurityNumber);
			assert.isTrue(Option.isNone(firstHitOf(others)(phi.text)));
			assert.isFalse(judgeSeals(phi.text));
			assert.isTrue(Array.isReadonlyArrayNonEmpty(tracked.wholeCanaryTokens));
		}),
	);
});
