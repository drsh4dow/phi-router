import type { Answers, Found, Ready, Step } from "./plan.ts";
import { Array, Config, Console, Effect, Option, Record, Schema, pipe } from "effect";
import type { HarnessName, InstallSource } from "./harnesses.ts";
import { foundScreen, keyPrompt, plan } from "./plan.ts";
import { readyOf, typedKey } from "./asked.ts";
import { SetupStepJson } from "#shared/cli.ts";
import type { Vendor } from "#router/client/configuration/index.ts";
import { apply } from "./apply.ts";
import { isTerminal } from "#router/client/terminal.ts";
import { stopped } from "./keys.ts";

const keyInputs = { anthropic: "PHI_ROUTER_ANTHROPIC_KEY", openai: "PHI_ROUTER_OPENAI_KEY" } as const;

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

const givenKey = Effect.fnUntraced(function* givenKey(vendor: Vendor, roles: Ready["roles"]) {
	const given = yield* Config.option(Config.Redacted(keyInputs[vendor]));

	if (Option.isSome(given)) {
		return [vendor, given.value] as const;
	}

	const terminal = yield* isTerminal;

	if (terminal) {
		return yield* typedKey(vendor, roles);
	}

	return yield* stopped(`Setup needs the key in ${keyInputs[vendor]}. Nothing changed.`);
});

const applied = Effect.fnUntraced(function* applied(
	name: HarnessName,
	found: Found,
	given: { readonly answers: Answers; readonly source: InstallSource },
) {
	const ready = yield* readyOf(plan({ answers: given.answers, found }));
	const typed = yield* Effect.forEach(ready.typed, (vendor) => givenKey(vendor, ready.roles), { concurrency: 1 });

	yield* apply(name, { roles: ready.roles, typed: Record.fromEntries(typed) }, given.source);
});

export { applied, reported };
