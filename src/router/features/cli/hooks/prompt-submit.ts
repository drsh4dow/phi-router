import { Console, DateTime, Effect, Option, Schema, String as Str, Struct, pipe } from "effect";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { asksUsage, statusOf } from "./statusline.ts";
import { statusText, usage } from "./phi-text.ts";
import { standardInput } from "#router/client/standard-input.ts";

const HookInput = Schema.fromJsonString(Schema.Struct({ prompt: Schema.String, session_id: SessionId }));

const Suppressed = Schema.Struct({
	hookEventName: Schema.Literal("UserPromptSubmit"),
	suppressOriginalPrompt: Schema.Literal(true),
});

const Blocked = Schema.fromJsonString(
	Schema.Struct({
		decision: Schema.Literal("block"),
		hookSpecificOutput: Schema.optionalKey(Suppressed),
		reason: Schema.String,
	}),
);

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

const answerOf = Effect.fnUntraced(function* answerOf(words: string, address: string, session: typeof SessionId.Type) {
	if (asksUsage(words)) {
		return usage;
	}

	const status = yield* statusOf(address, session);

	return `phi-router, ${yield* statusText(status)}`;
}, DateTime.withCurrentZoneLocal);

const suppressed = { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } as const;

const blockedOf = (reason: string, claude: boolean): typeof Blocked.Type => {
	const blocked = { decision: "block", reason } as const;

	if (!claude) {
		return blocked;
	}

	return Struct.assign(blocked, { hookSpecificOutput: suppressed });
};

const promptSubmit = Effect.fn("prompt-submit")(function* promptSubmit(hook: {
	readonly address: string;
	readonly claude: boolean;
}) {
	const text = yield* standardInput;
	const input = yield* Schema.decodeEffect(HookInput)(text);
	const words = wordsOf(input.prompt);

	if (Option.isNone(words)) {
		return;
	}

	const reason = yield* answerOf(words.value, hook.address, input.session_id).pipe(Effect.catch(Effect.succeed));

	const shown = yield* Schema.encodeEffect(Blocked)(blockedOf(reason, hook.claude));

	yield* Console.log(shown);
});

export { promptSubmit };
