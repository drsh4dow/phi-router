import { Effect, Schema } from "effect";

/** How `serve` exits when it has no BAA key, so the `start` that launched it can say so. */
const noBaaKeyExit = 3;

class NoBaaKey extends Schema.TaggedError<NoBaaKey, { readonly brand: unique symbol }>()("NoBaaKey", {
	why: Schema.String,
}) {
	public override get message(): string {
		return `phi-router serve: ${this.why}`;
	}
}

const keyless = (failure: { readonly message: string }): Effect.Effect<never, NoBaaKey> =>
	Effect.fail(NoBaaKey.make({ why: failure.message }));

export { keyless, noBaaKeyExit };
