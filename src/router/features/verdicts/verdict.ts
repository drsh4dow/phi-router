import type { IdentifierKind, RuleId } from "#router/features/policy/index.ts";
import type { ContentKey } from "#router/primitives/content-key.ts";
import { Data } from "effect";

type FailureWhy = "binary" | "undecodable" | "judge-error" | "judge-timeout" | "judge-refused" | "too-large";

type Finding = Data.TaggedEnum<{
	Rule: { readonly rule: RuleId; readonly kind: IdentifierKind };
	Judge: { readonly score: number; readonly kind: IdentifierKind | "unlabelled" };
	Failure: { readonly why: FailureWhy };
	Quote: { readonly of: typeof ContentKey.Type };
}>;

const Findings = Data.taggedEnum<Finding>();

/** `empty` is a piece with no text and no image left to judge. */
type ClearedBy = "judge" | "rules-only" | "fixture" | "empty";

type Verdict = Data.TaggedEnum<{
	Cleared: { readonly by: ClearedBy };
	Sealed: { readonly finding: Finding };
}>;

const Verdicts = Data.taggedEnum<Verdict>();

const standingOf = Verdicts.$match({ Cleared: () => "cleared" as const, Sealed: () => "sealed" as const });

export { Findings, Verdicts, standingOf };

export type { Verdict };
