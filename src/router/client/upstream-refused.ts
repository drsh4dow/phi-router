import { Schema } from "effect";

/** No answer from an account. It names the account and holds no header and no body. */
class Refused extends Schema.TaggedError<Refused, { readonly brand: unique symbol }>()("UpstreamRefused", {
	account: Schema.String,
}) {}

export { Refused };
