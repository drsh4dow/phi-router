import { Array, Context, Effect, pipe } from "effect";

/**
 * The exact texts the configuration lists as fixtures. A part whose texts are all listed is neither ruled on nor
 * judged. Unprovided, the registry is empty and exempts nothing.
 */
const Fixtures = Context.Reference<readonly string[]>("phi-router/router/features/verdicts/Fixtures", {
	defaultValue: () => [],
});

/** `texts` without the listed fixtures, in their order. */
const unlisted = Effect.fnUntraced(function* unlisted(texts: readonly string[]) {
	const fixtures = yield* Fixtures;

	return pipe(
		texts,
		Array.filter((text) => !Array.contains(fixtures, text)),
	);
});

export { Fixtures, unlisted };
