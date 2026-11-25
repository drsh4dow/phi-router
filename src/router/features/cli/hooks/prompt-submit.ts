import { Console, Effect, Option, Schema, String as Str, pipe } from "effect";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { statusText, usage } from "./phi-text.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { failedAs } from "#router/features/cli/sessions/index.ts";
import { portOf } from "./session-start.ts";
import { standardInput } from "#router/client/standard-input.ts";

const HookInput = Schema.fromJsonString(Schema.Struct({ prompt: Schema.String, session_id: SessionId }));

const Blocked = Schema.fromJsonString(Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }));

const slashed = /^\/(?:phi-router:)?phi(?:\s+(?<words>[\s\S]*))?$/u;

const droppedPin = "pin";

const bare = new RegExp(`^${phiCommand.name}(?:\\s+(?<words>${droppedPin}))?$`, "u");

const wordsOf = (prompt: string): Option.Option<string> => {
	const typed = Str.trim(prompt);

	return pipe(
		Option.fromNullishOr(slashed.exec(typed)),
		Option.orElse(() => Option.fromNullishOr(bare.exec(typed))),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.map(({ words = "" }) => words),
	);
};

const answerOf = Effect.fnUntraced(function* answerOf(words: string, session: typeof SessionId.Type, port: number) {
	if (Str.isNonEmpty(Str.trim(words))) {
		return usage;
	}

	const requests = yield* SessionRequests;
	const status = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));

	return statusText(status);
});

const unprotected = "phi-router: this instance's model address names no router, so phi-router does not route it.";

const promptSubmit = Effect.fn("prompt-submit")(function* promptSubmit(hook: { readonly address: string }) {
	const text = yield* standardInput;
	const input = yield* Schema.decodeEffect(HookInput)(text);
	const words = wordsOf(input.prompt);

	if (Option.isNone(words)) {
		return;
	}

	const reason = yield* Option.match(portOf(hook.address), {
		onNone: () => Effect.succeed(unprotected),
		onSome: (port) =>
			answerOf(words.value, input.session_id, port).pipe(
				Effect.catchTag("RouterUnanswered", (failed) => Effect.succeed(failed.message)),
			),
	});

	const blocked = yield* Schema.encodeEffect(Blocked)({ decision: "block", reason });

	yield* Console.log(blocked);
});

export { promptSubmit };
