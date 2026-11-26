import { Context, Effect } from "effect";
import { versionOf } from "#router/client/own-package.ts";

class Platform extends Context.Service<
	Platform,
	{ readonly name: "bun" | "node"; readonly entry: string; readonly os: string }
>()("phi-router/router/features/cli/platform") {}

const ownVersion = Effect.gen(function* ownVersion() {
	const { entry } = yield* Platform;

	return yield* versionOf(entry);
});

export { Platform, ownVersion };
