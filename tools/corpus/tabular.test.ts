import { Array, Effect, String as Str } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { csv } from "./tabular.ts";
import { diagnoses } from "./health.ts";
import { identifierKind } from "#router/features/policy/index.ts";
import { seeded } from "./random.ts";

const seed = 1;

const idFirst = Effect.sync(() => {
	const row = csv({
		minified: true,
		record: {
			diagnosis: Array.headNonEmpty(diagnoses),
			fields: [{ kind: identifierKind.patientName, value: "Mara Tovanek" }],
			internalId: 4242,
			lang: "en",
		},
		rng: seeded(seed),
	});

	assert.isTrue(Str.startsWith('[{"id":4242,')(row), row);
});

describe("tabular", () => {
	it.effect("a minified CSV row is a JSON row object whose first key is the internal id", () => idFirst);
});
