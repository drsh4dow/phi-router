import { Console, Effect, Option, Schema } from "effect";
import { firstLine } from "#router/client/harnesses/index.ts";
import { providerId } from "./codex-settings.ts";
import { standardInput } from "#router/client/standard-input.ts";

/** What Codex writes to a prompt hook's stdin, as far as this check reads it. The harness's field names stay here. */
const HookInput = Schema.fromJsonString(Schema.Struct({ transcript_path: Schema.NullOr(Schema.String) }));

/** The line that opens a Codex transcript, as far as it names the provider the session sends to. */
const SessionMeta = Schema.fromJsonString(
	Schema.Struct({ payload: Schema.Struct({ model_provider: Schema.String }), type: Schema.Literal("session_meta") }),
);

/** The answer that blocks a prompt in a Codex `UserPromptSubmit` hook. */
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

/**
 * The Codex prompt hook's command. It prints nothing when the session's transcript says the session sends to the
 * router's provider. It prints Codex's block answer when the transcript names another provider, as `-c model_provider`
 * or a profile makes it, and when Codex keeps no transcript, as with `--ephemeral`. A transcript it cannot read fails
 * the command, and the hook blocks on that too.
 */
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
