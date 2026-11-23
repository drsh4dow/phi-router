import { Array, Effect, Record, Schema, pipe } from "effect";
import {
	counterExamples,
	defaults,
	identifierKinds,
	identifierQuestion,
	judgeLimits,
	kindQuestion,
	quoteMinChars,
	seamChars,
	stubs,
	syntheticIdentities,
	syntheticMark,
	thresholds,
	window,
} from "./policy.ts";
import { Digest } from "effect/crypto";
import type { Rule } from "./rules.ts";
import { rules } from "./rules.ts";

const PolicyVersion = Schema.String.pipe(Schema.brand("PolicyVersion"));

/** What a version hashes beside the policy's text: the judge model and the rules. */
interface Versioned {
	readonly judgeModel: string;
	readonly rules: readonly Rule[];
}

/** Plain data, so encoding cannot fail. */
const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Key order is data, since the version hashes it. Entries keep the original's order, where `sort-keys` would sort a literal. */
const identifierQuestionJson = Record.fromEntries([
	["type", identifierQuestion.type],
	["instructions", identifierQuestion.instructions],
	[
		"criteria",
		Record.fromEntries([
			["true", identifierQuestion.criteria.true],
			["false", identifierQuestion.criteria.false],
		]),
	],
]);

const kindQuestionJson = Record.fromEntries([
	["type", kindQuestion.type],
	["instructions", kindQuestion.instructions],
	["criteria", Record.fromEntries(kindQuestion.criteria)],
]);

const ruleJson = ({ id, kind, pattern }: Rule): Record<string, string> =>
	Record.fromEntries([
		["id", id],
		["kind", kind],
		["source", pattern.source],
		["flags", pattern.flags],
	]);

const manifestOf = ({ judgeModel, rules: versionedRules }: Versioned): Record<string, unknown> =>
	Record.fromEntries([
		["identifierKinds", Record.fromEntries(identifierKinds)],
		["defaults", defaults],
		["counterExamples", counterExamples],
		["syntheticIdentities", syntheticIdentities],
		["syntheticMark", syntheticMark],
		["stubs", stubs],
		["identifierQuestion", identifierQuestionJson],
		["kindQuestion", kindQuestionJson],
		["thresholds", thresholds],
		["quoteMinChars", quoteMinChars],
		["seamChars", seamChars],
		["window", window],
		["judgeLimits", judgeLimits],
		["judgeModel", judgeModel],
		["rules", pipe(versionedRules, Array.map(ruleJson))],
	]);

/** Everything above, hashed. A stored verdict from another version is ignored and judged again. */
const versionOf = Effect.fnUntraced(function* versionOf(versioned: Versioned) {
	const digest = yield* Digest.Digest;
	const json = yield* Effect.orDie(jsonOf(manifestOf(versioned)));
	const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(json));

	return PolicyVersion.make(hex);
});

/** The version of this policy, with its own rules, judged by `judgeModel`. */
const policyVersion = Effect.fnUntraced(function* policyVersion(judgeModel: string) {
	return yield* versionOf({ judgeModel, rules });
});

export { policyVersion, versionOf };
