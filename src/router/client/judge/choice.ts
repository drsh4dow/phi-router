import { Array, Effect, Option, Schema, pipe } from "effect";
import { Configuration, configuredAccounts } from "#router/client/configuration/index.ts";
import type { KeySource, NamedAccount } from "#router/client/configuration/index.ts";
import type { JudgeName } from "./index.ts";
import { claudeModel } from "./claude.ts";
import { defaultDecisionsModel } from "./decisions.ts";

type ChosenJudge =
	| { readonly name: "decisions"; readonly endpoint: string; readonly key: KeySource; readonly model: string }
	| { readonly name: "claude"; readonly account: NamedAccount; readonly model: string };

class NoJudge extends Schema.TaggedError<NoJudge, { readonly brand: unique symbol }>()("NoJudge", {
	message: Schema.String,
}) {}

const defaultJudgeModels: Readonly<Record<JudgeName, string>> = {
	claude: claudeModel,
	decisions: defaultDecisionsModel,
};

const decisionsOn = (account: NamedAccount): Option.Option<ChosenJudge> => {
	if (account.vendor !== "openai" || account.credential.kind !== "key") {
		return Option.none();
	}

	return Option.some({
		endpoint: account.endpoint,
		key: account.credential.source,
		model: defaultJudgeModels.decisions,
		name: "decisions",
	});
};

const claudeOn = (account: NamedAccount): Option.Option<ChosenJudge> => {
	if (
		account.vendor !== "anthropic" ||
		account.credential.kind === "forwarded" ||
		Array.contains(account.lacks, defaultJudgeModels.claude)
	) {
		return Option.none();
	}

	return Option.some({ account, model: defaultJudgeModels.claude, name: "claude" });
};

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
				"config.json names no judge, and sealed holds no account the judge can run on. Add an OpenAI API-key account, or an Anthropic account with its own key or login folder, to sealed, or add a judge block.",
		});
	}

	return chosen.value;
});

const chosenJudge = Effect.gen(function* chosenJudge() {
	const { judge } = yield* Configuration;

	if (Option.isSome(judge)) {
		const { endpoint, key, model } = judge.value;

		return {
			endpoint,
			key,
			model: Option.getOrElse(model, () => defaultJudgeModels.decisions),
			name: "decisions",
		} as const;
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

export { chosenJudge, claudeOnSealed, defaultJudgeModels };

export type { ChosenJudge };
