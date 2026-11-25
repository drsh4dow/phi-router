import { Array, Effect, FileSystem, Path, Schema, String as Str, pipe } from "effect";
import type { Json, Scripts } from "./harnesses.ts";
import type { Post, Turn } from "./mocked-router.ts";
import { bodyOf, laneLines } from "./mocked-router.ts";
import { codexBodyOf, jsonText, replyMessage, userMessage } from "./harnesses.ts";
import type { Sent } from "#router/client/mock-upstreams/index.ts";
import { pinnedLine } from "#router/features/lanes/index.ts";

const canary = "PATIENT-CANARY-25K7";

const holdsCanary = Str.includes(canary);

const sentModels = {
	claudeHaiku: "claude-haiku-5-5",
	claudeSonnet: "claude-sonnet-5-5",
	codexMemories: "gpt-5.6-luna",
	codexReviewer: "codex-auto-review",
	gatewayWithSlash: "my-gateway/claude-opus-5-5",
} as const;

type HarnessName = NonNullable<Scripts["harness"]>;

const harnessNames: readonly HarnessName[] = ["claude", "codex", "pi"];

const autoOf: Readonly<Record<HarnessName, string>> = { claude: "phi/auto", codex: "phi/auto", pi: "auto" };

const phi: Turn = { role: "user", text: `Member ${canary} called.` };

const clean: Turn = { role: "user", text: "List the build steps." };

const codexItemOf = ({ role, text }: Turn): Json => {
	if (role === "user") {
		return userMessage(text);
	}

	return replyMessage({ id: "msg_baa_ok", text });
};

const bodyFor = Effect.fnUntraced(function* bodyFor(
	sent: { readonly harness: HarnessName; readonly model: string },
	turns: readonly Turn[],
) {
	const field = yield* jsonText(sent.model);

	const body = yield* Effect.suspend(() => {
		if (sent.harness === "codex") {
			return codexBodyOf(pipe(turns, Array.map(codexItemOf)));
		}

		return bodyOf(turns);
	});

	return Str.replace('"model":"phi/auto"', `"model":${field}`)(body);
});

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

const postedPinnedByLine = Effect.fnUntraced(function* postedPinnedByLine(
	post: Post,
	sent: { readonly session: string; readonly model: string },
	turn: Turn,
) {
	const body = yield* jsonText({
		max_tokens: 1024,
		messages: [{ content: [{ text: turn.text, type: "text" }], role: turn.role }],
		model: sent.model,
		stream: true,
		system: [{ text: pinnedLine, type: "text" }],
	});

	const response = yield* post({ body, session: sent.session });

	yield* response.text;

	return response.status;
});

const ModelOf = Schema.fromJsonString(Schema.Struct({ model: Schema.String }));

const modelsIn = (received: readonly Sent[]): Effect.Effect<readonly string[], Schema.SchemaError> =>
	Effect.forEach(received, ({ body }) => Effect.map(Schema.decodeEffect(ModelOf)(body), ({ model }) => model), {
		concurrency: 1,
	});

const linesIn = Effect.fnUntraced(function* linesIn(state: string) {
	const lines = yield* laneLines(state);

	return pipe(
		lines,
		Array.map((line) => [line.account, line.lane, line.model, line.substitute, line.reason]),
	);
});

const privateModes = { file: 0o600, folder: 0o700 } as const;

const leased = Effect.fnUntraced(function* leased(state: string, session: string, folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const leases = yield* jsonText({ leases: [{ folder, pid: process.pid, session, started: "a start time" }] });

	yield* fs.makeDirectory(state, { mode: privateModes.folder, recursive: true });
	yield* fs.writeFileString(path.join(state, "leases.json"), leases, { mode: privateModes.file });
});

const unreadableLeases = Effect.fnUntraced(function* unreadableLeases(state: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;

	yield* fs.makeDirectory(state, { mode: privateModes.folder, recursive: true });
	yield* fs.writeFileString(path.join(state, "leases.json"), "{", { mode: privateModes.file });
});

export {
	autoOf,
	clean,
	harnessNames,
	holdsCanary,
	leased,
	linesIn,
	modelsIn,
	phi,
	posted,
	postedPinnedByLine,
	sentModels,
	unreadableLeases,
};

export type { HarnessName };
