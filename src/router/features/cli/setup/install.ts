import { Array, Console, Effect, Option, Predicate, pipe } from "effect";
import type { HarnessName, Installed, Move, Target } from "./harnesses.ts";
import { packageOf, versionOf } from "#router/client/own-package.ts";
import { Platform } from "#router/features/cli/platform.ts";
import type { Turn } from "#router/client/harnesses/index.ts";
import { harnesses } from "./harnesses.ts";
import { installRun } from "#router/client/harnesses/index.ts";
import { isOlder } from "#router/primitives/release.ts";
import { stopped } from "./keys.ts";

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

const moveOf = ({
	installed,
	target,
}: {
	readonly installed: Installed;
	readonly target: Target;
}): Option.Option<Move> => {
	const { source, version } = installed;
	const install = Option.some<Move>("install");

	if (source === "absent") {
		return install;
	}

	if (Predicate.isNotUndefined(target.checkout)) {
		return pipe(
			install,
			Option.filter(() => Predicate.isUndefined(version)),
		);
	}

	const newer = Predicate.isNotUndefined(version) && isOlder(target.version, version);

	if (source === "elsewhere" || newer) {
		return Option.none();
	}

	if (source === "held") {
		return Option.some("move");
	}

	if (Predicate.isUndefined(version)) {
		return install;
	}

	return pipe(
		Option.some<Move>("update"),
		Option.filter(() => isOlder(version, target.version)),
	);
};

const installedIn = Effect.fnUntraced(function* installedIn(name: HarnessName, target: Target) {
	const { installed, steps, title } = harnesses[name];
	const before = yield* installed;
	const move = moveOf({ installed: before, target });

	yield* Effect.forEach(
		Option.match(move, { onNone: () => [], onSome: (chosen) => steps(target)[chosen] }),
		(step) =>
			Effect.gen(function* ranStep() {
				if (Effect.isEffect(step)) {
					return yield* Effect.mapError(step, () =>
						stopped(`Setup could not change the settings of ${title}. Your key is saved.`),
					);
				}

				const turn = yield* installRun(step);

				return yield* Option.match(installFailure({ name, turn }), {
					onNone: () => Effect.void,
					onSome: (failure) => stopped(`${failure}\n${title} was left as it was. Your key is saved.`),
				});
			}),
		{ concurrency: 1, discard: true },
	);

	const after = yield* installed;

	if (Predicate.isUndefined(after.version)) {
		return yield* stopped(`${title} did not install phi-router. Your key is saved.`);
	}

	return yield* Console.log(`✓ Installed phi-router ${after.version} in ${title}`);
});

const targetOf = Effect.fnUntraced(function* targetOf(checkout: string | undefined) {
	const { entry } = yield* Platform;
	const version = yield* versionOf(entry);

	return { checkout, version } satisfies Target;
});

const tested = Effect.fnUntraced(function* tested(name: HarnessName) {
	const { canary, title } = harnesses[name];

	const failed = stopped(
		`The test failed, so ${title} was left as it was. Your key is saved. For details, run: npx phi-router doctor ${name}`,
	);

	const { entry } = yield* Platform;

	const checks = yield* pipe(
		packageOf(entry),
		Effect.flatMap(Effect.fromOption),
		Effect.flatMap(canary),
		Effect.mapError(() => failed),
	);

	const failures = pipe(
		checks,
		Array.filter((check) => !check.passed),
	);

	yield* Effect.forEach(failures, (check) => Console.log(`✗ ${check.name}`), { concurrency: 1, discard: true });

	return yield* Effect.when(failed, Effect.succeed(Array.isReadonlyArrayNonEmpty(failures)));
});

const switched = Effect.fnUntraced(function* switched(name: HarnessName) {
	const { switchOn, title } = harnesses[name];

	const writing = Effect.gen(function* writing() {
		const said = yield* switchOn;

		yield* Effect.forEach(said, (line) => Console.log(line), { concurrency: 1, discard: true });
	});

	yield* Effect.mapError(writing, (error) =>
		stopped(`Setup could not change the settings of ${title}. Your key is saved. ${error.message}`),
	);
});

const turnedOn = Effect.fnUntraced(function* turnedOn(name: HarnessName, target: Target, openPlan: string) {
	yield* tested(name);
	yield* installedIn(name, target);
	yield* Console.log(`✓ Test: a fake patient record reached ${openPlan} only as a handle`);
	yield* switched(name);
});

export { installFailure, installedIn, moveOf, targetOf, turnedOn };
