import { Array, Effect, Option, Schema, pipe } from "effect";
import { Configuration } from "./configuration.ts";
import type { JudgeName } from "./judge.ts";
import type { KeySource } from "./credentials.ts";
import type { NamedAccount } from "./lane-configuration.ts";
import { claudeModel } from "./judge-claude.ts";
import { configuredAccounts } from "./lane-configuration.ts";
import { decisionsModel } from "./judge-decisions.ts";

/** The judge a configuration picks, with the model it runs. */
type ChosenJudge =
	| { readonly name: "decisions"; readonly endpoint: string; readonly key: KeySource; readonly model: string }
	| { readonly name: "claude"; readonly account: NamedAccount; readonly model: string };

/** A `config.json` that names no judge and no BAA account the judge can run on. The router refuses it. */
class NoJudge extends Schema.TaggedError<NoJudge, { readonly brand: unique symbol }>()("NoJudge", {
	message: Schema.String,
}) {}

/** Each judge's model when the configuration names none. */
const judgeModels = { claude: claudeModel, decisions: decisionsModel } as const satisfies Record<JudgeName, string>;

const decisionsOn = (account: NamedAccount): Option.Option<ChosenJudge> => {
	if (account.vendor !== "openai" || account.credential.kind !== "key") {
		return Option.none();
	}

	return Option.some({
		endpoint: account.endpoint,
		key: account.credential.source,
		model: judgeModels.decisions,
		name: "decisions",
	});
};

const claudeOn = (account: NamedAccount): Option.Option<ChosenJudge> => {
	if (account.vendor !== "anthropic" || account.credential.kind === "forwarded") {
		return Option.none();
	}

	return Option.some({ account, model: judgeModels.claude, name: "claude" });
};

/** The first account on `sealed` that `on` takes, or `NoJudge`. */
const onSealed = Effect.fnUntraced(function* onSealed(
	on: (accounts: readonly NamedAccount[]) => Option.Option<ChosenJudge>,
) {
	const accounts = yield* configuredAccounts;

	const chosen = pipe(
		accounts,
		Option.flatMap(({ sealed }) => on(sealed)),
	);

	if (Option.isNone(chosen)) {
		return yield* NoJudge.make({
			message:
				"phi-router: config.json names no judge, and sealed holds no account the judge can run on. Add an OpenAI API-key account, or an Anthropic account with its own key or login folder, to sealed, or add a judge block.",
		});
	}

	return chosen.value;
});

/**
 * The judge the configuration picks. A `judge` block asks Decisions with its own key. With none, the first OpenAI
 * API-key account on `sealed` asks Decisions, else the first Anthropic account on `sealed` that holds its own
 * credential asks the Claude judge. A forwarded account holds none, and an OpenAI login folder reaches no Decisions.
 */
const chosenJudge = Effect.gen(function* chosenJudge() {
	const { judge } = yield* Configuration;

	if (Option.isSome(judge)) {
		const { endpoint, key, model } = judge.value;

		return { endpoint, key, model: Option.getOrElse(model, () => judgeModels.decisions), name: "decisions" } as const;
	}

	return yield* onSealed((sealed) =>
		pipe(
			sealed,
			Array.findFirst(decisionsOn),
			Option.orElse(() => pipe(sealed, Array.findFirst(claudeOn))),
		),
	);
});

/** The Claude judge on the first Anthropic account on `sealed` that holds its own credential, whatever else is named. */
const claudeOnSealed = onSealed((sealed) => pipe(sealed, Array.findFirst(claudeOn)));

export { chosenJudge, claudeOnSealed, judgeModels };

export type { ChosenJudge };
