import { assert, it } from "@effect/vitest";
import { defaultJudgeModel, policyVersion } from "./index.ts";
import { Digest } from "effect/crypto";
import { Effect } from "effect";
import { rules } from "./rules.ts";
import { versionOf } from "./version.ts";

it.layer(Digest.layerWebCrypto)("policyVersion", (test) => {
	test.effect("is this policy's version, which only an intended policy change moves", () =>
		Effect.gen(function* pinned() {
			const version = yield* policyVersion(defaultJudgeModel);

			assert.strictEqual(version, "82f545db788137e72892b106fcad966c71f7d77ab3c7dcd683751dc57d8cdbf8");
		}),
	);

	test.effect("changes when one rule's pattern changes", () =>
		Effect.gen(function* changedRule() {
			const [ssn, ...others] = rules;
			const before = yield* versionOf({ judgeModel: defaultJudgeModel, rules });

			const after = yield* versionOf({
				judgeModel: defaultJudgeModel,
				rules: [{ id: ssn.id, kind: ssn.kind, pattern: /\d{3}-\d\d-\d{4}/u }, ...others],
			});

			assert.notStrictEqual(after, before);
		}),
	);

	test.effect("changes when the judge model changes", () =>
		Effect.gen(function* changedModel() {
			const before = yield* policyVersion(defaultJudgeModel);
			const after = yield* policyVersion("gpt-6-sol");

			assert.notStrictEqual(after, before);
		}),
	);
});
