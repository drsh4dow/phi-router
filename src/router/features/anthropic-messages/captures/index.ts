import { autoMode } from "./auto-mode.ts";
import { compaction } from "./compaction.ts";
import { firstTurn } from "./first-turn.ts";
import { pi160Requests } from "./pi.ts";
import { subagent } from "./subagent.ts";
import { toolCallReply } from "./tool-call.ts";
import { toolResult } from "./tool-result.ts";
import { toolSearch } from "./tool-search.ts";
import { webSearch } from "./web-search.ts";

const requests = {
	autoMode,
	compaction,
	firstTurn,
	piCompaction: pi160Requests.compaction,
	piFirstTurn: pi160Requests.firstTurn,
	piThinkingOff: pi160Requests.thinkingOff,
	piToolResult: pi160Requests.toolResult,
	subagent,
	toolResult,
	toolSearch,
	webSearch,
};

const replies = { toolCallReply } as const;

export { replies, requests };
