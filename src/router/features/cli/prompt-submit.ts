import { Console, Effect, Option, Schema, String as Str, pipe } from "effect";
import { SessionId, phiCommand } from "#shared/cli.ts";
import { failedAs, pin, unpin } from "./pin.ts";
import { statusText, usage } from "./phi-text.ts";
import { SessionRequests } from "#router/client/router-port/index.ts";
import { portOf } from "./session-start.ts";
import { standardInput } from "#router/client/standard-input.ts";

/** What a prompt-submit hook reads on its stdin. The harness's field names stay here. */
const HookInput = Schema.fromJsonString(Schema.Struct({ prompt: Schema.String, session_id: SessionId }));

/** What blocks the prompt in both harnesses: the model never sees it, and the developer reads `reason`. */
const Blocked = Schema.fromJsonString(Schema.Struct({ decision: Schema.Literal("block"), reason: Schema.String }));

/**
 * `/phi` with any words, as Claude Code passes it, also under the plugin's name, `/phi-router:phi`, which the slash
 * menu completes to.
 */
const slashed = /^\/(?:phi-router:)?phi(?:\s+(?<words>[\s\S]*))?$/u;

/**
 * `phi`, `phi pin` or `phi unpin` alone. The Codex TUI refuses `/phi` itself, and the Claude Code TUI refuses `/phi pin`
 * typed in full, so these are the spellings both pass.
 */
const bare = new RegExp(`^${phiCommand.name}(?:\\s+(?<words>${phiCommand.pin}|${phiCommand.unpin}))?$`, "u");

/**
 * The words after `/phi` when the prompt is one, and none for any other prompt.
 *
 * @param {string} prompt The prompt as the developer typed it.
 * @returns {Option.Option<string>} The words, empty for `/phi` alone.
 */
const wordsOf = (prompt: string): Option.Option<string> => {
	const typed = Str.trim(prompt);

	return pipe(
		Option.fromNullishOr(slashed.exec(typed)),
		Option.orElse(() => Option.fromNullishOr(bare.exec(typed))),
		Option.flatMap(({ groups }) => Option.fromNullishOr(groups)),
		Option.map(({ words = "" }) => words),
	);
};

/** What `/phi` answers for a session on a port: its status, after a pin or an unpin when the words ask. */
const answerOf = Effect.fnUntraced(function* answerOf(words: string, session: typeof SessionId.Type, port: number) {
	const word = Str.trim(words);
	const requests = yield* SessionRequests;

	if (word === phiCommand.pin) {
		yield* pin(session, port);
	} else if (word === phiCommand.unpin) {
		yield* unpin(session, port);
	} else if (Str.isNonEmpty(word)) {
		return usage;
	}

	const status = yield* Effect.mapError(requests.status(port, session), failedAs({ command: "status", port }));

	return statusText(status);
});

const unprotected = "phi-router: this instance's model address names no router, so phi-router does not route it.";

/**
 * The prompt-submit hook's command. When the prompt is `/phi`, it answers it from the router on the port of `address`
 * and blocks the prompt with the answer, so the command never becomes a model turn. A router that does not answer
 * blocks it with `RouterUnanswered`'s line. Any other prompt passes, and the hook prints nothing.
 */
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
