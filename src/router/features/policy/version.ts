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

interface VersionedJudge {
	readonly model: string;
}

interface Versioned {
	readonly judge: VersionedJudge;
	readonly rules: readonly Rule[];
}

const jsonOf = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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

const manifestOf = ({ judge, rules: versionedRules }: Versioned): Record<string, unknown> =>
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
		["judgeModel", judge.model],
		["rules", pipe(versionedRules, Array.map(ruleJson))],
	]);

const versionOf = Effect.fnUntraced(function* versionOf(versioned: Versioned) {
	const digest = yield* Digest.Digest;
	const json = yield* Effect.orDie(jsonOf(manifestOf(versioned)));
	const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(json));

	return PolicyVersion.make(hex);
});

const policyVersion = Effect.fnUntraced(function* policyVersion(judge: VersionedJudge) {
	return yield* versionOf({ judge, rules });
});

export { policyVersion, versionOf };
