import { Array, Effect, FileSystem, Path, Schema, String as Str, pipe } from "effect";
import type { Json, Scripts } from "./harnesses.ts";
import type { Post, Turn } from "./mocked-router.ts";
import { bodyOf, laneLines } from "./mocked-router.ts";
import { codexBodyOf, jsonText, replyMessage, userMessage } from "./harnesses.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";

const canary = "PATIENT-CANARY-25K7";

const holdsCanary = Str.includes(canary);

/**
 * Model names other than `phi/auto` that reach the router: the strings Claude Code sent for the `haiku` and `sonnet`
 * aliases, Codex's reviewer and memory models, and a gateway id with a slash.
 */
const named = {
	gateway: "my-gateway/claude-opus-5-5",
	memories: "gpt-5.6-luna",
	reviewer: "codex-auto-review",
	sonnet: "claude-sonnet-5-5",
	subagent: "claude-haiku-5-5",
} as const;

type HarnessName = NonNullable<Scripts["harness"]>;

const harnessNames: readonly HarnessName[] = ["claude", "codex", "pi"];

/** How each harness spells `phi/auto`: the pi package sends the id `auto` inside its provider `phi`. */
const autoOf: Readonly<Record<HarnessName, string>> = { claude: "phi/auto", codex: "phi/auto", pi: "auto" };

const phi: Turn = { role: "user", text: `Member ${canary} called.` };

const clean: Turn = { role: "user", text: "List the build steps." };

/**
 * One turn as a Codex input item. An assistant turn is the reply the BAA mock wrote.
 *
 * @param {Turn} turn The turn.
 * @returns {Json} The item.
 */
const itemOf = ({ role, text }: Turn): Json => {
	if (role === "user") {
		return userMessage(text);
	}

	return replyMessage({ id: "msg_baa_ok", text });
};

/**
 * `turns` as the body `harness` sends, naming `model` where the test bodies name `phi/auto`.
 *
 * @param {object} sent The harness and the model.
 * @param {readonly Turn[]} turns The conversation.
 * @returns {Effect.Effect<string>} The body.
 */
const bodyFor = Effect.fnUntraced(function* bodyFor(
	sent: { readonly harness: HarnessName; readonly model: string },
	turns: readonly Turn[],
) {
	const field = yield* jsonText(sent.model);

	const body = yield* Effect.suspend(() => {
		if (sent.harness === "codex") {
			return codexBodyOf(pipe(turns, Array.map(itemOf)));
		}

		return bodyOf(turns);
	});

	return Str.replace('"model":"phi/auto"', `"model":${field}`)(body);
});

/** Posts `turns` as one request of `sent.session` under `sent.model`, reads the whole answer, and returns its status. */
const posted = Effect.fnUntraced(function* posted(
	post: Post,
	sent: { readonly harness: HarnessName; readonly session: string; readonly model: string },
	turns: readonly Turn[],
) {
	const body = yield* bodyFor(sent, turns);
	const response = yield* post({ body, session: sent.session });

	yield* response.text;

	return response.status;
});

const ModelOf = Schema.fromJsonString(Schema.Struct({ model: Schema.String }));

/**
 * The model each request an account mock received names.
 *
 * @param {readonly Sent[]} received What the mock received.
 * @returns {Effect.Effect} The models, in order.
 */
const modelsIn = (received: readonly Sent[]): Effect.Effect<readonly string[], Schema.SchemaError> =>
	Effect.forEach(received, ({ body }) => Effect.map(Schema.decodeEffect(ModelOf)(body), ({ model }) => model), {
		concurrency: 1,
	});

/** The account, lane, model, substitute flag and reason of each line of the lane log in `state`. */
const linesIn = Effect.fnUntraced(function* linesIn(state: string) {
	const lines = yield* laneLines(state);

	return pipe(
		lines,
		Array.map((line) => [line.account, line.lane, line.model, line.substitute, line.reason]),
	);
});

const privateModes = { file: 0o600, folder: 0o700 } as const;

/** A lease of `session` held by this process in `folder`, as `start` leaves it, in the router's state folder. */
const leased = Effect.fnUntraced(function* leased(state: string, session: string, folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const leases = yield* jsonText({ leases: [{ folder, pid: process.pid, session, started: "a start time" }] });

	yield* fs.makeDirectory(state, { mode: privateModes.folder, recursive: true });
	yield* fs.writeFileString(path.join(state, "leases.json"), leases, { mode: privateModes.file });
});

export { autoOf, clean, harnessNames, holdsCanary, leased, linesIn, modelsIn, named, phi, posted };

export type { HarnessName };
