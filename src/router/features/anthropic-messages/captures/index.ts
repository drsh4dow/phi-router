import { autoMode } from "./auto-mode.ts";
import { compaction } from "./compaction.ts";
import { firstTurn } from "./first-turn.ts";
import { piRequests } from "./pi.ts";
import { subagent } from "./subagent.ts";
import { toolCallReply } from "./tool-call.ts";
import { toolResult } from "./tool-result.ts";
import { toolSearch } from "./tool-search.ts";
import { webSearch } from "./web-search.ts";

/** Every captured request body, by name. */
const requests = {
	autoMode,
	compaction,
	firstTurn,
	piCompaction: piRequests.compaction,
	piFirstTurn: piRequests.firstTurn,
	piThinkingOff: piRequests.thinkingOff,
	piToolResult: piRequests.toolResult,
	subagent,
	toolResult,
	toolSearch,
	webSearch,
};

const replies = { toolCallReply } as const;

export { replies, requests };
