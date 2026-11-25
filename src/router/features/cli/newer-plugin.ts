import { Effect, Option, Schema, pipe } from "effect";
import { Release, isOlder } from "#router/primitives/release.ts";
import { Platform } from "./platform.ts";
import { versionOf } from "#router/client/own-package.ts";

const runningOf = (router: string | undefined): string =>
	pipe(
		Option.fromUndefinedOr(router),
		Option.getOrElse(() => "an older version"),
	);

const newerPlugin = Effect.fnUntraced(function* newerPlugin(router: string | undefined) {
	const { entry } = yield* Platform;
	const read = yield* Effect.option(versionOf(entry));
	const own = pipe(read, Option.filter(Schema.is(Release)));

	return pipe(
		own,
		Option.filter((installed) =>
			Option.match(Option.fromUndefinedOr(router), {
				onNone: () => true,
				onSome: (running) => isOlder(running, installed),
			}),
		),
		Option.map(
			(installed) =>
				`phi-router ${installed} is installed. Your open windows still run ${runningOf(router)} until you close them all.`,
		),
	);
});

export { newerPlugin };
