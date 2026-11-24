import { Schema } from "effect";

class NoAnswer extends Schema.TaggedError<NoAnswer, { readonly brand: unique symbol }>()("UpstreamRefused", {
	account: Schema.String,
}) {}

export { NoAnswer };
