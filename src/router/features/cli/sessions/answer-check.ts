import { AnswerCheckJson, AnswerCheckedJson, spelling } from "#shared/cli.ts";
import { Console, Effect, Schema } from "effect";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { failedAs } from "./status.ts";
import { standardInput } from "#router/client/standard-input.ts";

const answerCheck = Effect.fn("answerCheck")(function* answerCheck(port: number) {
	const asked = yield* standardInput.pipe(Effect.flatMap(Schema.decodeEffect(AnswerCheckJson)));
	const requests = yield* SessionRequests;

	const checked = yield* Effect.mapError(
		requests.answerCheck(port, asked),
		failedAs({ command: spelling.answerCheck.name, port }),
	);

	const line = yield* Effect.orDie(Schema.encodeEffect(AnswerCheckedJson)(checked));

	yield* Console.log(line);
});

export { answerCheck };
