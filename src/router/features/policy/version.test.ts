import { assert, it } from "@effect/vitest";
import { Digest } from "effect/crypto";
import { Effect } from "effect";
import { policyVersion } from "./index.ts";
import { rules } from "./rules.ts";
import { versionOf } from "./version.ts";

const decisions = { model: "gpt-6-luna" } as const;

it.layer(Digest.layerWebCrypto)("policyVersion", (test) => {
	test.effect("is this policy's version, which only an intended policy change moves", () =>
		Effect.gen(function* pinned() {
			const version = yield* policyVersion(decisions);

			assert.strictEqual(version, "54b0d7540e6d2d47697c63e42f0e9bda5e6b373b43c7efbc51823778c46003fc");
		}),
	);

	test.effect("changes when one rule's pattern changes", () =>
		Effect.gen(function* changedRule() {
			const [ssn, ...others] = rules;
			const before = yield* versionOf({ judge: decisions, rules });

			const after = yield* versionOf({
				judge: decisions,
				rules: [{ id: ssn.id, kind: ssn.kind, pattern: /\d{3}-\d\d-\d{4}/u }, ...others],
			});

			assert.notStrictEqual(after, before);
		}),
	);

	test.effect("changes when the judge model changes", () =>
		Effect.gen(function* changedModel() {
			const before = yield* policyVersion(decisions);
			const after = yield* policyVersion({ model: "gpt-6-sol" });

			assert.notStrictEqual(after, before);
		}),
	);
});
