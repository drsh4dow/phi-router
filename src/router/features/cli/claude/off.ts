import { Array, Console, Effect, pipe } from "effect";
import { claudeSettings, exemptionName, restored } from "./settings.ts";
import { rewriteEnv, userSettings } from "#router/client/harnesses/index.ts";

const names = pipe(
	claudeSettings,
	Array.map(({ name }) => name),
);

const off = Effect.fn("off claude")(function* off(configDir: string) {
	const settings = yield* userSettings(configDir);
	const exempt = restored(settings.env);
	const { changed, path } = yield* rewriteEnv(configDir, exempt.set, [...names, ...exempt.unset]);

	const removed = pipe(
		changed,
		Array.filter((name) => Array.contains(names, name)),
	);

	const exemptionLines = pipe(
		[`phi-router gave ${exemptionName} back as it was before on`],
		Array.filter(() => Array.contains(changed, exemptionName)),
	);

	yield* Console.log(
		Array.join(
			[`phi-router removed ${String(removed.length)} settings from ${path}`, ...removed, ...exemptionLines],
			"\n",
		),
	);
});

export { off };
