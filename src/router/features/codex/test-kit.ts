import { Array, Effect, pipe } from "effect";
import type { CleanLaneRefused, CodexRequest, CodexRequestRejected } from "./index.ts";
import { cleanLaneKeys, decodeRequest } from "./index.ts";
import type { Digest } from "effect/crypto";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { Message } from "#router/features/parts/index.ts";
import type { ToolsNotCleared } from "#router/features/border/index.ts";
import { guard } from "#router/features/border/index.ts";

const realModel = "gpt-5.5";

const nothingWritten = (): boolean => false;

const allCleared: Lookup = () => "cleared";

const cleanBodyPastBorder =
	(lookup: Lookup) =>
	(request: CodexRequest): Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
		Effect.flatMap(guard({ harness: "codex", lookup, messages: request.messages }), (messages) =>
			request.encode({ lane: "clean", messages, upstreamModel: realModel }),
		);

const decodedAfter =
	(reply: string) =>
	(text: string): Effect.Effect<CodexRequest, CodexRequestRejected, Digest.Digest> =>
		Effect.gen(function* afterReply() {
			const keys = yield* cleanLaneKeys(reply);
			const written = new Set(keys);

			return yield* decodeRequest(text, (key) => written.has(key));
		});

const writersOf = (messages: readonly Message[]): readonly string[] =>
	pipe(
		messages,
		Array.flatMap((message) => {
			if (message.role === "assistant") {
				return [message.writtenBy];
			}

			return [];
		}),
	);

export { allCleared, cleanBodyPastBorder, decodedAfter, nothingWritten, realModel, writersOf };
