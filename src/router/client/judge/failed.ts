import { Schema } from "effect";

const Usage = Schema.Struct({
	calls: Schema.Finite,
	cost: Schema.Finite,
	inputTokens: Schema.Finite,
	ms: Schema.Finite,
});

/** A judge call that gave no usable answer. It carries the usage it billed, when it billed. */
class JudgeFailed extends Schema.TaggedError<JudgeFailed, { readonly brand: unique symbol }>()("JudgeFailed", {
	usage: Schema.optionalKey(Usage),
	why: Schema.Literals(["judge-error", "judge-timeout", "judge-refused"]),
}) {}

export { JudgeFailed, Usage };
