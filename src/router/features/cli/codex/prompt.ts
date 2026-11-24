import { Console, Effect, Option, Schema } from "effect";
import { firstLine } from "#router/client/harnesses/index.ts";
import { providerId } from "./settings.ts";
import { standardInput } from "#router/client/standard-input.ts";

const HookInput = Schema.fromJsonString(Schema.Struct({ transcript_path: Schema.NullOr(Schema.String) }));

const SessionMeta = Schema.fromJsonString(
	Schema.Struct({ payload: Schema.Struct({ model_provider: Schema.String }), type: Schema.Literal("session_meta") }),
);

const Block = Schema.fromJsonString(Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }));

const unrecorded =
	"Codex keeps no transcript of this session, as with --ephemeral, so phi-router cannot tell whether it sends to the router. Run codex without --ephemeral.";

const elsewhere = (named: string): string =>
	`this session sends to the provider ${named}, not to the router. Start a new session without -c model_provider or a profile that names another provider.`;

const blocked = (reason: string): Effect.Effect<void, Schema.SchemaError> =>
	Effect.flatMap(
		Schema.encodeEffect(Block)({ decision: "block", reason: `phi-router blocked this prompt: ${reason}` }),
		(answer) => Console.log(answer),
	);

const codexPrompt = Effect.fn("codex-prompt")(function* codexPrompt() {
	const text = yield* standardInput;
	const { transcript_path: transcript } = yield* Schema.decodeEffect(HookInput)(text);

	if (transcript === null) {
		return yield* blocked(unrecorded);
	}

	const line = yield* firstLine(transcript);
	const meta = yield* Schema.decodeEffect(SessionMeta)(Option.getOrElse(line, () => ""));
	const named = meta.payload.model_provider;

	return yield* Effect.when(blocked(elsewhere(named)), Effect.succeed(named !== providerId));
});

export { codexPrompt };
