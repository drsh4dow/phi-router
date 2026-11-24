import { Array, Context, Effect, pipe } from "effect";

const Fixtures = Context.Reference<readonly string[]>("phi-router/router/features/verdicts/Fixtures", {
	defaultValue: () => [],
});

const unlisted = Effect.fnUntraced(function* unlisted(texts: readonly string[]) {
	const fixtures = yield* Fixtures;

	return pipe(
		texts,
		Array.filter((text) => !Array.contains(fixtures, text)),
	);
});

export { Fixtures, unlisted };
