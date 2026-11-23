import { Schema } from "effect";

/**
 * A login folder's token got a 401. The folder's next read refreshes it unless another process already did, so the same
 * account may take the request once more. It names the account and holds no token.
 */
class Rejected extends Schema.TaggedError<Rejected, { readonly brand: unique symbol }>()("Rejected", {
	account: Schema.String,
}) {}

export { Rejected };
