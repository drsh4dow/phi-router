import { Command, Flag } from "effect/cli";
import { Effect, Option, Schema } from "effect";
import { SetupAnswersJson, spelling } from "#shared/cli.ts";
import { applied, reported } from "./wire.ts";
import type { HarnessName } from "./harnesses.ts";
import { KeyChecks } from "#router/client/keys/index.ts";
import { asked } from "./asked.ts";
import { find } from "./found.ts";
import { stopped } from "./keys.ts";
import { targetOf } from "./install.ts";

const noVersion = stopped(
	"Setup could not read the version of phi-router, so it cannot tell which release to install. Nothing was changed.",
);

const unreadAnswers = stopped("Setup could not read --answers. Nothing was changed.");

const flags = {
	answers: Flag.optional(Flag.String(spelling.setup.answers)).pipe(Flag.map((json) => Option.getOrUndefined(json))),
	apply: Flag.Boolean(spelling.setup.apply).pipe(Flag.withDefault(false)),
	channel: Flag.String("channel").pipe(Flag.withDefault("release")),
	json: Flag.Boolean(spelling.setup.json).pipe(Flag.withDefault(false)),
	newKey: Flag.Boolean("new-key").pipe(Flag.withDefault(false)),
	source: Flag.optional(Flag.Directory("source", { mustExist: true })).pipe(
		Flag.map((folder) => Option.getOrUndefined(folder)),
	),
};

const setup = Effect.fn("setup")(function* setup(
	name: HarnessName,
	given: {
		readonly answers: string | undefined;
		readonly apply: boolean;
		readonly channel: string;
		readonly json: boolean;
		readonly newKey: boolean;
		readonly source: string | undefined;
	},
) {
	const answers = yield* Schema.decodeEffect(SetupAnswersJson)(given.answers ?? "{}").pipe(
		Effect.mapError(() => unreadAnswers),
	);

	const target = yield* Effect.mapError(targetOf({ channel: given.channel, checkout: given.source }), () => noVersion);
	const found = yield* find(name, given.newKey);

	if (given.json) {
		return yield* reported(found, answers);
	}

	if (given.apply) {
		return yield* applied(name, found, { answers, answersJson: given.answers, target });
	}

	return yield* asked(name, found, target);
});

const claude = Command.make("claude", flags, (given) => setup("claude", given));

const codex = Command.make("codex", flags, (given) => setup("codex", given));

const pi = Command.make("pi", flags, (given) => setup("pi", given));

const setupCommand = Command.make(spelling.setup.name).pipe(
	Command.withSubcommands([claude, codex, pi]),
	Command.provide(KeyChecks.layer),
);

export { setupCommand };
