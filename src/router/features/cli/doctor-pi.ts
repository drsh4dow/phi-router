import { Effect, Option, Struct } from "effect";
import { canaryRun, reported } from "./doctor.ts";
import { installedPackage, piTurn } from "#router/client/harnesses/index.ts";
import { piWire } from "#shared/pi.ts";

/** The canary run of `pi -p` on `phi/auto` through the package pi installed in `folder`. */
const piCanary = Effect.fnUntraced(function* piCanary(folder: string) {
	return yield* canaryRun({ binary: "pi", headless: "pi -p", vendor: "anthropic" }, ({ address, env, prompt }) =>
		piTurn({
			env: Struct.assign(env, { [piWire.portVariable]: new URL(address).port }),
			model: "phi/auto",
			packageFolder: folder,
			prompt,
		}),
	);
});

/**
 * Checks that pi installed the package, from pi's own record, and loads it unfiltered, and stops there when not. Then
 * it runs the canary through the installed package, and passes only when `pi -p` exited 0, the canary arrived at the
 * BAA mock, and it arrived at no open mock. It changes nothing in pi's agent folder, and never touches the product port, the user's
 * router configuration, or a real account.
 */
const doctorPi = Effect.fn("doctor pi")(function* doctorPi(agentDir: string) {
	const installed = yield* installedPackage(agentDir);

	yield* reported(
		"pi",
		[
			{ name: "pi installed the package phi-router", passed: Option.isSome(installed) },
			{
				name: "pi loads all of the package, which no filter in pi's settings narrows",
				passed: Option.exists(installed, ({ narrowedBySettings }) => !narrowedBySettings),
			},
		],
		"Run pi install with the address of the phi-router repository, and name it in pi's settings without a filter.",
	);

	const checks = yield* Option.match(installed, {
		onNone: () => Effect.succeed([]),
		onSome: ({ folder }) => piCanary(folder),
	});

	yield* reported(
		"pi",
		checks,
		"The canary must reach the BAA mock alone, through the router the package's session hook starts. Each FAIL line names what did not hold. When pi -p fails, run pi install with the repository's address again.",
	);
});

export { doctorPi, piCanary };
