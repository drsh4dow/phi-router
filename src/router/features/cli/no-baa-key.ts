import { Effect, Schema } from "effect";

/** How `serve` exits when it has no BAA key, so the `start` that launched it can say so. */
const noBaaKeyExit = 3;

/** `config.json` does not exist, or a key it names cannot be read, so the router has nowhere safe to send PHI. */
class NoBaaKey extends Schema.TaggedError<NoBaaKey, { readonly brand: unique symbol }>()("NoBaaKey", {
	why: Schema.String,
}) {
	public override get message(): string {
		return `phi-router serve: ${this.why}`;
	}
}

/**
 * `NoBaaKey` for the failure that left the router without one.
 *
 * @param {object} failure The failure, as its message says it.
 * @returns {Effect.Effect<never, NoBaaKey>} `NoBaaKey`, naming why.
 */
const keyless = (failure: { readonly message: string }): Effect.Effect<never, NoBaaKey> =>
	Effect.fail(NoBaaKey.make({ why: failure.message }));

export { keyless, noBaaKeyExit };
