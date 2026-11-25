import type { Answers, Found, Ready, Step } from "./plan.ts";
import { Array, Console, Effect, Option, Record, Redacted, String as Str, pipe } from "effect";
import type { HarnessName, Target } from "./harnesses.ts";
import { answering, foundScreen, keyPrompt, plan } from "./plan.ts";
import { enterPressed, handedOver, hiddenLine, isTerminal, picked } from "#router/client/terminal.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { apply } from "./apply.ts";
import { harnesses } from "./harnesses.ts";
import { stopped } from "./keys.ts";
import { stops } from "./copy.ts";

const noTerminal = stopped(
	"phi-router setup asks for a key, so it needs your own terminal. Run it yourself, outside your coding agent. Nothing was changed.",
);

const ended = stopped(stops.ended);

type Picking = Effect.Services<ReturnType<typeof picked>>;

const readyOf = (step: Step): Effect.Effect<Ready, ReturnType<typeof stopped>> => {
	if (step.kind === "ready") {
		return Effect.succeed(step);
	}

	if (step.kind === "stop") {
		return Effect.fail(stopped(step.line));
	}

	return Effect.fail(stopped(`Setup needs an answer to: ${step.question.text} Nothing changed.`));
};

const answered = (found: Found, answers: Answers): Effect.Effect<Step, ReturnType<typeof stopped>, Picking> => {
	const step = plan({ answers, found });

	if (step.kind !== "ask") {
		return Effect.succeed(step);
	}

	const { question } = step;

	const labels = pipe(
		question.choices,
		Array.map(({ label }) => label),
	);

	return picked(question.text, labels).pipe(
		Effect.map(Option.flatMap((index) => Array.get(question.choices, index))),
		Effect.flatMap(Effect.fromOption),
		Effect.mapError(() => ended),
		Effect.flatMap(({ id }) => answered(found, answering({ answers, choice: id, id: question.id }))),
	);
};

const typedKey = Effect.fnUntraced(function* typedKey(vendor: Vendor, roles: Ready["roles"]) {
	const key = yield* Effect.flatMap(hiddenLine(`${keyPrompt({ roles, vendor })} `), Effect.fromOption).pipe(
		Effect.mapError(() => ended),
	);

	const trimmed = Str.trim(Redacted.value(key));

	if (Str.isEmpty(trimmed) && vendor === "openai") {
		return yield* stopped(stops.noJudge);
	}

	if (Str.isEmpty(trimmed)) {
		return yield* ended;
	}

	return [vendor, Redacted.make(trimmed)] as const;
});

const asked = Effect.fnUntraced(function* asked(name: HarnessName, found: Found, target: Target) {
	const { closingLines, start } = harnesses[name];

	yield* Effect.filterOrFail(isTerminal, Boolean, () => noTerminal);
	yield* Console.log(`${Array.join(foundScreen(found), "\n")}\n`);

	const ready = yield* Effect.flatMap(answered(found, {}), readyOf);
	const typed = yield* Effect.forEach(ready.typed, (vendor) => typedKey(vendor, ready.roles), { concurrency: 1 });

	yield* apply(name, { roles: ready.roles, typed: Record.fromEntries(typed) }, target);
	yield* Console.log(Array.join(["", ...closingLines(target)], "\n"));
	yield* Effect.when(Effect.asVoid(handedOver(start)), enterPressed);
});

export { asked, readyOf, typedKey };
