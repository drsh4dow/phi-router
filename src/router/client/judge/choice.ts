import { Array, Effect, Option, Schema, pipe } from "effect";
import { Configuration, configuredAccounts } from "#router/client/configuration/index.ts";
import type { KeySource, NamedAccount } from "#router/client/configuration/index.ts";

interface ChosenJudge {
	readonly endpoint: string;
	readonly key: KeySource;
}

class NoJudge extends Schema.TaggedError<NoJudge, { readonly brand: unique symbol }>()("NoJudge", {
	message: Schema.String,
}) {}

const decisionsOn = (account: NamedAccount): Option.Option<ChosenJudge> => {
	if (account.vendor !== "openai" || account.credential.kind !== "key") {
		return Option.none();
	}

	return Option.some({ endpoint: account.endpoint, key: account.credential.source });
};

const chosenJudge = Effect.gen(function* chosenJudge() {
	const { judge } = yield* Configuration;

	if (Option.isSome(judge)) {
		return judge.value;
	}

	const accounts = yield* configuredAccounts;

	const chosen = pipe(
		accounts,
		Option.flatMap(({ sealed }) => Array.findFirst(sealed, decisionsOn)),
	);

	if (Option.isNone(chosen)) {
		return yield* NoJudge.make({
			message:
				"config.json names no judge, and sealed holds no OpenAI API-key account. The judge runs on OpenAI Decisions, so it needs an OpenAI API key under your BAA. Run phi-router setup.",
		});
	}

	return chosen.value;
});

export { chosenJudge };

export type { ChosenJudge };
