import { Console, Effect, Option, Record, Schema, pipe } from "effect";
import { ModelsJson, spelling } from "#shared/cli.ts";
import { Command } from "effect/cli";
import { configuredLanes } from "#router/client/lane-configuration.ts";

/**
 * `phi-router models`, unlisted, which the pi package runs to give `phi/auto` and `phi/sealed` the limits of the models
 * they run: the JSON line the contract names. It reads `config.json` alone, and fails on a file the router would refuse.
 */
const models = Command.make(spelling.models.name, {}, () =>
	Effect.gen(function* printed() {
		const lanes = yield* configuredLanes;

		const routed = pipe(
			lanes,
			Option.map(Record.getSomes),
			Option.map(Record.map(({ sealedModel, targetModel }) => ({ auto: targetModel, sealed: sealedModel }))),
			Option.getOrElse(() => ({})),
		);

		const line = yield* Effect.orDie(Schema.encodeEffect(ModelsJson)(routed));

		yield* Console.log(line);
	}),
).pipe(Command.unlisted);

export { models };
