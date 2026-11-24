import type { CleanLaneRefused, CodexRequest } from "./index.ts";
import type { Digest } from "effect/crypto";
import { Effect } from "effect";
import type { Lookup } from "#router/features/verdicts/index.ts";
import type { ToolsNotCleared } from "#router/features/border/index.ts";
import { guard } from "#router/features/border/index.ts";

const realModel = "gpt-5.5";

const nothingWritten = (): boolean => false;

const allCleared: Lookup = () => "cleared";

const cleanBodyPastBorder =
	(lookup: Lookup) =>
	(request: CodexRequest): Effect.Effect<string, CleanLaneRefused | ToolsNotCleared, Digest.Digest> =>
		Effect.flatMap(guard({ harness: "codex", lookup, messages: request.messages }), (messages) =>
			request.encode({ lane: "clean", messages, model: realModel }),
		);

export { allCleared, cleanBodyPastBorder, nothingWritten, realModel };
