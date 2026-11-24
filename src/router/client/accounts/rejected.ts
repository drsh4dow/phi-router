import { Schema } from "effect";

class Rejected extends Schema.TaggedError<Rejected, { readonly brand: unique symbol }>()("Rejected", {
	account: Schema.String,
}) {}

export { Rejected };
