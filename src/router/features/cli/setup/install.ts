import { Console, Effect, Option, Predicate, pipe } from "effect";
import type { HarnessName, InstallSource } from "./harnesses.ts";
import { Platform } from "#router/features/cli/platform.ts";
import type { Turn } from "#router/client/harnesses/index.ts";
import { harnesses } from "./harnesses.ts";
import { installRun } from "#router/client/harnesses/index.ts";
import { stopped } from "./keys.ts";
import { versionOf } from "#router/client/own-package.ts";

const repository = "drsh4dow/phi-router";

const succeeded = 0;

const installFailure = ({ name, turn }: { readonly name: HarnessName; readonly turn: Turn }): Option.Option<string> => {
	const {
		start: [binary],
		title,
	} = harnesses[name];

	if (turn.kind === "notStarted") {
		return Option.some(`Setup could not find ${binary}. Install ${title}, then rerun the command.`);
	}

	if (turn.kind === "timedOut") {
		return Option.some(`The install in ${title} took over 2 minutes.`);
	}

	return Option.liftPredicate(`The install in ${title} failed:\n${turn.printed}`, () => turn.exitCode !== succeeded);
};

/** Runs the harness's installer when it has not installed phi-router yet, and checks that it did. */
const installedIn = Effect.fnUntraced(function* installedIn(name: HarnessName, source: InstallSource) {
	const { installCommands, installed, title } = harnesses[name];
	const before = yield* installed;

	const installs = Option.match(before, { onNone: () => installCommands(source), onSome: () => [] });

	yield* Effect.forEach(
		installs,
		(argv) =>
			Effect.flatMap(installRun(argv), (turn) =>
				Option.match(installFailure({ name, turn }), {
					onNone: () => Effect.void,
					onSome: (failure) => stopped(`${failure}\n${title} was left as it was. Your key is saved.`),
				}),
			),
		{ concurrency: 1, discard: true },
	);

	yield* pipe(
		installed,
		Effect.flatMap(Effect.fromOption),
		Effect.mapError(() => stopped(`${title} did not install phi-router. Your key is saved.`)),
	);

	yield* Console.log(`✓ Installed phi-router in ${title}`);
});

/**
 * What each installer takes: the checkout `--source` names, else the release of the version of the phi-router package
 * setup runs from, which is the repository at the tag `v<version>` and the npm package of that version.
 */
const sourceOf = Effect.fnUntraced(function* sourceOf(checkout: string | undefined) {
	if (Predicate.isNotUndefined(checkout)) {
		return {
			claudeMarketplace: checkout,
			codexMarketplaceArgs: [checkout],
			piPackage: checkout,
		} satisfies InstallSource;
	}

	const { entry } = yield* Platform;
	const version = yield* versionOf(entry);
	const tag = `v${version}`;

	return {
		claudeMarketplace: `${repository}@${tag}`,
		codexMarketplaceArgs: [repository, "--ref", tag],
		piPackage: `npm:phi-router@${version}`,
	} satisfies InstallSource;
});

export { installFailure, installedIn, sourceOf };
