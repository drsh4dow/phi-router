import type { Answers, Found, Step } from "./plan.ts";
import { Array, Console, Effect, Predicate, Schema, Struct, pipe } from "effect";
import type { HarnessName, Target } from "./harnesses.ts";
import { codexDone, windowDone } from "./copy.ts";
import { foundScreen, keyPrompt, plan } from "./plan.ts";
import { SetupStepJson } from "#shared/cli.ts";
import { apply } from "./apply.ts";
import { givenKeys } from "./given-keys.ts";
import { harnesses } from "./harnesses.ts";
import { readyOf } from "./asked.ts";

const wired = (found: Found, step: Step): typeof SetupStepJson.Type => {
	const screen = foundScreen(found);

	if (step.kind === "ask") {
		return { found: screen, kind: "ask", question: step.question };
	}

	if (step.kind === "stop") {
		return { found: screen, kind: "stop", line: step.line };
	}

	const keys = pipe(
		step.typed,
		Array.map((vendor) => ({ prompt: keyPrompt({ roles: step.roles, vendor }), vendor })),
	);

	return { found: screen, keys, kind: "ready" };
};

const reported = Effect.fnUntraced(function* reported(found: Found, answers: Answers) {
	const text = yield* Schema.encodeEffect(SetupStepJson)(wired(found, plan({ answers, found })));

	yield* Console.log(text);
});

const applied = Effect.fnUntraced(function* applied(
	name: HarnessName,
	found: Found,
	given: { readonly answers: Answers; readonly answersJson: string | undefined; readonly target: Target },
) {
	const ready = yield* readyOf(plan({ answers: Struct.assign({ another: "no" } as const, given.answers), found }));
	const typed = yield* givenKeys(name, ready, given);
	const before = yield* harnesses[name].installed;

	yield* apply(name, { another: ready.another, roles: ready.roles, typed }, given.target);
	yield* Effect.when(
		Console.log(windowDone[`${Predicate.isNotUndefined(before.version)}`]),
		Effect.succeed(name === "claude"),
	);
	yield* Effect.when(Console.log(codexDone), Effect.succeed(name === "codex"));
});

export { applied, reported };
